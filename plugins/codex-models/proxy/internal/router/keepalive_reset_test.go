package router

import (
	"bytes"
	"context"
	"sync"
	"testing"
	"time"
)

// lockedBuffer is a bytes.Buffer safe to write from the ping goroutine.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) pings() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return bytes.Count(b.buf.Bytes(), pingFrame)
}

// A ping goes out only after the interval passes with nothing written: frames
// written more often than that keep it from going out.
func TestAWrittenFrameRestartsTheWait(t *testing.T) {
	const interval = 250 * time.Millisecond
	var out lockedBuffer
	w := newSSEWriter(context.Background(), &out, func() error { return nil }, interval)
	defer w.close()

	frame := []byte("event: content_block_delta\ndata: {}\n\n")
	w.write([]byte("event: message_start\ndata: {}\n\n"), true)
	for end := time.Now().Add(600 * time.Millisecond); time.Now().Before(end); {
		time.Sleep(20 * time.Millisecond)
		w.write(frame, true)
	}
	if n := out.pings(); n != 0 {
		t.Fatalf("%d ping(s) went out while frames flowed every 20 ms", n)
	}

	time.Sleep(3 * interval)
	if n := out.pings(); n == 0 {
		t.Fatal("no ping after a silence of three intervals")
	}
}
