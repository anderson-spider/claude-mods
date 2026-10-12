package router

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/jclab-joseph/claude-code-model-proxy/internal/logx"
	"github.com/tidwall/gjson"
)

// Planted secrets: none of them may ever appear in a log line.
var plantedSecrets = []string{
	"PLANTED-PROMPT-ECHO-7f3a",
	"sk-proj-PLANTEDTOKEN0123456789",
	"eyJhbGciOiJQTANTED.jwt.payload",
	"planted@example.org",
}

func plantedText() string { return strings.Join(plantedSecrets, " | ") }

func assertNothingPlanted(t *testing.T, label, log string) {
	t.Helper()
	for _, s := range plantedSecrets {
		if strings.Contains(log, s) {
			t.Fatalf("%s: log carries planted %q:\n%s", label, s, log)
		}
	}
}

func TestBackendErrorLogsCarryNoUpstreamText(t *testing.T) {
	var logged strings.Builder
	restore := logx.SetOutput(&logged)
	defer restore()
	logx.SetLevel("debug")
	defer logx.SetLevel("debug")

	plant := plantedText()
	bodies := map[string]string{
		"message":        `{"error":{"message":"` + plant + `","type":"invalid_request_error","code":"bad_input"}}`,
		"detail":         `{"detail":"` + plant + `"}`,
		"raw":            plant,
		"raw json other": `{"weird":"` + plant + `"}`,
		"type free text": `{"error":{"message":"m","type":"` + plant + `"}}`,
		"code free text": `{"error":{"message":"m","code":"` + plant + `"}}`,
		"type newline":   `{"error":{"message":"m","type":"ok\nPLANTED-PROMPT-ECHO-7f3a"}}`,
		"code unicode":   `{"error":{"message":"m","code":"códigoPLANTED-PROMPT-ECHO-7f3a"}}`,
		"type 65 chars":  `{"error":{"message":"m","type":"` + strings.Repeat("A", 41) + `PLANTED-PROMPT-ECHO-7f3a"}}`,
		"code quote":     `{"error":{"message":"m","code":"a\"PLANTED-PROMPT-ECHO-7f3a"}}`,
		"message nested": `{"error":{"message":{"x":"` + plant + `"}}}`,
		"html":           `<html><body>` + plant + `</body></html>`,
		"array body":     `["` + plant + `"]`,
		"error string":   `{"error":"` + plant + `"}`,
	}
	statuses := []int{400, 401, 403, 404, 409, 413, 422, 429, 500, 502, 503, 504, 529}
	for name, body := range bodies {
		for _, status := range statuses {
			for _, stream := range []string{"true", "false"} {
				logged.Reset()
				h := newHarness(t, nil, backendStatus(status, body), true)
				rec := h.do(t, http.MethodPost, "/v1/messages", `{"model":"gpt-6-luna","stream":`+stream+`,"messages":[]}`)
				label := name + " " + http.StatusText(status) + " stream=" + stream
				assertNothingPlanted(t, label, logged.String())
				if rec.Code == http.StatusUnauthorized {
					t.Fatalf("%s: answered 401", label)
				}
				want := status
				if status == 401 {
					want = 403
				}
				if rec.Code != want {
					t.Fatalf("%s: status %d, want %d", label, rec.Code, want)
				}
				if !strings.Contains(logged.String(), "codex backend error ") {
					t.Fatalf("%s: no status line:\n%s", label, logged.String())
				}
				msg := gjson.Get(rec.Body.String(), "error.message").String()
				kind := gjson.Get(rec.Body.String(), "error.type").String()
				if !isAnthropicErrorType(kind) {
					t.Fatalf("%s: error.type %q is not an Anthropic type", label, kind)
				}
				if kind == "authentication_error" {
					t.Fatalf("%s: authentication_error reaches the client", label)
				}
				for _, r := range msg {
					if r < 0x20 || r == 0x7f {
						t.Fatalf("%s: control char %U in %q", label, r, msg)
					}
				}
			}
		}
	}
}

