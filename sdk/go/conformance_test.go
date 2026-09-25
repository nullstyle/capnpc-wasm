package capnpcwasm_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	capnpcwasm "github.com/nullstyle/capnpc-wasm/sdk/go"
)

// TestConformance runs the shared failure and limit corpus
// (tests/fixtures/conformance, defined in tests/conformance/cases.ts) through
// the Go SDK and checks every case against the "go" surface of expected.json.
// The TypeScript SDK, the packaged launcher, the browsers, and the Studio
// adapter run the same corpus against the same table; a departure of one
// surface is recorded there with its reason.
//
// Outcomes are derived from the error fields, as docs/sdk-contract.md
// describes: Limit names a budget, ExitCode a guest exit, a validate or
// modules stage rejected input, and the contract messages are protocol
// violations. A trap needs wazero's own report (`wasm error:`); any other
// failure is reported as error:<type> and matches no row.
//
// The "go" surface is the SDK with default options, so every corpus compiler
// uses EngineAuto whatever CAPNPC_WASM_TEST_ENGINE selects for the rest of the
// suite: stack depth, and so the deep rows, depend on the engine.
func TestConformance(t *testing.T) {
	corpus := loadConformanceCorpus(t)
	if testEngine != capnpcwasm.EngineAuto {
		t.Logf("the corpus pins EngineAuto, the go surface's default; CAPNPC_WASM_TEST_ENGINE does not apply to it")
	}
	compilers := map[string]*capnpcwasm.Compiler{}
	t.Cleanup(func() {
		for _, c := range compilers {
			_ = c.Close(context.Background())
		}
	})
	corpus.real = conformanceNew(t, corpus.modules, nil, compilers, "real")
	for _, spec := range corpus.cases {
		expectation, skip := corpus.expectationFor(t, spec.Name, "go")
		if skip != "" {
			t.Run(spec.Name, func(t *testing.T) { t.Skip(skip) })
			continue
		}
		t.Run(spec.Name, func(t *testing.T) {
			c := conformanceCompiler(t, corpus, spec, compilers)
			if c == nil {
				// The factory's rejection was the expected outcome.
				return
			}
			ctx := t.Context()
			if spec.DeadlineMs > 0 {
				var cancel context.CancelFunc
				ctx, cancel = context.WithTimeout(ctx, time.Duration(spec.DeadlineMs)*time.Millisecond)
				defer cancel()
			}
			var observed observation
			if spec.Op == "compile" {
				files, includes := corpus.expandWorkspace(t, spec)
				request := capnpcwasm.Request{Files: files, IncludeFiles: includes, Entrypoints: spec.Entrypoints, Generators: languagesOf(spec.Generators)}
				if spec.ImportPaths != nil {
					request.ImportPaths = spec.ImportPaths
				}
				if spec.SourcePrefix != nil {
					request.SourcePrefix = *spec.SourcePrefix
				}
				result, err := c.Compile(ctx, request)
				observed = observeGo(err, result.Outputs, result.Diagnostics)
				if err != nil && !reflect.DeepEqual(result, capnpcwasm.Result{}) {
					t.Fatalf("a failed compile published a result: %+v", result)
				}
			} else {
				result, err := c.Generate(ctx, capnpcwasm.GenerationRequest{Request: corpus.request(spec.Request), Generators: languagesOf(spec.Generators)})
				observed = observeGo(err, result.Outputs, result.Diagnostics)
				if err != nil && !reflect.DeepEqual(result, capnpcwasm.GenerationResult{}) {
					t.Fatalf("a failed generation published a result: %+v", result)
				}
			}
			if mismatches := expectation.check(observed); len(mismatches) > 0 {
				t.Fatalf("%s: %s [observed %s]", spec.Name, strings.Join(mismatches, "; "), observed)
			}
		})
	}
}

type conformanceFile struct {
	Text   *string `json:"text"`
	Recipe string  `json:"recipe"`
	Depth  int     `json:"depth"`
}

