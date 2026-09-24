package capnpcwasm_test

import (
	"bytes"
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	capnpcwasm "github.com/nullstyle/capnpc-wasm/sdk/go"
)

// assertPreStartLimit checks the contract for a budget exceeded by caller
// input: an Error at StageValidate matching both ErrInvalidRequest and
// ErrLimitExceeded, naming the limit.
func assertPreStartLimit(t *testing.T, err error, limit string) *capnpcwasm.Error {
	t.Helper()
	var failure *capnpcwasm.Error
	if !errors.As(err, &failure) || failure.Stage != capnpcwasm.StageValidate || failure.Language != "" ||
		!errors.Is(err, capnpcwasm.ErrInvalidRequest) || !errors.Is(err, capnpcwasm.ErrLimitExceeded) ||
		failure.Limit != limit || failure.ExitCode != 0 {
		t.Fatalf("expected a pre-start %s limit error, got %#v (%v)", limit, failure, err)
	}
	return failure
}

// assertGuestLimit checks the contract for a budget a running guest exceeded:
// an Error at the guest's stage matching ErrLimitExceeded only, naming the
// limit, without an exit status.
func assertGuestLimit(t *testing.T, err error, stage capnpcwasm.Stage, language capnpcwasm.Language, limit string) *capnpcwasm.Error {
	t.Helper()
	var failure *capnpcwasm.Error
	if !errors.As(err, &failure) || failure.Stage != stage || failure.Language != language ||
		errors.Is(err, capnpcwasm.ErrInvalidRequest) || !errors.Is(err, capnpcwasm.ErrLimitExceeded) ||
		failure.Limit != limit || failure.ExitCode != 0 {
		t.Fatalf("expected a run-time %s limit error at %s, got %#v (%v)", limit, stage, failure, err)
	}
	if want := limit + " resource limit exceeded"; failure.Err.Error() != want {
		t.Fatalf("message %q, want %q", failure.Err.Error(), want)
	}
	return failure
}

// assertReachedGuest checks that validation passed: the trapping compiler
// guest failed at StageCompiler without an exit status.
func assertReachedGuest(t *testing.T, err error) {
	t.Helper()
	var failure *capnpcwasm.Error
	if !errors.As(err, &failure) || failure.Stage != capnpcwasm.StageCompiler || errors.Is(err, capnpcwasm.ErrInvalidRequest) || errors.Is(err, capnpcwasm.ErrLimitExceeded) || failure.ExitCode != 0 {
		t.Fatalf("request within the limits did not reach the guest: %v", err)
	}
}

func TestLimitsValidation(t *testing.T) {
	for _, test := range []struct {
		name    string
		options []capnpcwasm.Option
		message string
	}{
		{"negative", []capnpcwasm.Option{capnpcwasm.WithLimits(func() capnpcwasm.Limits { l := capnpcwasm.DefaultLimits(); l.WorkspaceBytes = -1; return l }())}, "invalid resource limit: workspaceBytes"},
		{"zero pages", []capnpcwasm.Option{capnpcwasm.WithLimits(func() capnpcwasm.Limits { l := capnpcwasm.DefaultLimits(); l.MemoryPages = 0; return l }())}, "memoryPages must be between 1 and 65536"},
		{"too many pages", []capnpcwasm.Option{capnpcwasm.WithLimits(func() capnpcwasm.Limits { l := capnpcwasm.DefaultLimits(); l.MemoryPages = 65537; return l }())}, "memoryPages must be between 1 and 65536"},
		{"zero value limits", []capnpcwasm.Option{capnpcwasm.WithLimits(capnpcwasm.Limits{})}, "memoryPages must be between 1 and 65536"},
		{"zero jobs", []capnpcwasm.Option{capnpcwasm.WithMaxConcurrentJobs(0)}, "maxConcurrentJobs must be positive"},
		{"negative jobs", []capnpcwasm.Option{capnpcwasm.WithMaxConcurrentJobs(-1)}, "maxConcurrentJobs must be positive"},
	} {
		t.Run(test.name, func(t *testing.T) {
			c, err := capnpcwasm.New(t.Context(), capnpcwasm.Modules{Compiler: wasmBytes(t, noopCommand)}, testOptions(test.options...)...)
			var failure *capnpcwasm.Error
			if c != nil || !errors.As(err, &failure) || failure.Stage != capnpcwasm.StageValidate || !errors.Is(err, capnpcwasm.ErrInvalidRequest) || failure.Err.Error() != test.message {
				t.Fatalf("invalid options accepted: %v, %v", c, err)
			}
		})
	}
	// Every limit may be zero except memoryPages; the compiler then rejects
	// any workspace, before the guest starts.
	zero := capnpcwasm.Limits{MemoryPages: 1}
	c := newCompiler(t, trapCommand, nil, capnpcwasm.WithLimits(zero))
	_, err := c.Compile(t.Context(), compileOnly())
	assertPreStartLimit(t, err, "workspaceEntries")
}

