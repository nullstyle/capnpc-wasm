// Package capnpcwasm compiles schema workspaces and generates source entirely in
// memory using the project's WASI command modules and the wazero runtime.
package capnpcwasm

import (
	"bytes"
	"context"
	"crypto/rand"
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

const maxBytes = 64 << 20
const maxFiles = 4096

// ErrClosed reports a call on a closed Compiler, or a job that Close
// terminated. It is wrapped in *Error; test for it with errors.Is.
var ErrClosed = errors.New("compiler is closed")

// Modules contains the built compiler and the desired generators. Generator
// keys are "cpp", "rust", "go", or "zig". No modules are downloaded by the SDK.
type Modules struct {
	Compiler   []byte
	Generators map[string][]byte
}

// Request is a schema workspace. Paths are canonical relative POSIX paths.
// IncludeFiles supplies standard schemas and absolute imports (without their
// leading slash), while Files supplies application schemas. Entrypoints names
// files in Files. An empty Generators list requests only the compiler request.
// Do not mutate the request's maps or byte slices while Compile is running.
type Request struct {
	Files        map[string][]byte
	IncludeFiles map[string][]byte
	Entrypoints  []string
	Generators   []string
}

// GenerationRequest runs generators on an existing standard unpacked
// CodeGeneratorRequest. At least one generator is required. Do not mutate its
// byte slice or generator list while Generate is running.
type GenerationRequest struct {
	Request    []byte
	Generators []string
}

// Diagnostic preserves a command's stderr without interpreting upstream syntax.
type Diagnostic struct {
	Stage    string
	Language string
	Message  string
}

// Result is published only after every requested stage succeeds. Request is an
// unpacked CodeGeneratorRequest. Outputs groups relative paths by language.
type Result struct {
	Request     []byte
	Outputs     map[string]map[string][]byte
	Diagnostics []Diagnostic
}

// GenerationResult is published only after every requested generator succeeds.
// Outputs groups relative paths by language. All maps and bytes are caller-owned.
type GenerationResult struct {
	Outputs     map[string]map[string][]byte
	Diagnostics []Diagnostic
}

// Error identifies a failed stage and preserves its stderr and underlying error.
// On any failure Compile and Generate return zero results, so no partial files
// escape.
type Error struct {
	Stage    string
	Language string
	Stderr   string
	Err      error
}

func (e *Error) Error() string {
	stage := e.Stage
	if e.Language != "" {
		stage += " (" + e.Language + ")"
	}
	if e.Stderr != "" {
		return fmt.Sprintf("capnpc-wasm %s: %v: %s", stage, e.Err, strings.TrimSpace(e.Stderr))
	}
	return fmt.Sprintf("capnpc-wasm %s: %v", stage, e.Err)
}

func (e *Error) Unwrap() error { return e.Err }

// Compiler owns reusable compiled Wasm modules. Compile and Generate support
// concurrent calls; each call and generator receives fresh memory, stdio and
// filesystems.
//
// Close rejects new calls immediately and waits for active calls until its
// context ends; then it terminates them.
type Compiler struct {
	runtimes   []wazero.Runtime
	compiler   command
	generators map[string]command

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
		return nil, &Error{Stage: "modules", Err: errors.New("compiler module is empty")}
	}
	for language, wasm := range modules.Generators {
		if !supported(language) || len(wasm) == 0 {
			return nil, &Error{Stage: "modules", Language: language, Err: errors.New("unknown generator or empty module")}
		}
	}
	settings, err := resolve(opts)
	if err != nil {
		return nil, &Error{Stage: "validate", Err: err}
	}
	if _, err := mount(wazero.NewFSConfig(), nil, "/"); err != nil {
		return nil, &Error{Stage: "modules", Err: err}
	}
	if err := ctx.Err(); err != nil {
		return nil, &Error{Stage: "modules", Err: err}
	}
	c := &Compiler{generators: map[string]command{}, jobs: map[*job]struct{}{}, idle: make(chan struct{})}
	ok := false
	defer func() {
		if !ok {
			_ = c.closeRuntimes()
		}
	}()

	type unit struct {
		language string
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
			r := wazero.NewRuntimeWithConfig(ctx, runtimeConfig(engine, settings.cache))
			c.runtimes = append(c.runtimes, r)
			runtimes[engine] = r
			if _, err := wasi_snapshot_preview1.Instantiate(ctx, r); err != nil {
				return nil, &Error{Stage: "modules", Err: err}
			}
		}
		u.runtime = runtimes[engine]
	}
	var compilations sync.WaitGroup
	for _, u := range units {
		if ctx.Err() != nil {
			break
		}
		compilations.Go(func() { u.module, u.err = compileCommand(ctx, u.runtime, u.wasm) })
	}
	compilations.Wait()
	if err := ctx.Err(); err != nil {
		return nil, &Error{Stage: "modules", Err: err}
	}
	for _, u := range units {
		if u.err != nil {
			return nil, &Error{Stage: "modules", Language: u.language, Err: u.err}
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

func runtimeConfig(engine Engine, cache wazero.CompilationCache) wazero.RuntimeConfig {
	// NewRuntimeConfig selects the compiler where the platform supports it and
	// the interpreter elsewhere; unlike NewRuntimeConfigCompiler it never panics.
	config := wazero.NewRuntimeConfig()
	if engine == EngineInterpreter {
		config = wazero.NewRuntimeConfigInterpreter()
	}
	config = config.
		WithCoreFeatures(api.CoreFeaturesV2 | experimental.CoreFeaturesExceptionHandling).
		WithMemoryLimitPages(4096).
		WithCloseOnContextDone(true).
		// The C++ modules carry about 1 MB of sysroot DWARF that wazero would
		// otherwise walk on every guest exit to decorate the exit error.
		WithDebugInfoEnabled(false)
	if cache != nil {
		config = config.WithCompilationCache(cache)
	}
	return config
}

func compileCommand(ctx context.Context, runtime wazero.Runtime, wasm []byte) (wazero.CompiledModule, error) {
	module, err := runtime.CompileModule(ctx, wasm)
	if err != nil {
		return nil, err
	}
	if err := validateCommand(module); err != nil {
		_ = module.Close(ctx)
		return nil, err
	}
	return module, nil
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
// active, because closing the compiler engine unmaps its executable code.
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

// begin registers a job. The returned context ends with the caller's context
// or when Close terminates the job.
func (c *Compiler) begin(ctx context.Context) (context.Context, func(), error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil, nil, ErrClosed
	}
	ctx, cancel := context.WithCancelCause(ctx)
	j := &job{cancel: cancel}
	c.jobs[j] = struct{}{}
	return ctx, func() {
		cancel(nil)
		c.mu.Lock()
		defer c.mu.Unlock()
		delete(c.jobs, j)
		if c.closed && len(c.jobs) == 0 {
			close(c.idle)
			// A Close that already returned on its own deadline is not
			// waiting, so the last job releases the runtimes.
			go func() { _ = c.closeRuntimes() }()
		}
	}, nil
}

// Compile compiles a workspace and runs the selected generators in order.
// It performs no network operations and grants no host filesystem access.
func (c *Compiler) Compile(ctx context.Context, request Request) (Result, error) {
	ctx, done, err := c.begin(ctx)
	if err != nil {
		return Result{}, &Error{Stage: "validate", Err: err}
	}
	defer done()
	if err := ctx.Err(); err != nil {
		return Result{}, &Error{Stage: "validate", Err: err}
	}
	if err := c.validate(request); err != nil {
		return Result{}, &Error{Stage: "validate", Err: err}
	}
	source := newMemoryFS(request.Files, true)
	include := newMemoryFS(request.IncludeFiles, true)
	root := newMemoryFS(nil, false)
	root.Mkdir("src", 0755)
	root.Mkdir("include", 0755)
	// Some libc openat calls start from the root descriptor instead of the
	// longest matching preopen. Mirror the same read-only nodes there too.
	for name, node := range source.nodes {
		if name != "." {
			root.nodes["src/"+name] = node
		}
	}
	for name, node := range include.nodes {
		if name != "." {
			root.nodes["include/"+name] = node
		}
	}
	root.readOnly = true
	fs, err := mount(wazero.NewFSConfig(), root, "/")
	if err == nil {
		fs, err = mount(fs, source, "/src")
	}
	if err == nil {
		fs, err = mount(fs, include, "/include")
	}
	if err != nil {
		return Result{}, &Error{Stage: "compile", Err: err}
	}
	args := []string{"capnp", "compile", "--no-standard-import", "-I/include", "--src-prefix=/src", "-o-"}
	for _, entry := range request.Entrypoints {
		args = append(args, "/src/"+entry)
	}
	binary, stderr, err := c.run(ctx, c.compiler, fs, args, nil)
	if err == nil && len(binary) == 0 {
		err = errors.New("compiler emitted an empty CodeGeneratorRequest")
	}
	if err != nil {
		return Result{}, &Error{Stage: "compile", Stderr: stderr, Err: err}
	}
	generated, err := c.runGenerators(ctx, binary, request.Generators)
	if err != nil {
		return Result{}, err
	}
	result := Result{Request: binary, Outputs: generated.Outputs}
	if stderr != "" {
		result.Diagnostics = append(result.Diagnostics, Diagnostic{Stage: "compile", Message: stderr})
	}
	result.Diagnostics = append(result.Diagnostics, generated.Diagnostics...)
	return result, nil
}

// Generate runs the selected generators on an existing unpacked
// CodeGeneratorRequest, without invoking the compiler. Each generator receives
// a fresh instance and an empty writable memory filesystem. Malformed requests
// are diagnosed by the generators, not parsed by the host SDK.
func (c *Compiler) Generate(ctx context.Context, request GenerationRequest) (GenerationResult, error) {
	ctx, done, err := c.begin(ctx)
	if err != nil {
		return GenerationResult{}, &Error{Stage: "validate", Err: err}
	}
	defer done()
	if err := ctx.Err(); err != nil {
		return GenerationResult{}, &Error{Stage: "validate", Err: err}
	}
	if len(request.Request) == 0 || len(request.Request) > maxBytes {
		return GenerationResult{}, &Error{Stage: "validate", Err: errors.New("CodeGeneratorRequest must contain between 1 byte and 64 MiB")}
	}
	if len(request.Generators) == 0 {
		return GenerationResult{}, &Error{Stage: "validate", Err: errors.New("at least one generator is required")}
	}
	if err := c.validateGenerators(request.Generators); err != nil {
		return GenerationResult{}, &Error{Stage: "validate", Err: err}
	}
	return c.runGenerators(ctx, bytes.Clone(request.Request), request.Generators)
}

func (c *Compiler) runGenerators(ctx context.Context, binary []byte, languages []string) (GenerationResult, error) {
	result := GenerationResult{Outputs: map[string]map[string][]byte{}}
	for _, language := range languages {
		output := newMemoryFS(nil, false)
		fs, err := mount(wazero.NewFSConfig(), output, "/")
		if err != nil {
			return GenerationResult{}, &Error{Stage: "generate", Language: language, Err: err}
		}
		stdout, stderr, err := c.run(ctx, c.generators[language], fs, []string{"capnpc-" + language}, binary)
		if err == nil && len(stdout) != 0 {
			err = errors.New("generator unexpectedly wrote to stdout")
		}
		if err != nil {
			return GenerationResult{}, &Error{Stage: "generate", Language: language, Stderr: stderr, Err: err}
		}
		result.Outputs[language] = output.snapshot()
		if stderr != "" {
			result.Diagnostics = append(result.Diagnostics, Diagnostic{Stage: "generate", Language: language, Message: stderr})
		}
	}
	return result, nil
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

func (c *Compiler) run(ctx context.Context, cmd command, filesystem wazero.FSConfig, args []string, input []byte) ([]byte, string, error) {
	stdout := limitedBuffer{limit: maxBytes}
	stderr := limitedBuffer{limit: 1 << 20}
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
	if errors.As(err, &exit) && exit.ExitCode() == 0 {
		err = nil
	}
	if ctx.Err() != nil {
		err = ctx.Err()
		if errors.Is(context.Cause(ctx), ErrClosed) {
			err = ErrClosed
		}
	} else if stdout.exceeded || stderr.exceeded {
		err = errors.New("command stdio exceeded its size limit")
	}
	return stdout.Bytes(), stderr.String(), err
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

func (c *Compiler) validate(request Request) error {
	if len(request.Entrypoints) == 0 {
		return errors.New("at least one entrypoint is required")
	}
	total := 0
	count := 0
	for _, files := range []map[string][]byte{request.Files, request.IncludeFiles} {
		nodes := map[string]bool{}
		for name, data := range files {
			if !validPath(name) {
				return fmt.Errorf("invalid file path %q", name)
			}
			nodes[name] = true
			for i := 0; i < len(name); i++ {
				if name[i] == '/' {
					parent := name[:i]
					if _, exists := files[parent]; exists {
						return fmt.Errorf("file/directory collision at %q", parent)
					}
					nodes[parent] = true
				}
			}
			if len(nodes) > maxFiles-count {
				return errors.New("workspace exceeds 4096 files and directories")
			}
			if len(data) > maxBytes-total {
				return errors.New("workspace exceeds 64 MiB")
			}
			total += len(data)
		}
		count += len(nodes)
	}
	if count > maxFiles {
		return errors.New("workspace exceeds 4096 files and directories")
	}
	entries := map[string]bool{}
	for _, entry := range request.Entrypoints {
		if !validPath(entry) || entries[entry] {
			return fmt.Errorf("invalid or duplicate entrypoint %q", entry)
		}
		if _, exists := request.Files[entry]; !exists {
			return fmt.Errorf("entrypoint %q is not in Files", entry)
		}
		entries[entry] = true
	}
	return c.validateGenerators(request.Generators)
}

func (c *Compiler) validateGenerators(languages []string) error {
	seen := map[string]bool{}
	for _, language := range languages {
		if !supported(language) || c.generators[language].module == nil || seen[language] {
			return fmt.Errorf("unavailable or duplicate generator %q", language)
		}
		seen[language] = true
	}
	return nil
}

func supported(language string) bool {
	return language == "cpp" || language == "rust" || language == "go" || language == "zig"
}

func validPath(name string) bool {
	if len(name) > 4096 || !utf8.ValidString(name) || strings.ContainsAny(name, "\\\x00") {
		return false
	}
	for _, part := range strings.Split(name, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}

func sortedKeys[V any](values map[string]V) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
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
	engine Engine
	cache  wazero.CompilationCache
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

func resolve(opts []Option) (settings, error) {
	var s settings
	for _, opt := range opts {
		if opt != nil {
			opt(&s)
		}
	}
	if s.engine < EngineAuto || s.engine > EngineInterpreter {
		return s, fmt.Errorf("unknown engine %v", s.engine)
	}
	return s, nil
}

// engineFor resolves the engine that runs one module. The compiler module has
// an empty language.
func (s settings) engineFor(language string) Engine {
	switch s.engine {
	case EngineCompiler, EngineInterpreter:
		return s.engine
	}
	if language == "" || language == "cpp" {
		return EngineInterpreter
	}
	return EngineCompiler
}
