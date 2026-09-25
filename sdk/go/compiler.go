// Package capnpcwasm compiles schema workspaces and generates source entirely in
// memory using the project's WASI command modules and the wazero runtime.
//
// The request fields, resource limits, stage names, and error model are shared
// with the TypeScript SDK; docs/sdk-contract.md in the repository defines them.
package capnpcwasm

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
	"github.com/tetratelabs/wazero/experimental"
	"github.com/tetratelabs/wazero/experimental/sysfs"
	"github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
	"github.com/tetratelabs/wazero/sys"
)

// Language names a generator: the key in Modules.Generators, the entries of a
// request's Generators, the key of Outputs, and the Stage of a generator's
// diagnostics and errors. The set may grow in later releases; treat unknown
// values as data rather than exhausting them in a switch.
type Language string

const (
	LanguageCpp  Language = "cpp"
	LanguageRust Language = "rust"
	LanguageGo   Language = "go"
	LanguageZig  Language = "zig"
)

// Stage identifies the step that produced a Diagnostic or an Error. Guest
// stages are StageCompiler and, for a generator, Stage(language). The
// remaining stages never run a guest: StageValidate rejects caller input, and
// StageModules reports a module New could not compile.
type Stage string

const (
	StageValidate Stage = "validate"
	StageModules  Stage = "modules"
	StageCompiler Stage = "compiler"
)

// Sentinel errors, matched through errors.Is on the *Error a call returns.
var (
	// ErrClosed reports a call on a closed Compiler, or a job that Close
	// terminated.
	ErrClosed = errors.New("compiler is closed")
	// ErrInvalidRequest reports caller input that is rejected before any guest
	// starts: request fields, options passed to New, and module bytes that are
	// empty, unknown, or not WASI commands.
	ErrInvalidRequest = errors.New("invalid request")
	// ErrLimitExceeded reports a budget from Limits that was exceeded. The
	// Error's Limit field names the budget. A budget exceeded by caller input
	// before any guest starts also matches ErrInvalidRequest; a budget a guest
	// exceeds while it runs matches ErrLimitExceeded only.
	ErrLimitExceeded = errors.New("resource limit exceeded")
)

// Limits are the per-job host budgets and the per-instance guest memory
// ceiling, with the names and defaults of the TypeScript SDK's ResourceLimits.
// Error.Limit names a field in lower camel case: "workspaceBytes" for
// WorkspaceBytes. Start from DefaultLimits and change the fields to bound; a
// zero field disallows the resource, except MemoryPages, which must be between
// 1 and 65536.
type Limits struct {
	// MemoryPages bounds each guest instance's linear memory, in 64 KiB pages.
	MemoryPages int
	// WorkspaceBytes bounds the combined contents of Files and IncludeFiles.
	WorkspaceBytes int
	// WorkspaceEntries bounds the combined files and implied directories of
	// Files and IncludeFiles, excluding the mount roots, and separately the
	// number of Entrypoints and of ImportPaths.
	WorkspaceEntries int
	// PathBytes bounds the UTF-8 length of every workspace, entrypoint, import
	// root, source prefix, and generated output path.
	PathBytes int
	// RequestBytes bounds the compiler's CodeGeneratorRequest output and a
	// request supplied to Generate.
	RequestBytes int
	// OutputBytes bounds the file contents each generator retains.
	OutputBytes int
	// OutputEntries bounds the files and directories each generator creates
	// over its lifetime; removing an entry does not refund it.
	OutputEntries int
	// StdoutBytes bounds captured stdout per command; the compiler's stdout is
	// also bounded by RequestBytes.
	StdoutBytes int
	// StderrBytes bounds captured stderr per command.
	StderrBytes int
}

// DefaultLimits returns the limits a Compiler uses without WithLimits. The
// values are recorded in tests/fixtures/contract/limits.json; the Go test
// TestContractLimits and sdk/typescript/conformance_test.ts assert both SDKs'
// defaults against that file.
func DefaultLimits() Limits {
	return Limits{
		MemoryPages:      4096,
		WorkspaceBytes:   64 << 20,
		WorkspaceEntries: 4096,
		PathBytes:        4096,
		RequestBytes:     64 << 20,
		OutputBytes:      64 << 20,
		OutputEntries:    4096,
		StdoutBytes:      64 << 20,
		StderrBytes:      1 << 20,
	}
}

// limitEntry pairs a limit's contract name with its value.
type limitEntry struct {
	name  string
	value int
}

func (l Limits) entries() []limitEntry {
	return []limitEntry{
		{"memoryPages", l.MemoryPages},
		{"workspaceBytes", l.WorkspaceBytes},
		{"workspaceEntries", l.WorkspaceEntries},
		{"pathBytes", l.PathBytes},
		{"requestBytes", l.RequestBytes},
		{"outputBytes", l.OutputBytes},
		{"outputEntries", l.OutputEntries},
		{"stdoutBytes", l.StdoutBytes},
		{"stderrBytes", l.StderrBytes},
	}
}