type conformanceCase struct {
	Name         string                     `json:"name"`
	Op           string                     `json:"op"`
	Files        map[string]conformanceFile `json:"files"`
	FilesRecipe  *conformanceFile           `json:"filesRecipe"`
	IncludeFiles map[string]struct {
		Standard string `json:"standard"`
	} `json:"includeFiles"`
	Entrypoints     []string          `json:"entrypoints"`
	ImportPaths     []string          `json:"importPaths"`
	SourcePrefix    *string           `json:"sourcePrefix"`
	Generators      []string          `json:"generators"`
	Request         string            `json:"request"`
	Compiler        string            `json:"compiler"`
	GeneratorGuests map[string]string `json:"generatorGuests"`
	Limits          map[string]int    `json:"limits"`
	DeadlineMs      int               `json:"deadlineMs"`
	SHA256          string            `json:"sha256"`
}

// expectation is the reference expectation merged with the surface's override.
type expectation struct {
	Expect      json.RawMessage `json:"expect"`
	Stage       *string         `json:"stage"`
	Stderr      *bool           `json:"stderr"`
	Diagnostics *int            `json:"diagnostics"`
	Outputs     map[string]int  `json:"outputs"`
	Message     *string         `json:"message"`
}

type surfaceOverride struct {
	expectation
	Skip    string `json:"skip"`
	Reason  string `json:"reason"`
	Finding string `json:"finding"`
}

type caseExpectation struct {
	expectation
	Surfaces map[string]surfaceOverride `json:"surfaces"`
}

type conformanceCorpus struct {
	root     string
	cases    []conformanceCase
	expected map[string]caseExpectation
	guests   map[string][]byte
	modules  capnpcwasm.Modules
	// real runs the real modules with default limits on EngineAuto.
	real      *capnpcwasm.Compiler
	validOnce func() []byte
}

func loadConformanceCorpus(t *testing.T) *conformanceCorpus {
	t.Helper()
	r := root(t)
	corpus := &conformanceCorpus{root: r, guests: map[string][]byte{}}
	if err := json.Unmarshal(read(t, r+"/tests/fixtures/conformance/cases.json"), &corpus.cases); err != nil {
		t.Fatal(err)
	}
	var expected struct {
		Cases map[string]caseExpectation `json:"cases"`
	}
	if err := json.Unmarshal(read(t, r+"/tests/fixtures/conformance/expected.json"), &expected); err != nil {
		t.Fatal(err)
	}
	corpus.expected = expected.Cases
	var encoded map[string]string
	if err := json.Unmarshal(read(t, r+"/tests/fixtures/conformance/guests.json"), &encoded); err != nil {
		t.Fatal(err)
	}
	for name, hexBytes := range encoded {
		corpus.guests[name] = wasmBytes(t, hexBytes)
	}
	corpus.modules = loadModules(t)
	var valid []byte
	corpus.validOnce = func() []byte {
		if valid == nil {
			result, err := corpus.real.Compile(context.Background(), capnpcwasm.Request{
				Files:       map[string][]byte{"a.capnp": []byte(conformanceSimpleSchema)},
				Entrypoints: []string{"a.capnp"},
			})
			if err != nil {
				t.Fatalf("compiling the valid request: %v", err)
			}
			valid = result.Request
		}
		return valid
	}
	return corpus
}

const conformanceSimpleSchema = "@0xece4bf9c1f867623; struct Person { name @0 :Text; }"

// expectationFor applies the surface override to the reference, or reports
// the skip reason. An override that changes the outcome replaces the whole
// expectation, as expectationFor in tests/conformance/outcome.ts does; one
// that keeps the outcome adjusts the reference's fields.
func (corpus *conformanceCorpus) expectationFor(t *testing.T, name, surface string) (expectation, string) {
	t.Helper()
	entry, ok := corpus.expected[name]
	if !ok {
		t.Fatalf("expected.json has no entry for %s", name)
	}
	override, has := entry.Surfaces[surface]
	if !has {
		return entry.expectation, ""
	}
	if override.Skip != "" {
		return expectation{}, override.Skip
	}
	if override.Expect != nil {
		return override.expectation, ""
	}
	merged := entry.expectation
	if override.Stage != nil {
		merged.Stage = override.Stage
	}
	if override.Stderr != nil {
		merged.Stderr = override.Stderr
	}
	if override.Diagnostics != nil {
		merged.Diagnostics = override.Diagnostics
	}
	if override.Outputs != nil {
		merged.Outputs = override.Outputs
	}
	if override.Message != nil {
		merged.Message = override.Message
	}
	return merged, ""
}