func TestErrorTypeAndCodeAreLoggedOnlyAsIdentifiers(t *testing.T) {
	var logged strings.Builder
	restore := logx.SetOutput(&logged)
	defer restore()

	id64 := strings.Repeat("a", 60) + "_.-9"
	h := newHarness(t, nil, backendStatus(429, `{"error":{"message":"`+plantedText()+`","type":"`+id64+`","code":"rate.limit-X_1"}}`), true)
	rec := h.do(t, http.MethodPost, "/v1/messages", `{"model":"gpt-6-luna","messages":[]}`)
	log := logged.String()
	if !strings.Contains(log, `codex backend error 429 (type "`+id64+`", code "rate.limit-X_1")`) {
		t.Fatalf("log = %q", log)
	}
	assertNothingPlanted(t, "429", log)
	if gjson.Get(rec.Body.String(), "error.type").String() != "rate_limit_error" {
		t.Fatalf("body = %s", rec.Body.String())
	}

	logged.Reset()
	id65 := strings.Repeat("b", 65)
	newHarness(t, nil, backendStatus(400, `{"error":{"message":"m","type":"`+id65+`","code":"x y"}}`), true).
		do(t, http.MethodPost, "/v1/messages", `{"model":"gpt-6-luna","messages":[]}`)
	if log := logged.String(); strings.Contains(log, id65) || !strings.Contains(log, `(type "", code "")`) {
		t.Fatalf("log = %q", log)
	}
}

func isAnthropicErrorType(kind string) bool {
	switch kind {
	case "invalid_request_error", "permission_error", "not_found_error", "request_too_large",
		"rate_limit_error", "api_error", "overloaded_error":
		return true
	}
	return false
}

// TestMidStreamErrorsAreCleanedAndNeverLogged covers error and
// response.failed events after a 200, on both paths.
func TestMidStreamErrorsAreCleanedAndNeverLogged(t *testing.T) {
	var logged strings.Builder
	restore := logx.SetOutput(&logged)
	defer restore()

	long := strings.Repeat("w ", 500)
	plantJSON := `\u0000\u001b[2J` + plantedText() + `\n\t` + long
	events := []struct {
		payload  string
		wantType string
	}{
		{`{"type":"error","error":{"type":"authentication_error","message":"` + plantJSON + `"}}`, "permission_error"},
		{`{"type":"error","code":"invalid_api_key","message":"` + plantJSON + `"}`, "permission_error"},
		{`{"type":"error","error":{"type":"` + plantedSecrets[0] + `","code":"rate_limit_exceeded","message":"` + plantJSON + `"}}`, "rate_limit_error"},
		{`{"type":"response.failed","response":{"id":"r","error":{"type":"server_error","code":"server_is_overloaded","message":"` + plantJSON + `"}}}`, "overloaded_error"},
		{`{"type":"response.failed","response":{"id":"r","error":{"code":"context_length_exceeded","message":"` + plantJSON + `"}}}`, "invalid_request_error"},
		{`{"type":"response.failed","response":{"id":"r","error":{"code":"unauthorized","message":"` + plantJSON + `"}}}`, "permission_error"},
	}
	for _, ev := range events {
		for _, stream := range []bool{true, false} {
			logged.Reset()
			h := newHarness(t, nil, func(w http.ResponseWriter, r *http.Request) {
				writeSSE(w, `{"type":"response.created","response":{"id":"r"}}`)
				writeSSE(w, ev.payload)
			}, true)
			body := `{"model":"gpt-6-luna","stream":false,"messages":[]}`
			if stream {
				body = `{"model":"gpt-6-luna","stream":true,"messages":[]}`
			}
			rec := h.do(t, http.MethodPost, "/v1/messages", body)
			label := ev.wantType + " stream=" + map[bool]string{true: "true", false: "false"}[stream]
			assertNothingPlanted(t, label, logged.String())
			if rec.Code == http.StatusUnauthorized {
				t.Fatalf("%s: 401", label)
			}
			var errResult gjson.Result
			if stream {
				names, data := sseEvents(rec.Body.String())
				if len(names) == 0 || names[len(names)-1] != "error" {
					t.Fatalf("%s: events %v", label, names)
				}
				errResult = data[len(data)-1].Get("error")
			} else {
				errResult = gjson.Get(rec.Body.String(), "error")
				if rec.Code != errorTypeStatus(ev.wantType) {
					t.Fatalf("%s: status %d, want %d", label, rec.Code, errorTypeStatus(ev.wantType))
				}
			}
			if errResult.Get("type").String() != ev.wantType {
				t.Fatalf("%s: type %q", label, errResult.Get("type").String())
			}
			msg := errResult.Get("message").String()
			if !strings.HasPrefix(msg, "[2J"+plantedSecrets[0]) || !strings.HasSuffix(msg, "…") {
				t.Fatalf("%s: message %q", label, msg)
			}
			// At most 300 runes of text, then the ellipsis, never after a space.
			if n := len([]rune(msg)); n > 301 || strings.HasSuffix(msg, " …") {
				t.Fatalf("%s: message has %d runes, ends %q", label, n, msg[len(msg)-6:])
			}
			for _, r := range msg {
				if r < 0x20 || r == 0x7f {
					t.Fatalf("%s: control char in %q", label, msg)
				}
			}
		}
	}
}

