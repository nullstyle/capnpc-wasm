// wazero-run executes a WASI Preview 1 command with standardized Wasm exceptions.
package main

import (
	"context"
	"crypto/rand"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
	"github.com/tetratelabs/wazero/experimental"
	"github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
	"github.com/tetratelabs/wazero/sys"
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
		return 2
	}

	ctx := context.Background()
	config := wazero.NewRuntimeConfigCompiler()
	if *interpreter {
		config = wazero.NewRuntimeConfigInterpreter()
	}
	config = config.WithCoreFeatures(api.CoreFeaturesV2 | experimental.CoreFeaturesExceptionHandling)
	runtime := wazero.NewRuntimeWithConfig(ctx, config)
	defer runtime.Close(ctx)
	if _, err := wasi_snapshot_preview1.Instantiate(ctx, runtime); err != nil {
		fmt.Fprintln(os.Stderr, "wazero-run: instantiate WASI:", err)
		return 1
	}

	wasm, err := os.ReadFile(flag.Arg(0))
	if err != nil {
		fmt.Fprintln(os.Stderr, "wazero-run:", err)
		return 1
	}
	filesystem := wazero.NewFSConfig()
	for _, dir := range dirs {
		host, guest, _ := strings.Cut(dir, "::")
		filesystem = filesystem.WithDirMount(host, guest)
	}
	moduleConfig := wazero.NewModuleConfig().
		WithArgs(flag.Args()...).
		WithStdin(os.Stdin).
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
		return 1
	}
	return 0
}

func main() {
	os.Exit(run())
}
