package router

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/jsontest"
)

func TestRemoteRequestCanonicalizesPrivacyFieldsAndPreservesPayloads(t *testing.T) {
	body := `{"model":"claude-hidden","Model":"codex/gpt-6.1-sol:medium[1m]","metadata":{"user_id":"raw-first","User_ID":"raw-last","other":"preserved"},"thinking":{"type":"enabled"},"output_config":{"effort":"ultra","format":{"type":"json_schema","schema":{"type":"object"}}},"max_tokens":1,"messages":[{"role":"assistant","content":[{"type":"thinking","signature":"foreign-secret","thinking":"foreign"},{"type":"thinking","signature":"ccmp1:oneccmp1:two","thinking":""},{"type":"redacted_thinking","data":"foreign"},{"type":"tool_use","id":"call","name":"LongTool","input":{"signature":"do-not-change"}},{"type":"text","text":"ccmp1:literal text"}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"call","content":"ok"}]}],"tools":[{"name":"LongTool","input_schema":{"type":"object"}}]}`
	h := newHarness(t, nil, nil, true)
	rec := h.do(t, "POST", "/v1/messages", body)
	if rec.Code != 200 {
		t.Fatalf("response: %d %s", rec.Code, rec.Body.String())
	}
	sent := h.codex.body
	for _, secret := range []string{"raw-first", "raw-last", "claude-hidden", "foreign-secret", "foreign"} {
		if strings.Contains(sent, secret) {
			t.Errorf("outbound body retained %q", secret)
		}
	}
	obj := jsontest.Parse(sent)
	if obj.Get("model").String() != "gpt-6.1-sol(medium)" || obj.Get("metadata.user_id").String() != codexSessionID(h.router.cfg.SessionSalt, "raw-last") {
		t.Fatalf("privacy rewrite: %s", sent)
	}
	if obj.Get("thinking").Exists() || obj.Get("output_config.effort").Exists() || obj.Get("max_tokens").Int() != 1 || obj.Get("output_config.format.type").String() != "json_schema" {
		t.Fatalf("effort/format/ceiling rewrite: %s", sent)
	}
	if obj.Get("messages.0.content.0.signature").String() != "onetwo" || obj.Get("messages.0.content.1.input.signature").String() != "do-not-change" || obj.Get("messages.0.content.2.text").String() != "ccmp1:literal text" || obj.Get("messages.1.content.0.tool_use_id").String() != "call" {
		t.Fatalf("thinking or tool content changed incorrectly: %s", sent)
	}
}

func TestEveryJSONAndSSESignatureIsMarked(t *testing.T) {
	answer := `{"type":"message","content":[{"type":"thinking","signature":"one"},{"type":"thinking","signature":"two"},{"type":"tool_use","input":{"signature":"unchanged"}}]}`
	h := newHarness(t, nil, func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, answer) }, false)
	rec := h.do(t, "POST", "/v1/messages", `{"model":"gpt-6-luna","messages":[]}`)
	if rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	obj := jsontest.Parse(rec.Body.String())
	if obj.Get("content.0.signature").String() != "ccmp1:one" || obj.Get("content.1.signature").String() != "ccmp1:two" || obj.Get("content.2.input.signature").String() != "unchanged" {
		t.Fatal(rec.Body.String())
	}
	h = newHarness(t, nil, func(w http.ResponseWriter, r *http.Request) {
		writeSSE(w, `{"type":"message_start","message":{"content":[{"type":"thinking","signature":"initial"}]}}`)
		for _, signature := range []string{"one", "two"} {
			writeSSE(w, `{"type":"content_block_start","content_block":{"type":"thinking","signature":"`+signature+`"}}`)
			writeSSE(w, `{"type":"content_block_delta","delta":{"type":"signature_delta","signature":"`+signature+`-delta"}}`)
		}
		writeSSE(w, `{"type":"message_stop"}`)
	}, false)
	stream := h.do(t, "POST", "/v1/messages", `{"model":"gpt-6-luna","stream":true,"messages":[]}`).Body.String()
	for _, want := range []string{"ccmp1:initial", "ccmp1:one", "ccmp1:two", "ccmp1:one-delta", "ccmp1:two-delta"} {
		if !strings.Contains(stream, want) {
			t.Errorf("missing %s in %s", want, stream)
		}
	}
	if strings.Contains(stream, "event: error") {
		t.Fatal(stream)
	}
}

