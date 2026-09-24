package capnpcwasm_test

import (
	"bytes"
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"

	capnpcwasm "github.com/nullstyle/capnpc-wasm/sdk/go"
)

func TestGenerate(t *testing.T) {
	compiler := sharedCompiler(t)
	workspace := fixture(t)
	combined, err := compiler.Compile(t.Context(), workspace)
	if err != nil {
		t.Fatal(err)
	}
	workspace.Generators = nil
	compiled, err := compiler.Compile(t.Context(), workspace)
	if err != nil {
		t.Fatal(err)
	}
	if len(compiled.Outputs) != 0 {
		t.Fatal("compiler-only job generated files")
	}
	generator := compiler

	t.Run("does not invoke the compiler", func(t *testing.T) {
		// A compiler that emits no request would fail Compile. A successful
		// Generate call on this instance proves that it does not run the frontend.
		modules := loadModules(t)
		modules.Compiler = wasmBytes(t, noopCommand)
		modules.Generators = map[capnpcwasm.Language][]byte{"rust": modules.Generators["rust"]}
		c, err := capnpcwasm.New(t.Context(), modules, testOptions()...)
		if err != nil {
			t.Fatal(err)
		}
		defer c.Close(context.Background())
		got, err := c.Generate(t.Context(), capnpcwasm.GenerationRequest{Request: compiled.Request, Generators: []capnpcwasm.Language{"rust"}})
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(got.Outputs["rust"], combined.Outputs["rust"]) {
			t.Fatal("rust output differs from Compile")
		}
	})

	t.Run("compile once and generate target sets", func(t *testing.T) {
		for _, languages := range [][]capnpcwasm.Language{{"cpp"}, {"rust", "go"}, {"zig"}, {"cpp", "rust", "go", "zig"}} {
			got, err := generator.Generate(t.Context(), capnpcwasm.GenerationRequest{Request: compiled.Request, Generators: languages})
			if err != nil {
				t.Fatal(err)
			}
			if len(got.Outputs) != len(languages) || len(got.Diagnostics) != 0 {
				t.Fatalf("unexpected generated result: %+v", got)
			}
			for _, language := range languages {
				if !reflect.DeepEqual(got.Outputs[language], combined.Outputs[language]) {
					t.Errorf("%s output differs from Compile", language)
				}
			}
		}
	})

	t.Run("caller ownership and concurrent jobs", func(t *testing.T) {
		input := bytes.Clone(compiled.Request)
		got, err := generator.Generate(t.Context(), capnpcwasm.GenerationRequest{Request: input, Generators: []capnpcwasm.Language{"rust"}})
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(input, compiled.Request) {
			t.Fatal("Generate mutated its request")
		}
		clear(input)
		if !reflect.DeepEqual(got.Outputs["rust"], combined.Outputs["rust"]) {
			t.Fatal("result aliases its input request")
		}
		got.Outputs["rust"]["person_capnp.rs"][0] ^= 1
		var workers sync.WaitGroup
		for _, language := range allLanguages {
			workers.Go(func() {
				result, err := generator.Generate(t.Context(), capnpcwasm.GenerationRequest{Request: compiled.Request, Generators: []capnpcwasm.Language{language}})
				if err != nil {
					t.Error(err)
					return
				}
				if len(result.Outputs) != 1 || !reflect.DeepEqual(result.Outputs[language], combined.Outputs[language]) {
					t.Errorf("%s result aliases another job", language)
				}
			})
		}
		workers.Wait()
	})

	t.Run("malformed requests preserve guest diagnostics", func(t *testing.T) {
		for _, language := range allLanguages {
			for _, input := range [][]byte{{0xff, 0xff, 0xff, 0xff}, compiled.Request[:len(compiled.Request)-1]} {
				got, err := generator.Generate(t.Context(), capnpcwasm.GenerationRequest{Request: input, Generators: []capnpcwasm.Language{language}})
				var failure *capnpcwasm.Error
				if !errors.As(err, &failure) || failure.Stage != capnpcwasm.Stage(language) || failure.Language != language || failure.Stderr == "" {
					t.Fatalf("missing %s guest diagnostic: %v", language, err)
				}
				if !reflect.DeepEqual(got, capnpcwasm.GenerationResult{}) {
					t.Fatal("malformed request returned partial output")
				}
			}
		}
	})

	t.Run("later failure discards earlier generator outputs", func(t *testing.T) {
		bad := fixture(t)
		bad.Generators = nil
		bad.Files["person.capnp"] = bytes.Replace(bad.Files["person.capnp"], []byte(`$Go.package("fixture");`), nil, 1)
		request, err := compiler.Compile(t.Context(), bad)
		if err != nil {
			t.Fatal(err)
		}
		got, err := generator.Generate(t.Context(), capnpcwasm.GenerationRequest{Request: request.Request, Generators: []capnpcwasm.Language{"cpp", "rust", "zig", "go"}})
		var failure *capnpcwasm.Error
		if !errors.As(err, &failure) || failure.Stage != "go" || failure.Language != "go" || failure.Stderr == "" {
			t.Fatalf("missing later generator diagnostic: %v", err)
		}
		if !reflect.DeepEqual(got, capnpcwasm.GenerationResult{}) {
			t.Fatal("earlier generator outputs escaped")
		}
		got, err = generator.Generate(t.Context(), capnpcwasm.GenerationRequest{Request: compiled.Request, Generators: []capnpcwasm.Language{"go"}})
		if err != nil || !reflect.DeepEqual(got.Outputs["go"], combined.Outputs["go"]) {
			t.Fatalf("failed job contaminated next job: %v", err)
		}
	})

	t.Run("validation", func(t *testing.T) {
		for _, request := range []capnpcwasm.GenerationRequest{
			{Generators: []capnpcwasm.Language{"rust"}},
			{Request: compiled.Request},
			{Request: compiled.Request, Generators: []capnpcwasm.Language{"python"}},
			{Request: compiled.Request, Generators: []capnpcwasm.Language{"go", "go"}},
			{Request: make([]byte, (64<<20)+1), Generators: []capnpcwasm.Language{"rust"}},
		} {
			assertGenerateValidation(t, generator, request)
		}
	})

	t.Run("cancelled request", func(t *testing.T) {
		ctx, cancel := context.WithCancel(t.Context())
		cancel()
		got, err := generator.Generate(ctx, capnpcwasm.GenerationRequest{Request: compiled.Request, Generators: []capnpcwasm.Language{"rust"}})
		if !errors.Is(err, context.Canceled) || !reflect.DeepEqual(got, capnpcwasm.GenerationResult{}) {
			t.Fatalf("cancellation: %+v, %v", got, err)
		}
	})
}

