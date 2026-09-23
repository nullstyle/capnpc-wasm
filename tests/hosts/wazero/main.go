// wazero-run executes a WASI Preview 1 command with standardized Wasm exceptions.
package main

import (
	"context"
	"crypto/rand"
	"errors"
	"flag"
	"fmt"
	"io"
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
	}
	// The shipped modules carry sysroot DWARF that wazero would otherwise walk
	// on every proc_exit; the SDKs disable it as well.
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
	// The guest sees the tool name, as the SDKs and the launcher pass it, so
	// diagnostics do not leak the host module path.
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

func main() {
	os.Exit(run())
}
