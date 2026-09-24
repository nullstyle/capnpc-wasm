package capnpcwasm_test

import (
	"context"
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"

	capnpcwasm "github.com/nullstyle/capnpc-wasm/sdk/go"
)

// TestInvalidSchemasExitOne mirrors the TypeScript and conformance checks: an
// invalid schema is a compiler exit 1 with clean diagnostics, no engine or
// host text, and no result.
func TestInvalidSchemasExitOne(t *testing.T) {
	c := sharedCompiler(t)
	r := root(t)
	entries, err := os.ReadDir(r + "/tests/fixtures/invalid")
	if err != nil {
		unavailable(t, err)
	}
	count := 0
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".capnp") {
			continue
		}
		count++
		got, err := c.Compile(t.Context(), capnpcwasm.Request{
			Files:       map[string][]byte{entry.Name(): read(t, r+"/tests/fixtures/invalid/"+entry.Name())},
			Entrypoints: []string{entry.Name()},
			Generators:  []capnpcwasm.Language{"cpp"},
		})
		var failure *capnpcwasm.Error
		if !errors.As(err, &failure) || failure.Stage != capnpcwasm.StageCompiler || failure.Language != "" || failure.ExitCode != 1 || failure.Limit != "" {
			t.Fatalf("%s: %v", entry.Name(), err)
		}
		if errors.Is(err, capnpcwasm.ErrInvalidRequest) || errors.Is(err, capnpcwasm.ErrLimitExceeded) || errors.Is(err, capnpcwasm.ErrClosed) {
			t.Fatalf("%s: guest failure matched a sentinel: %v", entry.Name(), err)
		}
		if len(failure.Diagnostics) == 0 || failure.Diagnostics[0].Stage != capnpcwasm.StageCompiler || failure.Diagnostics[0].Stderr != failure.Stderr {
			t.Fatalf("%s: diagnostics %+v", entry.Name(), failure.Diagnostics)
		}
		if strings.Contains(failure.Stderr, "wasm error") || strings.Contains(failure.Stderr, "wasm stack trace") || strings.Contains(failure.Stderr, r) {
			t.Fatalf("%s: diagnostics leak engine or host text: %q", entry.Name(), failure.Stderr)
		}
		if !reflect.DeepEqual(got, capnpcwasm.Result{}) {
			t.Fatalf("%s: result published", entry.Name())
		}
	}
	if count < 4 {
		t.Fatal("invalid fixtures are missing")
	}
}

// TestMalformedRequestsExitOne checks that a malformed request is a
// generator exit 1 at the generator's stage, with its stderr, and no outputs.
func TestMalformedRequestsExitOne(t *testing.T) {
	c := sharedCompiler(t)
	workspace := fixture(t)
	workspace.Generators = nil
	compiled, err := c.Compile(t.Context(), workspace)
	if err != nil {
		t.Fatal(err)
	}
	for _, language := range allLanguages {
		for name, request := range map[string][]byte{
			"truncated":             compiled.Request[:12],
			"invalid segment table": {255, 255, 255, 255, 0, 0, 0, 0},
		} {
			got, err := c.Generate(t.Context(), capnpcwasm.GenerationRequest{Request: request, Generators: []capnpcwasm.Language{language}})
			var failure *capnpcwasm.Error
			if !errors.As(err, &failure) || failure.Stage != capnpcwasm.Stage(language) || failure.Language != language || failure.ExitCode != 1 || failure.Limit != "" {
				t.Fatalf("%s %s: %v", language, name, err)
			}
			if len(failure.Diagnostics) != 1 || failure.Diagnostics[0].Language != language || failure.Diagnostics[0].Stderr == "" || failure.Diagnostics[0].Stderr != failure.Stderr {
				t.Fatalf("%s %s: diagnostics %+v", language, name, failure.Diagnostics)
			}
			if !reflect.DeepEqual(got, capnpcwasm.GenerationResult{}) {
				t.Fatalf("%s %s: outputs published", language, name)
			}
		}
	}
}

// TestFailureKindsFromGuests pins ExitCode and Limit for exits, traps, and
// contract violations.
func TestFailureKindsFromGuests(t *testing.T) {
	c := newCompiler(t, noopCommand, map[string]string{"cpp": exitCommand, "rust": trapCommand, "go": stdoutCommand})
	for _, test := range []struct {
		language capnpcwasm.Language
		exitCode int
		message  string
	}{
		{"cpp", 1, "exited with status 1"},
		{"rust", 0, ""},
		{"go", 0, "generator unexpectedly wrote to stdout"},
	} {
		_, err := c.Generate(t.Context(), capnpcwasm.GenerationRequest{Request: []byte{1}, Generators: []capnpcwasm.Language{test.language}})
		var failure *capnpcwasm.Error
		if !errors.As(err, &failure) || failure.Stage != capnpcwasm.Stage(test.language) || failure.Language != test.language || failure.ExitCode != test.exitCode || failure.Limit != "" {
			t.Fatalf("%s: %#v (%v)", test.language, failure, err)
		}
		if test.message != "" && failure.Err.Error() != test.message {
			t.Fatalf("%s: message %q, want %q", test.language, failure.Err, test.message)
		}
		if errors.Is(err, capnpcwasm.ErrInvalidRequest) || errors.Is(err, capnpcwasm.ErrLimitExceeded) {
			t.Fatalf("%s: guest failure matched a sentinel: %v", test.language, err)
		}
	}
}

