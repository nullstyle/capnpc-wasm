package capnpcwasm_test

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
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
		unavailable(t, shared.err)
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

// inRepository reports whether the package is the repository checkout rather
// than a downloaded module. The checkout builds the Wasm commands, the native
// oracle, and the shared fixtures that most tests read.
func inRepository() bool {
	_, err := os.Stat("../../mise.toml")
	return err == nil
}

// unavailable fails a test that needs a repository artifact inside the
// checkout, where `mise run build` provides it, and skips it elsewhere, so
// `go test` of a downloaded module runs only the self-contained tests.
func unavailable(t testing.TB, err error) {
	t.Helper()
	if !inRepository() && errors.Is(err, fs.ErrNotExist) {
		t.Skipf("skipped outside the repository checkout: %v", err)
	}
	t.Fatalf("%v (run mise run build before SDK tests)", err)
}

func read(t testing.TB, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		unavailable(t, err)
	}
	return data
}

// modulesDir is the directory holding the built command modules:
// CAPNPC_WASM_TEST_MODULES, or the repository's build output.
func modulesDir() (string, error) {
	if dir := os.Getenv("CAPNPC_WASM_TEST_MODULES"); dir != "" {
		return dir, nil
	}
	return filepath.Abs("../../build/wasm/bin")
}

func readModules() (capnpcwasm.Modules, error) {
	dir, err := modulesDir()
	if err != nil {
		return capnpcwasm.Modules{}, err
	}
	modules := capnpcwasm.Modules{Generators: map[capnpcwasm.Language][]byte{}}
	for language, file := range map[capnpcwasm.Language]string{"": "capnp.wasm", "cpp": "capnpc-c++.wasm", "rust": "capnpc-rust.wasm", "go": "capnpc-go.wasm", "zig": "capnpc-zig.wasm"} {
		data, err := os.ReadFile(dir + "/" + file)
		if err != nil {
			return capnpcwasm.Modules{}, err
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
		unavailable(t, err)
	}
	return modules
}

// native returns the path of a built native tool, or skips outside the
// repository checkout.
func native(t testing.TB, name string) string {
	t.Helper()
	path := root(t) + "/build/native/bin/" + name
	if _, err := os.Stat(path); err != nil {
		unavailable(t, err)
	}
	return path
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
