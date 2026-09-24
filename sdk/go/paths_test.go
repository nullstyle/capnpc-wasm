package capnpcwasm_test

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	capnpcwasm "github.com/nullstyle/capnpc-wasm/sdk/go"
)

// compilerPathFixture mirrors tests/package/compiler-path-fixture.ts, which
// the TypeScript package gate compares with the native compiler. The Go SDK
// compares the same workspace, so both SDKs produce the native bytes.
var compilerPathFixture = struct {
	files        map[string][]byte
	entrypoints  []string
	importPaths  []string
	sourcePrefix string
}{
	files: map[string][]byte{
		"workspace/app/person.capnp": []byte(`@0xece4bf9c1f867623; using Common = import "/common.capnp"; using Parent = import "../parent.capnp"; struct Person { selected @0 :Common.Value; parent @1 :Parent.Value; bytes @2 :Data = embed "../bytes.bin"; }`),
		"workspace/parent.capnp":     []byte("@0x9c9e5ec72c9f6a21; struct Value { label @0 :Text; }"),
		"workspace/bytes.bin":        {0, 128, 255, 42},
		"outside.capnp":              []byte("@0xe730e9b7daf07b13; struct Outside { value @0 :Bool; }"),
		"roots/first/common.capnp":   []byte("@0xb4bbd4e34c6f77f1; struct Value { first @0 :UInt32; }"),
		"roots/second/common.capnp":  []byte("@0xdbca7fc6b19b98a3; struct Value { second @0 :UInt64; }"),
	},
	entrypoints:  []string{"workspace/app/person.capnp", "outside.capnp"},
	importPaths:  []string{"roots/first", "roots/second"},
	sourcePrefix: "workspace",
}

// TestCompilerPathFixtureMatchesNative compiles the shared path fixture with
// both import orders and compares the canonical request with the native
// compiler run on the same files and arguments.
func TestCompilerPathFixtureMatchesNative(t *testing.T) {
	c := sharedCompiler(t)
	work := workDir(t, "go-paths-")
	for name, data := range compilerPathFixture.files {
		target := filepath.Join(work, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, data, 0644); err != nil {
			t.Fatal(err)
		}
	}
	var requests [][]byte
	for _, reverse := range []bool{false, true} {
		roots := slices.Clone(compilerPathFixture.importPaths)
		if reverse {
			slices.Reverse(roots)
		}
		got, err := c.Compile(t.Context(), capnpcwasm.Request{
			Files:        compilerPathFixture.files,
			Entrypoints:  compilerPathFixture.entrypoints,
			ImportPaths:  roots,
			SourcePrefix: compilerPathFixture.sourcePrefix,
		})
		if err != nil {
			t.Fatal(err)
		}
		if len(got.Diagnostics) != 0 {
			t.Fatalf("unexpected diagnostics: %+v", got.Diagnostics)
		}
		args := []string{"compile", "--no-standard-import"}
		for _, root := range roots {
			args = append(args, "-I"+root)
		}
		args = append(args, "--src-prefix="+compilerPathFixture.sourcePrefix, "-o-")
		args = append(args, compilerPathFixture.entrypoints...)
		nativeRequest := command(t, "capnp", work, nil, args...)
		want := command(t, "normalize-request", work, nativeRequest)
		if canonical := command(t, "normalize-request", work, got.Request); !bytes.Equal(canonical, want) {
			t.Fatalf("canonical request differs from native (reversed roots: %v)", reverse)
		}
		requests = append(requests, got.Request)
	}
	if bytes.Equal(requests[0], requests[1]) {
		t.Fatal("import root order did not change the request")
	}
}

// TestImportRootsSearchedInOrder ports the TypeScript test of the same name:
// both roots provide /dep.capnp, and the request names the field of the
// struct the compiler picked, so the first root listed must win.
func TestImportRootsSearchedInOrder(t *testing.T) {
	c := sharedCompiler(t)
	job := capnpcwasm.Request{
		Files: map[string][]byte{
			"main.capnp":       []byte(`@0xece4bf9c1f867623; using Dep = import "/dep.capnp"; struct Main { dep @0 :Dep.Value; }`),
			"first/dep.capnp":  []byte("@0x9c9e5ec72c9f6a21; struct Value { fromFirstRoot @0 :UInt8; }"),
			"second/dep.capnp": []byte("@0xb3d1a5f0c7e2d914; struct Value { fromSecondRoot @0 :UInt16; }"),
		},
		Entrypoints: []string{"main.capnp"},
	}
	text := func(roots []string) string {
		t.Helper()
		job.ImportPaths = roots
		result, err := c.Compile(t.Context(), job)
		if err != nil {
			t.Fatal(err)
		}
		return string(result.Request)
	}
	firstWins := text([]string{"first", "second"})
	if !strings.Contains(firstWins, "fromFirstRoot") || strings.Contains(firstWins, "fromSecondRoot") {
		t.Fatal("first import root was not searched first")
	}
	secondWins := text([]string{"second", "first"})
	if !strings.Contains(secondWins, "fromSecondRoot") || strings.Contains(secondWins, "fromFirstRoot") {
		t.Fatal("reversed import roots were not searched in order")
	}
	job.ImportPaths = nil
	_, err := c.Compile(t.Context(), job)
	var failure *capnpcwasm.Error
	if !errors.As(err, &failure) || failure.Stage != capnpcwasm.StageCompiler || failure.ExitCode != 1 || errors.Is(err, capnpcwasm.ErrInvalidRequest) {
		t.Fatalf("absolute import without roots: %v", err)
	}
}