func TestRelayEarlyEOFAndInvalidEventsNeverInventMessageStop(t *testing.T) {
	for name, tail := range map[string]string{
		"no terminal":         "",
		"incomplete terminal": "event: message_stop\ndata: {\"type\":\"message_stop\"}\n",
		"bad JSON":            "event: content_block_delta\ndata: {\n\n",
		"mismatch":            "event: message_stop\ndata: {\"type\":\"ping\"}\n\n",
	} {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t, nil, func(w http.ResponseWriter, r *http.Request) {
				writeSSE(w, `{"type":"message_start","message":{}}`)
				io.WriteString(w, tail)
			}, false)
			rec := h.do(t, "POST", "/v1/messages", `{"model":"gpt-6-luna","stream":true,"messages":[]}`)
			names, _ := sseEvents(rec.Body.String())
			if !reflect.DeepEqual(names, []string{"message_start", "error"}) || !strings.Contains(rec.Body.String(), "stream ended early") {
				t.Fatalf("truncated stream: %s", rec.Body.String())
			}
		})
	}
}

func TestFrameRelayHandlesCRLFMultilineAndComments(t *testing.T) {
	var frames [][]byte
	input := ": keepalive\r\n\r\nevent: content_block_delta\r\nid: synthetic\r\ndata: {\"type\":\"content_block_delta\",\r\ndata: \"delta\":{\"type\":\"signature_delta\",\"signature\":\"one\"}}\r\n\r\n"
	err := scanFrames(strings.NewReader(input), func(frame []byte) bool { frames = append(frames, append([]byte(nil), frame...)); return true })
	if err != nil || len(frames) != 2 {
		t.Fatalf("frames: %q, %v", frames, err)
	}
	comment, typ, err := relayFrame(frames[0])
	if err != nil || typ != "" || !bytes.Equal(comment, frames[0]) {
		t.Fatal("comment changed state")
	}
	frame, typ, err := relayFrame(frames[1])
	if err != nil || typ != "content_block_delta" || !strings.Contains(string(frame), "ccmp1:one") || !strings.Contains(string(frame), "id: synthetic") {
		t.Fatalf("multiline: %s %v", frame, err)
	}
}