func (l Limits) validate() error {
	for _, entry := range l.entries() {
		if entry.value < 0 {
			return invalid("invalid resource limit: " + entry.name)
		}
	}
	if l.MemoryPages < 1 || l.MemoryPages > 65536 {
		return invalid("memoryPages must be between 1 and 65536")
	}
	return nil
}

// Modules contains the built compiler and the desired generators. No modules
// are downloaded by the SDK.
type Modules struct {
	Compiler   []byte
	Generators map[Language][]byte
}

// Request is a schema workspace. Paths are canonical relative POSIX paths.
// IncludeFiles supplies standard schemas and absolute imports (without their
// leading slash), while Files supplies application schemas. Entrypoints names
// files in Files. An empty Generators list requests only the compiler request.
// Do not mutate the request's maps or byte slices while Compile is running.
type Request struct {
	Files        map[string][]byte
	IncludeFiles map[string][]byte
	// ImportPaths lists directories within Files, searched in order for
	// absolute imports before IncludeFiles. An empty list adds no roots; the
	// element "" names the /src root itself. Every other entry must be a
	// directory implied by a path in Files.
	ImportPaths []string
	// SourcePrefix names a directory within Files to strip from requested
	// source names; "" (the default) keeps names relative to /src.
	SourcePrefix string
	Entrypoints  []string
	Generators   []Language
}

// GenerationRequest runs generators on an existing standard unpacked
// CodeGeneratorRequest. At least one generator is required. Do not mutate its
// byte slice or generator list while Generate is running.
type GenerationRequest struct {
	Request    []byte
	Generators []Language
}

// Diagnostic preserves a command's stderr without interpreting upstream syntax.
// Stage is StageCompiler or the generator's language, which Language repeats.
type Diagnostic struct {
	Stage    Stage
	Language Language
	Stderr   string
}

// Result is published only after every requested stage succeeds. Request is an
// unpacked CodeGeneratorRequest. Outputs groups relative paths by language.
// Diagnostics holds every stage's stderr in execution order.
type Result struct {
	Request     []byte
	Outputs     map[Language]map[string][]byte
	Diagnostics []Diagnostic
}

// GenerationResult is published only after every requested generator succeeds.
// Outputs groups relative paths by language. All maps and bytes are caller-owned.
type GenerationResult struct {
	Outputs     map[Language]map[string][]byte
	Diagnostics []Diagnostic
}

// Error is the error type every call returns. On any failure Compile and
// Generate return zero results, so no partial files escape. Use errors.Is
// with ErrInvalidRequest, ErrLimitExceeded, ErrClosed, context.Canceled, and
// context.DeadlineExceeded, and errors.As to reach the fields.
type Error struct {
	// Stage is the step that failed.
	Stage Stage
	// Language is the generator when Stage is a generator stage, or the
	// generator whose module New rejected; otherwise it is empty.
	Language Language
	// ExitCode is the failing guest's nonzero exit status. It is 0 for every
	// other failure: a trap, an exceeded limit, cancellation, rejected input,
	// or a command that exited 0 without honoring its contract.
	ExitCode int
	// Limit names the exceeded budget from Limits, or is empty.
	Limit string
	// Diagnostics holds every stage's stderr so far in execution order,
	// including the failing stage's, exactly as a Result would have.
	Diagnostics []Diagnostic
	// Stderr is the failing stage's stderr, when it wrote any.
	Stderr string
	// Err is the underlying error; errors.Is on the *Error reaches it.
	Err error
}

func (e *Error) Error() string {
	stage := string(e.Stage)
	if e.Language != "" {
		if Stage(e.Language) == e.Stage {
			stage = string(e.Language) + " generator"
		} else {
			stage += " (" + string(e.Language) + ")"
		}
	}
	message := fmt.Sprintf("capnpc-wasm %s: %v", stage, e.Err)
	if e.Stderr != "" {
		message += ": " + strings.TrimSpace(e.Stderr)
	}
	return message
}

func (e *Error) Unwrap() error { return e.Err }

// failure builds the Error for a stage from its underlying error, filling
// ExitCode and Limit from the error's classification.
func failure(stage Stage, language Language, stderr string, diagnostics []Diagnostic, err error) *Error {
	e := &Error{Stage: stage, Language: language, Stderr: stderr, Diagnostics: diagnostics, Err: err}
	var exit exitStatus
	if errors.As(err, &exit) {
		e.ExitCode = int(exit)
	}
	var limit *limitError
	if errors.As(err, &limit) {
		e.Limit = limit.limit
	}
	return e
}

// invalidError is caller input rejected before any guest starts.
type invalidError string

