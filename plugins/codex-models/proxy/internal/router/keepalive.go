package router

import (
	"context"
	"io"
	"sync"
	"time"

	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/logx"
)

// defaultPingInterval is how long a streamed answer may stay silent before a
// ping goes out. Claude Code drops a stream that sends no bytes for about
// 180 s, and a long tool call is sent only once Codex finished its arguments,
// which can take minutes.
const defaultPingInterval = 10 * time.Second

// pingFrame is Anthropic's own keepalive event, which clients skip.
var pingFrame = []byte("event: ping\ndata: {\"type\": \"ping\"}\n\n")

// sseWriter writes a streamed answer and keeps it alive: while the message is
// open (after message_start, before message_stop or an error), a ping goes
// out whenever nothing was written for the interval. Frames and pings are
// written under one lock, so a ping always falls between two whole events.
type sseWriter struct {
	ctx      context.Context
	w        io.Writer
	flush    func() error
	interval time.Duration

	mu sync.Mutex
	// timer fires ping; it exists from the first write that leaves the
	// message open and is stopped whenever the message is not open.
	timer *time.Timer
	// open is whether the message is open after the last write.
	open bool
	// done is set by close, or by a write to the client that failed;
	// nothing is written after it.
	done bool
}

func newSSEWriter(ctx context.Context, w io.Writer, flush func() error, interval time.Duration) *sseWriter {
	return &sseWriter{ctx: ctx, w: w, flush: flush, interval: interval}
}

// write sends frames, then records whether the message is open after them.
// It reports false once the client can no longer be written to.
func (s *sseWriter) write(frames []byte, open bool) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.done {
		return false
	}
	if len(frames) > 0 && !s.sendLocked(frames, "write") {
		return false
	}
	s.open = open
	switch {
	case !open || s.interval <= 0:
		s.stopLocked()
	case s.timer == nil:
		s.timer = time.AfterFunc(s.interval, s.ping)
	case len(frames) > 0:
		// Only bytes that went out restart the wait; an event that made no
		// frame (a call's argument delta) leaves it running.
		s.timer.Reset(s.interval)
	}
	return true
}

// ping runs on the timer's goroutine.
func (s *sseWriter) ping() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.done || !s.open || s.ctx.Err() != nil {
		return
	}
	if s.sendLocked(pingFrame, "ping") {
		s.timer.Reset(s.interval)
	}
}

// sendLocked writes and flushes b, a whole event (what names it in the log).
// A failed write marks the writer done and stops the pings: the client has
// gone.
func (s *sseWriter) sendLocked(b []byte, what string) bool {
	if _, err := s.w.Write(b); err != nil {
		logx.Debugf("codex stream: client %s failed: %v", what, err)
		s.done = true
		s.stopLocked()
		return false
	}
	_ = s.flush()
	return true
}

// close stops the pings; nothing is written after it returns.
func (s *sseWriter) close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.done = true
	s.stopLocked()
}

func (s *sseWriter) stopLocked() {
	if s.timer != nil {
		s.timer.Stop()
	}
}
