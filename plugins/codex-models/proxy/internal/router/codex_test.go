package router

import (
	"encoding/json"
	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/jsontest"
	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/logx"
	"net/http"
	"regexp"
	"strings"
	"testing"
)

var uuidV4 = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func TestEffortPrecedence(t *testing.T) {
	// Claude Code sends a subagent's own effort as output_config.effort next
	// to thinking: adaptive. The stated effort wins; adaptive alone means
	// "think as needed"; an effort pinned in the model name beats both.
	cases := []struct {
		name string
		body string
		want string
	}{
		{"effort only", `{"model":"gpt-6-luna","messages":[],"output_config":{"effort":"low"}}`, "low"},
		{"adaptive only", `{"model":"gpt-6-luna","messages":[],"thinking":{"type":"adaptive"}}`, "xhigh"},
		{"effort and adaptive", `{"model":"gpt-6-luna","messages":[],"thinking":{"type":"adaptive"},"output_config":{"effort":"low"}}`, "low"},
		{"medium effort and adaptive", `{"model":"gpt-6-luna","messages":[],"thinking":{"type":"adaptive"},"output_config":{"effort":"medium"}}`, "medium"},
		{"effort above the model and adaptive", `{"model":"gpt-6-luna","messages":[],"thinking":{"type":"adaptive"},"output_config":{"effort":"ultra"}}`, "max"},
		{"ultra and adaptive on an ultra model", `{"model":"gpt-6-astra","messages":[],"thinking":{"type":"adaptive"},"output_config":{"effort":"ultra"}}`, "ultra"},
		{"effort and a large budget", `{"model":"gpt-6-luna","messages":[],"thinking":{"type":"enabled","budget_tokens":64000},"output_config":{"effort":"low"}}`, "low"},
		{"budget 2k", `{"model":"gpt-6-luna","messages":[],"thinking":{"type":"enabled","budget_tokens":2000}}`, "low"},
		{"budget 10k", `{"model":"gpt-6-luna","messages":[],"thinking":{"type":"enabled","budget_tokens":10000}}`, "medium"},
		{"budget 30k", `{"model":"gpt-6-luna","messages":[],"thinking":{"type":"enabled","budget_tokens":30000}}`, "high"},
		{"budget 64k", `{"model":"gpt-6-luna","messages":[],"thinking":{"type":"enabled","budget_tokens":64000}}`, "xhigh"},
		{"pinned in the name", `{"model":"gpt-6-luna-low","messages":[],"thinking":{"type":"adaptive"},"output_config":{"effort":"high"}}`, "low"},
		{"pinned with a colon", `{"model":"gpt-6-luna:high","messages":[],"output_config":{"effort":"low"}}`, "high"},
		{"nothing stated", `{"model":"gpt-6-luna","messages":[]}`, "medium"},
	}
	for _, tc := range cases {
		h := newHarness(t, nil, nil, true)
		rec := h.do(t, http.MethodPost, "/v1/messages", tc.body)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status = %d: %s", tc.name, rec.Code, rec.Body.String())
		}
		resolution, _ := h.router.registry.Resolve(string(readHead([]byte(tc.body)).Model))
		if got := h.codexUpstream(t).Get("model").String(); got != resolution.Model.ID+"("+tc.want+")" {
			t.Fatalf("%s: reasoning.effort = %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestUserIDIsHashedBeforeItReachesCodex(t *testing.T) {
	const salt = "5a175a175a175a175a175a175a175a175a175a175a175a175a175a175a175a17"
	rawID := `user_8c2f0e1d_account_3f9a2b7c-1111-2222-3333-444455556666_session_aa11bb22-cc33-dd44-ee55-ff6677889900`

	send := func(salt, userID string) (string, *harness) {
		h := newHarness(t, nil, nil, true)
		h.router.cfg.SessionSalt = salt
		body := `{"model":"gpt-6-luna","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}`
		if userID != "" {
			body = `{"model":"gpt-6-luna","max_tokens":16,"metadata":{"user_id":` + jsonString(userID) + `},"messages":[{"role":"user","content":"hi"}]}`
		}
		if rec := h.do(t, http.MethodPost, "/v1/messages", body); rec.Code != http.StatusOK {
			t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
		}
		return lookupText([]byte(h.codex.body), "metadata", "user_id"), h
	}

	first, h := send(salt, rawID)
	if first == "" || !uuidV4.MatchString(first) {
		t.Fatalf("Session_id = %q, want a version 4 UUID", first)
	}
	if first != codexSessionID(salt, rawID) {
		t.Fatalf("Session_id = %q, want codexSessionID's value", first)
	}
	// Neither the id nor any of its parts reaches the Codex backend.
	for _, part := range []string{rawID, "8c2f0e1d", "3f9a2b7c-1111-2222-3333-444455556666", "aa11bb22-cc33-dd44-ee55-ff6677889900"} {
		if strings.Contains(h.codex.body, part) {
			t.Fatalf("the Codex body carries %q", part)
		}
		for name, values := range h.codex.header {
			for _, value := range values {
				if strings.Contains(value, part) {
					t.Fatalf("the Codex header %s carries %q", name, part)
				}
			}
		}
	}

	if again, _ := send(salt, rawID); again != first {
		t.Fatalf("the same user_id gave %q then %q, want one stable id", first, again)
	}
	if other, _ := send(salt, rawID+"x"); other == first {
		t.Fatal("two user_ids gave the same session id")
	}
	if salted, _ := send(strings.Repeat("0", 64), rawID); salted == first {
		t.Fatal("another salt gave the same session id")
	}

	a := codexSessionID(salt, "")
	b := codexSessionID(salt, "")
	if !uuidV4.MatchString(a) || a == b {
		t.Fatalf("without a user_id: %q and %q, want two random UUIDs", a, b)
	}
}

func jsonString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"', '\\':
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	b.WriteByte('"')
	return b.String()
}

func backendStatus(status int, body string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}
}