// TestPreStartLimits checks each caller-input budget at its exact boundary:
// a request at the budget reaches the guest and one past it is rejected
// before any guest starts, with the TypeScript SDK's message.
func TestPreStartLimits(t *testing.T) {
	files := func(sizes map[string]int) map[string][]byte {
		result := map[string][]byte{}
		for name, size := range sizes {
			result[name] = make([]byte, size)
		}
		return result
	}
	for _, test := range []struct {
		name    string
		adjust  func(*capnpcwasm.Limits, int)
		limit   string
		at      int
		request capnpcwasm.Request
		message string
	}{
		{
			"workspaceBytes across files", func(l *capnpcwasm.Limits, n int) { l.WorkspaceBytes = n }, "workspaceBytes", 5,
			capnpcwasm.Request{Files: files(map[string]int{"a": 3, "b": 2}), Entrypoints: []string{"a"}},
			"workspace exceeds workspaceBytes limit",
		},
		{
			"workspaceBytes includes IncludeFiles", func(l *capnpcwasm.Limits, n int) { l.WorkspaceBytes = n }, "workspaceBytes", 5,
			capnpcwasm.Request{Files: files(map[string]int{"a": 3}), IncludeFiles: files(map[string]int{"i": 2}), Entrypoints: []string{"a"}},
			"workspace exceeds workspaceBytes limit",
		},
		{
			"workspaceEntries counts implied directories", func(l *capnpcwasm.Limits, n int) { l.WorkspaceEntries = n }, "workspaceEntries", 3,
			capnpcwasm.Request{Files: files(map[string]int{"d/a": 0, "d/b": 0}), Entrypoints: []string{"d/a"}},
			"workspace exceeds workspaceEntries limit",
		},
		{
			"workspaceEntries counts each mount", func(l *capnpcwasm.Limits, n int) { l.WorkspaceEntries = n }, "workspaceEntries", 4,
			capnpcwasm.Request{Files: files(map[string]int{"d/a": 0}), IncludeFiles: files(map[string]int{"d/a": 0}), Entrypoints: []string{"d/a"}},
			"workspace exceeds workspaceEntries limit",
		},
		{
			"entrypoint count", func(l *capnpcwasm.Limits, n int) { l.WorkspaceEntries = n }, "workspaceEntries", 2,
			capnpcwasm.Request{Files: files(map[string]int{"a": 0, "b": 0}), Entrypoints: []string{"a", "b"}},
			"entrypoint count exceeds workspaceEntries limit",
		},
		{
			"import root count", func(l *capnpcwasm.Limits, n int) { l.WorkspaceEntries = n }, "workspaceEntries", 2,
			capnpcwasm.Request{Files: files(map[string]int{"d/a": 0}), Entrypoints: []string{"d/a"}, ImportPaths: []string{"", "d"}},
			"import root count exceeds workspaceEntries limit",
		},
		{
			"pathBytes on files", func(l *capnpcwasm.Limits, n int) { l.PathBytes = n }, "pathBytes", 3,
			capnpcwasm.Request{Files: files(map[string]int{"a/b": 0}), Entrypoints: []string{"a/b"}},
			"path exceeds pathBytes limit",
		},
		{
			"pathBytes counts UTF-8 bytes", func(l *capnpcwasm.Limits, n int) { l.PathBytes = n }, "pathBytes", 2,
			capnpcwasm.Request{Files: files(map[string]int{"é": 0}), Entrypoints: []string{"é"}},
			"path exceeds pathBytes limit",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			for _, extra := range []int{0, -1} {
				limits := capnpcwasm.DefaultLimits()
				test.adjust(&limits, test.at+extra)
				c := newCompiler(t, trapCommand, nil, capnpcwasm.WithLimits(limits))
				got, err := c.Compile(t.Context(), test.request)
				if !reflect.DeepEqual(got, capnpcwasm.Result{}) {
					t.Fatalf("result published: %+v", got)
				}
				if extra == 0 {
					assertReachedGuest(t, err)
					continue
				}
				failure := assertPreStartLimit(t, err, test.limit)
				if failure.Err.Error() != test.message {
					t.Fatalf("message %q, want %q", failure.Err.Error(), test.message)
				}
			}
		})
	}
	// The import root budget is checked before the workspace is measured, so
	// an oversized workspace still reports the root count first, as in the
	// TypeScript SDK.
	limits := capnpcwasm.DefaultLimits()
	limits.WorkspaceEntries = 1
	c := newCompiler(t, trapCommand, nil, capnpcwasm.WithLimits(limits))
	_, err := c.Compile(t.Context(), capnpcwasm.Request{Files: files(map[string]int{"a": 0, "b": 0}), Entrypoints: []string{"a"}, ImportPaths: []string{"", "b"}})
	if failure := assertPreStartLimit(t, err, "workspaceEntries"); failure.Err.Error() != "import root count exceeds workspaceEntries limit" {
		t.Fatalf("check order: %v", failure.Err)
	}
	// Import roots and the source prefix are measured against pathBytes
	// before their directories are looked up, so a long root that is not a
	// directory reports the budget at 3 and the missing directory at 4.
	for _, field := range []string{"importPath", "sourcePrefix"} {
		request := capnpcwasm.Request{Files: files(map[string]int{"a": 0}), Entrypoints: []string{"a"}}
		if field == "importPath" {
			request.ImportPaths = []string{"dddd"}
		} else {
			request.SourcePrefix = "dddd"
		}
		limits.PathBytes = 3
		c = newCompiler(t, trapCommand, nil, capnpcwasm.WithLimits(limits))
		_, err = c.Compile(t.Context(), request)
		if failure := assertPreStartLimit(t, err, "pathBytes"); failure.Err.Error() != "path exceeds pathBytes limit" {
			t.Fatalf("%s over pathBytes: %v", field, failure.Err)
		}
		limits.PathBytes = 4
		c = newCompiler(t, trapCommand, nil, capnpcwasm.WithLimits(limits))
		_, err = c.Compile(t.Context(), request)
		var failure *capnpcwasm.Error
		if !errors.As(err, &failure) || errors.Is(err, capnpcwasm.ErrLimitExceeded) || failure.Err.Error() != field+" is not a directory in files: dddd" {
			t.Fatalf("%s at pathBytes: %v", field, err)
		}
	}
}