// TestBackendErrorMessagesAreCappedOnEveryPath cuts multibyte text with a
// space or a control character at the boundary, through a backend error
// status (401 included, which adds its own prefix) and through a mid-stream
// error and response.failed, streamed and not.
func TestBackendErrorMessagesAreCappedOnEveryPath(t *testing.T) {
	const loginPrefix = "the Codex backend refused the ChatGPT login; run `ccmproxy login codex` to sign in again: "
	inputs := map[string]string{
		"space at 300":   strings.Repeat("é", 299) + " " + strings.Repeat("界", 20),
		"control at 300": strings.Repeat("🙂", 299) + "\u001b\n" + strings.Repeat("b", 20),
		"word pairs":     strings.Repeat("w ", 400),
		"short":          "upstream said no",
	}
	check := func(label, msg, original string) {
		t.Helper()
		if strings.HasSuffix(msg, " …") || strings.HasSuffix(msg, " ") {
			t.Fatalf("%s: ends in a space: %q", label, msg)
		}
		if n := len([]rune(msg)); n > 301 {
			t.Fatalf("%s: %d runes", label, n)
		}
		if original == "upstream said no" && msg != original {
			t.Fatalf("%s: a short message changed: %q", label, msg)
		}
		if original != "upstream said no" && !strings.HasSuffix(msg, "…") {
			t.Fatalf("%s: a cut message must say so: %q", label, msg)
		}
		for _, r := range msg {
			if r < 0x20 || r == 0x7f {
				t.Fatalf("%s: control char in %q", label, msg)
			}
		}
	}
	for name, in := range inputs {
		for _, status := range []int{400, 401, 429, 500} {
			for _, stream := range []string{"true", "false"} {
				h := newHarness(t, nil, backendStatus(status, `{"error":{"message":`+encodedJSON(in)+`}}`), true)
				rec := h.do(t, http.MethodPost, "/v1/messages", `{"model":"gpt-6-luna","stream":`+stream+`,"messages":[]}`)
				msg := gjson.Get(rec.Body.String(), "error.message").String()
				label := name + " status " + http.StatusText(status) + " stream=" + stream
				if status == 401 {
					if !strings.HasPrefix(msg, loginPrefix) {
						t.Fatalf("%s: %q", label, msg)
					}
					msg = strings.TrimPrefix(msg, loginPrefix)
				}
				check(label, msg, in)
			}
		}
		for _, event := range []string{
			`{"type":"error","error":{"type":"server_error","message":` + encodedJSON(in) + `}}`,
			`{"type":"response.failed","response":{"id":"r","error":{"code":"server_error","message":` + encodedJSON(in) + `}}}`,
		} {
			for _, stream := range []bool{true, false} {
				h := newHarness(t, nil, func(w http.ResponseWriter, r *http.Request) {
					writeSSE(w, `{"type":"response.created","response":{"id":"r"}}`)
					writeSSE(w, event)
				}, true)
				body := `{"model":"gpt-6-luna","stream":false,"messages":[]}`
				if stream {
					body = `{"model":"gpt-6-luna","stream":true,"messages":[]}`
				}
				rec := h.do(t, http.MethodPost, "/v1/messages", body)
				var msg string
				if stream {
					_, data := sseEvents(rec.Body.String())
					msg = data[len(data)-1].Get("error.message").String()
				} else {
					msg = gjson.Get(rec.Body.String(), "error.message").String()
				}
				check(name+" "+gjson.Get(event, "type").String(), msg, in)
			}
		}
	}
}

// encodedJSON renders s as a JSON string, control characters escaped.
func encodedJSON(s string) string {
	out, _ := json.Marshal(s)
	return string(out)
}