func (e invalidError) Error() string { return string(e) }

func (e invalidError) Is(target error) bool { return target == ErrInvalidRequest }

func invalid(message string) error { return invalidError(message) }

// limitError is an exceeded budget. Budgets exceeded by caller input before
// any guest starts are also invalid requests.
type limitError struct {
	limit   string
	message string
	invalid bool
}

func (e *limitError) Error() string { return e.message }

func (e *limitError) Is(target error) bool {
	return target == ErrLimitExceeded || (e.invalid && target == ErrInvalidRequest)
}

// inputExceeds reports caller input over a budget: "<subject> exceeds <limit> limit".
func inputExceeds(subject, limit string) error {
	return &limitError{limit: limit, message: subject + " exceeds " + limit + " limit", invalid: true}
}

// guestExceeded reports a budget a running guest exceeded.
func guestExceeded(limit string) error {
	return &limitError{limit: limit, message: limit + " resource limit exceeded"}
}

// exitStatus is a guest's nonzero exit status.
type exitStatus int

func (e exitStatus) Error() string { return fmt.Sprintf("exited with status %d", int(e)) }

// Compiler owns reusable compiled Wasm modules. Compile and Generate support
// concurrent calls; each call and generator receives fresh memory, stdio and
// filesystems.
//
// Close rejects new calls immediately and waits for active calls until its
// context ends; then it terminates them.
type Compiler struct {
	runtimes   []wazero.Runtime
	compiler   command
	generators map[Language]command
	limits     Limits
	// slots bounds the jobs running guests when WithMaxConcurrentJobs is set;
	// a job holds one slot from admission until it returns.
	slots chan struct{}

	// mu guards the fields below. It is held only for bookkeeping, never while
	// a guest runs, so a pending Close cannot block new callers.
	mu     sync.Mutex
	closed bool
	jobs   map[*job]struct{}
	idle   chan struct{} // closed once the Compiler is closed and no job remains

	release    sync.Once
	releaseErr error
}

// command pairs a compiled module with the runtime that compiled it, because
// modules run on the engine that compiled them.
type command struct {
	runtime wazero.Runtime
	module  wazero.CompiledModule
}

// job is one active Compile or Generate call. Close cancels its context with
// ErrClosed as the cause when the job outlives Close's own context.
type job struct {
	cancel context.CancelCauseFunc
}

// New compiles modules once. Compilation and execution require standardized
// Wasm exception handling, enabled on the repository's pinned wazero runtime.
// Modules compile concurrently; ctx is checked before each compilation starts
// and after all of them finish, but one module's compilation cannot be
// interrupted.
func New(ctx context.Context, modules Modules, opts ...Option) (*Compiler, error) {
	if len(modules.Compiler) == 0 {
		return nil, &Error{Stage: StageModules, Err: invalid("compiler module is empty")}
	}
	for language, wasm := range modules.Generators {
		if !supported(language) || len(wasm) == 0 {
			return nil, &Error{Stage: StageModules, Language: language, Err: invalid("unknown generator or empty module")}
		}
	}
	settings, err := resolve(opts)
	if err != nil {
		return nil, &Error{Stage: StageValidate, Err: err}
	}
	if _, err := mount(wazero.NewFSConfig(), nil, "/"); err != nil {
		return nil, &Error{Stage: StageModules, Err: err}
	}
	if err := ctx.Err(); err != nil {
		return nil, &Error{Stage: StageModules, Err: err}
	}
	c := &Compiler{generators: map[Language]command{}, limits: settings.limits, jobs: map[*job]struct{}{}, idle: make(chan struct{})}
	if settings.maxJobs > 0 {
		c.slots = make(chan struct{}, settings.maxJobs)
	}
	ok := false
	defer func() {
		if !ok {
			_ = c.closeRuntimes()
		}
	}()

	type unit struct {
		language Language
		wasm     []byte
		runtime  wazero.Runtime
		module   wazero.CompiledModule
		err      error
	}
	units := []*unit{{wasm: modules.Compiler}}
	for _, language := range sortedKeys(modules.Generators) {
		units = append(units, &unit{language: language, wasm: modules.Generators[language]})
	}
	runtimes := map[Engine]wazero.Runtime{}
	for _, u := range units {
		engine := settings.engineFor(u.language)
		if runtimes[engine] == nil {
			r := wazero.NewRuntimeWithConfig(ctx, runtimeConfig(engine, settings.cache, settings.limits.MemoryPages))
			c.runtimes = append(c.runtimes, r)
			runtimes[engine] = r
			if _, err := wasi_snapshot_preview1.Instantiate(ctx, r); err != nil {
				return nil, &Error{Stage: StageModules, Err: err}
			}
		}
		u.runtime = runtimes[engine]
	}
	var compilations sync.WaitGroup
	for _, u := range units {
		if ctx.Err() != nil {
			break
		}
		compilations.Go(func() { u.module, u.err = compileCommand(ctx, u.runtime, u.wasm, settings.limits.MemoryPages) })
	}
	compilations.Wait()
	if err := ctx.Err(); err != nil {
		return nil, &Error{Stage: StageModules, Err: err}
	}
	for _, u := range units {
		if u.err != nil {
			return nil, failure(StageModules, u.language, "", nil, u.err)
		}
		if u.language == "" {
			c.compiler = command{runtime: u.runtime, module: u.module}
		} else {
			c.generators[u.language] = command{runtime: u.runtime, module: u.module}
		}
	}
	ok = true
	return c, nil
}

