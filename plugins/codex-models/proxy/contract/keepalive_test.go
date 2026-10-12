//go:build contract

package contract

import (
	"net/http"
	"testing"
	"time"
)

// With a 50 ms interval, a stream that stalls inside the message gets pings;
// none go out before message_start or after message_stop.
func TestKeepalivePingsOnlyInsideTheMessage(t *testing.T) {
	e := loggedIn(t, opts{ping: "50ms"})
	e.cdx.set(func(w http.ResponseWriter, _ *http.Request, _ rec) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fl := w.(http.Flusher)
		fl.Flush()
		time.Sleep(400 * time.Millisecond) // headers sent, message not started
		sseChunk(w, fl, evCreated)
		time.Sleep(500 * time.Millisecond) // stalled inside the message
		sseChunk(w, fl, evText("a"))
		time.Sleep(300 * time.Millisecond) // stalled inside a text block
		sseChunk(w, fl, evCompleted)
		time.Sleep(400 * time.Millisecond) // the connection stays open after the end
	})
	r := e.post("/v1/messages", claudeReq("gpt-6-astra", true, nil))
	if r.Status != 200 {
		t.Fatalf("status = %d", r.Status)
	}
	evs := parseSSE(t, r.Body)
	start, stop := indexOf(evs, "message_start"), indexOf(evs, "message_stop")
	if start != 0 || stop != len(evs)-1 {
		t.Fatalf("events = %v", names(evs))
	}
	pings := 0
	for i, ev := range evs {
		if ev.Name != "ping" {
			continue
		}
		pings++
		if i < start || i > stop {
			t.Fatalf("ping %d outside the message (start %d, stop %d)", i, start, stop)
		}
		if ev.Data["type"] != "ping" {
			t.Fatalf("ping data = %v", ev.Data)
		}
	}
	// 800 ms of stalls inside the message at 50 ms: far more than a few.
	if pings < 4 {
		t.Fatalf("only %d pings in %v", pings, names(evs))
	}
	// Pings fall between whole events: the stream still parses as a message.
	var rest []sseEvent
	for _, ev := range evs {
		if ev.Name != "ping" {
			rest = append(rest, ev)
		}
	}
	wellFormed(t, rest)
}

func TestNoPingsOnAFastStream(t *testing.T) {
	e := loggedIn(t, opts{ping: "50ms"})
	e.cdx.set(answerWith(evCreated, evText("a"), evCompleted))
	evs := parseSSE(t, e.post("/v1/messages", claudeReq("gpt-6-astra", true, nil)).Body)
	if indexOf(evs, "ping") >= 0 {
		t.Fatalf("pings on a fast stream: %v", names(evs))
	}
}

func sseChunk(w http.ResponseWriter, fl http.Flusher, ev string) {
	sseAnswerBody(w, ev)
	fl.Flush()
}
