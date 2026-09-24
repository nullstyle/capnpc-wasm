package capnpcwasm_test

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"

	capnpcwasm "github.com/nullstyle/capnpc-wasm/sdk/go"
)

var allLanguages = []capnpcwasm.Language{"cpp", "rust", "go", "zig"}

func fixture(t testing.TB) capnpcwasm.Request {
	r := root(t)
	return capnpcwasm.Request{
		Files: map[string][]byte{
			"person.capnp":       read(t, r+"/tests/fixtures/schemas/person.capnp"),
			"types/common.capnp": read(t, r+"/tests/fixtures/schemas/types/common.capnp"),
		},
		IncludeFiles: map[string][]byte{
			"capnp/c++.capnp": read(t, r+"/ref/capnproto/c++/src/capnp/c++.capnp"),
			"go.capnp":        read(t, r+"/ref/go-capnp/std/go.capnp"),
		},
		Entrypoints: []string{"person.capnp", "types/common.capnp"},
		Generators:  []capnpcwasm.Language{"cpp", "rust", "go", "zig"},
	}
}

func command(t *testing.T, name, cwd string, input []byte, args ...string) []byte {
	t.Helper()
	cmd := exec.CommandContext(t.Context(), native(t, name), args...)
	cmd.Dir = cwd
	cmd.Stdin = bytes.NewReader(input)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("%s: %v: %s", name, err, stderr.String())
	}
	return out
}

