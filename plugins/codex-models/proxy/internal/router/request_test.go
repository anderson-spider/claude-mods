package router

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/logx"
)

// The model, the stream flag and the user id are read with encoding/json,
// as the relay reads controlled fields: of two equal keys the last one
// counts, whatever its case. A body routed by one reading and rewritten by
// another could otherwise be sent to Codex with settings it did not ask for.
func TestRoutingAndRelayShareJSONReadingRules(t *testing.T) {
	cases := []struct {
		name    string
		body    string
		toCodex bool
	}{
		{"last model is Codex", `{"model":"claude-opus-5","messages":[],"model":"gpt-6-luna"}`, true},
		{"last model is Claude", `{"model":"gpt-6-luna","messages":[],"model":"claude-opus-5"}`, false},
		{"other case last", `{"model":"claude-opus-5","messages":[],"Model":"gpt-6-luna"}`, true},
	}
	for _, tc := range cases {
		h := newHarness(t, nil, nil, true)
		rec := h.do(t, http.MethodPost, "/v1/messages", tc.body)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status = %d: %s", tc.name, rec.Code, rec.Body.String())
		}
		if got := h.codex.method != ""; got != tc.toCodex {
			t.Fatalf("%s: reached Codex = %v, want %v", tc.name, got, tc.toCodex)
		}
		if got := h.anthropic.method != ""; got == tc.toCodex {
			t.Fatalf("%s: reached Anthropic = %v, want %v", tc.name, got, !tc.toCodex)
		}
	}

	// The stream flag: the last one decides the answer's shape.
	h := newHarness(t, nil, nil, true)
	rec := h.do(t, http.MethodPost, "/v1/messages", `{"model":"gpt-6-luna","stream":true,"messages":[],"stream":false}`)
	if got := rec.Header().Get("Content-Type"); !strings.HasPrefix(got, "application/json") {
		t.Fatalf("Content-Type = %q, want the JSON answer the last stream flag asks for", got)
	}

	// The user id behind Session_id.
	h = newHarness(t, nil, nil, true)
	h.do(t, http.MethodPost, "/v1/messages",
		`{"model":"gpt-6-luna","metadata":{"user_id":"first"},"messages":[],"metadata":{"user_id":"last"}}`)
	if got, want := lookupText([]byte(h.codex.body), "metadata", "user_id"), codexSessionID(h.router.cfg.SessionSalt, "last"); got != want {
		t.Fatalf("Session_id = %q, want the one for the last user_id (%q)", got, want)
	}
}

