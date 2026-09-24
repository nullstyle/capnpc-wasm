package capnpcwasm_test

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	capnpcwasm "github.com/nullstyle/capnpc-wasm/sdk/go"
	"github.com/tetratelabs/wazero"
)

// Guests assembled from WAT with the pinned wasm-tools and stripped of custom
// sections. Each exports memory and _start, as the command contract requires.
const (
	// Loops forever: (func (export "_start") (loop br 0)).
	loopCommand = "0061736d01000000010401600000030201000503010001071302066d656d6f72790200065f737461727400000a0901070003400c000b0b"
	// Traps at once: (func (export "_start") unreachable).
	trapCommand = "0061736d01000000010401600000030201000503010001071302066d656d6f72790200065f737461727400000a05010300000b"
	// Exits with status 1 through proc_exit.
	exitCommand = "0061736d0100000001080260017f0060000002240116776173695f736e617073686f745f70726576696577310970726f635f657869740000030201010503010001071302066d656d6f72790200065f737461727400010a08010600410110000b"
	// Declares two pages of memory and returns at once.
	twoPageCommand = "0061736d01000000010401600000030201000503010002071302066d656d6f72790200065f737461727400000a040102000b"
	// Writes 'x' to fd 1 (stdout) through WASI fd_write, then returns normally.
	stdoutCommand = "0061736d01000000010c0260047f7f7f7f017f60000002230116776173695f736e617073686f745f70726576696577310866645f77726974650000030201010503010001071302066d656d6f72790200065f737461727400010a0f010d00410141004101410c10001a0b0b0f010041000b09080000000100000078"
	// Writes 'x' to fd 2 (stderr) through WASI fd_write, then returns normally.
	stderrCommand = "0061736d01000000010c0260047f7f7f7f017f60000002230116776173695f736e617073686f745f70726576696577310866645f77726974650000030201010503010001071302066d656d6f72790200065f737461727400010a0f010d00410241004101410c10001a0b0b0f010041000b09080000000100000078"
	// Writes 'x' to stdout and then 'w' to stderr, then returns normally.
	stdoutStderrCommand = "0061736d01000000010c0260047f7f7f7f017f60000002230116776173695f736e617073686f745f70726576696577310866645f77726974650000030201010503010001071302066d656d6f72790200065f737461727400010a1a011800410141004101412010001a410241104101412010001a0b0b1d020041000b090800000001000000780041100b09180000000100000077"
	// Writes the NUL-separated argv it receives to stderr, then returns.
	argsCommand = "0061736d0100000001120360027f7f017f60047f7f7f7f017f600000026d0316776173695f736e617073686f745f70726576696577310e617267735f73697a65735f676574000016776173695f736e617073686f745f707265766965773108617267735f676574000016776173695f736e617073686f745f70726576696577310866645f77726974650001030201020503010001071302066d656d6f72790200065f737461727400030a3f013d01017f4100410410001a4110410028020041046c6a21004110200010011a41082000360200410c410428020036020041024108410141e0d40310021a0b"
	// Creates the empty file "out" in its root through path_open, ignoring the
	// result, then returns normally.
	createCommand = "0061736d0100000001110260097f7f7f7f7f7e7e7f7f017f60000002240116776173695f736e617073686f745f707265766965773109706174685f6f70656e0000030201010503010001071302066d656d6f72790200065f737461727400010a1a0118004103410041004103410142c20042004100411010001a0b0b09010041000b036f7574"
	// Creates the empty file "generated.txt" (13 bytes) in its root through
	// path_open, ignoring the result, then returns normally.
	createLongCommand = "0061736d0100000001110260097f7f7f7f7f7e7e7f7f017f60000002240116776173695f736e617073686f745f707265766965773109706174685f6f70656e0000030201010503010001071302066d656d6f72790200065f737461727400010a1a011800410341004100410d410142c20042004100411010001a0b0b13010041000b0d67656e6572617465642e747874"
	// Writes its first 64 KiB page to fd 1 1025 times: 64 MiB plus one page.
	stdoutFloodCommand = "0061736d01000000010c0260047f7f7f7f017f60000002230116776173695f736e617073686f745f70726576696577310866645f77726974650000030201010503010002071302066d656d6f72790200065f737461727400010a3c013a01017f41808004410036020041848004418080043602004181082100034041014180800441014188800410001a200041016b210020000d000b0b"
	// Writes its first 64 KiB page to fd 2 17 times: 1 MiB plus one page.
	stderrFloodCommand = "0061736d01000000010c0260047f7f7f7f017f60000002230116776173695f736e617073686f745f70726576696577310866645f77726974650000030201010503010002071302066d656d6f72790200065f737461727400010a3b013901017f418080044100360200418480044180800436020041112100034041024180800441014188800410001a200041016b210020000d000b0b"
	// Starts with one page, then traps unless memory.grow(4096) fails,
	// memory.grow(4095) succeeds (reaching the 4096-page ceiling exactly), and
	// memory.grow(1) fails again.
	growCommand = "0061736d01000000010401600000030201000503010001071302066d656d6f72790200065f737461727400000a270125004180204000417f470440000b41ff1f4000417f460440000b41014000417f470440000b0b"
	// Calls poll_oneoff with one relative monotonic clock subscription of 3 s,
	// then loops forever, so termination is observed at a loop edge.
	sleepCommand = "0061736d01000000010c0260047f7f7f7f017f60000002260116776173695f736e617073686f745f70726576696577310b706f6c6c5f6f6e656f66660000030201010503010001071302066d656d6f72790200065f737461727400010a280126004110410136020041184280bcc1960b370300410041c000410141800110001a03400c000b0b"
)