// The recipes of tests/conformance/cases.ts, byte for byte.

func conformanceSchemaID(n int) string {
	return fmt.Sprintf("@0x%x;", uint64(0xc000000000000000)+uint64(n)*7919)
}

func conformanceConstChain(depth int) string {
	var sb strings.Builder
	sb.WriteString(conformanceSchemaID(1) + "\n")
	for i := 0; i < depth; i++ {
		fmt.Fprintf(&sb, "const c%d :UInt32 = .c%d;\n", i, i+1)
	}
	fmt.Fprintf(&sb, "const c%d :UInt32 = 7;\n", depth)
	return sb.String()
}

func conformanceNestedStructs(depth int) string {
	var sb strings.Builder
	for i := 0; i < depth; i++ {
		fmt.Fprintf(&sb, "struct S%d { ", i)
	}
	sb.WriteString("x @0 :UInt8; ")
	for i := 0; i < depth; i++ {
		sb.WriteString("} ")
	}
	return "@0xece4bf9c1f867623;\n" + sb.String() + "\n"
}

func conformanceNestedList(depth int) string {
	return "@0xece4bf9c1f867623;\nstruct A { f @0 :" + strings.Repeat("List(", depth) + "Text" + strings.Repeat(")", depth) + "; }\n"
}

func conformanceNestedExpr(depth int) string {
	return "@0xece4bf9c1f867623;\nconst c :UInt32 = " + strings.Repeat("(", depth) + "1" + strings.Repeat(")", depth) + ";\n"
}

func conformanceImportChain(depth int) map[string][]byte {
	files := map[string][]byte{}
	for i := 0; i < depth; i++ {
		files[fmt.Sprintf("f%d.capnp", i)] = []byte(fmt.Sprintf("%s\nusing Next = import \"f%d.capnp\";\nstruct T { t @0 :Next.T; }\n", conformanceSchemaID(i+10), i+1))
	}
	files[fmt.Sprintf("f%d.capnp", depth)] = []byte(conformanceSchemaID(depth+10) + "\nstruct T { x @0 :UInt8; }\n")
	return files
}

var conformanceStandardIncludes = map[string]string{
	"go.capnp":        "ref/go-capnp/std/go.capnp",
	"capnp/c++.capnp": "ref/capnproto/c++/src/capnp/c++.capnp",
}

// expandWorkspace expands a compile case and checks the recorded digest, so a
// recipe that differs from the TypeScript expansion fails before it runs.
func (corpus *conformanceCorpus) expandWorkspace(t *testing.T, spec conformanceCase) (map[string][]byte, map[string][]byte) {
	t.Helper()
	files := map[string][]byte{}
	if spec.FilesRecipe != nil {
		if spec.FilesRecipe.Recipe != "importChain" {
			t.Fatalf("unknown files recipe %s", spec.FilesRecipe.Recipe)
		}
		for path, content := range conformanceImportChain(spec.FilesRecipe.Depth) {
			files[path] = content
		}
	}
	for path, file := range spec.Files {
		switch {
		case file.Text != nil:
			files[path] = []byte(*file.Text)
		case file.Recipe == "constChain":
			files[path] = []byte(conformanceConstChain(file.Depth))
		case file.Recipe == "nestedStructs":
			files[path] = []byte(conformanceNestedStructs(file.Depth))
		case file.Recipe == "nestedList":
			files[path] = []byte(conformanceNestedList(file.Depth))
		case file.Recipe == "nestedExpr":
			files[path] = []byte(conformanceNestedExpr(file.Depth))
		default:
			t.Fatalf("unknown file recipe %q", file.Recipe)
		}
	}
	includes := map[string][]byte{}
	for path, include := range spec.IncludeFiles {
		relative, ok := conformanceStandardIncludes[include.Standard]
		if !ok {
			t.Fatalf("unknown standard include %s", include.Standard)
		}
		includes[path] = read(t, corpus.root+"/"+relative)
	}
	if digest := conformanceDigest(files, includes); digest != spec.SHA256 {
		t.Fatalf("expanded workspace digest %s differs from the recorded %s", digest, spec.SHA256)
	}
	return files, includes
}