// A body the proxy can read and knows is not valid JSON has no upstream that
// can serve it, so it is refused locally: forwarding it could send a prompt
// meant for Codex to Anthropic.
func TestABodyThatIsNotJSONIsRefusedLocally(t *testing.T) {
	broken := `{"model":"gpt-6-luna","messages":[{"role":"user","content":"hi"}]`
	for _, path := range []string{"/v1/messages", "/v1/messages/count_tokens"} {
		for _, c := range []struct {
			name, encoding string
			raw            []byte
		}{
			{"broken", "", []byte(broken)},
			{"empty", "", []byte{}},
			{"not json", "", []byte("not json")},
			{"gzip of broken", "gzip", gzipBytes(t, broken)},
		} {
			label := path + " " + c.name
			h := newHarness(t, nil, nil, true)
			rec := h.doEncoded(t, path, c.encoding, c.raw)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("%s: status = %d: %s", label, rec.Code, rec.Body.String())
			}
			var payload struct {
				Type  string `json:"type"`
				Error struct {
					Type    string `json:"type"`
					Message string `json:"message"`
				} `json:"error"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil || payload.Type != "error" ||
				payload.Error.Type != "invalid_request_error" || payload.Error.Message != "ccmproxy: request body is not valid JSON" {
				t.Fatalf("%s: body = %s", label, rec.Body.String())
			}
			if h.anthropic.method != "" || h.codex.method != "" {
				t.Fatalf("%s: a broken body reached an upstream", label)
			}
		}

		// Valid JSON that is not an object names no model and goes upstream.
		h := newHarness(t, nil, nil, true)
		if rec := h.do(t, http.MethodPost, path, `[]`); rec.Code != http.StatusOK || h.anthropic.body != `[]` {
			t.Fatalf("%s []: status %d, upstream saw %q", path, rec.Code, h.anthropic.body)
		}
		// A coding the proxy cannot undo is not judged: it goes upstream.
		h = newHarness(t, nil, nil, true)
		raw := []byte("\x83\x87 not decodable")
		if rec := h.doEncoded(t, path, "br", raw); rec.Code != http.StatusOK || h.anthropic.body != string(raw) {
			t.Fatalf("%s br: status %d, upstream saw %q", path, rec.Code, h.anthropic.body)
		}
	}
}

func TestReadHeadTakesAnyValueAsGjsonDid(t *testing.T) {
	cases := []struct {
		body   string
		model  string
		stream bool
		user   string
		effort string
	}{
		{`{"model":"gpt-6-luna","stream":true,"metadata":{"user_id":"u"},"output_config":{"effort":"high"}}`, "gpt-6-luna", true, "u", "high"},
		{`{"model":12,"stream":"TRUE","metadata":{"user_id":7}}`, "12", true, "7", ""},
		{`{"model":1.50,"stream":1}`, "1.5", true, "", ""},
		{`{"model":null,"stream":"no","metadata":"x","output_config":[1]}`, "", false, "", ""},
		{`{"model":{"a":1},"stream":0}`, `{"a":1}`, false, "", ""},
		{`{"model":true,"stream":false}`, "true", false, "", ""},
		{`["gpt-6-luna"]`, "", false, "", ""},
		{`not json`, "", false, "", ""},
		{``, "", false, "", ""},
	}
	for _, c := range cases {
		head := readHead([]byte(c.body))
		if string(head.Model) != c.model || bool(head.Stream) != c.stream || head.userID() != c.user || head.clientEffort() != c.effort {
			t.Errorf("%s: model %q stream %v user %q effort %q", c.body, head.Model, head.Stream, head.userID(), head.clientEffort())
		}
	}
	if head := readHead(nil); head.Model != "" {
		t.Fatalf("an unreadable body named model %q", head.Model)
	}
}

// Upstream answers (a Codex error body, the model list) are read as the
// router always read them: the first value on the path counts, and a body
// broken after it still answers.
func TestUpstreamAnswersAreReadFirstMemberFirst(t *testing.T) {
	cases := []struct{ body, want string }{
		{`{"error":{"message":"first","message":"second"}}`, "first"},
		{`{"error":{"message":"kept"},"tail":`, "kept"},
		{`{"error":{"message":"cut short`, `{"error":{"message":"cut short`},
		{`{"error":{"type":"t"},"error":{"message":"second error"}}`, "second error"},
		{`{"error":[1,{"message":"in an array"}],"detail":"d"}`, "d"},
		{`{"Error":{"message":"other case"},"detail":"detail"}`, "detail"},
		{`{"error":{"message":{"nested":true}}}`, `{"nested":true}`},
		{`{"error":"plain"}`, `{"error":"plain"}`},
		{`<html>down</html>`, `<html>down</html>`},
	}
	for _, c := range cases {
		if got := upstreamMessage([]byte(c.body)); got != c.want {
			t.Errorf("%s: message = %q, want %q", c.body, got, c.want)
		}
	}
}

func TestModelListKeepsWhatItDoesNotExtend(t *testing.T) {
	entry := json.RawMessage(`{"type":"model","id":"gpt-x"}`)
	got := string(mergeModelList([]byte(`{"next":"n", "data" : [ {"id":"a","x":1} ],"has_more":true,"last_id":"a"}`), []json.RawMessage{entry}))
	want := `{"next":"n","data":[{"id":"a","x":1},{"type":"model","id":"gpt-x"}],"has_more":true,"last_id":"gpt-x","first_id":"a"}`
	if got != want {
		t.Fatalf("merged = %s\nwant     %s", got, want)
	}
	for _, upstream := range []string{"", "nope", `[]`, `{"data":{}}`, `{"data":[]} trailing`} {
		got := string(mergeModelList([]byte(upstream), nil))
		if got != emptyModelList {
			t.Errorf("%q: merged = %s, want the empty list", upstream, got)
		}
	}
}

// A failed model list request is logged without the client's query, which
// the transport error repeats.
func TestModelListFailureLogCarriesNoQuery(t *testing.T) {
	var logged strings.Builder
	restore := logx.SetOutput(&logged)
	defer restore()

	for _, loggedIn := range []bool{true, false} {
		logged.Reset()
		h := newHarness(t, func(w http.ResponseWriter, r *http.Request) {
			// Drop the connection, so the client gets a transport error.
			conn, _, err := http.NewResponseController(w).Hijack()
			if err == nil {
				_ = conn.Close()
			}
		}, nil, loggedIn)
		rec := h.do(t, http.MethodGet, "/v1/models?after_id=QUERY-SECRET-1&limit=5", "")
		log := logged.String()
		if !strings.Contains(log, "models: upstream request failed") {
			t.Fatalf("logged in %v: the failure was not logged:\n%s", loggedIn, log)
		}
		if strings.Contains(log, "QUERY-SECRET-1") || strings.Contains(log, "limit=5") {
			t.Fatalf("logged in %v: the log carries the query:\n%s", loggedIn, log)
		}
		if !strings.Contains(log, "/v1/models") {
			t.Fatalf("logged in %v: the log lost the path:\n%s", loggedIn, log)
		}
		want := http.StatusBadGateway
		if loggedIn {
			want = http.StatusOK
		}
		if rec.Code != want {
			t.Fatalf("logged in %v: status = %d, want %d", loggedIn, rec.Code, want)
		}
	}
}
