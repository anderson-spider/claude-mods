//go:build contract

package contract

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

// sessionID mirrors the documented metadata.user_id derivation: an
// HMAC-SHA-256 of the client's user id keyed by session_salt, shaped as a v4 UUID.
func sessionID(salt, userID string) string {
	mac := hmac.New(sha256.New, []byte(salt))
	mac.Write([]byte(userID))
	id := mac.Sum(nil)[:16]
	id[6] = id[6]&0x0f | 0x40
	id[8] = id[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", id[0:4], id[4:6], id[6:8], id[8:10], id[10:16])
}

// A Codex request reaches the remote as Anthropic Messages with only the
// allowlisted headers: no Anthropic credential, proxy secret or client identity.
func TestRelayHeadersCarryNoCredentials(t *testing.T) {
	e := withAccount(t, opts{})
	e.cdx.set(jsonAnswer(`[{"type":"text","text":"ok"}]`))
	r := e.do(http.MethodPost, "/v1/messages", claudeReq("gpt-6-astra", false, nil), map[string]string{
		"Authorization":            "Bearer SENTINEL_OAUTH",
		"X-Api-Key":                "SENTINEL_APIKEY",
		"Cookie":                   "session=SENTINEL_COOKIE",
		"User-Agent":               "claude-cli/9.9.9",
		"X-Claude-Code-Session-Id": "SENTINEL_SESSION",
		"Anthropic-Version":        "2023-06-01",
		"Anthropic-Beta":           "oauth-2025-04-20,interleaved-thinking-2025-05-14",
		"Accept":                   "application/json",
	})
	if r.Status != 200 {
		t.Fatalf("status = %d: %s", r.Status, r.Body)
	}
	got := e.cdx.last(t)
	if got.Method != http.MethodPost || got.Path != "/v1/messages" || got.Query != "" {
		t.Fatalf("remote request = %s %s?%s", got.Method, got.Path, got.Query)
	}
	for _, name := range []string{"Authorization", "X-Api-Key", "Cookie", "User-Agent", "X-Ccmproxy-Token", "X-Claude-Code-Session-Id"} {
		if v := got.Header.Values(name); len(v) > 0 {
			t.Errorf("remote got %s = %q", name, v)
		}
	}
	for name, want := range map[string]string{
		"Anthropic-Version": "2023-06-01",
		"Anthropic-Beta":    "oauth-2025-04-20,interleaved-thinking-2025-05-14",
		"Content-Type":      "application/json",
		"Accept":            "application/json",
	} {
		if v := got.Header.Get(name); v != want {
			t.Errorf("remote got %s = %q, want %q", name, v, want)
		}
	}
	for name, values := range got.Header {
		for _, v := range values {
			for _, secret := range []string{"SENTINEL", e.token, e.mgmtKey} {
				if strings.Contains(v, secret) {
					t.Errorf("remote header %s carries %q", name, secret)
				}
			}
		}
	}
	if e.anth.count() != 0 {
		t.Fatal("a Codex request reached Anthropic")
	}
}

// The body goes untranslated except for the controlled fields: the model with
// its effort, the user id HMAC, and thinking state only the remote issued.
func TestRelayBodyRewrite(t *testing.T) {
	e := withAccount(t, opts{})
	e.cdx.set(jsonAnswer(`[{"type":"text","text":"ok"}]`))
	body := claudeReq("gpt-6-astra", false, map[string]any{
		"system":        "be brief",
		"thinking":      map[string]any{"type": "enabled", "budget_tokens": 2048},
		"output_config": map[string]any{"effort": "high", "other": 1},
		"metadata":      map[string]any{"user_id": "user-abc", "keep": "x"},
		"tools":         []any{map[string]any{"name": "Read", "input_schema": map[string]any{"type": "object"}}},
		"messages": []any{
			map[string]any{"role": "user", "content": "first"},
			map[string]any{"role": "assistant", "content": []any{
				map[string]any{"type": "thinking", "thinking": "ours", "signature": "ccmp1:REMOTE_STATE"},
				map[string]any{"type": "thinking", "thinking": "foreign", "signature": "ANTHROPIC_STATE"},
				map[string]any{"type": "redacted_thinking", "data": "REDACTED"},
				map[string]any{"type": "text", "text": "answer"},
			}},
			map[string]any{"role": "user", "content": "second"},
		},
	})
	if r := e.post("/v1/messages", body); r.Status != 200 {
		t.Fatalf("status = %d: %s", r.Status, r.Body)
	}
	var got map[string]any
	must(t, json.Unmarshal(e.cdx.last(t).Body, &got))
	if got["model"] != "gpt-6-astra(high)" {
		t.Errorf("model = %v", got["model"])
	}
	if _, ok := got["thinking"]; ok {
		t.Errorf("thinking config was forwarded: %v", got["thinking"])
	}
	if oc := got["output_config"].(map[string]any); len(oc) != 1 || oc["other"].(float64) != 1 {
		t.Errorf("output_config = %v", oc)
	}
	md := got["metadata"].(map[string]any)
	if md["user_id"] != sessionID(e.salt, "user-abc") || md["keep"] != "x" {
		t.Errorf("metadata = %v", md)
	}
	if got["system"] != "be brief" || got["max_tokens"].(float64) != 1024 || len(got["tools"].([]any)) != 1 {
		t.Errorf("untouched fields changed: %v", got)
	}
	msgs := got["messages"].([]any)
	if len(msgs) != 3 {
		t.Fatalf("messages = %v", msgs)
	}
	blocks := msgs[1].(map[string]any)["content"].([]any)
	if len(blocks) != 2 {
		t.Fatalf("assistant blocks = %v", blocks)
	}
	if b := blocks[0].(map[string]any); b["type"] != "thinking" || b["thinking"] != "ours" || b["signature"] != "REMOTE_STATE" {
		t.Errorf("remote thinking = %v", b)
	}
	if b := blocks[1].(map[string]any); b["type"] != "text" || b["text"] != "answer" {
		t.Errorf("text block = %v", b)
	}
	raw := string(e.cdx.last(t).Body)
	for _, s := range []string{"user-abc", "ANTHROPIC_STATE", "REDACTED", "ccmp1:"} {
		if strings.Contains(raw, s) {
			t.Errorf("remote body carries %q", s)
		}
	}
}

// Without output_config.effort the thinking budget picks the effort.
func TestRelayEffortFromThinking(t *testing.T) {
	e := withAccount(t, opts{})
	e.cdx.set(jsonAnswer(`[{"type":"text","text":"ok"}]`))
	for _, c := range []struct {
		thinking map[string]any
		want     string
	}{
		{map[string]any{"type": "disabled"}, "gpt-6-astra(low)"},
		{map[string]any{"type": "enabled", "budget_tokens": 10000}, "gpt-6-astra(medium)"},
		{nil, "gpt-6-astra(medium)"},
	} {
		extra := map[string]any{}
		if c.thinking != nil {
			extra["thinking"] = c.thinking
		}
		if r := e.post("/v1/messages", claudeReq("gpt-6-astra", false, extra)); r.Status != 200 {
			t.Fatalf("status = %d: %s", r.Status, r.Body)
		}
		var got map[string]any
		must(t, json.Unmarshal(e.cdx.last(t).Body, &got))
		if got["model"] != c.want {
			t.Errorf("thinking %v: model = %v, want %s", c.thinking, got["model"], c.want)
		}
	}
}

// Every thinking signature the remote issues reaches the client marked, so a
// later Claude turn can drop it, in a JSON answer and in a stream.
func TestRelayMarksRemoteSignatures(t *testing.T) {
	e := withAccount(t, opts{})
	t.Run("json", func(t *testing.T) {
		e.cdx.set(jsonAnswer(`[{"type":"thinking","thinking":"t","signature":"SIG_A"},{"type":"text","text":"ok"}]`))
		r := e.post("/v1/messages", claudeReq("gpt-6-astra", false, nil))
		if r.Status != 200 {
			t.Fatalf("status = %d: %s", r.Status, r.Body)
		}
		content := r.json(t)["content"].([]any)
		if sig := content[0].(map[string]any)["signature"]; sig != "ccmp1:SIG_A" {
			t.Fatalf("signature = %v", sig)
		}
	})
	t.Run("stream", func(t *testing.T) {
		e.cdx.set(answerWith(evStart,
			`{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}`,
			`{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"t"}}`,
			`{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"SIG_B"}}`,
			evStop0, evMsgDelta, evMsgStop))
		r := e.post("/v1/messages", claudeReq("gpt-6-astra", true, nil))
		if r.Status != 200 {
			t.Fatalf("status = %d: %s", r.Status, r.Body)
		}
		evs := parseSSE(t, r.Body)
		wellFormed(t, evs)
		var sigs []any
		for _, ev := range evs {
			if d, ok := ev.Data["delta"].(map[string]any); ok && d["type"] == "signature_delta" {
				sigs = append(sigs, d["signature"])
			}
		}
		if len(sigs) != 1 || sigs[0] != "ccmp1:SIG_B" {
			t.Fatalf("signature deltas = %v", sigs)
		}
	})
}

// A stream that ends before message_stop ends with an error event, never a
// silent truncation that looks complete.
func TestRelayStreamEndingEarlyIsAnError(t *testing.T) {
	e := withAccount(t, opts{})
	e.cdx.set(answerWith(evStart, evTextStart, evText("partial")))
	r := e.post("/v1/messages", claudeReq("gpt-6-astra", true, nil))
	if r.Status != 200 {
		t.Fatalf("status = %d", r.Status)
	}
	evs := parseSSE(t, r.Body)
	last := evs[len(evs)-1]
	if last.Name != "error" || indexOf(evs, "message_stop") >= 0 {
		t.Fatalf("events = %v", names(evs))
	}
	if errObj := last.Data["error"].(map[string]any); errObj["type"] != "api_error" || !strings.Contains(errObj["message"].(string), "ended early") {
		t.Fatalf("error = %v", last.Data)
	}
}

// count_tokens for a Codex model is answered locally.
func TestRelayCountTokensIsLocal(t *testing.T) {
	e := withAccount(t, opts{})
	r := e.post("/v1/messages/count_tokens", claudeReq("gpt-6-astra", false, map[string]any{
		"messages": []any{map[string]any{"role": "user", "content": strings.Repeat("hello world ", 50)}},
	}))
	if r.Status != 200 {
		t.Fatalf("status = %d: %s", r.Status, r.Body)
	}
	if n, _ := r.json(t)["input_tokens"].(float64); n <= 0 {
		t.Fatalf("input_tokens = %v", r.json(t)["input_tokens"])
	}
	if e.cdx.count() != 0 || e.anth.count() != 0 {
		t.Fatalf("count_tokens left the proxy: remote=%d anthropic=%d", e.cdx.count(), e.anth.count())
	}
}
