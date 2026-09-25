// wazero-run executes a WASI Preview 1 command with standardized Wasm exceptions.
package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
	"github.com/tetratelabs/wazero/experimental"
	"github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
	"github.com/tetratelabs/wazero/sys"
)

// Exit statuses that cannot be confused with a guest's own exit status: the
// command modules exit 0 or 1, so a trap, an uncaught exception, or a host
// failure is reported distinctly. Usage errors keep the flag package's 2.
const (
	exitUsage = 2
	exitHost  = 70
)

type mounts []string

func (m *mounts) String() string { return strings.Join(*m, ", ") }

func (m *mounts) Set(value string) error {
	host, guest, found := strings.Cut(value, "::")
	if !found || host == "" || guest == "" {
		return fmt.Errorf("directory mount must be host::guest, got %q", value)
	}
	*m = append(*m, value)
	return nil
}

func run() int {
	var dirs mounts
	flag.Var(&dirs, "dir", "grant a directory as host::guest (repeatable)")
	interpreter := flag.Bool("interpreter", false, "use wazero's interpreter instead of its compiler")
	flag.Usage = func() {
		fmt.Fprintln(flag.CommandLine.Output(), "Usage: wazero-run [--dir host::guest] [--interpreter] module.wasm [args...]")
		flag.PrintDefaults()
	}
	flag.Parse()
	if flag.NArg() == 0 {
		flag.Usage()
		return exitUsage
	}

	ctx := context.Background()
	config := wazero.NewRuntimeConfigCompiler()
	if *interpreter {
		config = wazero.NewRuntimeConfigInterpreter()
	} else if cache := compilationCache(); cache != nil {
		defer cache.Close(ctx)
		config = config.WithCompilationCache(cache)
	}
	// The shipped modules carry sysroot DWARF that wazero would otherwise walk
	// on every proc_exit; this runner leaves it unloaded.
	config = config.
		WithCoreFeatures(api.CoreFeaturesV2 | experimental.CoreFeaturesExceptionHandling).
		WithDebugInfoEnabled(false)
	runtime := wazero.NewRuntimeWithConfig(ctx, config)
	defer runtime.Close(ctx)
	if _, err := wasi_snapshot_preview1.Instantiate(ctx, runtime); err != nil {
		fmt.Fprintln(os.Stderr, "wazero-run: instantiate WASI:", err)
		return exitHost
	}

	wasm, err := os.ReadFile(flag.Arg(0))
	if err != nil {
		fmt.Fprintln(os.Stderr, "wazero-run:", err)
		return exitHost
	}
	filesystem := wazero.NewFSConfig()
	for _, dir := range dirs {
		host, guest, _ := strings.Cut(dir, "::")
		filesystem = filesystem.WithDirMount(host, guest)
	}
	// The guest sees the tool name, as the SDKs and the packaged launcher pass
	// it, so diagnostics do not leak the host module path.
	args := append([]string(nil), flag.Args()...)
	args[0] = strings.TrimSuffix(filepath.Base(args[0]), ".wasm")
	moduleConfig := wazero.NewModuleConfig().
		WithArgs(args...).
		// A plain reader hides the *os.File: for a regular file wazero would
		// report its stdin stat as a zero-length regular file, which guests
		// that size reads from the stat (capnpc-zig) trust.
		WithStdin(struct{ io.Reader }{os.Stdin}).
		WithStdout(os.Stdout).
		WithStderr(os.Stderr).
		WithFSConfig(filesystem).
		WithRandSource(rand.Reader).
		WithSysWalltime().
		WithSysNanotime().
		WithSysNanosleep()
	if _, err = runtime.InstantiateWithConfig(ctx, wasm, moduleConfig); err != nil {
		var exitError *sys.ExitError
		if errors.As(err, &exitError) {
			return int(exitError.ExitCode())
		}
		fmt.Fprintln(os.Stderr, "wazero-run:", err)
		return exitHost
	}
	return 0
}

// compilationCache keeps the compiler engine's machine code in
// build/wazero-cache, beside build/hosts/wazero-run, so the test suites that
// run this host hundreds of times compile each module once. The directory is
// keyed by the SHA-256 of this binary: an identical rebuild (Go refreshes the
// output's modification time) reuses the cache, and a different build, which
// may embed another wazero, never reads code another build compiled. The
// first run of a new build removes the other builds' directories; mise builds
// the host before any suite runs it, so no other build is using them. wazero
// writes each entry to a temporary file and renames it, so concurrent hosts
// of one build share the directory safely. Any failure only disables the
// cache.
func compilationCache() wazero.CompilationCache {
	executable, err := os.Executable()
	if err != nil {
		return nil
	}
	binary, err := os.Open(executable)
	if err != nil {
		return nil
	}
	hash := sha256.New()
	_, err = io.Copy(hash, binary)
	binary.Close()
	if err != nil {
		return nil
	}
	key := hex.EncodeToString(hash.Sum(nil))[:32]
	root := filepath.Join(filepath.Dir(executable), "..", "wazero-cache")
	dir := filepath.Join(root, key)
	if _, err := os.Stat(dir); errors.Is(err, fs.ErrNotExist) {
		if entries, err := os.ReadDir(root); err == nil {
			for _, entry := range entries {
				if entry.Name() != key {
					_ = os.RemoveAll(filepath.Join(root, entry.Name()))
				}
			}
		}
	}
	cache, err := wazero.NewCompilationCacheWithDir(dir)
	if err != nil {
		return nil
	}
	return cache
}

func main() {
	os.Exit(run())
}
