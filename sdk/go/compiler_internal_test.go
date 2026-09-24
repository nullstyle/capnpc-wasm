package capnpcwasm

import (
	"context"
	"errors"
	"testing"
)

func bookkeepingOnly() *Compiler {
	return &Compiler{generators: map[string]command{}, jobs: map[*job]struct{}{}, idle: make(chan struct{})}
}

// TestJobRegisteredBeforeExpiredClose pins the interleaving that the public
// API cannot force: a job has registered but not yet checked its context when
// a Close whose context already ended terminates it. The job context then
// carries ErrClosed as its cause, so jobErr, which the Compile and Generate
// pre-checks and run use, reports ErrClosed rather than the context error.
func TestJobRegisteredBeforeExpiredClose(t *testing.T) {
	c := bookkeepingOnly()
	ctx, done, err := c.begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if err := jobErr(ctx); err != nil {
		t.Fatalf("live job reports %v", err)
	}
	expired, cancel := context.WithCancel(context.Background())
	cancel()
	if err := c.Close(expired); !errors.Is(err, context.Canceled) {
		t.Fatalf("Close with an expired context returned %v, want context.Canceled", err)
	}
	if err := jobErr(ctx); !errors.Is(err, ErrClosed) || errors.Is(err, context.Canceled) {
		t.Fatalf("job terminated by Close reports %v, want ErrClosed", err)
	}
	if _, _, err := c.begin(context.Background()); !errors.Is(err, ErrClosed) {
		t.Fatalf("job registered after Close: %v", err)
	}
	done()
	if err := c.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
}

// TestJobKeepsItsOwnCancellation checks that a job cancelled by its caller
// reports the caller's error, not ErrClosed.
func TestJobKeepsItsOwnCancellation(t *testing.T) {
	c := bookkeepingOnly()
	own, cancel := context.WithCancel(context.Background())
	ctx, done, err := c.begin(own)
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	if err := jobErr(ctx); !errors.Is(err, context.Canceled) || errors.Is(err, ErrClosed) {
		t.Fatalf("job cancelled by its caller reports %v, want context.Canceled", err)
	}
	done()
	if err := c.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
}