// conformanceDigest is workspaceDigest from tests/conformance/cases.ts.
func conformanceDigest(files, includes map[string][]byte) string {
	h := sha256.New()
	for _, mount := range []struct {
		tag     string
		entries map[string][]byte
	}{{"f", files}, {"i", includes}} {
		paths := make([]string, 0, len(mount.entries))
		for path := range mount.entries {
			paths = append(paths, path)
		}
		sort.Strings(paths)
		for _, path := range paths {
			h.Write([]byte(mount.tag + "\x00" + path + "\x00"))
			h.Write(mount.entries[path])
			h.Write([]byte{0})
		}
	}
	return hex.EncodeToString(h.Sum(nil))
}

// request derives a generation input from the valid request, as
// requestVariant in tests/conformance/cases.ts does.
func (corpus *conformanceCorpus) request(variant string) []byte {
	valid := corpus.validOnce()
	switch variant {
	case "valid":
		return valid
	case "half":
		return valid[:len(valid)/2]
	case "one":
		return []byte{1}
	case "zeros8":
		return make([]byte, 8)
	case "pattern4k":
		bytes := make([]byte, 4096)
		for i := range bytes {
			bytes[i] = byte((i*167 + 89) & 0xff)
		}
		return bytes
	}
	panic("unknown request variant " + variant)
}

func languagesOf(names []string) []capnpcwasm.Language {
	languages := make([]capnpcwasm.Language, len(names))
	for i, name := range names {
		languages[i] = capnpcwasm.Language(name)
	}
	return languages
}

// conformanceCompiler builds (once per module set and limits) the Compiler a
// case runs on: the shared compiler for real modules with default limits, a
// private one otherwise. A factory rejection is the case's outcome, checked
// here; nil then tells the case that nothing is left to run.
func conformanceCompiler(t *testing.T, corpus *conformanceCorpus, spec conformanceCase, cache map[string]*capnpcwasm.Compiler) *capnpcwasm.Compiler {
	t.Helper()
	if spec.Compiler == "" && len(spec.GeneratorGuests) == 0 && len(spec.Limits) == 0 {
		return corpus.real
	}
	key, _ := json.Marshal([]any{spec.Compiler, spec.GeneratorGuests, spec.Generators, spec.Limits})
	if c, ok := cache[string(key)]; ok {
		return c
	}
	modules := capnpcwasm.Modules{Compiler: corpus.modules.Compiler, Generators: map[capnpcwasm.Language][]byte{}}
	if spec.Compiler != "" {
		modules.Compiler = corpus.guest(t, spec.Compiler)
	}
	for _, language := range spec.Generators {
		if guest, ok := spec.GeneratorGuests[language]; ok {
			modules.Generators[capnpcwasm.Language(language)] = corpus.guest(t, guest)
		} else {
			modules.Generators[capnpcwasm.Language(language)] = corpus.modules.Generators[capnpcwasm.Language(language)]
		}
	}
	options := []capnpcwasm.Option{capnpcwasm.WithEngine(capnpcwasm.EngineAuto)}
	if len(spec.Limits) > 0 {
		limits := capnpcwasm.DefaultLimits()
		for name, value := range spec.Limits {
			switch name {
			case "memoryPages":
				limits.MemoryPages = value
			case "workspaceBytes":
				limits.WorkspaceBytes = value
			case "workspaceEntries":
				limits.WorkspaceEntries = value
			case "pathBytes":
				limits.PathBytes = value
			case "requestBytes":
				limits.RequestBytes = value
			case "outputBytes":
				limits.OutputBytes = value
			case "outputEntries":
				limits.OutputEntries = value
			case "stdoutBytes":
				limits.StdoutBytes = value
			case "stderrBytes":
				limits.StderrBytes = value
			default:
				t.Fatalf("unknown limit %s", name)
			}
		}
		options = append(options, capnpcwasm.WithLimits(limits))
	}
	c, err := capnpcwasm.New(t.Context(), modules, options...)
	if err != nil {
		// The factory's rejection is the outcome; report it like a job's.
		expectation, _ := corpus.expectationFor(t, spec.Name, "go")
		observed := observeGo(err, nil, nil)
		observed.phase = "factory"
		if mismatches := expectation.check(observed); len(mismatches) > 0 {
			t.Fatalf("%s: factory %s [observed %s]", spec.Name, strings.Join(mismatches, "; "), observed)
		}
		return nil
	}
	cache[string(key)] = c
	return c
}