func runtimeConfig(engine Engine, cache wazero.CompilationCache, memoryPages int) wazero.RuntimeConfig {
	// NewRuntimeConfig selects the compiler where the platform supports it and
	// the interpreter elsewhere; unlike NewRuntimeConfigCompiler it never panics.
	config := wazero.NewRuntimeConfig()
	if engine == EngineInterpreter {
		config = wazero.NewRuntimeConfigInterpreter()
	}
	config = config.
		WithCoreFeatures(api.CoreFeaturesV2 | experimental.CoreFeaturesExceptionHandling).
		WithMemoryLimitPages(uint32(memoryPages)).
		WithCloseOnContextDone(true).
		// The C++ modules carry about 1 MB of sysroot DWARF that wazero would
		// otherwise walk on every guest exit to decorate the exit error.
		WithDebugInfoEnabled(false)
	if cache != nil {
		config = config.WithCompilationCache(cache)
	}
	return config
}

// moduleError is a module the engine rejected or that is not a WASI command;
// both are invalid caller input.
type moduleError struct{ err error }

func (e *moduleError) Error() string { return e.err.Error() }

func (e *moduleError) Unwrap() error { return e.err }

func (e *moduleError) Is(target error) bool { return target == ErrInvalidRequest }

// compileCommand compiles one module. A module whose initial memory exceeds
// memoryPages is the exceeded budget, as in the TypeScript SDK, rather than
// the engine rejection wazero would report for it.
func compileCommand(ctx context.Context, runtime wazero.Runtime, wasm []byte, memoryPages int) (wazero.CompiledModule, error) {
	if pages, ok := initialMemoryPages(wasm); ok && pages > uint64(memoryPages) {
		return nil, inputExceeds("initial guest memory", "memoryPages")
	}
	module, err := runtime.CompileModule(ctx, wasm)
	if err != nil {
		return nil, &moduleError{fmt.Errorf("the engine rejected the Wasm module: %w", err)}
	}
	if err := validateCommand(module); err != nil {
		_ = module.Close(ctx)
		return nil, &moduleError{err}
	}
	return module, nil
}

// initialMemoryPages decodes the initial size of a module's first defined
// memory from its memory section. ok is false when the module has no memory
// section or does not decode; the engine then reports whatever is wrong.
func initialMemoryPages(wasm []byte) (pages uint64, ok bool) {
	const header = 8 // magic and version
	if len(wasm) < header || string(wasm[:4]) != "\x00asm" {
		return 0, false
	}
	position := header
	for position < len(wasm) {
		id := wasm[position]
		position++
		size, n := binary.Uvarint(wasm[position:])
		if n <= 0 || size > uint64(len(wasm)-position-n) {
			return 0, false
		}
		position += n
		section := wasm[position : position+int(size)]
		position += int(size)
		if id != 5 { // the memory section
			continue
		}
		count, n := binary.Uvarint(section)
		if n <= 0 || count == 0 || len(section) <= n {
			return 0, false
		}
		// Each memory starts with a flags byte and then its minimum, an
		// unsigned LEB128 that Uvarint decodes for wasm32 and memory64 alike.
		pages, n = binary.Uvarint(section[n+1:])
		return pages, n > 0
	}
	return 0, false
}

func validateCommand(module wazero.CompiledModule) error {
	if module.ExportedMemories()["memory"] == nil {
		return errors.New("command must export its linear memory as memory")
	}
	start := module.ExportedFunctions()["_start"]
	if start == nil || len(start.ParamTypes()) != 0 || len(start.ResultTypes()) != 0 {
		return errors.New("command must export _start with no parameters or results")
	}
	return nil
}