func assertGenerateValidation(t *testing.T, c *capnpcwasm.Compiler, request capnpcwasm.GenerationRequest) {
	t.Helper()
	got, err := c.Generate(t.Context(), request)
	var failure *capnpcwasm.Error
	if !errors.As(err, &failure) || failure.Stage != capnpcwasm.StageValidate || !errors.Is(err, capnpcwasm.ErrInvalidRequest) {
		t.Fatalf("expected validation error, got %v", err)
	}
	if !reflect.DeepEqual(got, capnpcwasm.GenerationResult{}) {
		t.Fatal("partial validation result")
	}
}

func TestGenerateUnavailableModule(t *testing.T) {
	c, err := capnpcwasm.New(t.Context(), capnpcwasm.Modules{Compiler: wasmBytes(t, noopCommand)}, testOptions()...)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close(context.Background())
	assertGenerateValidation(t, c, capnpcwasm.GenerationRequest{Request: []byte{1}, Generators: []capnpcwasm.Language{"rust"}})
}

func TestGeneratePreservesSuccessfulDiagnostics(t *testing.T) {
	c, err := capnpcwasm.New(t.Context(), capnpcwasm.Modules{
		Compiler: wasmBytes(t, noopCommand), Generators: map[capnpcwasm.Language][]byte{"rust": wasmBytes(t, stderrCommand)},
	}, testOptions()...)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close(context.Background())
	got, err := c.Generate(t.Context(), capnpcwasm.GenerationRequest{Request: []byte{1}, Generators: []capnpcwasm.Language{"rust"}})
	if err != nil {
		t.Fatal(err)
	}
	want := []capnpcwasm.Diagnostic{{Stage: "rust", Language: "rust", Stderr: "x"}}
	if !reflect.DeepEqual(got.Diagnostics, want) {
		t.Fatalf("successful diagnostic lost: %+v", got.Diagnostics)
	}
}

func TestGenerateCancellationDuringGuestExecution(t *testing.T) {
	c, err := capnpcwasm.New(t.Context(), capnpcwasm.Modules{
		Compiler: wasmBytes(t, noopCommand), Generators: map[capnpcwasm.Language][]byte{"rust": wasmBytes(t, loopCommand)},
	}, testOptions()...)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close(context.Background())
	ctx, cancel := context.WithTimeout(t.Context(), 25*time.Millisecond)
	defer cancel()
	got, err := c.Generate(ctx, capnpcwasm.GenerationRequest{Request: []byte{1}, Generators: []capnpcwasm.Language{"rust"}})
	var failure *capnpcwasm.Error
	if !errors.Is(err, context.DeadlineExceeded) || !errors.As(err, &failure) || failure.Stage != "rust" || failure.Language != "rust" || !reflect.DeepEqual(got, capnpcwasm.GenerationResult{}) {
		t.Fatalf("cancellation: %+v, %v", got, err)
	}
}