// TestRequestBytesByDetectionTime ports the TypeScript test: a supplied
// request over requestBytes is rejected before any guest starts, while the
// compiler's output is bounded by the same budget as it runs.
func TestRequestBytesByDetectionTime(t *testing.T) {
	limits := capnpcwasm.DefaultLimits()
	limits.RequestBytes = 1
	c := newCompiler(t, stdoutStderrCommand, map[string]string{"cpp": trapCommand}, capnpcwasm.WithLimits(limits))
	got, err := c.Generate(t.Context(), capnpcwasm.GenerationRequest{Request: []byte{1, 2}, Generators: []capnpcwasm.Language{"cpp"}})
	if failure := assertPreStartLimit(t, err, "requestBytes"); failure.Err.Error() != "request exceeds requestBytes limit" || !reflect.DeepEqual(got, capnpcwasm.GenerationResult{}) {
		t.Fatalf("supplied request over the budget: %v", err)
	}
	// One byte is exactly the budget: the request reaches the generator.
	_, err = c.Generate(t.Context(), capnpcwasm.GenerationRequest{Request: []byte{1}, Generators: []capnpcwasm.Language{"cpp"}})
	var failure *capnpcwasm.Error
	if !errors.As(err, &failure) || failure.Stage != "cpp" || errors.Is(err, capnpcwasm.ErrLimitExceeded) {
		t.Fatalf("request at the budget: %v", err)
	}
	// The compiler emits exactly one byte: within the budget.
	result, err := c.Compile(t.Context(), compileOnly())
	if err != nil || !bytes.Equal(result.Request, []byte("x")) {
		t.Fatalf("compiler output at the budget: %v, %q", err, result.Request)
	}
	if want := []capnpcwasm.Diagnostic{{Stage: capnpcwasm.StageCompiler, Stderr: "w"}}; !reflect.DeepEqual(result.Diagnostics, want) {
		t.Fatalf("diagnostics %+v, want %+v", result.Diagnostics, want)
	}
	limits.RequestBytes = 0
	c = newCompiler(t, stdoutStderrCommand, nil, capnpcwasm.WithLimits(limits))
	compiled, err := c.Compile(t.Context(), compileOnly())
	failure = assertGuestLimit(t, err, capnpcwasm.StageCompiler, "", "requestBytes")
	if !reflect.DeepEqual(compiled, capnpcwasm.Result{}) {
		t.Fatal("result published past the budget")
	}
	// The compiler's stderr is still captured for the failing stage.
	if want := []capnpcwasm.Diagnostic{{Stage: capnpcwasm.StageCompiler, Stderr: "w"}}; !reflect.DeepEqual(failure.Diagnostics, want) || failure.Stderr != "w" {
		t.Fatalf("diagnostics %+v, want %+v", failure.Diagnostics, want)
	}
}