// Close marks the Compiler closed, so new calls fail with ErrClosed, and waits
// for active calls to finish. If ctx ends first, Close terminates the active
// calls (they fail with ErrClosed) and returns ctx's error; the runtime is
// released as soon as the last of them stops. Repeated calls are safe.
func (c *Compiler) Close(ctx context.Context) error {
	c.mu.Lock()
	if !c.closed {
		c.closed = true
		if len(c.jobs) == 0 {
			close(c.idle)
		}
	}
	c.mu.Unlock()
	select {
	case <-c.idle:
		return c.closeRuntimes()
	default:
	}
	select {
	case <-c.idle:
		return c.closeRuntimes()
	case <-ctx.Done():
		c.mu.Lock()
		for j := range c.jobs {
			j.cancel(ErrClosed)
		}
		c.mu.Unlock()
		return ctx.Err()
	}
}

// closeRuntimes releases every runtime once. Callers guarantee that no job is
// active: a runtime is closed only after the last job that uses it has stopped.
func (c *Compiler) closeRuntimes() error {
	c.release.Do(func() {
		for _, r := range c.runtimes {
			if err := r.Close(context.Background()); err != nil && c.releaseErr == nil {
				c.releaseErr = err
			}
		}
	})
	return c.releaseErr
}

// begin registers a job and, when jobs are bounded, waits for a slot. The
// returned context ends with the caller's context or when Close terminates
// the job, including while it waits.
func (c *Compiler) begin(ctx context.Context) (context.Context, func(), error) {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil, nil, ErrClosed
	}
	ctx, cancel := context.WithCancelCause(ctx)
	j := &job{cancel: cancel}
	c.jobs[j] = struct{}{}
	c.mu.Unlock()
	admitted := false
	done := func() {
		cancel(nil)
		if admitted {
			<-c.slots
		}
		c.mu.Lock()
		defer c.mu.Unlock()
		delete(c.jobs, j)
		if c.closed && len(c.jobs) == 0 {
			close(c.idle)
			// A Close that already returned on its own deadline is not
			// waiting, so the last job releases the runtimes.
			go func() { _ = c.closeRuntimes() }()
		}
	}
	if c.slots != nil {
		select {
		case c.slots <- struct{}{}:
			admitted = true
		case <-ctx.Done():
			err := jobErr(ctx)
			done()
			return nil, nil, err
		}
	}
	return ctx, done, nil
}

// Compile compiles a workspace and runs the selected generators in order.
// It performs no network operations and grants no host filesystem access.
func (c *Compiler) Compile(ctx context.Context, request Request) (Result, error) {
	ctx, done, err := c.begin(ctx)
	if err != nil {
		return Result{}, &Error{Stage: StageValidate, Err: err}
	}
	defer done()
	if err := jobErr(ctx); err != nil {
		return Result{}, &Error{Stage: StageValidate, Err: err}
	}
	if err := c.validate(request); err != nil {
		return Result{}, failure(StageValidate, "", "", nil, err)
	}
	source := newMemoryFS(request.Files, true, c.limits)
	include := newMemoryFS(request.IncludeFiles, true, c.limits)
	root := newRootFS(source, include, c.limits)
	fs, err := mount(wazero.NewFSConfig(), root, "/")
	if err == nil {
		fs, err = mount(fs, source, "/src")
	}
	if err == nil {
		fs, err = mount(fs, include, "/include")
	}
	if err != nil {
		return Result{}, &Error{Stage: StageCompiler, Err: err}
	}
	args := []string{"capnp", "compile", "--no-standard-import"}
	for _, root := range request.ImportPaths {
		if root == "" {
			args = append(args, "-I/src")
		} else {
			args = append(args, "-I/src/"+root)
		}
	}
	args = append(args, "-I/include", "--src-prefix=/src")
	if request.SourcePrefix != "" {
		args = append(args, "--src-prefix=/src/"+request.SourcePrefix)
	}
	args = append(args, "-o-")
	for _, entry := range request.Entrypoints {
		args = append(args, "/src/"+entry)
	}
	// The compiler's stdout is the request, so the smaller of the two budgets
	// bounds it and names the failure.
	stdoutBytes, stdoutLimit := c.limits.StdoutBytes, "stdoutBytes"
	if c.limits.RequestBytes < c.limits.StdoutBytes {
		stdoutBytes, stdoutLimit = c.limits.RequestBytes, "requestBytes"
	}
	binary, stderr, err := c.run(ctx, c.compiler, fs, nil, args, nil, stdoutBytes, stdoutLimit)
	var diagnostics []Diagnostic
	if stderr != "" {
		diagnostics = append(diagnostics, Diagnostic{Stage: StageCompiler, Stderr: stderr})
	}
	if err == nil && len(binary) == 0 {
		err = errors.New("compiler emitted an empty CodeGeneratorRequest")
	}
	if err != nil {
		return Result{}, failure(StageCompiler, "", stderr, diagnostics, err)
	}
	generated, err := c.runGenerators(ctx, binary, request.Generators, diagnostics)
	if err != nil {
		return Result{}, err
	}
	return Result{Request: binary, Outputs: generated.Outputs, Diagnostics: generated.Diagnostics}, nil
}