// conformanceNew builds a corpus compiler on EngineAuto and closes it with
// the test; the real modules must compile.
func conformanceNew(t *testing.T, modules capnpcwasm.Modules, options []capnpcwasm.Option, cache map[string]*capnpcwasm.Compiler, key string) *capnpcwasm.Compiler {
	t.Helper()
	c, err := capnpcwasm.New(t.Context(), modules, append([]capnpcwasm.Option{capnpcwasm.WithEngine(capnpcwasm.EngineAuto)}, options...)...)
	if err != nil {
		t.Fatalf("the real modules: %v", err)
	}
	cache[key] = c
	return c
}

func (corpus *conformanceCorpus) guest(t *testing.T, name string) []byte {
	t.Helper()
	bytes, ok := corpus.guests[name]
	if !ok {
		t.Fatalf("unknown guest %s", name)
	}
	return bytes
}

// observation mirrors Observation in tests/conformance/outcome.ts.
type observation struct {
	outcome string
	// phase is "factory" when New rejected the module set; only
	// validation:memoryPages may fail there.
	phase       string
	stage       string
	stderr      bool
	diagnostics int
	outputs     map[string]int
	// message is the failure's own message, for rows that pin one.
	message string
	detail  string
}

func (o observation) String() string {
	parts := []string{o.outcome}
	if o.stage != "" {
		parts = append(parts, "stage="+o.stage, fmt.Sprintf("stderr=%v", o.stderr))
	}
	if o.outcome == "ok" {
		parts = append(parts, fmt.Sprintf("diagnostics=%d outputs=%v", o.diagnostics, o.outputs))
	}
	if o.detail != "" {
		parts = append(parts, "("+o.detail+")")
	}
	return strings.Join(parts, " ")
}

// observeGo classifies a Go SDK result or error into the corpus vocabulary
// from the Error fields, as docs/sdk-contract.md derives the failure kind.
func observeGo(err error, outputs map[capnpcwasm.Language]map[string][]byte, diagnostics []capnpcwasm.Diagnostic) observation {
	if err == nil {
		counts := map[string]int{}
		for language, files := range outputs {
			counts[string(language)] = len(files)
		}
		return observation{outcome: "ok", diagnostics: len(diagnostics), outputs: counts}
	}
	var failure *capnpcwasm.Error
	if !errors.As(err, &failure) {
		return observation{outcome: "error", detail: err.Error()}
	}
	message := failure.Err.Error()
	detail := message
	if len(detail) > 200 {
		detail = detail[:200]
	}
	observed := observation{message: message, detail: strings.ReplaceAll(detail, "\n", " ")}
	switch {
	case errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled):
		observed.outcome = "timeout"
	case failure.Stage == capnpcwasm.StageValidate || failure.Stage == capnpcwasm.StageModules:
		observed.outcome = "validation"
		if failure.Limit != "" {
			observed.outcome += ":" + failure.Limit
		}
	default:
		observed.stage = string(failure.Stage)
		observed.stderr = failure.Stderr != ""
		switch {
		case failure.Limit != "":
			observed.outcome = "limit:" + failure.Limit
		case failure.ExitCode != 0:
			observed.outcome = fmt.Sprintf("exit(%d)", failure.ExitCode)
		case message == "compiler emitted an empty CodeGeneratorRequest" || message == "generator unexpectedly wrote to stdout":
			observed.outcome = "protocol"
		default:
			observed.outcome = trapOutcome(message, failure.Err)
		}
	}
	return observed
}

