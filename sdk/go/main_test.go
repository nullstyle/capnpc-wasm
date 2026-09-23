package capnpcwasm_test

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"

	capnpcwasm "github.com/nullstyle/capnpc-wasm/sdk/go"
)

// testEngine applies to every Compiler the tests build, so the whole suite
// runs under one wazero engine: CAPNPC_WASM_TEST_ENGINE=auto|compiler|interpreter.
var testEngine = capnpcwasm.EngineAuto

func TestMain(m *testing.M) {
	switch name := os.Getenv("CAPNPC_WASM_TEST_ENGINE"); name {
	case "", "auto":
	case "compiler":
		testEngine = capnpcwasm.EngineCompiler
	case "interpreter":
		testEngine = capnpcwasm.EngineInterpreter
	default:
		fmt.Fprintf(os.Stderr, "CAPNPC_WASM_TEST_ENGINE=%q: want auto, compiler, or interpreter\n", name)
		os.Exit(2)
	}
	code := m.Run()
	if shared.compiler != nil {
		if err := shared.compiler.Close(context.Background()); err != nil {
			fmt.Fprintln(os.Stderr, "close shared compiler:", err)
			if code == 0 {
				code = 1
			}
		}
	}
	os.Exit(code)
}

// testOptions prepends the suite's engine to opts.
func testOptions(opts ...capnpcwasm.Option) []capnpcwasm.Option {
	return append([]capnpcwasm.Option{capnpcwasm.WithEngine(testEngine)}, opts...)
}

// shared is the Compiler built from the real modules once per test binary and
// closed by TestMain. Tests that close a Compiler build their own.
var shared struct {
	once     sync.Once
	compiler *capnpcwasm.Compiler
	err      error
}

func sharedCompiler(t testing.TB) *capnpcwasm.Compiler {
	t.Helper()
	shared.once.Do(func() {
		modules, err := readModules()
		if err != nil {
			shared.err = err
			return
		}
		shared.compiler, shared.err = capnpcwasm.New(context.Background(), modules, testOptions()...)
	})
	if shared.err != nil {
		t.Fatalf("shared compiler: %v", shared.err)
	}
	return shared.compiler
}

func root(t testing.TB) string {
	t.Helper()
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	return root
}

func read(t testing.TB, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%s: %v (run mise run build before SDK tests)", path, err)
	}
	return data
}

func readModules() (capnpcwasm.Modules, error) {
	dir, err := filepath.Abs("../../build/wasm/bin")
	if err != nil {
		return capnpcwasm.Modules{}, err
	}
	modules := capnpcwasm.Modules{Generators: map[string][]byte{}}
	for language, file := range map[string]string{"": "capnp.wasm", "cpp": "capnpc-c++.wasm", "rust": "capnpc-rust.wasm", "go": "capnpc-go.wasm", "zig": "capnpc-zig.wasm"} {
		data, err := os.ReadFile(dir + "/" + file)
		if err != nil {
			return capnpcwasm.Modules{}, fmt.Errorf("%w (run mise run build before SDK tests)", err)
		}
		if language == "" {
			modules.Compiler = data
		} else {
			modules.Generators[language] = data
		}
	}
	return modules, nil
}

func loadModules(t testing.TB) capnpcwasm.Modules {
	t.Helper()
	modules, err := readModules()
	if err != nil {
		t.Fatal(err)
	}
	return modules
}

// workDir creates a directory under build/test for native comparisons. It is
// removed when the test passes, and kept for inspection when the test fails
// or CAPNP_KEEP_TEST_DIRS=1.
func workDir(t *testing.T, prefix string) string {
	t.Helper()
	dir := root(t) + "/build/test"
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	work, err := os.MkdirTemp(dir, prefix)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if t.Failed() || os.Getenv("CAPNP_KEEP_TEST_DIRS") == "1" {
			t.Logf("keeping %s", work)
			return
		}
		if err := os.RemoveAll(work); err != nil {
			t.Error(err)
		}
	})
	return work
}