// Generate runs the selected generators on an existing unpacked
// CodeGeneratorRequest, without invoking the compiler. Each generator receives
// a fresh instance and an empty writable memory filesystem. Malformed requests
// are diagnosed by the generators, not parsed by the host SDK.
func (c *Compiler) Generate(ctx context.Context, request GenerationRequest) (GenerationResult, error) {
	ctx, done, err := c.begin(ctx)
	if err != nil {
		return GenerationResult{}, &Error{Stage: StageValidate, Err: err}
	}
	defer done()
	if err := jobErr(ctx); err != nil {
		return GenerationResult{}, &Error{Stage: StageValidate, Err: err}
	}
	if err := c.validateGenerate(request); err != nil {
		return GenerationResult{}, failure(StageValidate, "", "", nil, err)
	}
	return c.runGenerators(ctx, bytes.Clone(request.Request), request.Generators, nil)
}

func (c *Compiler) validateGenerate(request GenerationRequest) error {
	if err := c.validateGenerators(request.Generators); err != nil {
		return err
	}
	if len(request.Generators) == 0 {
		return invalid("at least one generator is required")
	}
	if len(request.Request) == 0 {
		return invalid("request must contain unpacked CodeGeneratorRequest bytes")
	}
	if len(request.Request) > c.limits.RequestBytes {
		return inputExceeds("request", "requestBytes")
	}
	return nil
}

// runGenerators runs each generator in order, appending to the diagnostics
// collected by earlier stages. A failure carries every diagnostic so far.
func (c *Compiler) runGenerators(ctx context.Context, binary []byte, languages []Language, diagnostics []Diagnostic) (GenerationResult, error) {
	result := GenerationResult{Outputs: map[Language]map[string][]byte{}}
	for _, language := range languages {
		stage := Stage(language)
		output := newMemoryFS(nil, false, c.limits)
		fs, err := mount(wazero.NewFSConfig(), output, "/")
		if err != nil {
			return GenerationResult{}, failure(stage, language, "", diagnostics, err)
		}
		stdout, stderr, err := c.run(ctx, c.generators[language], fs, output, []string{argv0(language)}, binary, c.limits.StdoutBytes, "stdoutBytes")
		if stderr != "" {
			diagnostics = append(diagnostics, Diagnostic{Stage: stage, Language: language, Stderr: stderr})
		}
		if err == nil && len(stdout) != 0 {
			err = errors.New("generator unexpectedly wrote to stdout")
		}
		if err != nil {
			return GenerationResult{}, failure(stage, language, stderr, diagnostics, err)
		}
		result.Outputs[language] = output.snapshot()
	}
	result.Diagnostics = diagnostics
	return result, nil
}

// argv0 is the command name a generator sees, matching the native tool and
// the TypeScript SDK.
func argv0(language Language) string {
	if language == LanguageCpp {
		return "capnpc-c++"
	}
	return "capnpc-" + string(language)
}

// mount adds a guest mount through wazero's experimental filesystem
// configuration. A nil fs only checks that the configuration supports it.
func mount(config wazero.FSConfig, fs *memoryFS, guest string) (wazero.FSConfig, error) {
	mounts, ok := config.(sysfs.FSConfig)
	if !ok {
		return nil, errors.New("wazero filesystem configuration does not support experimental mounts")
	}
	if fs == nil {
		return config, nil
	}
	return mounts.WithSysFSMount(fs, guest), nil
}

// run executes one command and classifies its outcome, in this precedence:
// the job's cancellation, a budget the guest exceeded (in output, a limit it
// hit first, then stdout and stderr), a nonzero exit status, or a trap. The
// output filesystem is nil for the compiler.
func (c *Compiler) run(ctx context.Context, cmd command, filesystem wazero.FSConfig, output *memoryFS, args []string, input []byte, stdoutBytes int, stdoutLimit string) ([]byte, string, error) {
	stdout := limitedBuffer{limit: stdoutBytes}
	stderr := limitedBuffer{limit: c.limits.StderrBytes}
	config := wazero.NewModuleConfig().WithName("").WithArgs(args...).
		WithStdin(bytes.NewReader(input)).WithStdout(&stdout).WithStderr(&stderr).
		WithFSConfig(filesystem).WithRandSource(rand.Reader).
		WithSysWalltime().WithSysNanotime().
		WithNanosleep(func(ns int64) { sleep(ctx, ns) })
	instance, err := cmd.runtime.InstantiateModule(ctx, cmd.module, config)
	if instance != nil {
		defer instance.Close(context.Background())
	}
	var exit *sys.ExitError
	if errors.As(err, &exit) {
		if code := exit.ExitCode(); code == 0 {
			err = nil
		} else {
			err = exitStatus(code)
		}
	}
	switch {
	case jobErr(ctx) != nil:
		err = jobErr(ctx)
	case output != nil && output.limit != "":
		err = guestExceeded(output.limit)
	case stdout.exceeded:
		err = guestExceeded(stdoutLimit)
	case stderr.exceeded:
		err = guestExceeded("stderrBytes")
	}
	return stdout.Bytes(), stderr.String(), err
}

