package capnpcwasm_test

import (
	"bytes"
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"

	capnpcwasm "capnpc-wasm/sdk/go"
)

func TestGenerate(t *testing.T) {
	modules := loadModules(t)
	compiler, err := capnpcwasm.New(t.Context(), modules)
	if err != nil {
		t.Fatal(err)
	}
	defer compiler.Close(context.Background())
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

	// A compiler that emits no request would fail Compile. Successful Generate
	// calls on this instance prove that it does not invoke the frontend.
	modules.Compiler = wasmBytes(t, noopCommand)
	generator, err := capnpcwasm.New(t.Context(), modules)
	if err != nil {
		t.Fatal(err)
	}
	defer generator.Close(context.Background())

	t.Run("compile once and generate target sets", func(t *testing.T) {
		for _, languages := range [][]string{{"cpp"}, {"rust", "go"}, {"zig"}, {"cpp", "rust", "go", "zig"}} {
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
		got, err := generator.Generate(t.Context(), capnpcwasm.GenerationRequest{Request: input, Generators: []string{"rust"}})
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
		for _, language := range []string{"cpp", "rust", "go", "zig"} {
			workers.Go(func() {
				result, err := generator.Generate(t.Context(), capnpcwasm.GenerationRequest{Request: compiled.Request, Generators: []string{language}})
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
		for _, language := range []string{"cpp", "rust", "go", "zig"} {
			for _, input := range [][]byte{{0xff, 0xff, 0xff, 0xff}, compiled.Request[:len(compiled.Request)-1]} {
				got, err := generator.Generate(t.Context(), capnpcwasm.GenerationRequest{Request: input, Generators: []string{language}})
				var failure *capnpcwasm.Error
				if !errors.As(err, &failure) || failure.Stage != "generate" || failure.Language != language || failure.Stderr == "" {
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
		got, err := generator.Generate(t.Context(), capnpcwasm.GenerationRequest{Request: request.Request, Generators: []string{"cpp", "rust", "zig", "go"}})
		var failure *capnpcwasm.Error
		if !errors.As(err, &failure) || failure.Stage != "generate" || failure.Language != "go" || failure.Stderr == "" {
			t.Fatalf("missing later generator diagnostic: %v", err)
		}
		if !reflect.DeepEqual(got, capnpcwasm.GenerationResult{}) {
			t.Fatal("earlier generator outputs escaped")
		}
		got, err = generator.Generate(t.Context(), capnpcwasm.GenerationRequest{Request: compiled.Request, Generators: []string{"go"}})
		if err != nil || !reflect.DeepEqual(got.Outputs["go"], combined.Outputs["go"]) {
			t.Fatalf("failed job contaminated next job: %v", err)
		}
	})

	t.Run("validation", func(t *testing.T) {
		for _, request := range []capnpcwasm.GenerationRequest{
			{Generators: []string{"rust"}},
			{Request: compiled.Request},
			{Request: compiled.Request, Generators: []string{"python"}},
			{Request: compiled.Request, Generators: []string{"go", "go"}},
			{Request: make([]byte, (64<<20)+1), Generators: []string{"rust"}},
		} {
			assertGenerateValidation(t, generator, request)
		}
	})

	t.Run("cancelled request", func(t *testing.T) {
		ctx, cancel := context.WithCancel(t.Context())
		cancel()
		got, err := generator.Generate(ctx, capnpcwasm.GenerationRequest{Request: compiled.Request, Generators: []string{"rust"}})
		if !errors.Is(err, context.Canceled) || !reflect.DeepEqual(got, capnpcwasm.GenerationResult{}) {
			t.Fatalf("cancellation: %+v, %v", got, err)
		}
	})
	if err := generator.Close(t.Context()); err != nil {
		t.Fatal(err)
	}
	assertGenerateValidation(t, generator, capnpcwasm.GenerationRequest{Request: compiled.Request, Generators: []string{"rust"}})
}

func assertGenerateValidation(t *testing.T, c *capnpcwasm.Compiler, request capnpcwasm.GenerationRequest) {
	t.Helper()
	got, err := c.Generate(t.Context(), request)
	var failure *capnpcwasm.Error
	if !errors.As(err, &failure) || failure.Stage != "validate" {
		t.Fatalf("expected validation error, got %v", err)
	}
	if !reflect.DeepEqual(got, capnpcwasm.GenerationResult{}) {
		t.Fatal("partial validation result")
	}
}

func TestGenerateUnavailableModule(t *testing.T) {
	c, err := capnpcwasm.New(t.Context(), capnpcwasm.Modules{Compiler: wasmBytes(t, noopCommand)})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close(context.Background())
	assertGenerateValidation(t, c, capnpcwasm.GenerationRequest{Request: []byte{1}, Generators: []string{"rust"}})
}

func TestGeneratePreservesSuccessfulDiagnostics(t *testing.T) {
	// Writes 'x' to stderr through WASI fd_write, then returns normally.
	stderrCommand := wasmBytes(t, "0061736d01000000010c0260047f7f7f7f017f60000002230116776173695f736e617073686f745f70726576696577310866645f77726974650000030201010503010001071302066d656d6f72790200065f737461727400010a0f010d00410241004101410c10001a0b0b0f010041000b09080000000100000078")
	c, err := capnpcwasm.New(t.Context(), capnpcwasm.Modules{
		Compiler: wasmBytes(t, noopCommand), Generators: map[string][]byte{"rust": stderrCommand},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close(context.Background())
	got, err := c.Generate(t.Context(), capnpcwasm.GenerationRequest{Request: []byte{1}, Generators: []string{"rust"}})
	if err != nil {
		t.Fatal(err)
	}
	want := []capnpcwasm.Diagnostic{{Stage: "generate", Language: "rust", Message: "x"}}
	if !reflect.DeepEqual(got.Diagnostics, want) {
		t.Fatalf("successful diagnostic lost: %+v", got.Diagnostics)
	}
}

func TestGenerateCancellationDuringGuestExecution(t *testing.T) {
	loop := wasmBytes(t, "0061736d01000000010401600000030201000503010001071302066d656d6f72790200065f737461727400000a0901070003400c000b0b")
	c, err := capnpcwasm.New(t.Context(), capnpcwasm.Modules{
		Compiler: wasmBytes(t, noopCommand), Generators: map[string][]byte{"rust": loop},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close(context.Background())
	ctx, cancel := context.WithTimeout(t.Context(), 25*time.Millisecond)
	defer cancel()
	got, err := c.Generate(ctx, capnpcwasm.GenerationRequest{Request: []byte{1}, Generators: []string{"rust"}})
	var failure *capnpcwasm.Error
	if !errors.Is(err, context.DeadlineExceeded) || !errors.As(err, &failure) || failure.Stage != "generate" || failure.Language != "rust" || !reflect.DeepEqual(got, capnpcwasm.GenerationResult{}) {
		t.Fatalf("cancellation: %+v, %v", got, err)
	}
}