func TestCodexBackendErrorsUseAnthropicTypes(t *testing.T) {
	cases := []struct {
		status     int
		wantStatus int
		wantType   string
	}{
		{400, 400, "invalid_request_error"},
		{401, 403, "permission_error"},
		{403, 403, "permission_error"},
		{404, 404, "not_found_error"},
		{413, 413, "request_too_large"},
		{422, 422, "invalid_request_error"},
		{429, 429, "rate_limit_error"},
		{500, 500, "api_error"},
		{503, 503, "api_error"},
		{529, 529, "overloaded_error"},
	}
	for _, tc := range cases {
		for _, stream := range []string{"true", "false"} {
			h := newHarness(t, nil, backendStatus(tc.status, `{"error":{"message":"upstream says no"}}`), true)
			rec := h.do(t, http.MethodPost, "/v1/messages", `{"model":"gpt-6-luna","stream":`+stream+`,"messages":[]}`)
			label := http.StatusText(tc.status) + " stream=" + stream
			if rec.Code != tc.wantStatus {
				t.Fatalf("%s: status = %d, want %d", label, rec.Code, tc.wantStatus)
			}
			body := jsontest.Parse(rec.Body.String())
			if got := body.Get("error.type").String(); got != tc.wantType {
				t.Fatalf("%s: error.type = %q, want %q", label, got, tc.wantType)
			}
			message := body.Get("error.message").String()
			if !strings.Contains(message, "upstream says no") {
				t.Fatalf("%s: error.message = %q", label, message)
			}
			if tc.status == 401 && (!strings.Contains(message, "Codex remote") || strings.Contains(message, "ccmproxy login")) {
				t.Fatalf("%s: error.message = %q, want guidance for the remote account", label, message)
			}
		}
	}
}

func sseEvents(body string) (names []string, data []jsontest.Result) {
	for _, block := range strings.Split(body, "\n\n") {
		var name string
		for _, line := range strings.Split(block, "\n") {
			if v, ok := strings.CutPrefix(line, "event: "); ok {
				name = v
			}
			if v, ok := strings.CutPrefix(line, "data: "); ok {
				names = append(names, name)
				data = append(data, jsontest.Parse(v))
			}
		}
	}
	return names, data
}

func TestEffortEdgeCasesClampSensibly(t *testing.T) {
	cases := []struct {
		body string
		want string
	}{
		// Below the model's lowest level: the lowest level, not the default.
		{`{"model":"gpt-6-luna","messages":[],"output_config":{"effort":"minimal"}}`, "low"},
		{`{"model":"gpt-6-luna","messages":[],"output_config":{"effort":"none"}}`, "low"},
		// Unknown: the model's default, not its top.
		{`{"model":"gpt-6-luna","messages":[],"output_config":{"effort":"banana"}}`, "medium"},
		{`{"model":"gpt-6-astra","messages":[],"output_config":{"effort":"banana"}}`, "medium"},
		// Claude Code's top level still maps to the model's top.
		{`{"model":"gpt-6-astra","messages":[],"output_config":{"effort":"ultra"}}`, "ultra"},
		{`{"model":"gpt-6-luna","messages":[],"output_config":{"effort":"ultra"}}`, "max"},
	}
	for _, tc := range cases {
		h := newHarness(t, nil, nil, true)
		h.do(t, http.MethodPost, "/v1/messages", tc.body)
		resolution, _ := h.router.registry.Resolve(string(readHead([]byte(tc.body)).Model))
		if got := h.codexUpstream(t).Get("model").String(); got != resolution.Model.ID+"("+tc.want+")" {
			t.Fatalf("%s: reasoning.effort = %q, want %q", tc.body, got, tc.want)
		}
	}
}

