package capnpcwasm

import (
	"fmt"

	"github.com/tetratelabs/wazero"
)

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