// TestImportPathValidation ports the TypeScript checks on import roots and
// source prefixes. The compiler guest traps at once, so a validation error
// proves the check ran before any guest started.
func TestImportPathValidation(t *testing.T) {
	c := newCompiler(t, trapCommand, nil)
	base := func() capnpcwasm.Request {
		return capnpcwasm.Request{
			Files: map[string][]byte{
				"project/schema/a.capnp": {},
				"project/vendor/b.capnp": {},
				"shared/c.capnp":         {},
			},
			Entrypoints: []string{"project/schema/a.capnp"},
		}
	}
	for _, path := range []string{"../escape", "/absolute", "a/../b", "a\\b", "a\x00b", "a//b"} {
		req := base()
		req.SourcePrefix = path
		assertInvalid(t, c, req, "expected a canonical relative POSIX path: "+path)
		req = base()
		req.ImportPaths = []string{path}
		assertInvalid(t, c, req, "expected a canonical relative POSIX path: "+path)
	}
	for _, test := range []struct {
		name    string
		modify  func(*capnpcwasm.Request)
		message string
	}{
		{"duplicate roots", func(r *capnpcwasm.Request) { r.ImportPaths = []string{"", ""} }, "duplicate importPaths"},
		{"missing root", func(r *capnpcwasm.Request) { r.ImportPaths = []string{"nope"} }, "importPath is not a directory in files: nope"},
		{"file as root", func(r *capnpcwasm.Request) { r.ImportPaths = []string{"project/vendor/b.capnp"} }, "importPath is not a directory in files: project/vendor/b.capnp"},
		{"missing prefix", func(r *capnpcwasm.Request) { r.SourcePrefix = "nope" }, "sourcePrefix is not a directory in files: nope"},
		{"file as prefix", func(r *capnpcwasm.Request) { r.SourcePrefix = "shared/c.capnp" }, "sourcePrefix is not a directory in files: shared/c.capnp"},
		{"include directories do not qualify", func(r *capnpcwasm.Request) {
			r.IncludeFiles = map[string][]byte{"inc/x.capnp": {}}
			r.ImportPaths = []string{"inc"}
		}, "importPath is not a directory in files: inc"},
		{"root over pathBytes", func(r *capnpcwasm.Request) { r.ImportPaths = []string{strings.Repeat("a", 4097)} }, "path exceeds pathBytes limit"},
	} {
		t.Run(test.name, func(t *testing.T) {
			req := base()
			test.modify(&req)
			assertInvalid(t, c, req, test.message)
		})
	}
	// Real directories, including the root, reach the guest.
	req := base()
	req.ImportPaths = []string{"", "project/vendor", "shared"}
	req.SourcePrefix = "project"
	_, err := c.Compile(t.Context(), req)
	var failure *capnpcwasm.Error
	if !errors.As(err, &failure) || failure.Stage != capnpcwasm.StageCompiler || errors.Is(err, capnpcwasm.ErrInvalidRequest) || failure.ExitCode != 0 {
		t.Fatalf("valid roots did not reach the guest: %v", err)
	}
}

// assertInvalid checks an Error at StageValidate matching ErrInvalidRequest
// with the TypeScript SDK's message.
func assertInvalid(t *testing.T, c *capnpcwasm.Compiler, request capnpcwasm.Request, message string) *capnpcwasm.Error {
	t.Helper()
	got, err := c.Compile(t.Context(), request)
	var failure *capnpcwasm.Error
	if !errors.As(err, &failure) || failure.Stage != capnpcwasm.StageValidate || !errors.Is(err, capnpcwasm.ErrInvalidRequest) {
		t.Fatalf("expected a validation error, got %v", err)
	}
	if failure.Err.Error() != message {
		t.Fatalf("message %q, want %q", failure.Err.Error(), message)
	}
	if !reflect.DeepEqual(got, capnpcwasm.Result{}) {
		t.Fatal("partial validation result")
	}
	return failure
}

