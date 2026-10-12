//go:build contract

package contract

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// oddBody is valid JSON whose bytes a re-encoder would change: key order,
// spacing, escapes and a number form.
var oddBody = []byte("{ \"stream\" : false,\n\t\"model\":\"claude-sonnet-5\", \"max_tokens\":  1.0e3,\n \"messages\":[ {\"role\":\"user\",\"content\":\"caf\\u00e9 \\/ <b>&amp;</b>\"} ] }\n")

func TestPassthroughBytesBothWays(t *testing.T) {
	e := loggedIn(t, opts{})
	reply := []byte("{\"id\":\"msg_x\",  \"type\":\"message\",\"note\":\"caf\\u00e9\"}\n")
	e.anth.set(func(w http.ResponseWriter, _ *http.Request, _ rec) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Request-Id", "req_123")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Expose-Headers", "X-Request-Id")
		_, _ = w.Write(reply)
	})
	r := e.do(http.MethodPost, "/v1/messages", oddBody, map[string]string{
		"Authorization":     "Bearer oauth-token",
		"Anthropic-Version": "2023-06-01",
		"Anthropic-Beta":    "x-1,x-2",
		"X-Api-Key":         "key-1",
	})
	if r.Status != 200 || !bytes.Equal(r.Body, reply) {
		t.Fatalf("response = %d %q, want the fake's bytes", r.Status, r.Body)
	}
	if r.Header.Get("X-Request-Id") != "req_123" {
		t.Fatal("an upstream header was dropped")
	}
	noCORS(t, r)

	got := e.anth.last(t)
	if got.Method != "POST" || got.Path != "/v1/messages" {
		t.Fatalf("upstream saw %s %s", got.Method, got.Path)
	}
	if !bytes.Equal(got.Body, oddBody) {
		t.Fatalf("request body changed:\n%q\n%q", got.Body, oddBody)
	}
	for k, v := range map[string]string{
		"Authorization": "Bearer oauth-token", "Anthropic-Version": "2023-06-01",
		"Anthropic-Beta": "x-1,x-2", "X-Api-Key": "key-1", "Content-Type": "application/json",
	} {
		if got.Header.Get(k) != v {
			t.Fatalf("upstream header %s = %q, want %q", k, got.Header.Get(k), v)
		}
	}
	if got.Host != strings.TrimPrefix(e.anth.URL, "http://") {
		t.Fatalf("upstream Host = %q, want the upstream's own", got.Host)
	}
	if e.cdx.count() != 0 {
		t.Fatal("a Claude model reached the Codex backend")
	}
}

