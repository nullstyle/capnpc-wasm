package capnpcwasm_test

import (
	"context"
	"errors"
	"testing"
	"time"

	capnpcwasm "github.com/nullstyle/capnpc-wasm/sdk/go"
)

// TestMaxConcurrentJobs checks that WithMaxConcurrentJobs admits at most n
// guests, that a waiting job reports its own cancellation, and that a slot is
// released for the next job.
func TestMaxConcurrentJobs(t *testing.T) {
	c := newCompiler(t, sleepCommand, nil, capnpcwasm.WithMaxConcurrentJobs(1))
	first, cancelFirst := context.WithCancel(t.Context())
	defer cancelFirst()
	firstErr := make(chan error, 1)
	go func() {
		_, err := c.Compile(first, compileOnly())
		firstErr <- err
	}()
	waitFor(t, "the first job to run", func() bool { return c.RunningJobs() == 1 })

	second, cancelSecond := context.WithCancel(t.Context())
	defer cancelSecond()
	secondErr := make(chan error, 1)
	go func() {
		_, err := c.Compile(second, compileOnly())
		secondErr <- err
	}()
	waitFor(t, "the second job to register", func() bool { return c.ActiveJobs() == 2 })
	time.Sleep(20 * time.Millisecond)
	if running := c.RunningJobs(); running != 1 {
		t.Fatalf("%d jobs run with one slot", running)
	}

	start := time.Now()
	cancelSecond()
	err := <-secondErr
	var failure *capnpcwasm.Error
	if !errors.Is(err, context.Canceled) || errors.Is(err, capnpcwasm.ErrClosed) || !errors.As(err, &failure) || failure.Stage != capnpcwasm.StageValidate {
		t.Fatalf("job cancelled while waiting: %v", err)
	}
	if elapsed := time.Since(start); elapsed > promptly {
		t.Fatalf("waiting job took %v to observe its cancellation", elapsed)
	}
	cancelFirst()
	if err := <-firstErr; !errors.Is(err, context.Canceled) || !errors.As(err, &failure) || failure.Stage != capnpcwasm.StageCompiler {
		t.Fatalf("running job: %v", err)
	}
	waitFor(t, "the slot to be released", func() bool { return c.RunningJobs() == 0 && c.ActiveJobs() == 0 })

	// The released slot admits the next job.
	ctx, cancel := context.WithTimeout(t.Context(), 25*time.Millisecond)
	defer cancel()
	if _, err := c.Compile(ctx, compileOnly()); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("job after the slot was released: %v", err)
	}
}

// TestMaxConcurrentJobsAdmitsN checks that n jobs run at once.
func TestMaxConcurrentJobsAdmitsN(t *testing.T) {
	c := newCompiler(t, sleepCommand, nil, capnpcwasm.WithMaxConcurrentJobs(2))
	ctx, cancel := context.WithCancel(t.Context())
	errs := make(chan error, 2)
	for range 2 {
		go func() {
			_, err := c.Compile(ctx, compileOnly())
			errs <- err
		}()
	}
	waitFor(t, "both jobs to run", func() bool { return c.RunningJobs() == 2 })
	cancel()
	for range 2 {
		if err := <-errs; !errors.Is(err, context.Canceled) {
			t.Fatalf("job: %v", err)
		}
	}
}

// TestCloseTerminatesWaitingJobs checks that Close at its deadline terminates
// a job that is still waiting for a slot, with ErrClosed like a running one.
func TestCloseTerminatesWaitingJobs(t *testing.T) {
	c := newCompiler(t, sleepCommand, nil, capnpcwasm.WithMaxConcurrentJobs(1))
	results := make(chan error, 2)
	go func() {
		_, err := c.Compile(t.Context(), compileOnly())
		results <- err
	}()
	waitFor(t, "the first job to run", func() bool { return c.RunningJobs() == 1 })
	go func() {
		_, err := c.Compile(t.Context(), compileOnly())
		results <- err
	}()
	waitFor(t, "the second job to wait", func() bool { return c.ActiveJobs() == 2 })
	ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
	defer cancel()
	if err := c.Close(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Close: %v", err)
	}
	stages := map[capnpcwasm.Stage]int{}
	for range 2 {
		err := <-results
		var failure *capnpcwasm.Error
		if !errors.Is(err, capnpcwasm.ErrClosed) || !errors.As(err, &failure) {
			t.Fatalf("terminated job: %v", err)
		}
		stages[failure.Stage]++
	}
	if stages[capnpcwasm.StageCompiler] != 1 || stages[capnpcwasm.StageValidate] != 1 {
		t.Fatalf("terminated stages %v, want one running (compiler) and one waiting (validate)", stages)
	}
	if err := c.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	assertClosed(t, c)
}