// trapReport is the prefix wazero writes, and the guest cannot, when the
// guest's _start traps: "module[] function[_start] failed: wasm error:
// <reason>".
const trapReport = "module[] function[_start] failed: wasm error: "

// trapOutcome reads wazero's own trap report, anchored on trapReport: the
// "wasm stack trace:" lines after it name the guest's functions, and a link
// error, which has no stack trace, quotes the guest's import names, so either
// could carry any text. Err never carries the guest's stderr.
func trapOutcome(message string, err error) string {
	report, _, _ := strings.Cut(message, "\nwasm stack trace:")
	reason, ok := strings.CutPrefix(report, trapReport)
	switch {
	case !ok:
		return fmt.Sprintf("error:%T", err)
	case reason == "stack overflow":
		return "trap:stack"
	default:
		return "trap"
	}
}

// check reports the mismatches between the expectation and an observation,
// as checkObservation in tests/conformance/outcome.ts does.
func (e expectation) check(o observation) []string {
	var mismatches []string
	var accepted []string
	var single string
	if err := json.Unmarshal(e.Expect, &single); err == nil {
		accepted = []string{single}
	} else if err := json.Unmarshal(e.Expect, &accepted); err != nil {
		return []string{"unreadable expectation " + string(e.Expect)}
	}
	if o.phase == "factory" && o.outcome != "validation:memoryPages" {
		mismatches = append(mismatches, fmt.Sprintf("New rejected the module set (%s); only validation:memoryPages may fail there", o.detail))
	}
	if e.Message != nil && !strings.Contains(o.message, *e.Message) {
		mismatches = append(mismatches, fmt.Sprintf("the message %q lacks %q", o.message, *e.Message))
	}
	found := false
	for _, word := range accepted {
		if word == o.outcome {
			found = true
		}
	}
	if !found {
		mismatches = append(mismatches, fmt.Sprintf("outcome %s, expected %s", o.outcome, strings.Join(accepted, " or ")))
	}
	// A row that accepts both a success and a failure describes each: stage
	// and stderr apply to the failure, outputs and diagnostics to the success.
	if o.outcome != "ok" {
		if e.Stage != nil && o.stage != *e.Stage {
			mismatches = append(mismatches, fmt.Sprintf("stage %q, expected %q", o.stage, *e.Stage))
		}
		if e.Stderr != nil && o.stderr != *e.Stderr {
			if *e.Stderr {
				mismatches = append(mismatches, "the failing stage wrote no stderr")
			} else {
				mismatches = append(mismatches, "the failing stage wrote stderr")
			}
		}
		return mismatches
	}
	if e.Diagnostics != nil && o.diagnostics != *e.Diagnostics {
		mismatches = append(mismatches, fmt.Sprintf("%d diagnostics, expected %d", o.diagnostics, *e.Diagnostics))
	}
	if e.Outputs != nil {
		actual := o.outputs
		if actual == nil {
			actual = map[string]int{}
		}
		if !reflect.DeepEqual(actual, e.Outputs) {
			mismatches = append(mismatches, fmt.Sprintf("outputs %v, expected %v", actual, e.Outputs))
		}
	}
	return mismatches
}