// promptly bounds operations that must not wait for a guest: a job whose guest
// sleeps 3 s or loops forever under a short deadline, a Close at its deadline,
// or a call rejected by a closed Compiler. On an idle host these take about
// 50 ms plus the deadline; the bound keeps at least 5x headroom so the tests
// hold while other builds load the machine.
const promptly = time.Second

func compileOnly() capnpcwasm.Request {
	return capnpcwasm.Request{Files: map[string][]byte{"test.capnp": {}}, Entrypoints: []string{"test.capnp"}}
}

func generateRust() capnpcwasm.GenerationRequest {
	return capnpcwasm.GenerationRequest{Request: []byte{1}, Generators: []capnpcwasm.Language{"rust"}}
}

// newCompiler builds a Compiler from hex-encoded guests and closes it with the test.
func newCompiler(t *testing.T, compiler string, generators map[string]string, opts ...capnpcwasm.Option) *capnpcwasm.Compiler {
	t.Helper()
	modules := capnpcwasm.Modules{Compiler: wasmBytes(t, compiler), Generators: map[capnpcwasm.Language][]byte{}}
	for language, guest := range generators {
		modules.Generators[capnpcwasm.Language(language)] = wasmBytes(t, guest)
	}
	c, err := capnpcwasm.New(t.Context(), modules, testOptions(opts...)...)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close(context.Background()) })
	return c
}

func waitFor(t *testing.T, what string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(time.Millisecond)
	}
}

func assertClosed(t *testing.T, c *capnpcwasm.Compiler) {
	t.Helper()
	start := time.Now()
	got, err := c.Compile(t.Context(), compileOnly())
	var failure *capnpcwasm.Error
	if !errors.Is(err, capnpcwasm.ErrClosed) || errors.Is(err, capnpcwasm.ErrInvalidRequest) || !errors.As(err, &failure) || failure.Stage != capnpcwasm.StageValidate || !reflect.DeepEqual(got, capnpcwasm.Result{}) {
		t.Fatalf("closed compiler accepted Compile: %+v, %v", got, err)
	}
	generated, err := c.Generate(t.Context(), generateRust())
	if !errors.Is(err, capnpcwasm.ErrClosed) || !reflect.DeepEqual(generated, capnpcwasm.GenerationResult{}) {
		t.Fatalf("closed compiler accepted Generate: %+v, %v", generated, err)
	}
	if elapsed := time.Since(start); elapsed > promptly {
		t.Fatalf("closed compiler rejected calls after %v, want under %v", elapsed, promptly)
	}
}