func TestPingsCannotSplitAPartiallyReceivedRemoteEvent(t *testing.T) {
	h := newHarness(t, nil, func(w http.ResponseWriter, r *http.Request) {
		writeSSE(w, `{"type":"message_start","message":{}}`)
		io.WriteString(w, "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",")
		w.(http.Flusher).Flush()
		time.Sleep(6 * pingTestInterval)
		io.WriteString(w, "\"delta\":{\"type\":\"text_delta\",\"text\":\"done\"}}\n\n")
		writeSSE(w, `{"type":"message_stop"}`)
	}, false)
	h.router.pingInterval = pingTestInterval
	stream := h.do(t, "POST", "/v1/messages", `{"model":"gpt-6-luna","stream":true,"messages":[]}`).Body.String()
	if checkPingPlacement(t, stream) < 2 {
		t.Fatalf("missing keepalives: %s", stream)
	}
	for _, block := range strings.Split(stream, "\n\n") {
		if strings.Contains(block, "content_block_delta") && strings.Contains(block, "event: ping") {
			t.Fatalf("ping split event: %s", stream)
		}
	}
}

func TestAnthropicBetaAndCredentialsRemainByteForByte(t *testing.T) {
	h := newHarness(t, nil, nil, false)
	body := "{\n \"model\": \"claude-opus-5\", \"messages\": []\n}"
	req := httptest.NewRequest("POST", "/v1/messages", strings.NewReader(body))
	beta := []string{"interleaved-thinking-2025-05-14,context-1m-2025-08-07", "other-beta"}
	req.Header["Anthropic-Beta"] = beta
	req.Header.Set("Authorization", "Bearer synthetic-anthropic-token")
	req.Header.Set("X-Api-Key", "synthetic-api-key")
	rec := httptest.NewRecorder()
	h.router.ServeHTTP(rec, req)
	if h.anthropic.body != body || !reflect.DeepEqual(h.anthropic.header.Values("Anthropic-Beta"), beta) || h.anthropic.header.Get("Authorization") != "Bearer synthetic-anthropic-token" || h.anthropic.header.Get("X-Api-Key") != "synthetic-api-key" {
		t.Fatal("Anthropic passthrough changed credentials, beta or body")
	}
	if h.codex.method != "" {
		t.Fatal("Claude traffic reached remote")
	}
}

func TestStripProxySignaturesPreservesUnrelatedBytes(t *testing.T) {
	raw := []byte("{\n\"model\":\"claude-opus-5\",\"messages\":[{\"content\":[{\"type\":\"thinking\",\"signature\":\"ccmp1:remote\"},{\"type\":\"thinking\",\"signature\":\"anthropic\"},{\"type\":\"text\",\"text\":\"text\"}]}], \"other\": [ 1, 2 ]\n}")
	clean, changed := StripProxySignatures(raw)
	if !changed || bytes.Contains(clean, []byte("ccmp1:remote")) || !bytes.Contains(clean, []byte("\"other\": [ 1, 2 ]\n}")) || !bytes.Contains(clean, []byte("anthropic")) {
		t.Fatalf("strip: %s", clean)
	}
	if again, changed := StripProxySignatures(clean); changed || !bytes.Equal(again, clean) {
		t.Fatal("filter not idempotent")
	}
}

func TestMultilineNestedJSONRemainsOneSSEDataLine(t *testing.T) {
	frame := []byte("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\ndata: \"type\":\"signature_delta\",\"signature\":\"state\"}}\n\n")
	out, _, err := relayFrame(frame)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(string(out), "\n")
	if len(lines) != 4 || !strings.HasPrefix(lines[1], "data: ") || !json.Valid([]byte(strings.TrimPrefix(lines[1], "data: "))) || !strings.Contains(lines[1], "ccmp1:state") {
		t.Fatalf("nested JSON broke SSE framing: %q", out)
	}
}

func TestJSONErrorOnHTTP200IsSanitizedAndMapped(t *testing.T) {
	h := newHarness(t, nil, func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"type":"error","error":{"type":"authentication_error","message":"expired\u0000remote"}}`)
	}, false)
	rec := h.do(t, "POST", "/v1/messages", `{"model":"gpt-6-luna","messages":[]}`)
	if rec.Code != 403 || jsontest.Get(rec.Body.String(), "error.type").String() != "permission_error" || jsontest.Get(rec.Body.String(), "error.message").String() != "expired remote" {
		t.Fatalf("JSON remote error: %d %s", rec.Code, rec.Body.String())
	}
}

func TestEarlyStreamEOFInvalidatesHeldQuota(t *testing.T) {
	h := newHarness(t, nil, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v8/management/requests/api-call" {
			json.NewEncoder(w).Encode(map[string]any{"status_code": 200, "body": `{"rate_limit":{"primary_window":{"used_percent":12,"limit_window_seconds":604800}}}`})
			return
		}
		writeSSE(w, `{"type":"message_start","message":{}}`)
	}, true)
	<-h.router.backend.RefreshLimits(5 * time.Minute)
	if len(h.router.backend.LimitSnapshot()) != 1 {
		t.Fatal("quota fixture not populated")
	}
	h.do(t, "POST", "/v1/messages", `{"model":"gpt-6-luna","stream":true,"messages":[]}`)
	if len(h.router.backend.LimitSnapshot()) != 0 {
		t.Fatal("truncated remote stream kept quota")
	}
}
