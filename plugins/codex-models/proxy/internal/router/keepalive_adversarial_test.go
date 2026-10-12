package router

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// slowWriter writes each call a few bytes at a time with a pause between
// chunks, so a ping racing a frame would land inside it if the lock did not
// cover the whole write. It records when each ping started.
type slowWriter struct {
	mu    sync.Mutex
	buf   bytes.Buffer
	pings []time.Time
	chunk int
	pause time.Duration
}

func (s *slowWriter) Write(p []byte) (int, error) {
	if bytes.Equal(p, pingFrame) {
		s.mu.Lock()
		s.pings = append(s.pings, time.Now())
		s.mu.Unlock()
	}
	for i := 0; i < len(p); i += s.chunk {
		end := min(i+s.chunk, len(p))
		s.mu.Lock()
		s.buf.Write(p[i:end])
		s.mu.Unlock()
		if s.pause > 0 {
			time.Sleep(s.pause)
		}
	}
	return len(p), nil
}

func (s *slowWriter) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.String()
}

func (s *slowWriter) pingTimes() []time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]time.Time(nil), s.pings...)
}

const pingBlock = "event: ping\ndata: {\"type\": \"ping\"}"

// TestPingsNeverSplitAFrame writes multi-event batches through a slow
// client while pings fire every 200 µs. With the pings taken out, the bytes
// must be exactly what was written, in order.
func TestPingsNeverSplitAFrame(t *testing.T) {
	w := &slowWriter{chunk: 24, pause: 10 * time.Microsecond}
	out := newSSEWriter(context.Background(), w, func() error { return nil }, 200*time.Microsecond)
	var want strings.Builder
	start := "event: message_start\ndata: {\"type\":\"message_start\"}\n\n"
	out.write([]byte(start), true)
	want.WriteString(start)
	for i := 0; i < 120; i++ {
		batch := fmt.Sprintf("event: content_block_delta\ndata: {\"i\":%d,\"a\":\"%s\"}\n\nevent: content_block_delta\ndata: {\"i\":%d,\"b\":1}\n\n", i, strings.Repeat("x", i%40), i)
		if !out.write([]byte(batch), true) {
			t.Fatal("write refused")
		}
		want.WriteString(batch)
		if i%7 == 0 {
			time.Sleep(time.Duration(i%5) * 100 * time.Microsecond)
		}
	}
	stop := "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
	out.write([]byte(stop), false)
	want.WriteString(stop)
	time.Sleep(2 * time.Millisecond)
	out.close()

	got := w.String()
	if !strings.Contains(got, pingBlock) {
		t.Fatalf("no ping fired; the test did not exercise the race")
	}
	if withoutPings(got) != want.String() {
		t.Fatalf("a ping split a frame or reordered bytes")
	}
	if !strings.HasSuffix(got, stop) {
		t.Fatalf("bytes after message_stop: %q", got[strings.LastIndex(got, "message_stop"):])
	}
}

// TestNoPingAfterMessageStopEvenWhenTheTimerFiresAtOnce lands the ping
// timer on the same instant as message_stop, many times over.
func TestNoPingAfterMessageStopEvenWhenTheTimerFiresAtOnce(t *testing.T) {
	start := []byte("event: message_start\ndata: {}\n\n")
	stop := []byte("event: message_stop\ndata: {}\n\n")
	for i := 0; i < 2000; i++ {
		w := &slowWriter{chunk: 1 << 20}
		interval := time.Duration(20+i%80) * time.Microsecond
		out := newSSEWriter(context.Background(), w, func() error { return nil }, interval)
		out.write(start, true)
		time.Sleep(interval)
		out.write(stop, false)
		time.Sleep(time.Duration(i%3) * interval)
		got := w.String()
		out.close()
		if !strings.HasSuffix(got, string(stop)) {
			t.Fatalf("run %d (interval %v): something followed message_stop: %q", i, interval, got)
		}
		if after := w.String(); after != got {
			t.Fatalf("run %d: written after close: %q", i, strings.TrimPrefix(after, got))
		}
	}
}

// blockingPingWriter holds a ping write until released, then fails it, as a
// client that went away while the ping was in flight.
type blockingPingWriter struct {
	mu      sync.Mutex
	buf     bytes.Buffer
	inPing  chan struct{}
	release chan struct{}
	once    sync.Once
	writes  atomic.Int32
}