func TestStdioLimits(t *testing.T) {
	t.Run("stdout over 64 MiB", func(t *testing.T) {
		c := newCompiler(t, stdoutFloodCommand, nil)
		got, err := c.Compile(t.Context(), compileOnly())
		assertGuestLimit(t, err, capnpcwasm.StageCompiler, "", "stdoutBytes")
		if !reflect.DeepEqual(got, capnpcwasm.Result{}) {
			t.Fatal("stdout flood returned a result")
		}
	})
	t.Run("stderr over 1 MiB", func(t *testing.T) {
		c := newCompiler(t, noopCommand, map[string]string{"rust": stderrFloodCommand})
		got, err := c.Generate(t.Context(), generateRust())
		failure := assertGuestLimit(t, err, "rust", "rust", "stderrBytes")
		if !reflect.DeepEqual(got, capnpcwasm.GenerationResult{}) {
			t.Fatal("stderr flood returned a result")
		}
		if len(failure.Stderr) != 1<<20 {
			t.Fatalf("retained %d stderr bytes, want exactly the 1 MiB cap", len(failure.Stderr))
		}
	})
}

func TestMemoryCeiling(t *testing.T) {
	c := newCompiler(t, noopCommand, map[string]string{"rust": growCommand, "go": trapCommand})
	if _, err := c.Generate(t.Context(), generateRust()); err != nil {
		t.Fatalf("memory.grow did not honor the 4096-page ceiling: %v", err)
	}
	// The trap control proves that a failed guest check would surface.
	got, err := c.Generate(t.Context(), capnpcwasm.GenerationRequest{Request: []byte{1}, Generators: []capnpcwasm.Language{"go"}})
	var failure *capnpcwasm.Error
	if !errors.As(err, &failure) || failure.Stage != "go" || failure.Language != "go" || !reflect.DeepEqual(got, capnpcwasm.GenerationResult{}) {
		t.Fatalf("guest trap not reported: %+v, %v", got, err)
	}
}

func TestSleepingGuestHonorsDeadline(t *testing.T) {
	c := newCompiler(t, sleepCommand, nil)
	ctx, cancel := context.WithTimeout(t.Context(), 50*time.Millisecond)
	defer cancel()
	start := time.Now()
	got, err := c.Compile(ctx, compileOnly())
	elapsed := time.Since(start)
	t.Logf("50 ms deadline against a 3 s poll_oneoff sleep returned after %v", elapsed)
	var failure *capnpcwasm.Error
	if !errors.Is(err, context.DeadlineExceeded) || !errors.As(err, &failure) || failure.Stage != capnpcwasm.StageCompiler || !reflect.DeepEqual(got, capnpcwasm.Result{}) {
		t.Fatalf("sleeping guest: %+v, %v", got, err)
	}
	if elapsed > promptly {
		t.Fatalf("sleeping guest ignored its deadline: returned after %v, want under %v", elapsed, promptly)
	}
}

func TestCloseTerminatesActiveCallsAtItsDeadline(t *testing.T) {
	c := newCompiler(t, sleepCommand, nil)
	type outcome struct {
		got     capnpcwasm.Result
		err     error
		elapsed time.Duration
	}
	results := make(chan outcome, 1)
	start := time.Now()
	go func() {
		got, err := c.Compile(t.Context(), compileOnly())
		results <- outcome{got, err, time.Since(start)}
	}()
	waitFor(t, "the job to register", func() bool { return c.ActiveJobs() == 1 })

	ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
	defer cancel()
	closeStart := time.Now()
	err := c.Close(ctx)
	closeElapsed := time.Since(closeStart)
	t.Logf("Close with a 100 ms deadline over a sleeping job returned after %v", closeElapsed)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Close ignored its context: %v", err)
	}
	if closeElapsed > promptly {
		t.Fatalf("Close returned after %v, want under %v", closeElapsed, promptly)
	}

	result := <-results
	var failure *capnpcwasm.Error
	if !errors.Is(result.err, capnpcwasm.ErrClosed) || !errors.As(result.err, &failure) || failure.Stage != capnpcwasm.StageCompiler || !reflect.DeepEqual(result.got, capnpcwasm.Result{}) {
		t.Fatalf("terminated job returned %+v, %v", result.got, result.err)
	}
	if result.elapsed > 2*promptly {
		t.Fatalf("terminated job outlived Close: returned after %v", result.elapsed)
	}
	// The job has stopped, so a later Close finds nothing to wait for.
	if err := c.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	assertClosed(t, c)
}

