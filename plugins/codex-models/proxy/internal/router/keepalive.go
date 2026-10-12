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
// open (after message_start, before message_stop or an error), a ping goes out
// whenever nothing was written for the interval. Frames and pings are written
// under one lock, so a ping always falls between two whole events.
type sseWriter struct {
	ctx      context.Context
	w        io.Writer
	flush    func() error
	interval time.Duration

	mu     sync.Mutex
	timer  *time.Timer
	open   bool
	closed bool
	failed bool
}

func newSSEWriter(ctx context.Context, w io.Writer, flush func() error, interval time.Duration) *sseWriter {
	return &sseWriter{ctx: ctx, w: w, flush: flush, interval: interval}
}

// write sends frames, then records whether the message is open after them.
// It reports false once the client can no longer be written to.
func (s *sseWriter) write(frames []byte, open bool) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.failed {
		return false
	}
	if len(frames) > 0 {
		if _, err := s.w.Write(frames); err != nil {
			logx.Debugf("codex stream: client write failed: %v", err)
			s.failed = true
			s.stopLocked()
			return false
		}
		_ = s.flush()
	}
	s.open = open
	switch {
	case !open || s.interval <= 0:
		s.stopLocked()
	case s.timer == nil:
		s.timer = time.AfterFunc(s.interval, s.ping)
	case len(frames) > 0:
		// Only bytes that went out restart the wait; events that produced
		// no frame (a call's argument deltas) leave it running.
		s.timer.Reset(s.interval)
	}
	return true
}

// ping runs on the timer's goroutine.
func (s *sseWriter) ping() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.failed || !s.open || s.ctx.Err() != nil {
		return
	}
	if _, err := s.w.Write(pingFrame); err != nil {
		logx.Debugf("codex stream: client ping failed: %v", err)
		s.failed = true
		return
	}
	_ = s.flush()
	s.timer.Reset(s.interval)
}

// close stops the pings; nothing is written after it returns.
func (s *sseWriter) close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	s.stopLocked()
}

func (s *sseWriter) stopLocked() {
	if s.timer != nil {
		s.timer.Stop()
	}
}