func TestPassthroughOtherPathsAndStatuses(t *testing.T) {
	e := newEnv(t, opts{})
	e.anth.set(func(w http.ResponseWriter, _ *http.Request, got rec) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}`))
	})
	r := e.do(http.MethodGet, "/v1/organizations/o1/usage?limit=2&x=%20y", nil, nil)
	if r.Status != 429 || string(r.Body) != `{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}` {
		t.Fatalf("response = %d %s", r.Status, r.Body)
	}
	got := e.anth.last(t)
	if got.Method != "GET" || got.Path != "/v1/organizations/o1/usage" || got.Query != "limit=2&x=%20y" {
		t.Fatalf("upstream saw %s %s?%s", got.Method, got.Path, got.Query)
	}
}

func TestPassthroughStreamingBytes(t *testing.T) {
	e := newEnv(t, opts{})
	stream := "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\"}}\n\n" +
		"event: ping\ndata: {\"type\": \"ping\"}\n\n" +
		": a comment line\n\n" +
		"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
	e.anth.set(func(w http.ResponseWriter, _ *http.Request, _ rec) {
		w.Header().Set("Content-Type", "text/event-stream")
		fl := w.(http.Flusher)
		for _, chunk := range []string{stream[:30], stream[30:97], stream[97:]} {
			_, _ = w.Write([]byte(chunk))
			fl.Flush()
		}
	})
	body := claudeReq("claude-opus-5", true, nil)
	r := e.post("/v1/messages", body)
	if r.Status != 200 || string(r.Body) != stream {
		t.Fatalf("stream differs:\n%q\n%q", r.Body, stream)
	}
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("content-type = %q", r.Header.Get("Content-Type"))
	}
	if !bytes.Equal(e.anth.last(t).Body, body) {
		t.Fatal("request body changed")
	}
}

func TestPassthroughDoesNotFollowRedirects(t *testing.T) {
	e := newEnv(t, opts{})
	e.anth.set(func(w http.ResponseWriter, _ *http.Request, _ rec) {
		w.Header().Set("Location", "http://127.0.0.1:1/elsewhere")
		w.WriteHeader(http.StatusFound)
		_, _ = w.Write([]byte("moved"))
	})
	for _, path := range []string{"/v1/messages", "/v1/other"} {
		r := e.post(path, claudeReq("claude-sonnet-5", false, nil))
		if r.Status != http.StatusFound || r.Header.Get("Location") != "http://127.0.0.1:1/elsewhere" || string(r.Body) != "moved" {
			t.Fatalf("%s: response = %d %q %q", path, r.Status, r.Header.Get("Location"), r.Body)
		}
	}
	if e.anth.count() != 2 {
		t.Fatalf("upstream saw %d requests, want 2 (no follow)", e.anth.count())
	}
}

func TestPassthroughUpstreamDown(t *testing.T) {
	e := newEnv(t, opts{})
	e.anth.Close()
	r := e.post("/v1/messages", claudeReq("claude-sonnet-5", false, nil))
	if r.Status != http.StatusBadGateway {
		t.Fatalf("status = %d", r.Status)
	}
	if kind, _ := r.errInfo(t); kind != "api_error" {
		t.Fatalf("error type = %q", kind)
	}
}

// Thinking blocks the proxy issued (signature ccmp1:...) are dropped from a
// request that goes to Anthropic; everything else stays byte for byte.
func TestPassthroughStripsProxyThinkingBlocks(t *testing.T) {
	e := newEnv(t, opts{})
	e.anth.set(func(w http.ResponseWriter, _ *http.Request, _ rec) { _, _ = w.Write([]byte(`{}`)) })

	keepThinking := `{"type":"thinking",  "thinking":"real","signature":"sig-from-anthropic"}`
	keepText := `{"type":"text", "text":"café"}`
	keepTool := `{"type":"tool_use","id":"toolu_1","name":"Read","input":{"b":1,  "a":2}}`
	ours := `{"type":"thinking","thinking":"codex","signature":"ccmp1:ENCRYPTED"}`
	body := `{"model":"claude-sonnet-5","max_tokens":9,"messages":[` +
		`{"role":"user","content":"hi"},` +
		`{"role":"assistant","content":[` + ours + `,` + keepText + `,` + ours + `,` + keepThinking + `,` + keepTool + `]},` +
		`{"role":"user","content":[{"type":"text","text":"more"}]}]}`

	for _, path := range []string{"/v1/messages", "/v1/messages/count_tokens"} {
		e.post(path, []byte(body))
		got := string(e.anth.last(t).Body)
		if strings.Contains(got, "ccmp1:") {
			t.Fatalf("%s: a proxy signature reached the upstream: %s", path, got)
		}
		for _, kept := range []string{keepThinking, keepText, keepTool, `{"role":"user","content":"hi"}`, `{"role":"user","content":[{"type":"text","text":"more"}]}`} {
			if !strings.Contains(got, kept) {
				t.Fatalf("%s: block %s was altered or dropped:\n%s", path, kept, got)
			}
		}
		var parsed struct {
			Messages []struct {
				Content json.RawMessage `json:"content"`
			} `json:"messages"`
		}
		must(t, json.Unmarshal([]byte(got), &parsed))
		var blocks []map[string]any
		must(t, json.Unmarshal(parsed.Messages[1].Content, &blocks))
		if len(blocks) != 3 {
			t.Fatalf("%s: the assistant message has %d blocks, want 3", path, len(blocks))
		}
	}

	// A request with no proxy signature is forwarded byte for byte.
	plain := []byte(`{ "model":"claude-sonnet-5","messages":[{"role":"assistant","content":[` + keepThinking + `]}] }`)
	e.post("/v1/messages", plain)
	if !bytes.Equal(e.anth.last(t).Body, plain) {
		t.Fatal("a request without proxy signatures was altered")
	}
}

// A gzip body is forwarded as the client sent it, and still routes by model.
func TestGzipBodies(t *testing.T) {
	e := loggedIn(t, opts{})
	gz := func(b []byte) []byte {
		var buf bytes.Buffer
		w := gzip.NewWriter(&buf)
		_, _ = w.Write(b)
		_ = w.Close()
		return buf.Bytes()
	}
	e.anth.set(func(w http.ResponseWriter, _ *http.Request, _ rec) { _, _ = w.Write([]byte(`{"ok":true}`)) })
	packed := gz(oddBody)
	r := e.do(http.MethodPost, "/v1/messages", packed, map[string]string{"Content-Encoding": "gzip"})
	if r.Status != 200 {
		t.Fatalf("status = %d", r.Status)
	}
	got := e.anth.last(t)
	if !bytes.Equal(got.Body, packed) || got.Header.Get("Content-Encoding") != "gzip" {
		t.Fatal("the gzip body was not forwarded as sent")
	}

	e.cdx.set(answerWith(evCreated, evText("ok"), evCompleted))
	r = e.do(http.MethodPost, "/v1/messages", gz(claudeReq("gpt-6-astra", true, nil)), map[string]string{"Content-Encoding": "gzip"})
	if r.Status != 200 || e.cdx.count() != 1 {
		t.Fatalf("a gzip body for a Codex model: status %d, codex requests %d", r.Status, e.cdx.count())
	}
	if e.anth.count() != 1 {
		t.Fatal("a gzip body for a Codex model went to Anthropic")
	}
}