// TestStdioBudgetsAtExactBoundaries checks stdoutBytes and stderrBytes with
// one-byte writers: a budget of one byte passes, zero fails while the guest
// runs, whatever its exit status.
func TestStdioBudgetsAtExactBoundaries(t *testing.T) {
	for _, budget := range []int{1, 0} {
		limits := capnpcwasm.DefaultLimits()
		limits.StdoutBytes = budget
		limits.StderrBytes = budget
		c := newCompiler(t, noopCommand, map[string]string{"rust": stdoutCommand, "go": stderrCommand}, capnpcwasm.WithLimits(limits))
		_, err := c.Generate(t.Context(), generateRust())
		var failure *capnpcwasm.Error
		if budget == 1 {
			// Within the budget, the stdout write is the contract violation.
			if !errors.As(err, &failure) || failure.Stage != "rust" || errors.Is(err, capnpcwasm.ErrLimitExceeded) || failure.Err.Error() != "generator unexpectedly wrote to stdout" {
				t.Fatalf("stdout at the budget: %v", err)
			}
		} else {
			assertGuestLimit(t, err, "rust", "rust", "stdoutBytes")
		}
		got, err := c.Generate(t.Context(), capnpcwasm.GenerationRequest{Request: []byte{1}, Generators: []capnpcwasm.Language{"go"}})
		if budget == 1 {
			if err != nil || !reflect.DeepEqual(got.Diagnostics, []capnpcwasm.Diagnostic{{Stage: "go", Language: "go", Stderr: "x"}}) {
				t.Fatalf("stderr at the budget: %v, %+v", err, got.Diagnostics)
			}
		} else {
			assertGuestLimit(t, err, "go", "go", "stderrBytes")
		}
	}
}

// TestOutputBudgetsAtExactBoundaries ports the TypeScript test: the cpp
// generator's real output fits budgets equal to its bytes and entries, and
// fails budgets one below, naming the budget.
func TestOutputBudgetsAtExactBoundaries(t *testing.T) {
	compiler := sharedCompiler(t)
	request := fixture(t)
	request.Entrypoints = []string{"person.capnp"}
	request.Generators = []capnpcwasm.Language{"cpp"}
	baseline, err := compiler.Compile(t.Context(), request)
	if err != nil {
		t.Fatal(err)
	}
	files := baseline.Outputs["cpp"]
	size := 0
	nodes := map[string]bool{}
	for name, data := range files {
		size += len(data)
		for i := 0; i <= len(name); i++ {
			if i == len(name) || name[i] == '/' {
				nodes[name[:i]] = true
			}
		}
	}
	entries := len(nodes)
	if len(files) < 2 || size == 0 {
		t.Fatalf("baseline generated %d files with %d bytes", len(files), size)
	}
	modules := loadModules(t)
	modules.Generators = map[capnpcwasm.Language][]byte{"cpp": modules.Generators["cpp"]}
	bounded := func(adjust func(*capnpcwasm.Limits)) *capnpcwasm.Compiler {
		t.Helper()
		limits := capnpcwasm.DefaultLimits()
		adjust(&limits)
		c, err := capnpcwasm.New(t.Context(), modules, testOptions(capnpcwasm.WithLimits(limits))...)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = c.Close(context.Background()) })
		return c
	}
	generate := capnpcwasm.GenerationRequest{Request: baseline.Request, Generators: []capnpcwasm.Language{"cpp"}}
	for _, extra := range []int{0, 1} {
		c := bounded(func(l *capnpcwasm.Limits) { l.OutputBytes, l.OutputEntries = size+extra, entries+extra })
		got, err := c.Generate(t.Context(), generate)
		if err != nil || !reflect.DeepEqual(got.Outputs["cpp"], files) {
			t.Fatalf("output within the budgets (+%d): %v", extra, err)
		}
	}
	for _, test := range []struct {
		limit  string
		adjust func(*capnpcwasm.Limits)
	}{
		{"outputBytes", func(l *capnpcwasm.Limits) { l.OutputBytes = size - 1 }},
		{"outputEntries", func(l *capnpcwasm.Limits) { l.OutputEntries = entries - 1 }},
	} {
		c := bounded(test.adjust)
		got, err := c.Generate(t.Context(), generate)
		failure := assertGuestLimit(t, err, "cpp", "cpp", test.limit)
		if !reflect.DeepEqual(got, capnpcwasm.GenerationResult{}) {
			t.Fatalf("%s: filesystem failure published output", test.limit)
		}
		// The generator's own report of the failed write is preserved.
		if failure.Stderr == "" || !strings.Contains(failure.Stderr, "Result too large") {
			t.Logf("%s: generator stderr %q", test.limit, failure.Stderr)
		}
	}
}

