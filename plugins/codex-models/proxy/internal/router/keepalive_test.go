package router

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

const pingTestInterval = 20 * time.Millisecond

// pausedToolCallBackend streams the same call as toolCallBackend, pausing
// before each argument delta and before the item ends, as Codex does while it
// writes a long input.
func pausedToolCallBackend(short string, pause time.Duration) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeSSE(w, `{"type":"response.created","response":{"id":"resp_tool","model":"gpt-6-luna"}}`)
		writeSSE(w, `{"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_77","name":"`+short+`"}}`)
		time.Sleep(pause)
		writeSSE(w, `{"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc_1","delta":"{\"answer\":"}`)
		time.Sleep(pause)
		writeSSE(w, `{"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc_1","delta":"\"done\"}"}`)
		time.Sleep(pause)
		writeSSE(w, `{"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_77","name":"`+short+`","arguments":"{\"answer\":\"done\"}"}}`)
		writeSSE(w, `{"type":"response.completed","response":{"id":"resp_tool","usage":{"input_tokens":10,"output_tokens":5}}}`)
	}
}

const toolStreamRequest = `{"model":"gpt-6-luna","max_tokens":300,"stream":true,
	"messages":[{"role":"user","content":"report back"}],
	"tools":[{"name":"StructuredOutput","input_schema":{"type":"object","properties":{"answer":{"type":"string"}}}}]}`

// withoutPings drops the ping events, keeping the rest of the stream as sent.
func withoutPings(body string) string {
	var kept []string
	for _, block := range strings.Split(body, "\n\n") {
		if block != "event: ping\ndata: {\"type\": \"ping\"}" {
			kept = append(kept, block)
		}
	}
	return strings.Join(kept, "\n\n")
}

// checkPingPlacement fails when a ping comes before message_start or after
// message_stop or an error, and returns how many pings there were.
func checkPingPlacement(t *testing.T, body string) int {
	t.Helper()
	names, _ := sseEvents(body)
	if len(names) == 0 || names[0] != "message_start" {
		t.Fatalf("the stream must open with message_start: %v", names)
	}
	pings, ended := 0, false
	for _, name := range names {
		switch name {
		case "ping":
			if ended {
				t.Fatalf("ping after the message ended: %v", names)
			}
			pings++
		case "message_stop", "error":
			ended = true
		}
	}
	return pings
}

func TestAStalledToolCallIsKeptAliveWithPings(t *testing.T) {
	h := newHarness(t, nil, pausedToolCallBackend("StructuredOutput", 6*pingTestInterval), true)
	h.router.pingInterval = pingTestInterval
	rec := h.do(t, http.MethodPost, "/v1/messages", toolStreamRequest)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if pings := checkPingPlacement(t, rec.Body.String()); pings < 3 {
		t.Fatalf("got %d pings over three stalls of six intervals:\n%s", pings, rec.Body.String())
	}

	// Without its pings the stream is byte for byte the one a fast upstream
	// gives: the tool_use block is unchanged.
	fast := newHarness(t, nil, toolCallBackend("StructuredOutput"), true)
	want := fast.do(t, http.MethodPost, "/v1/messages", toolStreamRequest).Body.String()
	if got := withoutPings(rec.Body.String()); got != want {
		t.Fatalf("stream without pings:\n%s\nwant:\n%s", got, want)
	}
	if !strings.Contains(want, `"partial_json":"{\"answer\":\"done\"}"`) {
		t.Fatalf("the reference stream lost the tool input:\n%s", want)
	}
}

func TestAFastStreamHasNoPing(t *testing.T) {
	h := newHarness(t, nil, toolCallBackend("StructuredOutput"), true)
	h.router.pingInterval = time.Second
	rec := h.do(t, http.MethodPost, "/v1/messages", toolStreamRequest)
	if pings := checkPingPlacement(t, rec.Body.String()); pings != 0 {
		t.Fatalf("a fast stream got %d pings:\n%s", pings, rec.Body.String())
	}
}

func TestNoPingOutsideTheMessage(t *testing.T) {
	stall := 6 * pingTestInterval
	cases := map[string]http.HandlerFunc{
		"before message_start": func(w http.ResponseWriter, r *http.Request) {
			time.Sleep(stall)
			writeSSE(w, `{"type":"response.created","response":{"id":"r"}}`)
			writeSSE(w, `{"type":"response.completed","response":{"id":"r","usage":{}}}`)
		},
		"after message_stop": func(w http.ResponseWriter, r *http.Request) {
			writeSSE(w, `{"type":"response.created","response":{"id":"r"}}`)
			writeSSE(w, `{"type":"response.output_text.delta","delta":"Hi"}`)
			writeSSE(w, `{"type":"response.completed","response":{"id":"r","usage":{}}}`)
			time.Sleep(stall)
		},
		"after an error": func(w http.ResponseWriter, r *http.Request) {
			writeSSE(w, `{"type":"response.created","response":{"id":"r"}}`)
			writeSSE(w, `{"type":"error","error":{"type":"server_error","message":"boom"}}`)
			time.Sleep(stall)
		},
	}
	for name, handler := range cases {
		h := newHarness(t, nil, handler, true)
		h.router.pingInterval = pingTestInterval
		rec := h.do(t, http.MethodPost, "/v1/messages", `{"model":"gpt-6-luna","stream":true,"messages":[]}`)
		if pings := checkPingPlacement(t, rec.Body.String()); pings != 0 {
			t.Errorf("%s: %d pings:\n%s", name, pings, rec.Body.String())
		}
	}
}