// TestCommandArguments pins the argv both SDKs pass: import roots in order
// before /include, the /src prefix and then the caller's prefix, then the
// entrypoints; generators receive only the native tool name.
func TestCommandArguments(t *testing.T) {
	c := newCompiler(t, argsCommand, map[string]string{"cpp": argsCommand, "zig": argsCommand})
	_, err := c.Compile(t.Context(), capnpcwasm.Request{
		Files:        map[string][]byte{"d/a.capnp": {}, "e/b.capnp": {}, "p/q/c.capnp": {}},
		Entrypoints:  []string{"d/a.capnp", "p/q/c.capnp"},
		ImportPaths:  []string{"", "e", "p/q"},
		SourcePrefix: "p",
	})
	var failure *capnpcwasm.Error
	if !errors.As(err, &failure) || failure.Stage != capnpcwasm.StageCompiler || failure.Stderr == "" {
		t.Fatalf("argv guest: %v", err)
	}
	want := []string{
		"capnp", "compile", "--no-standard-import",
		"-I/src", "-I/src/e", "-I/src/p/q", "-I/include",
		"--src-prefix=/src", "--src-prefix=/src/p", "-o-",
		"/src/d/a.capnp", "/src/p/q/c.capnp",
	}
	if got := strings.Split(strings.TrimSuffix(failure.Stderr, "\x00"), "\x00"); !reflect.DeepEqual(got, want) {
		t.Fatalf("compiler argv %q, want %q", got, want)
	}
	plain, err := c.Compile(t.Context(), capnpcwasm.Request{Files: map[string][]byte{"a.capnp": {}}, Entrypoints: []string{"a.capnp"}})
	if !errors.As(err, &failure) {
		t.Fatalf("argv guest: %v, %+v", err, plain)
	}
	want = []string{"capnp", "compile", "--no-standard-import", "-I/include", "--src-prefix=/src", "-o-", "/src/a.capnp"}
	if got := strings.Split(strings.TrimSuffix(failure.Stderr, "\x00"), "\x00"); !reflect.DeepEqual(got, want) {
		t.Fatalf("default compiler argv %q, want %q", got, want)
	}
	generated, err := c.Generate(t.Context(), capnpcwasm.GenerationRequest{Request: []byte{1}, Generators: []capnpcwasm.Language{"cpp", "zig"}})
	if err != nil {
		t.Fatal(err)
	}
	wantDiagnostics := []capnpcwasm.Diagnostic{
		{Stage: "cpp", Language: "cpp", Stderr: "capnpc-c++\x00"},
		{Stage: "zig", Language: "zig", Stderr: "capnpc-zig\x00"},
	}
	if !reflect.DeepEqual(generated.Diagnostics, wantDiagnostics) {
		t.Fatalf("generator argv %+v, want %+v", generated.Diagnostics, wantDiagnostics)
	}
}

// TestGuestVisiblePathLength checks that every path within pathBytes reaches
// the compiler, including the 4,092-4,096-byte range that once failed inside
// the guest with "Filename too long" because the SDK's root mirror bounded the
// absolute guest path, mount prefix included, at 4,096 bytes.
func TestGuestVisiblePathLength(t *testing.T) {
	c := sharedCompiler(t)
	include := strings.Repeat("i", 4096-len(".capnp")) + ".capnp"
	for _, n := range []int{4091, 4092, 4096} {
		name := strings.Repeat("a", n-len(".capnp")) + ".capnp"
		got, err := c.Compile(t.Context(), capnpcwasm.Request{
			Files:        map[string][]byte{name: []byte(`@0xece4bf9c1f867623; using Inc = import "/` + include + `"; struct Foo { inc @0 :Inc.Value; }`)},
			IncludeFiles: map[string][]byte{include: []byte("@0x9c9e5ec72c9f6a21; struct Value { label @0 :Text; }")},
			Entrypoints:  []string{name},
		})
		if err != nil || len(got.Request) == 0 || len(got.Diagnostics) != 0 {
			t.Fatalf("%d-byte entrypoint with a %d-byte include: %v, %+v", n, len(include), err, got.Diagnostics)
		}
	}
	name := strings.Repeat("a", 4097-len(".capnp")) + ".capnp"
	_, err := c.Compile(t.Context(), capnpcwasm.Request{Files: map[string][]byte{name: {}}, Entrypoints: []string{name}})
	failure := assertPreStartLimit(t, err, "pathBytes")
	if failure.Err.Error() != "path exceeds pathBytes limit" {
		t.Fatalf("4097-byte path: %v", failure.Err)
	}
}