// TestConformanceClassification pins observeGo: a trap needs wazero's own
// report, and anything else is error:<type>, which matches no corpus row.
func TestConformanceClassification(t *testing.T) {
	for _, test := range []struct {
		err  *capnpcwasm.Error
		want string
	}{
		{&capnpcwasm.Error{Stage: "cpp", Err: errors.New("module[] function[_start] failed: wasm error: unreachable\nwasm stack trace: ...")}, "trap"},
		{&capnpcwasm.Error{Stage: "compiler", Err: errors.New("module[] function[_start] failed: wasm error: stack overflow")}, "trap:stack"},
		{&capnpcwasm.Error{Stage: "cpp", Stderr: "wasm error: stack overflow", Err: errors.New("instantiate failed")}, "error:*errors.errorString"},
		{&capnpcwasm.Error{Stage: "cpp", Err: errors.New("generator unexpectedly wrote to stdout")}, "protocol"},
		// A guest function named like a stack report, in the stack trace of
		// an ordinary trap.
		{&capnpcwasm.Error{Stage: "cpp", Err: errors.New("module[] function[_start] failed: wasm error: unreachable\nwasm stack trace:\n\t.wasm error: stack overflow()\n\t._start()")}, "trap"},
		{&capnpcwasm.Error{Stage: "cpp", Err: errors.New("instantiate failed\nwasm stack trace:\n\t.wasm error: unreachable()")}, "error:*errors.errorString"},
		// A link error has no stack trace and quotes the guest's import name:
		// a guest that imports a function named like a trap report never ran.
		{&capnpcwasm.Error{Stage: "compiler", Err: errors.New(`"wasm error: stack overflow" is not exported in module "wasi_snapshot_preview1"`)}, "error:*errors.errorString"},
		{&capnpcwasm.Error{Stage: "compiler", Err: errors.New(`"module[] function[_start] failed: wasm error: stack overflow" is not exported in module "env"`)}, "error:*errors.errorString"},
	} {
		if got := observeGo(test.err, nil, nil).outcome; got != test.want {
			t.Errorf("%v: %s, want %s", test.err, got, test.want)
		}
	}
}

// TestConformanceCheck pins expectation.check: only validation:memoryPages
// may fail in New, a pinned message must appear, and a row that accepts a
// success and a failure checks each with its own fields.
func TestConformanceCheck(t *testing.T) {
	text := func(s string) *string { return &s }
	count := func(n int) *int { return &n }
	expect := func(outcomes ...string) json.RawMessage {
		encoded, _ := json.Marshal(outcomes)
		return encoded
	}
	depth := expectation{
		Expect:      expect("ok", "trap:stack"),
		Stage:       text("compiler"),
		Diagnostics: count(0),
		Outputs:     map[string]int{"cpp": 2, "rust": 1, "zig": 1},
	}
	for _, test := range []struct {
		name       string
		expected   expectation
		observed   observation
		mismatches int
	}{
		{"New rejects a module", expectation{Expect: expect("validation")}, observation{outcome: "validation", phase: "factory"}, 1},
		{"New rejects the memory ceiling", expectation{Expect: expect("validation:memoryPages")}, observation{outcome: "validation:memoryPages", phase: "factory"}, 0},
		{"message pinned and present", expectation{Expect: expect("validation"), Message: text("is not a directory in files")}, observation{outcome: "validation", message: "importPath is not a directory in files: nope"}, 0},
		{"message pinned and absent", expectation{Expect: expect("validation"), Message: text("is not a directory in files")}, observation{outcome: "validation", message: "some other input error"}, 1},
		{"depth ok with every output", depth, observation{outcome: "ok", outputs: map[string]int{"cpp": 2, "rust": 1, "zig": 1}}, 0},
		{"depth ok that published nothing", depth, observation{outcome: "ok", outputs: map[string]int{}, diagnostics: 3}, 2},
		{"depth trap:stack at the compiler", depth, observation{outcome: "trap:stack", stage: "compiler"}, 0},
		{"depth trap:stack in a generator", depth, observation{outcome: "trap:stack", stage: "cpp"}, 1},
	} {
		if got := test.expected.check(test.observed); len(got) != test.mismatches {
			t.Errorf("%s: %d mismatches %q, want %d", test.name, len(got), got, test.mismatches)
		}
	}
}

// TestConformanceCorpusIsReadable fails early when the fixtures are missing
// inside the checkout, so a stale build is not mistaken for a passing corpus.
func TestConformanceCorpusIsReadable(t *testing.T) {
	for _, name := range []string{"cases.json", "expected.json", "guests.json"} {
		if _, err := os.Stat(root(t) + "/tests/fixtures/conformance/" + name); err != nil {
			unavailable(t, err)
		}
	}
}