// TestErrorKeepsEarlierDiagnostics checks that a failure carries every stage's
// stderr so far in order, as the TypeScript CompileError does: the compiler's
// warning, a successful generator's warning, then the failing generator.
func TestErrorKeepsEarlierDiagnostics(t *testing.T) {
	c := newCompiler(t, stdoutStderrCommand, map[string]string{"rust": stderrCommand, "cpp": exitCommand, "zig": stderrCommand})
	got, err := c.Compile(t.Context(), capnpcwasm.Request{
		Files: map[string][]byte{"a.capnp": {}}, Entrypoints: []string{"a.capnp"},
		Generators: []capnpcwasm.Language{"rust", "cpp", "zig"},
	})
	var failure *capnpcwasm.Error
	if !errors.As(err, &failure) || failure.Stage != "cpp" || failure.ExitCode != 1 || !reflect.DeepEqual(got, capnpcwasm.Result{}) {
		t.Fatalf("later generator failure: %v", err)
	}
	want := []capnpcwasm.Diagnostic{
		{Stage: capnpcwasm.StageCompiler, Stderr: "w"},
		{Stage: "rust", Language: "rust", Stderr: "x"},
	}
	if !reflect.DeepEqual(failure.Diagnostics, want) || failure.Stderr != "" {
		t.Fatalf("diagnostics %+v, want %+v (failing stage stderr %q)", failure.Diagnostics, want, failure.Stderr)
	}
	// A successful job reports the same list plus the later stages.
	result, err := c.Compile(t.Context(), capnpcwasm.Request{
		Files: map[string][]byte{"a.capnp": {}}, Entrypoints: []string{"a.capnp"},
		Generators: []capnpcwasm.Language{"rust", "zig"},
	})
	if err != nil {
		t.Fatal(err)
	}
	want = append(want, capnpcwasm.Diagnostic{Stage: "zig", Language: "zig", Stderr: "x"})
	if !reflect.DeepEqual(result.Diagnostics, want) || string(result.Request) != "x" {
		t.Fatalf("diagnostics %+v, want %+v", result.Diagnostics, want)
	}
	// Generate starts its own list.
	generated, err := c.Generate(t.Context(), capnpcwasm.GenerationRequest{Request: []byte{1}, Generators: []capnpcwasm.Language{"zig", "cpp"}})
	if !errors.As(err, &failure) || !reflect.DeepEqual(failure.Diagnostics, []capnpcwasm.Diagnostic{{Stage: "zig", Language: "zig", Stderr: "x"}}) || !reflect.DeepEqual(generated, capnpcwasm.GenerationResult{}) {
		t.Fatalf("Generate diagnostics: %+v (%v)", failure.Diagnostics, err)
	}
}

// TestSentinelsAreDisjoint checks that each sentinel matches only its own
// class of failure.
func TestSentinelsAreDisjoint(t *testing.T) {
	c := newCompiler(t, trapCommand, nil)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	_, err := c.Compile(ctx, compileOnly())
	if !errors.Is(err, context.Canceled) || errors.Is(err, capnpcwasm.ErrInvalidRequest) || errors.Is(err, capnpcwasm.ErrLimitExceeded) || errors.Is(err, capnpcwasm.ErrClosed) {
		t.Fatalf("cancellation: %v", err)
	}
	_, err = c.Compile(t.Context(), capnpcwasm.Request{})
	if !errors.Is(err, capnpcwasm.ErrInvalidRequest) || errors.Is(err, capnpcwasm.ErrLimitExceeded) || errors.Is(err, capnpcwasm.ErrClosed) {
		t.Fatalf("invalid input: %v", err)
	}
	_, err = c.Compile(t.Context(), compileOnly())
	if errors.Is(err, capnpcwasm.ErrInvalidRequest) || errors.Is(err, capnpcwasm.ErrLimitExceeded) || errors.Is(err, capnpcwasm.ErrClosed) {
		t.Fatalf("trap: %v", err)
	}
	if err := c.Close(t.Context()); err != nil {
		t.Fatal(err)
	}
	_, err = c.Compile(t.Context(), compileOnly())
	if !errors.Is(err, capnpcwasm.ErrClosed) || errors.Is(err, capnpcwasm.ErrInvalidRequest) || errors.Is(err, capnpcwasm.ErrLimitExceeded) {
		t.Fatalf("closed: %v", err)
	}
}

// TestErrorMessages pins the rendered messages: the stage, the generator
// where one applies, the underlying error, and trimmed stderr.
func TestErrorMessages(t *testing.T) {
	for _, test := range []struct {
		err  *capnpcwasm.Error
		want string
	}{
		{&capnpcwasm.Error{Stage: capnpcwasm.StageValidate, Err: errors.New("at least one entrypoint is required")}, "capnpc-wasm validate: at least one entrypoint is required"},
		{&capnpcwasm.Error{Stage: capnpcwasm.StageCompiler, ExitCode: 1, Stderr: "error\n", Err: errors.New("exited with status 1")}, "capnpc-wasm compiler: exited with status 1: error"},
		{&capnpcwasm.Error{Stage: "cpp", Language: "cpp", Limit: "outputBytes", Err: errors.New("outputBytes resource limit exceeded")}, "capnpc-wasm cpp generator: outputBytes resource limit exceeded"},
		{&capnpcwasm.Error{Stage: capnpcwasm.StageModules, Language: "rust", Err: errors.New("unknown generator or empty module")}, "capnpc-wasm modules (rust): unknown generator or empty module"},
	} {
		if got := test.err.Error(); got != test.want {
			t.Errorf("Error() = %q, want %q", got, test.want)
		}
	}
}
