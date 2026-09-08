// Package capnpwasm compiles schema workspaces and generates source entirely in
// memory using the project's WASI command modules and the wazero runtime.
package capnpwasm

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

// Modules contains the built compiler and the desired generators. Generator
// keys are "cpp", "rust", or "go". No modules are downloaded by the SDK.
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
		return fmt.Sprintf("capnp-wasm %s: %v: %s", stage, e.Err, strings.TrimSpace(e.Stderr))
	}
	return fmt.Sprintf("capnp-wasm %s: %v", stage, e.Err)
}

func (e *Error) Unwrap() error { return e.Err }

// Compiler owns reusable compiled Wasm modules. Compile and Generate support
// concurrent calls; each call and generator receives fresh memory, stdio and
// filesystems.
// Close waits for active calls, which callers can cancel with contexts.
type Compiler struct {
	mu         sync.RWMutex
	runtime    wazero.Runtime
	compiler   wazero.CompiledModule
	generators map[string]wazero.CompiledModule
	closed     bool
}

// New compiles modules once. Compilation and execution require standardized
// Wasm exception handling, enabled on the repository's pinned wazero runtime.
func New(ctx context.Context, modules Modules) (*Compiler, error) {
	if len(modules.Compiler) == 0 {
		return nil, &Error{Stage: "modules", Err: errors.New("compiler module is empty")}
	}
	for language, wasm := range modules.Generators {
		if !supported(language) || len(wasm) == 0 {
			return nil, &Error{Stage: "modules", Language: language, Err: errors.New("unknown generator or empty module")}
		}
	}
	config := wazero.NewRuntimeConfigCompiler().
		WithCoreFeatures(api.CoreFeaturesV2 | experimental.CoreFeaturesExceptionHandling).
		WithMemoryLimitPages(4096).
		WithCloseOnContextDone(true)
	c := &Compiler{runtime: wazero.NewRuntimeWithConfig(ctx, config), generators: map[string]wazero.CompiledModule{}}
	ok := false
	defer func() {
		if !ok {
			_ = c.runtime.Close(context.Background())
		}
	}()
	if _, err := wasi_snapshot_preview1.Instantiate(ctx, c.runtime); err != nil {
		return nil, &Error{Stage: "modules", Err: err}
	}
	var err error
	if c.compiler, err = c.runtime.CompileModule(ctx, modules.Compiler); err != nil {
		return nil, &Error{Stage: "modules", Err: err}
	}
	if err := validateCommand(c.compiler); err != nil {
		return nil, &Error{Stage: "modules", Err: err}
	}
	for _, language := range sortedKeys(modules.Generators) {
		compiled, err := c.runtime.CompileModule(ctx, modules.Generators[language])
		if err != nil {
			return nil, &Error{Stage: "modules", Language: language, Err: err}
		}
		if err := validateCommand(compiled); err != nil {
			return nil, &Error{Stage: "modules", Language: language, Err: err}
		}
		c.generators[language] = compiled
	}
	ok = true
	return c, nil
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

// Close releases the runtime and its compiled modules. Repeated calls are safe.
func (c *Compiler) Close(ctx context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil
	}
	c.closed = true
	return c.runtime.Close(ctx)
}

// Compile compiles a workspace and runs the selected generators in order.
// It performs no network operations and grants no host filesystem access.
func (c *Compiler) Compile(ctx context.Context, request Request) (Result, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.closed {
		return Result{}, &Error{Stage: "validate", Err: errors.New("compiler is closed")}
	}
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
	fs := mount(wazero.NewFSConfig(), root, "/")
	fs = mount(fs, source, "/src")
	fs = mount(fs, include, "/include")
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
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.closed {
		return GenerationResult{}, &Error{Stage: "validate", Err: errors.New("compiler is closed")}
	}
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
		stdout, stderr, err := c.run(ctx, c.generators[language], mount(wazero.NewFSConfig(), output, "/"), []string{"capnpc-" + language}, binary)
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

func mount(config wazero.FSConfig, fs *memoryFS, guest string) wazero.FSConfig {
	return config.(sysfs.FSConfig).WithSysFSMount(fs, guest)
}

func (c *Compiler) run(ctx context.Context, module wazero.CompiledModule, filesystem wazero.FSConfig, args []string, input []byte) ([]byte, string, error) {
	stdout := limitedBuffer{limit: maxBytes}
	stderr := limitedBuffer{limit: 1 << 20}
	config := wazero.NewModuleConfig().WithName("").WithArgs(args...).
		WithStdin(bytes.NewReader(input)).WithStdout(&stdout).WithStderr(&stderr).
		WithFSConfig(filesystem).WithRandSource(rand.Reader).
		WithSysWalltime().WithSysNanotime().WithSysNanosleep()
	instance, err := c.runtime.InstantiateModule(ctx, module, config)
	if instance != nil {
		defer instance.Close(context.Background())
	}
	var exit *sys.ExitError
	if errors.As(err, &exit) && exit.ExitCode() == 0 {
		err = nil
	}
	if ctx.Err() != nil {
		err = ctx.Err()
	} else if stdout.exceeded || stderr.exceeded {
		err = errors.New("command stdio exceeded its size limit")
	}
	return stdout.Bytes(), stderr.String(), err
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
		if !supported(language) || c.generators[language] == nil || seen[language] {
			return fmt.Errorf("unavailable or duplicate generator %q", language)
		}
		seen[language] = true
	}
	return nil
}

func supported(language string) bool {
	return language == "cpp" || language == "rust" || language == "go"
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