func outputFiles(t *testing.T, dir string) map[string][]byte {
	t.Helper()
	result := map[string][]byte{}
	if err := filepath.WalkDir(dir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.IsDir() {
			name, err := filepath.Rel(dir, path)
			if err != nil {
				return err
			}
			result[filepath.ToSlash(name)] = read(t, path)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestCompiler(t *testing.T) {
	r := root(t)
	c := sharedCompiler(t)
	request := fixture(t)
	actual, err := c.Compile(t.Context(), request)
	if err != nil {
		t.Fatal(err)
	}
	if len(actual.Diagnostics) != 0 {
		t.Fatalf("unexpected diagnostics: %+v", actual.Diagnostics)
	}

	t.Run("native parity", func(t *testing.T) {
		schemas := r + "/tests/fixtures/schemas"
		nativeRequest := command(t, "capnp", r, nil, "compile", "--no-standard-import", "-I"+r+"/ref/capnproto/c++/src", "-I"+r+"/ref/go-capnp/std", "--src-prefix="+schemas, "-o-", schemas+"/person.capnp", schemas+"/types/common.capnp")
		wantRequest := command(t, "normalize-request", r, nativeRequest)
		gotRequest := command(t, "normalize-request", r, actual.Request)
		if !bytes.Equal(gotRequest, wantRequest) {
			t.Fatal("canonical compiler request differs from native")
		}
		work := workDir(t, "go-sdk-")
		for _, language := range request.Generators {
			dir := work + "/" + string(language)
			if err := os.Mkdir(dir, 0755); err != nil {
				t.Fatal(err)
			}
			// The SDK runs each generator under the native tool's name.
			command(t, capnpcwasm.Argv0(language), dir, nativeRequest)
			want := outputFiles(t, dir)
			if !reflect.DeepEqual(actual.Outputs[language], want) {
				t.Errorf("%s source differs from native", language)
			}
		}
	})

	t.Run("concurrent isolated jobs", func(t *testing.T) {
		var workers sync.WaitGroup
		for range 3 {
			workers.Go(func() {
				got, err := c.Compile(t.Context(), request)
				if err != nil {
					t.Error(err)
					return
				}
				if !reflect.DeepEqual(got.Outputs, actual.Outputs) {
					t.Error("concurrent output differs")
				}
			})
		}
		workers.Wait()
		actual.Outputs["rust"]["person_capnp.rs"][0] ^= 1
		again, err := c.Compile(t.Context(), request)
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Equal(again.Outputs["rust"]["person_capnp.rs"], actual.Outputs["rust"]["person_capnp.rs"]) {
			t.Fatal("result aliases another job")
		}
	})

	t.Run("compiler only and Unicode entrypoint", func(t *testing.T) {
		req := fixture(t)
		req.Generators = nil
		req.Files["pérson-🦀.capnp"] = req.Files["person.capnp"]
		req.Entrypoints[0] = "pérson-🦀.capnp"
		got, err := c.Compile(t.Context(), req)
		if err != nil {
			t.Fatal(err)
		}
		if len(got.Request) == 0 || len(got.Outputs) != 0 {
			t.Fatal("unexpected compiler-only result")
		}
	})

	t.Run("schema failure discards result", func(t *testing.T) {
		req := fixture(t)
		req.Files["person.capnp"] = []byte("invalid schema")
		got, err := c.Compile(t.Context(), req)
		var failure *capnpcwasm.Error
		if !errors.As(err, &failure) || failure.Stage != capnpcwasm.StageCompiler || failure.Stderr == "" {
			t.Fatalf("missing diagnostic: %v", err)
		}
		if !reflect.DeepEqual(got, capnpcwasm.Result{}) {
			t.Fatal("partial result on error")
		}
	})

	t.Run("later generator failure discards all outputs", func(t *testing.T) {
		req := fixture(t)
		req.Generators = []capnpcwasm.Language{"cpp", "rust", "zig", "go"}
		req.Files["person.capnp"] = bytes.Replace(req.Files["person.capnp"], []byte(`$Go.package("fixture");`), nil, 1)
		got, err := c.Compile(t.Context(), req)
		var failure *capnpcwasm.Error
		if !errors.As(err, &failure) || failure.Stage != "go" || failure.Language != "go" || failure.Stderr == "" {
			t.Fatalf("missing generator diagnostic: %v", err)
		}
		if !reflect.DeepEqual(got, capnpcwasm.Result{}) {
			t.Fatal("earlier generator output escaped on failure")
		}
	})

	t.Run("validation", func(t *testing.T) {
		for _, name := range []string{"", "/absolute", "../escape", "dir/../escape", "./file", "dir//file", "dir/", "bad\\file", "bad\x00file", string([]byte{0xff})} {
			t.Run(name, func(t *testing.T) {
				req := fixture(t)
				req.Files[name] = []byte{}
				assertValidation(t, c, req)
				req = fixture(t)
				req.IncludeFiles[name] = []byte{}
				assertValidation(t, c, req)
			})
		}
		for _, modify := range []func(*capnpcwasm.Request){
			func(r *capnpcwasm.Request) { r.Entrypoints = nil },
			func(r *capnpcwasm.Request) { r.Entrypoints = []string{"missing.capnp"} },
			func(r *capnpcwasm.Request) { r.Entrypoints = []string{"person.capnp", "person.capnp"} },
			func(r *capnpcwasm.Request) { r.Generators = []capnpcwasm.Language{"python"} },
			func(r *capnpcwasm.Request) { r.Generators = []capnpcwasm.Language{"go", "go"} },
			func(r *capnpcwasm.Request) { r.Files["types"] = []byte{} },
		} {
			req := fixture(t)
			modify(&req)
			assertValidation(t, c, req)
		}
	})

	t.Run("cancelled request", func(t *testing.T) {
		ctx, cancel := context.WithCancel(t.Context())
		cancel()
		got, err := c.Compile(ctx, request)
		if !errors.Is(err, context.Canceled) || errors.Is(err, capnpcwasm.ErrInvalidRequest) || !reflect.DeepEqual(got, capnpcwasm.Result{}) {
			t.Fatalf("cancellation: %+v, %v", got, err)
		}
	})
}

// assertValidation checks the contract for rejected caller input: an Error at
// StageValidate that matches ErrInvalidRequest, and no result.
func assertValidation(t *testing.T, c *capnpcwasm.Compiler, request capnpcwasm.Request) {
	t.Helper()
	got, err := c.Compile(t.Context(), request)
	var failure *capnpcwasm.Error
	if !errors.As(err, &failure) || failure.Stage != capnpcwasm.StageValidate || !errors.Is(err, capnpcwasm.ErrInvalidRequest) {
		t.Fatalf("expected validation error, got %v", err)
	}
	if !reflect.DeepEqual(got, capnpcwasm.Result{}) {
		t.Fatal("partial validation result")
	}
}

func TestCancellationDuringGuestExecution(t *testing.T) {
	// (module (memory (export "memory") 1) (func (export "_start") (loop br 0)))
	loop := wasmBytes(t, "0061736d01000000010401600000030201000503010001071302066d656d6f72790200065f737461727400000a0901070003400c000b0b")
	c, err := capnpcwasm.New(t.Context(), capnpcwasm.Modules{Compiler: loop}, testOptions()...)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close(context.Background())
	ctx, cancel := context.WithTimeout(t.Context(), 25*time.Millisecond)
	defer cancel()
	got, err := c.Compile(ctx, capnpcwasm.Request{Files: map[string][]byte{"test.capnp": {}}, Entrypoints: []string{"test.capnp"}})
	if !errors.Is(err, context.DeadlineExceeded) || !reflect.DeepEqual(got, capnpcwasm.Result{}) {
		t.Fatalf("cancellation: %+v, %v", got, err)
	}
}

const noopCommand = "0061736d01000000010401600000030201000503010001071302066d656d6f72790200065f737461727400000a040102000b"

func wasmBytes(t testing.TB, encoded string) []byte {
	t.Helper()
	data, err := hex.DecodeString(encoded)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestCommandContractValidation(t *testing.T) {
	for _, guest := range []struct{ name, encoded string }{
		{"no exports", "0061736d01000000"},
		{"missing memory", "0061736d0100000001040160000003020100070a01065f737461727400000a040102000b"},
		{"missing start", "0061736d010000000503010001070a01066d656d6f72790200"},
		{"start with parameter", "0061736d0100000001050160017f00030201000503010001071302066d656d6f72790200065f737461727400000a040102000b"},
		{"start with result", "0061736d010000000105016000017f030201000503010001071302066d656d6f72790200065f737461727400000a0601040041000b"},
	} {
		t.Run(guest.name, func(t *testing.T) {
			for _, language := range []capnpcwasm.Language{"", "rust"} {
				modules := capnpcwasm.Modules{Compiler: wasmBytes(t, guest.encoded)}
				if language != "" {
					modules = capnpcwasm.Modules{Compiler: wasmBytes(t, noopCommand), Generators: map[capnpcwasm.Language][]byte{language: wasmBytes(t, guest.encoded)}}
				}
				c, err := capnpcwasm.New(t.Context(), modules, testOptions()...)
				if c != nil {
					_ = c.Close(context.Background())
				}
				var failure *capnpcwasm.Error
				if c != nil || !errors.As(err, &failure) || failure.Stage != capnpcwasm.StageModules || failure.Language != language || !errors.Is(err, capnpcwasm.ErrInvalidRequest) {
					t.Fatalf("invalid %q command accepted: %v, %v", language, c, err)
				}
			}
		})
	}
}

func TestEmptyCompilerOutputFails(t *testing.T) {
	c, err := capnpcwasm.New(t.Context(), capnpcwasm.Modules{Compiler: wasmBytes(t, noopCommand)}, testOptions()...)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close(context.Background())
	got, err := c.Compile(t.Context(), capnpcwasm.Request{Files: map[string][]byte{"test.capnp": {}}, Entrypoints: []string{"test.capnp"}})
	var failure *capnpcwasm.Error
	if !errors.As(err, &failure) || failure.Stage != capnpcwasm.StageCompiler || failure.ExitCode != 0 || !reflect.DeepEqual(got, capnpcwasm.Result{}) {
		t.Fatalf("empty compiler output accepted: %+v, %v", got, err)
	}
}

func TestModuleValidation(t *testing.T) {
	for _, modules := range []capnpcwasm.Modules{
		{},
		{Compiler: []byte("not wasm")},
		{Compiler: []byte("not wasm"), Generators: map[capnpcwasm.Language][]byte{"python": {1}}},
		{Compiler: []byte("not wasm"), Generators: map[capnpcwasm.Language][]byte{"rust": nil}},
	} {
		c, err := capnpcwasm.New(t.Context(), modules, testOptions()...)
		var failure *capnpcwasm.Error
		if c != nil || !errors.As(err, &failure) || failure.Stage != capnpcwasm.StageModules || !errors.Is(err, capnpcwasm.ErrInvalidRequest) {
			t.Fatalf("invalid modules accepted: %v, %v", c, err)
		}
	}
}