func TestCloseRejectsCallsWhileWaiting(t *testing.T) {
	c := newCompiler(t, sleepCommand, nil)
	jobCtx, cancelJob := context.WithCancel(t.Context())
	defer cancelJob()
	jobErr := make(chan error, 1)
	go func() {
		_, err := c.Compile(jobCtx, compileOnly())
		jobErr <- err
	}()
	waitFor(t, "the job to register", func() bool { return c.ActiveJobs() == 1 })

	closeErr := make(chan error, 1)
	go func() { closeErr <- c.Close(context.Background()) }()
	waitFor(t, "Close to mark the compiler closed", c.IsClosed)
	// Close is still waiting for the job, and the new call must not wait behind it.
	assertClosed(t, c)
	select {
	case err := <-closeErr:
		t.Fatalf("Close returned %v while its job was still running", err)
	default:
	}
	// Cancelling the job's own context is the documented way to let a Close
	// without a deadline finish.
	cancelJob()
	if err := <-jobErr; !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled job: %v", err)
	}
	if err := <-closeErr; err != nil {
		t.Fatalf("Close after its last job finished: %v", err)
	}
}

func TestCloseIsIdempotent(t *testing.T) {
	c := newCompiler(t, noopCommand, nil)
	for range 2 {
		if err := c.Close(t.Context()); err != nil {
			t.Fatal(err)
		}
	}
	// An expired context does not fail an idle Close.
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := c.Close(ctx); err != nil {
		t.Fatalf("idle Close with an expired context: %v", err)
	}
	assertClosed(t, c)
}

// TestCloseRacesWithCalls drives Close against a stream of short jobs; the race
// detector checks the job registry and every result must be one of the two
// documented outcomes.
func TestCloseRacesWithCalls(t *testing.T) {
	c := newCompiler(t, noopCommand, nil)
	var completed atomic.Int64
	var workers sync.WaitGroup
	for range 4 {
		workers.Go(func() {
			for {
				_, err := c.Compile(t.Context(), compileOnly())
				if errors.Is(err, capnpcwasm.ErrClosed) {
					return
				}
				var failure *capnpcwasm.Error
				if !errors.As(err, &failure) || failure.Stage != capnpcwasm.StageCompiler {
					t.Errorf("unexpected job result: %v", err)
					return
				}
				completed.Add(1)
			}
		})
	}
	waitFor(t, "jobs to complete", func() bool { return completed.Load() >= 8 })
	if err := c.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	workers.Wait()
	assertClosed(t, c)
}

func TestNewHonorsContext(t *testing.T) {
	modules := loadModules(t)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	start := time.Now()
	c, err := capnpcwasm.New(ctx, modules, testOptions()...)
	elapsed := time.Since(start)
	t.Logf("New with an expired context returned after %v", elapsed)
	var failure *capnpcwasm.Error
	if c != nil || !errors.Is(err, context.Canceled) || !errors.As(err, &failure) || failure.Stage != capnpcwasm.StageModules {
		t.Fatalf("New with an expired context: %v, %v", c, err)
	}
	if elapsed > promptly {
		t.Fatalf("New with an expired context took %v, want under %v", elapsed, promptly)
	}
}