func TestUpstreamErrorTextNeverReachesTheLog(t *testing.T) {
	const prompt = "PROMPT-ECHO-the-secret-plan"
	const token = "sk-proj-TOKENVALUE1234567890"
	var logged strings.Builder
	restore := logx.SetOutput(&logged)
	defer restore()

	for _, body := range []string{
		`{"error":{"message":"bad input: ` + prompt + ` with key ` + token + `","type":"invalid_request_error","code":"bad_input"}}`,
		`{"detail":"` + prompt + ` ` + token + `"}`,
		prompt + " " + token,
		// Free text in type or code (spaces, long values) is not logged either.
		`{"error":{"message":"x","type":"invalid: ` + prompt + `","code":"` + token + ` and more"}}`,
		`{"error":{"message":"x","type":"` + strings.Repeat("a", 65) + prompt + `"}}`,
	} {
		logged.Reset()
		h := newHarness(t, nil, backendStatus(http.StatusBadRequest, body), true)
		rec := h.do(t, http.MethodPost, "/v1/messages", `{"model":"gpt-6-luna","messages":[]}`)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d", rec.Code)
		}
		log := logged.String()
		if strings.Contains(log, prompt) || strings.Contains(log, token) {
			t.Fatalf("the log carries upstream text:\n%s", log)
		}
		if !strings.Contains(log, "codex backend error 400") {
			t.Fatalf("the log lost the status:\n%s", log)
		}
	}
	logged.Reset()
	h := newHarness(t, nil, backendStatus(http.StatusBadRequest, `{"error":{"message":"m","type":"invalid_request_error","code":"bad_input"}}`), true)
	h.do(t, http.MethodPost, "/v1/messages", `{"model":"gpt-6-luna","messages":[]}`)
	if log := logged.String(); !strings.Contains(log, `type "invalid_request_error"`) || !strings.Contains(log, `code "bad_input"`) {
		t.Fatalf("the log lost the type or code:\n%s", log)
	}
}

func TestUpstreamErrorMessageIsCleanedAndCapped(t *testing.T) {
	long := strings.Repeat("word ", 400)
	body := `{"error":{"message":"line one\u0000\u001b[31m\nline two\t` + long + `"}}`
	h := newHarness(t, nil, backendStatus(http.StatusBadRequest, body), true)
	rec := h.do(t, http.MethodPost, "/v1/messages", `{"model":"gpt-6-luna","messages":[]}`)
	message := jsontest.Get(rec.Body.String(), "error.message").String()
	if !strings.HasPrefix(message, "line one [31m line two word") {
		t.Fatalf("message = %q", message)
	}
	for _, r := range message {
		if r < 0x20 || r == 0x7f {
			t.Fatalf("message keeps control character %U: %q", r, message)
		}
	}
	if n := len([]rune(message)); n > 301 {
		t.Fatalf("message has %d characters, want at most 300 and an ellipsis", n)
	}
	if !strings.HasSuffix(message, "…") || strings.HasSuffix(message, " …") {
		t.Fatalf("a cut message must say so, after a word: %q", message)
	}

	// Around the cap, with and without a space where the cut falls.
	a := strings.Repeat("a", 300)
	cases := []struct{ name, in, want string }{
		{"300 runes", a, a},
		{"301 runes", a + "b", a + "…"},
		{"space at 299", a[:298] + " b", a[:298] + " b"},
		{"space at 299, then more", a[:298] + " bcd", a[:298] + " b…"},
		{"space at 300", a[:299] + " b", a[:299] + "…"},
		{"space at 300, then more", a[:299] + " bbb ccc", a[:299] + "…"},
		{"space at 301", a + " b", a + "…"},
		{"newline at 300", a[:299] + "\nb", a[:299] + "…"},
		{"trailing space", a[:299] + " ", a[:299]},
	}
	for _, c := range cases {
		text, err := json.Marshal(c.in)
		if err != nil {
			t.Fatal(err)
		}
		h := newHarness(t, nil, backendStatus(http.StatusBadRequest, `{"error":{"message":`+string(text)+`}}`), true)
		rec := h.do(t, http.MethodPost, "/v1/messages", `{"model":"gpt-6-luna","messages":[]}`)
		got := jsontest.Get(rec.Body.String(), "error.message").String()
		if got != c.want {
			t.Errorf("%s: message = %q (%d runes), want %q", c.name, got, len([]rune(got)), c.want)
		}
		if n := len([]rune(got)); n > 301 || strings.HasSuffix(got, " …") {
			t.Errorf("%s: message = %q (%d runes)", c.name, got, n)
		}
	}
}