// jobErr reports why a job context ended: ErrClosed when Close terminated
// the job, otherwise the context error itself. It is nil while the context
// is live.
func jobErr(ctx context.Context) error {
	if errors.Is(context.Cause(ctx), ErrClosed) {
		return ErrClosed
	}
	return ctx.Err()
}

// sleep implements the guest's nanosleep (poll_oneoff clock subscriptions) so
// that a sleeping guest wakes when its job's context ends and then observes
// the termination at its next loop or function entry.
func sleep(ctx context.Context, ns int64) {
	if ns <= 0 {
		return
	}
	timer := time.NewTimer(time.Duration(ns))
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-timer.C:
	}
}

// validate performs every check on a request before any guest starts, in the
// order and with the messages of the TypeScript SDK's validateCompile.
func (c *Compiler) validate(request Request) error {
	if err := c.validateGenerators(request.Generators); err != nil {
		return err
	}
	if len(request.ImportPaths) > c.limits.WorkspaceEntries {
		return inputExceeds("import root count", "workspaceEntries")
	}
	for _, root := range append([]string{request.SourcePrefix}, request.ImportPaths...) {
		if root != "" {
			if err := c.checkPath(root); err != nil {
				return err
			}
		}
	}
	if duplicated(request.ImportPaths) {
		return invalid("duplicate importPaths")
	}
	if len(request.Entrypoints) == 0 {
		return invalid("at least one entrypoint is required")
	}
	if len(request.Entrypoints) > c.limits.WorkspaceEntries {
		return inputExceeds("entrypoint count", "workspaceEntries")
	}
	for _, entry := range request.Entrypoints {
		if err := c.checkPath(entry); err != nil {
			return err
		}
	}
	if duplicated(request.Entrypoints) {
		return invalid("duplicate entrypoints")
	}

	sourceDirectories := map[string]bool{}
	total := 0
	entries := 0
	for mount, files := range []map[string][]byte{request.Files, request.IncludeFiles} {
		// Each mount counts its own files and implied directories, in a fixed
		// order so a workspace over two budgets always reports the same one.
		nodes := map[string]bool{}
		for _, name := range sortedKeys(files) {
			if err := c.checkPath(name); err != nil {
				return err
			}
			for i := 0; i <= len(name); i++ {
				if i < len(name) && name[i] != '/' {
					continue
				}
				if node := name[:i]; !nodes[node] {
					nodes[node] = true
					entries++
					if entries > c.limits.WorkspaceEntries {
						return inputExceeds("workspace", "workspaceEntries")
					}
				}
			}
			data := files[name]
			if len(data) > c.limits.WorkspaceBytes-total {
				return inputExceeds("workspace", "workspaceBytes")
			}
			total += len(data)
		}
		for _, name := range sortedKeys(files) {
			for i := 0; i < len(name); i++ {
				if name[i] == '/' {
					if _, exists := files[name[:i]]; exists {
						return invalid("file/directory collision: " + name)
					}
				}
			}
		}
		if mount == 0 {
			for node := range nodes {
				if _, isFile := files[node]; !isFile {
					sourceDirectories[node] = true
				}
			}
		}
	}
	for _, entry := range request.Entrypoints {
		if _, exists := request.Files[entry]; !exists {
			return invalid("entrypoint is not in files: " + entry)
		}
	}
	// Import roots and the source prefix name directories the guest will open;
	// reject them here rather than as a compiler exit or a kj exception.
	for _, root := range request.ImportPaths {
		if root != "" && !sourceDirectories[root] {
			return invalid("importPath is not a directory in files: " + root)
		}
	}
	if request.SourcePrefix != "" && !sourceDirectories[request.SourcePrefix] {
		return invalid("sourcePrefix is not a directory in files: " + request.SourcePrefix)
	}
	return nil
}

// checkPath rejects a path over PathBytes or outside the canonical relative
// POSIX form, with the TypeScript SDK's messages.
func (c *Compiler) checkPath(name string) error {
	if len(name) > c.limits.PathBytes {
		return inputExceeds("path", "pathBytes")
	}
	if !validPath(name) {
		return invalid("expected a canonical relative POSIX path: " + name)
	}
	return nil
}

func (c *Compiler) validateGenerators(languages []Language) error {
	if len(languages) > 4 {
		return invalid("too many generators")
	}
	if duplicated(languages) {
		return invalid("duplicate generators")
	}
	for _, language := range languages {
		if !supported(language) || c.generators[language].module == nil {
			return invalid("generator was not supplied: " + string(language))
		}
	}
	return nil
}