func TestEngineOptions(t *testing.T) {
	for _, engine := range []capnpcwasm.Engine{capnpcwasm.EngineAuto, capnpcwasm.EngineCompiler, capnpcwasm.EngineInterpreter} {
		t.Run(engine.String(), func(t *testing.T) {
			c, err := capnpcwasm.New(t.Context(), capnpcwasm.Modules{Compiler: wasmBytes(t, loopCommand), Generators: map[capnpcwasm.Language][]byte{"rust": wasmBytes(t, trapCommand)}}, capnpcwasm.WithEngine(engine))
			if err != nil {
				t.Fatal(err)
			}
			defer c.Close(context.Background())
			ctx, cancel := context.WithTimeout(t.Context(), 25*time.Millisecond)
			defer cancel()
			start := time.Now()
			if _, err := c.Compile(ctx, compileOnly()); !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("termination on the %v engine: %v", engine, err)
			}
			if elapsed := time.Since(start); elapsed > promptly {
				t.Fatalf("termination on the %v engine took %v", engine, elapsed)
			}
			var failure *capnpcwasm.Error
			if _, err := c.Generate(t.Context(), generateRust()); !errors.As(err, &failure) || failure.Stage != "rust" {
				t.Fatalf("trap on the %v engine: %v", engine, err)
			}
		})
	}
	t.Run("invalid", func(t *testing.T) {
		c, err := capnpcwasm.New(t.Context(), capnpcwasm.Modules{Compiler: wasmBytes(t, noopCommand)}, capnpcwasm.WithEngine(capnpcwasm.Engine(42)))
		var failure *capnpcwasm.Error
		if c != nil || !errors.As(err, &failure) || failure.Stage != capnpcwasm.StageValidate || !errors.Is(err, capnpcwasm.ErrInvalidRequest) {
			t.Fatalf("invalid engine accepted: %v, %v", c, err)
		}
	})
}

func TestCompilationCache(t *testing.T) {
	cache := wazero.NewCompilationCache()
	defer cache.Close(context.Background())
	modules := loadModules(t)
	request := fixture(t)
	var outputs []map[capnpcwasm.Language]map[string][]byte
	var elapsed []time.Duration
	for range 2 {
		start := time.Now()
		c, err := capnpcwasm.New(t.Context(), modules, testOptions(capnpcwasm.WithCompilationCache(cache))...)
		if err != nil {
			t.Fatal(err)
		}
		elapsed = append(elapsed, time.Since(start))
		got, err := c.Compile(t.Context(), request)
		if err != nil {
			t.Fatal(err)
		}
		outputs = append(outputs, got.Outputs)
		if err := c.Close(t.Context()); err != nil {
			t.Fatal(err)
		}
	}
	t.Logf("New took %v cold and %v with a warm cache", elapsed[0], elapsed[1])
	if len(outputs[0]) != len(request.Generators) || !reflect.DeepEqual(outputs[0], outputs[1]) {
		t.Fatal("cached modules produced different output")
	}
}

// TestCloseWithExpiredContextTerminatesActiveCall closes with a context that
// has already ended while a job runs: Close returns the context error at once
// and the job fails with ErrClosed, not with the closing context's error.
func TestCloseWithExpiredContextTerminatesActiveCall(t *testing.T) {
	c := newCompiler(t, sleepCommand, nil)
	results := make(chan error, 1)
	go func() {
		_, err := c.Compile(t.Context(), compileOnly())
		results <- err
	}()
	waitFor(t, "the job to register", func() bool { return c.ActiveJobs() == 1 })
	expired, cancel := context.WithCancel(t.Context())
	cancel()
	start := time.Now()
	err := c.Close(expired)
	if elapsed := time.Since(start); !errors.Is(err, context.Canceled) || elapsed > promptly {
		t.Fatalf("Close with an expired context returned %v after %v", err, elapsed)
	}
	err = <-results
	var failure *capnpcwasm.Error
	if !errors.Is(err, capnpcwasm.ErrClosed) || errors.Is(err, context.Canceled) || !errors.As(err, &failure) || failure.Stage != capnpcwasm.StageCompiler {
		t.Fatalf("terminated job returned %v, want ErrClosed", err)
	}
	if err := c.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	assertClosed(t, c)
}