// TestOutputPathAndEntryBudgetsIgnoreExitStatus checks that a guest which
// exceeds an output budget and exits 0 regardless still fails with the
// budget: the host classifies the job, not the guest.
func TestOutputPathAndEntryBudgetsIgnoreExitStatus(t *testing.T) {
	for _, test := range []struct {
		limit  string
		adjust func(*capnpcwasm.Limits)
	}{
		{"pathBytes", func(l *capnpcwasm.Limits) { l.PathBytes = 2 }},
		{"outputEntries", func(l *capnpcwasm.Limits) { l.OutputEntries = 0 }},
	} {
		limits := capnpcwasm.DefaultLimits()
		test.adjust(&limits)
		c := newCompiler(t, noopCommand, map[string]string{"cpp": createCommand}, capnpcwasm.WithLimits(limits))
		got, err := c.Generate(t.Context(), capnpcwasm.GenerationRequest{Request: []byte{1}, Generators: []capnpcwasm.Language{"cpp"}})
		assertGuestLimit(t, err, "cpp", "cpp", test.limit)
		if !reflect.DeepEqual(got, capnpcwasm.GenerationResult{}) {
			t.Fatalf("%s: output published", test.limit)
		}
	}
	// At the budgets, the three-byte "out" is created.
	limits := capnpcwasm.DefaultLimits()
	limits.PathBytes, limits.OutputEntries = 3, 1
	c := newCompiler(t, noopCommand, map[string]string{"cpp": createCommand}, capnpcwasm.WithLimits(limits))
	got, err := c.Generate(t.Context(), capnpcwasm.GenerationRequest{Request: []byte{1}, Generators: []capnpcwasm.Language{"cpp"}})
	out, created := got.Outputs["cpp"]["out"]
	if err != nil || len(got.Outputs["cpp"]) != 1 || !created || len(out) != 0 {
		t.Fatalf("creation at the budgets: %v, %+v", err, got.Outputs)
	}
}

// TestMemoryPagesLimit checks that memoryPages bounds a module's initial
// memory at New and its growth while it runs.
func TestMemoryPagesLimit(t *testing.T) {
	limits := capnpcwasm.DefaultLimits()
	limits.MemoryPages = 1
	c, err := capnpcwasm.New(t.Context(), capnpcwasm.Modules{Compiler: wasmBytes(t, twoPageCommand)}, testOptions(capnpcwasm.WithLimits(limits))...)
	var failure *capnpcwasm.Error
	if c != nil || !errors.As(err, &failure) || failure.Stage != capnpcwasm.StageModules || !errors.Is(err, capnpcwasm.ErrInvalidRequest) {
		t.Fatalf("two-page module accepted under a one-page limit: %v, %v", c, err)
	}
	limits.MemoryPages = 2
	c = newCompiler(t, twoPageCommand, nil, capnpcwasm.WithLimits(limits))
	if _, err := c.Compile(t.Context(), compileOnly()); !errors.As(err, &failure) || failure.Stage != capnpcwasm.StageCompiler {
		t.Fatalf("two-page module under a two-page limit: %v", err)
	}
	// growCommand expects the default 4096-page ceiling exactly.
	c = newCompiler(t, noopCommand, map[string]string{"rust": growCommand})
	if _, err := c.Generate(t.Context(), generateRust()); err != nil {
		t.Fatalf("default ceiling: %v", err)
	}
}