func (b *blockingPingWriter) Write(p []byte) (int, error) {
	b.writes.Add(1)
	if bytes.Equal(p, pingFrame) {
		b.once.Do(func() { close(b.inPing) })
		<-b.release
		return 0, fmt.Errorf("client gone")
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func TestAClientGoneDuringAPingStopsEverything(t *testing.T) {
	w := &blockingPingWriter{inPing: make(chan struct{}), release: make(chan struct{})}
	ctx, cancel := context.WithCancel(context.Background())
	out := newSSEWriter(ctx, w, func() error { return nil }, time.Millisecond)
	out.write([]byte("event: message_start\ndata: {}\n\n"), true)
	<-w.inPing
	cancel()

	// A frame and close() racing the ping must wait for it, then stop.
	wrote := make(chan bool, 1)
	go func() { wrote <- out.write([]byte("event: content_block_delta\ndata: {}\n\n"), true) }()
	closed := make(chan struct{})
	go func() { out.close(); close(closed) }()
	select {
	case <-closed:
		t.Fatal("close returned while a ping was still being written")
	case <-time.After(20 * time.Millisecond):
	}
	close(w.release)
	<-closed
	if ok := <-wrote; ok {
		// The frame may have gone first only if it won the lock before the
		// ping; it cannot, since the ping already holds it.
		t.Fatal("a frame was accepted after the ping failed")
	}
	n := w.writes.Load()
	time.Sleep(20 * time.Millisecond)
	if w.writes.Load() != n {
		t.Fatal("written after close")
	}
}

// TestALongStallPingsAtASteadyPace: many pings, never two in a burst.
func TestALongStallPingsAtASteadyPace(t *testing.T) {
	const interval = 5 * time.Millisecond
	const stall = 600 * time.Millisecond
	w := &slowWriter{chunk: 1 << 20}
	out := newSSEWriter(context.Background(), w, func() error { return nil }, interval)
	began := time.Now()
	out.write([]byte("event: message_start\ndata: {}\n\n"), true)
	// Argument deltas: events with no frame, arriving faster than the
	// interval, must not hold the pings back.
	for time.Since(began) < stall {
		out.write(nil, true)
		time.Sleep(interval / 4)
	}
	out.write([]byte("event: message_stop\ndata: {}\n\n"), false)
	out.close()

	pings := w.pingTimes()
	maxPings := int(stall/interval) + 2
	if len(pings) < int(stall/interval)/3 || len(pings) > maxPings {
		t.Fatalf("%d pings over %v at %v, want between %d and %d", len(pings), stall, interval, int(stall/interval)/3, maxPings)
	}
	for i := 1; i < len(pings); i++ {
		if gap := pings[i].Sub(pings[i-1]); gap < interval/2 {
			t.Fatalf("pings %d and %d only %v apart: a burst", i-1, i, gap)
		}
	}
}

// TestFrameFreeEventsDoNotDelayPingsThroughTheRouter streams argument deltas
// faster than the interval for a long time: pings still go out.
func TestFrameFreeEventsDoNotDelayPingsThroughTheRouter(t *testing.T) {
	h := newHarness(t, nil, func(w http.ResponseWriter, r *http.Request) {
		writeSSE(w, `{"type":"response.created","response":{"id":"r","model":"gpt-6-luna"}}`)
		writeSSE(w, `{"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"StructuredOutput"}}`)
		writeSSE(w, `{"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc_1","delta":"{\"answer\":\""}`)
		for i := 0; i < 60; i++ {
			time.Sleep(pingTestInterval / 4)
			writeSSE(w, `{"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc_1","delta":"x"}`)
		}
		writeSSE(w, `{"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc_1","delta":"\"}"}`)
		writeSSE(w, `{"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"StructuredOutput"}}`)
		writeSSE(w, `{"type":"response.completed","response":{"id":"r","usage":{}}}`)
	}, true)
	h.router.pingInterval = pingTestInterval
	rec := h.do(t, http.MethodPost, "/v1/messages", toolStreamRequest)
	if pings := checkPingPlacement(t, rec.Body.String()); pings < 3 {
		t.Fatalf("%d pings while frame-free deltas trickled for 15 intervals:\n%s", pings, rec.Body.String())
	}
}

// TestAnUpstreamFailureMidStallEndsWithAnErrorAndNoLaterPing: the upstream
// connection breaks during a stall, and an upstream error event arrives
// after a stall.
func TestAnUpstreamFailureMidStallEndsWithAnErrorAndNoLaterPing(t *testing.T) {
	stall := 5 * pingTestInterval
	cases := map[string]http.HandlerFunc{
		"connection broken": func(w http.ResponseWriter, r *http.Request) {
			writeSSE(w, `{"type":"response.created","response":{"id":"r"}}`)
			writeSSE(w, `{"type":"response.output_text.delta","delta":"Hi"}`)
			time.Sleep(stall)
			panic(http.ErrAbortHandler)
		},
		"error event": func(w http.ResponseWriter, r *http.Request) {
			writeSSE(w, `{"type":"response.created","response":{"id":"r"}}`)
			time.Sleep(stall)
			writeSSE(w, `{"type":"error","error":{"type":"server_error","message":"boom"}}`)
			time.Sleep(stall)
		},
		"response.failed": func(w http.ResponseWriter, r *http.Request) {
			writeSSE(w, `{"type":"response.created","response":{"id":"r"}}`)
			time.Sleep(stall)
			writeSSE(w, `{"type":"response.failed","response":{"id":"r","error":{"code":"server_error","message":"boom"}}}`)
			time.Sleep(stall)
		},
		"ends silently": func(w http.ResponseWriter, r *http.Request) {
			writeSSE(w, `{"type":"response.created","response":{"id":"r"}}`)
			time.Sleep(stall)
		},
	}
	for name, handler := range cases {
		h := newHarness(t, nil, handler, true)
		h.router.pingInterval = pingTestInterval
		rec := h.do(t, http.MethodPost, "/v1/messages", `{"model":"gpt-6-luna","stream":true,"messages":[]}`)
		body := rec.Body.String()
		pings := checkPingPlacement(t, body)
		names, _ := sseEvents(body)
		if names[len(names)-1] != "error" {
			t.Errorf("%s: stream ends with %v", name, names)
		}
		if pings < 2 {
			t.Errorf("%s: %d pings during the stall", name, pings)
		}
	}
}

// TestTheNonStreamingAnswerNeverCarriesAPing: a stalled non-streaming
// request answers plain JSON.
func TestTheNonStreamingAnswerNeverCarriesAPing(t *testing.T) {
	h := newHarness(t, nil, pausedToolCallBackend("StructuredOutput", 5*pingTestInterval), true)
	h.router.pingInterval = pingTestInterval
	body := strings.Replace(toolStreamRequest, `"stream":true`, `"stream":false`, 1)
	rec := h.do(t, http.MethodPost, "/v1/messages", body)
	if rec.Code != http.StatusOK || strings.Contains(rec.Body.String(), "ping") || !strings.HasPrefix(rec.Header().Get("Content-Type"), "application/json") {
		t.Fatalf("status %d type %q body %s", rec.Code, rec.Header().Get("Content-Type"), rec.Body.String())
	}
}

// TestStreamingWithPingsLeavesNoGoroutineBehind runs stalled streams through
// a real HTTP server, ending normally, by a broken upstream and by a client
// that leaves mid-stall.
func TestStreamingWithPingsLeavesNoGoroutineBehind(t *testing.T) {
	stall := 4 * pingTestInterval
	h := newHarness(t, nil, func(w http.ResponseWriter, r *http.Request) {
		writeSSE(w, `{"type":"response.created","response":{"id":"r"}}`)
		select {
		case <-time.After(stall):
		case <-r.Context().Done():
			return
		}
		writeSSE(w, `{"type":"response.completed","response":{"id":"r","usage":{}}}`)
	}, true)
	h.router.pingInterval = pingTestInterval
	server := httptest.NewServer(h.router)
	defer server.Close()
	client := server.Client()

	settle := func() int {
		for range 100 {
			runtime.GC()
			time.Sleep(2 * time.Millisecond)
		}
		return runtime.NumGoroutine()
	}
	run := func(leave bool) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, server.URL+"/v1/messages",
			strings.NewReader(`{"model":"gpt-6-luna","stream":true,"messages":[]}`))
		req.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		buf := make([]byte, 4096)
		var seen strings.Builder
		for !strings.Contains(seen.String(), "event: ping") {
			n, err := resp.Body.Read(buf)
			seen.Write(buf[:n])
			if err != nil {
				break
			}
		}
		if leave {
			cancel()
		} else {
			for {
				if _, err := resp.Body.Read(buf); err != nil {
					break
				}
			}
		}
		_ = resp.Body.Close()
	}
	run(false)
	baseline := settle()
	for i := 0; i < 10; i++ {
		run(i%2 == 0)
	}
	client.CloseIdleConnections()
	if got := settle(); got > baseline+2 {
		buf := make([]byte, 1<<16)
		n := runtime.Stack(buf, true)
		t.Fatalf("goroutines = %d after the streams, baseline %d\n%s", got, baseline, buf[:n])
	}
}

// TestAFailedFrameWriteStopsThePings: once a frame cannot be written, no
// ping is tried, even before close.
func TestAFailedFrameWriteStopsThePings(t *testing.T) {
	failing := &failingWriter{n: 1}
	out := newSSEWriter(context.Background(), failing, func() error { return nil }, time.Millisecond)
	out.write([]byte("event: message_start\ndata: {}\n\n"), true)
	if out.write([]byte("event: content_block_delta\ndata: {}\n\n"), true) {
		t.Fatal("a refused frame must report the client gone")
	}
	time.Sleep(30 * time.Millisecond)
	if got := failing.count(); got != 2 {
		t.Fatalf("writes = %d, want the frame, the refused frame and no ping", got)
	}
	if out.write([]byte("event: message_stop\ndata: {}\n\n"), false) {
		t.Fatal("a write after a refused frame must report the client gone")
	}
	out.close()
}