func supported(language Language) bool {
	switch language {
	case LanguageCpp, LanguageRust, LanguageGo, LanguageZig:
		return true
	}
	return false
}

// validPath reports whether name is a canonical relative POSIX path: valid
// UTF-8 without backslashes or NUL bytes, and no empty, ".", or ".."
// components. Length is bounded separately by PathBytes.
func validPath(name string) bool {
	if !utf8.ValidString(name) || strings.ContainsAny(name, "\\\x00") {
		return false
	}
	for _, part := range strings.Split(name, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}

func duplicated[T comparable](values []T) bool {
	seen := map[T]bool{}
	for _, value := range values {
		if seen[value] {
			return true
		}
		seen[value] = true
	}
	return false
}

func sortedKeys[K ~string, V any](values map[K]V) []K {
	keys := make([]K, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i] < keys[j] })
	return keys
}

type limitedBuffer struct {
	bytes.Buffer
	limit    int
	exceeded bool
}

func (b *limitedBuffer) Write(data []byte) (int, error) {
	if len(data) > b.limit-b.Len() {
		b.exceeded = true
		n, _ := b.Buffer.Write(data[:b.limit-b.Len()])
		return n, io.ErrShortWrite
	}
	return b.Buffer.Write(data)
}

// Engine selects which wazero engine executes a Compiler's modules.
//
// The pinned wazero compiler clones the Go-side stack on every Wasm try_table
// entry. The C++ command modules (the compiler and the cpp generator) enter
// thousands of try_table blocks per job, which makes them 2-7x slower on the
// compiler engine than on the interpreter and allocates 10-155 GB per job. The
// Rust, Go, and Zig generators contain no try_table blocks and run faster on
// the compiler engine.
type Engine int

const (
	// EngineAuto runs the compiler module and the cpp generator on wazero's
	// interpreter and every other generator on wazero's compiler where the
	// platform supports it. It is the default.
	EngineAuto Engine = iota
	// EngineCompiler requests wazero's ahead-of-time compiler for every module.
	// On platforms without compiler support, wazero runs its interpreter
	// instead; New never panics.
	EngineCompiler
	// EngineInterpreter runs every module on wazero's interpreter.
	EngineInterpreter
)

func (e Engine) String() string {
	switch e {
	case EngineAuto:
		return "auto"
	case EngineCompiler:
		return "compiler"
	case EngineInterpreter:
		return "interpreter"
	}
	return fmt.Sprintf("Engine(%d)", int(e))
}

// Option configures New.
type Option func(*settings)

type settings struct {
	engine    Engine
	cache     wazero.CompilationCache
	limits    Limits
	maxJobs   int
	boundJobs bool
}

// WithEngine selects the execution engine. The default is EngineAuto.
func WithEngine(engine Engine) Option {
	return func(s *settings) { s.engine = engine }
}

// WithCompilationCache shares compiled code between Compilers that receive
// the same cache, in memory or through wazero.NewCompilationCacheWithDir. The
// cache outlives the Compilers that use it; close it after the last one.
func WithCompilationCache(cache wazero.CompilationCache) Option {
	return func(s *settings) { s.cache = cache }
}

// WithLimits replaces DefaultLimits for every job of the Compiler. Every field
// must be nonnegative and MemoryPages between 1 and 65536; otherwise New
// fails with an Error at StageValidate that matches ErrInvalidRequest.
func WithLimits(limits Limits) Option {
	return func(s *settings) { s.limits = limits }
}

// WithMaxConcurrentJobs bounds the Compile and Generate calls that run guests
// at once. Further calls wait for a slot until their context ends or Close
// terminates them; n must be at least 1. Without this option jobs are
// unbounded.
func WithMaxConcurrentJobs(n int) Option {
	return func(s *settings) { s.maxJobs, s.boundJobs = n, true }
}

func resolve(opts []Option) (settings, error) {
	s := settings{limits: DefaultLimits()}
	for _, opt := range opts {
		if opt != nil {
			opt(&s)
		}
	}
	if s.engine < EngineAuto || s.engine > EngineInterpreter {
		return s, invalid(fmt.Sprintf("unknown engine %v", s.engine))
	}
	if err := s.limits.validate(); err != nil {
		return s, err
	}
	if s.boundJobs && s.maxJobs < 1 {
		return s, invalid("maxConcurrentJobs must be positive")
	}
	return s, nil
}

// engineFor resolves the engine that runs one module. The compiler module has
// an empty language.
func (s settings) engineFor(language Language) Engine {
	switch s.engine {
	case EngineCompiler, EngineInterpreter:
		return s.engine
	}
	if language == "" || language == LanguageCpp {
		return EngineInterpreter
	}
	return EngineCompiler
}