// streamRecorder is a ResponseWriter that the test can read while the
// handler still runs, and that fails a write once the handler returned.
type streamRecorder struct {
	t        *testing.T
	header   http.Header
	mu       sync.Mutex
	body     bytes.Buffer
	returned bool
}

func (s *streamRecorder) Header() http.Header { return s.header }
func (s *streamRecorder) WriteHeader(int)     {}
func (s *streamRecorder) Flush()              {}
func (s *streamRecorder) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.returned {
		s.t.Errorf("write after the handler returned: %q", p)
	}
	return s.body.Write(p)
}

func (s *streamRecorder) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.body.String()
}

func TestACancelledClientStopsThePings(t *testing.T) {
	h := newHarness(t, nil, func(w http.ResponseWriter, r *http.Request) {
		writeSSE(w, `{"type":"response.created","response":{"id":"r"}}`)
		writeSSE(w, `{"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"StructuredOutput"}}`)
		<-r.Context().Done()
	}, true)
	h.router.pingInterval = pingTestInterval

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(toolStreamRequest)).WithContext(ctx)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("anthropic-version", "2023-06-01")
	rec := &streamRecorder{t: t, header: http.Header{}}
	done := make(chan struct{})
	go func() {
		defer close(done)
		h.router.ServeHTTP(rec, req)
		rec.mu.Lock()
		rec.returned = true
		rec.mu.Unlock()
	}()

	deadline := time.Now().Add(5 * time.Second)
	for strings.Count(rec.String(), "event: ping") < 2 {
		if time.Now().After(deadline) {
			t.Fatalf("no pings while the upstream stalls:\n%s", rec.String())
		}
		time.Sleep(pingTestInterval / 2)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the handler did not return after the client went away")
	}
	before := rec.String()
	time.Sleep(10 * pingTestInterval)
	if after := rec.String(); after != before {
		t.Fatalf("written after the handler returned:\n%s", strings.TrimPrefix(after, before))
	}
}

// failingWriter fails every write after the first n.
type failingWriter struct {
	mu     sync.Mutex
	writes int
	n      int
}

func (f *failingWriter) Write(p []byte) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.writes++
	if f.writes > f.n {
		return 0, errors.New("client gone")
	}
	return len(p), nil
}

func (f *failingWriter) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.writes
}

func TestSSEWriterLeavesNoTimerBehind(t *testing.T) {
	settle := func() int {
		// The timer's goroutine exists only while a ping runs.
		for range 50 {
			runtime.GC()
			time.Sleep(time.Millisecond)
		}
		return runtime.NumGoroutine()
	}
	baseline := settle()
	nop := func() error { return nil }
	start := []byte("event: message_start\ndata: {}\n\n")

	// Closed: no ping after close returns.
	var buf safeBuffer
	out := newSSEWriter(context.Background(), &buf, nop, time.Millisecond)
	out.write(start, true)
	time.Sleep(20 * time.Millisecond)
	out.close()
	closed := buf.String()
	if !strings.Contains(closed, "event: ping") {
		t.Fatalf("no ping while open: %q", closed)
	}
	time.Sleep(20 * time.Millisecond)
	if buf.String() != closed {
		t.Fatal("a ping went out after close")
	}
	if out.write(start, true) {
		t.Fatal("a write after close must report the client gone")
	}

	// Cancelled: the pings stop and the timer is not armed again.
	ctx, cancel := context.WithCancel(context.Background())
	var cancelled safeBuffer
	out = newSSEWriter(ctx, &cancelled, nop, time.Millisecond)
	out.write(start, true)
	cancel()
	time.Sleep(5 * time.Millisecond)
	stopped := cancelled.String()
	time.Sleep(20 * time.Millisecond)
	if cancelled.String() != stopped {
		t.Fatal("pings went on after the client went away")
	}
	out.close()

	// A ping the client refuses ends the pings and the writes.
	failing := &failingWriter{n: 1}
	out = newSSEWriter(context.Background(), failing, nop, time.Millisecond)
	out.write(start, true)
	time.Sleep(20 * time.Millisecond)
	if got := failing.count(); got != 2 {
		t.Fatalf("writes = %d, want the frame and one refused ping", got)
	}
	if out.write(start, true) {
		t.Fatal("a write after a refused ping must report the client gone")
	}
	out.close()

	if got := settle(); got > baseline {
		t.Fatalf("goroutines = %d after every writer closed, want at most %d", got, baseline)
	}
}

// safeBuffer is a bytes.Buffer the test reads while pings write to it.
type safeBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *safeBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *safeBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}
