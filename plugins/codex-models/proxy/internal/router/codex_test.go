package router

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"testing"

	"github.com/jclab-joseph/claude-code-model-proxy/internal/logx"
	"github.com/tidwall/gjson"
)

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
		if got := h.codexUpstream(t).Get("reasoning.effort").String(); got != tc.want {
			t.Fatalf("%s: reasoning.effort = %q, want %q", tc.name, got, tc.want)
		}
	}
}

var uuidV4 = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

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
		return h.codex.header.Get("Session_id"), h
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

	a, _ := send(salt, "")
	b, _ := send(salt, "")
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

// toolCallBackend answers with one function call to a shortened tool name.
func toolCallBackend(short string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeSSE(w, `{"type":"response.created","response":{"id":"resp_tool","model":"gpt-6-luna"}}`)
		writeSSE(w, `{"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_77","name":"`+short+`"}}`)
		writeSSE(w, `{"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc_1","delta":"{\"answer\":"}`)
		writeSSE(w, `{"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc_1","delta":"\"done\"}"}`)
		writeSSE(w, `{"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_77","name":"`+short+`","arguments":"{\"answer\":\"done\"}"}}`)
		writeSSE(w, `{"type":"response.completed","response":{"id":"resp_tool","usage":{"input_tokens":10,"output_tokens":5}}}`)
	}
}

// A subagent answers its parent through a tool call (T0b), so tool_use has to
// survive both answer shapes and come back on the next turn.
func TestToolUseRoundTripsInBothModes(t *testing.T) {
	const tool = "StructuredOutput"
	request := func(stream bool) string {
		s := "false"
		if stream {
			s = "true"
		}
		return `{"model":"gpt-6-luna","max_tokens":300,"stream":` + s + `,
			"messages":[{"role":"user","content":"report back"}],
			"tools":[{"name":"` + tool + `","input_schema":{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"]}}]}`
	}

	// Streaming: the SSE carries a tool_use block with the arguments.
	h := newHarness(t, nil, toolCallBackend(tool), true)
	rec := h.do(t, http.MethodPost, "/v1/messages", request(true))
	if rec.Code != http.StatusOK {
		t.Fatalf("stream status = %d: %s", rec.Code, rec.Body.String())
	}
	var start, stop gjson.Result
	var arguments strings.Builder
	for _, line := range strings.Split(rec.Body.String(), "\n") {
		data, ok := strings.CutPrefix(line, "data: ")
		if !ok {
			continue
		}
		event := gjson.Parse(data)
		switch event.Get("type").String() {
		case "content_block_start":
			start = event
		case "content_block_delta":
			arguments.WriteString(event.Get("delta.partial_json").String())
		case "message_delta":
			stop = event
		}
	}
	if start.Get("content_block.type").String() != "tool_use" || start.Get("content_block.name").String() != tool ||
		start.Get("content_block.id").String() != "call_77" {
		t.Fatalf("content_block_start = %s", start.Raw)
	}
	if arguments.String() != `{"answer":"done"}` {
		t.Fatalf("streamed arguments = %q", arguments.String())
	}
	if stop.Get("delta.stop_reason").String() != "tool_use" {
		t.Fatalf("message_delta = %s", stop.Raw)
	}

	// JSON: the assembled message carries the same block.
	h = newHarness(t, nil, toolCallBackend(tool), true)
	rec = h.do(t, http.MethodPost, "/v1/messages", request(false))
	if rec.Code != http.StatusOK {
		t.Fatalf("json status = %d: %s", rec.Code, rec.Body.String())
	}
	message := gjson.Parse(rec.Body.String())
	block := message.Get("content.0")
	if message.Get("content.#").Int() != 1 || block.Get("type").String() != "tool_use" ||
		block.Get("name").String() != tool || block.Get("id").String() != "call_77" ||
		block.Get("input.answer").String() != "done" {
		t.Fatalf("message = %s", rec.Body.String())
	}
	if message.Get("stop_reason").String() != "tool_use" || message.Get("model").String() != "gpt-6-luna" {
		t.Fatalf("message = %s", rec.Body.String())
	}

	// Next turn: the tool_use and its result go back to Codex as a
	// function_call and its output, on the same call id.
	h = newHarness(t, nil, nil, true)
	next := `{"model":"gpt-6-luna","max_tokens":300,"stream":true,
		"messages":[
			{"role":"user","content":"report back"},
			{"role":"assistant","content":[` + block.Raw + `]},
			{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_77","content":"ok"}]}
		],
		"tools":[{"name":"` + tool + `","input_schema":{"type":"object","properties":{"answer":{"type":"string"}}}}]}`
	if rec := h.do(t, http.MethodPost, "/v1/messages", next); rec.Code != http.StatusOK {
		t.Fatalf("next turn status = %d: %s", rec.Code, rec.Body.String())
	}
	input := h.codexUpstream(t).Get("input").Array()
	var call, output gjson.Result
	for _, item := range input {
		switch item.Get("type").String() {
		case "function_call":
			call = item
		case "function_call_output":
			output = item
		}
	}
	if call.Get("call_id").String() != "call_77" || call.Get("name").String() != tool ||
		gjson.Parse(call.Get("arguments").String()).Get("answer").String() != "done" {
		t.Fatalf("function_call = %s", call.Raw)
	}
	if output.Get("call_id").String() != "call_77" {
		t.Fatalf("function_call_output = %s", output.Raw)
	}
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
			body := gjson.Parse(rec.Body.String())
			if got := body.Get("error.type").String(); got != tc.wantType {
				t.Fatalf("%s: error.type = %q, want %q", label, got, tc.wantType)
			}
			message := body.Get("error.message").String()
			if !strings.Contains(message, "upstream says no") {
				t.Fatalf("%s: error.message = %q", label, message)
			}
			if tc.status == 401 && !strings.Contains(message, "ccmproxy login") {
				t.Fatalf("%s: error.message = %q, want it to name `ccmproxy login`", label, message)
			}
		}
	}
}

// sseEvents splits an Anthropic SSE body into its event names and payloads.
func sseEvents(body string) (names []string, data []gjson.Result) {
	for _, block := range strings.Split(body, "\n\n") {
		var name string
		for _, line := range strings.Split(block, "\n") {
			if v, ok := strings.CutPrefix(line, "event: "); ok {
				name = v
			}
			if v, ok := strings.CutPrefix(line, "data: "); ok {
				names = append(names, name)
				data = append(data, gjson.Parse(v))
			}
		}
	}
	return names, data
}

func TestMidStreamErrorsUseAnthropicTypesAndEndTheStream(t *testing.T) {
	cases := []struct {
		name     string
		event    string
		wantType string
		wantCode int
	}{
		{"server_error event", `{"type":"error","error":{"type":"server_error","message":"boom"}}`, "api_error", 502},
		{"overloaded event", `{"type":"error","error":{"type":"overloaded_error","message":"boom"}}`, "overloaded_error", 529},
		{"authentication event", `{"type":"error","error":{"type":"authentication_error","message":"boom"}}`, "permission_error", 403},
		{"code only", `{"type":"error","code":"rate_limit_exceeded","message":"boom"}`, "rate_limit_error", 429},
		{"failed with code", `{"type":"response.failed","response":{"error":{"code":"rate_limit_exceeded","message":"boom"}}}`, "rate_limit_error", 429},
		{"failed with server_error", `{"type":"response.failed","response":{"error":{"code":"server_error","message":"boom"}}}`, "api_error", 502},
		{"failed with context length", `{"type":"response.failed","response":{"error":{"code":"context_length_exceeded","message":"boom"}}}`, "invalid_request_error", 400},
	}
	for _, tc := range cases {
		backend := func(w http.ResponseWriter, r *http.Request) {
			writeSSE(w, `{"type":"response.created","response":{"id":"resp_e","model":"gpt-6-luna"}}`)
			writeSSE(w, `{"type":"response.output_text.delta","delta":"par"}`)
			writeSSE(w, tc.event)
			// Anything after the error must not reopen the answer.
			writeSSE(w, `{"type":"response.completed","response":{"id":"resp_e","usage":{"input_tokens":1,"output_tokens":1}}}`)
		}

		h := newHarness(t, nil, backend, true)
		rec := h.do(t, http.MethodPost, "/v1/messages", `{"model":"gpt-6-luna","stream":true,"messages":[]}`)
		names, data := sseEvents(rec.Body.String())
		last := len(names) - 1
		if last < 0 || names[last] != "error" {
			t.Fatalf("%s: events = %v, want the stream to end at the error", tc.name, names)
		}
		if got := data[last].Get("error.type").String(); got != tc.wantType {
			t.Fatalf("%s: error.type = %q, want %q", tc.name, got, tc.wantType)
		}
		for _, name := range names {
			if name == "message_delta" || name == "message_stop" {
				t.Fatalf("%s: events = %v, want no %s after an error", tc.name, names, name)
			}
		}

		h = newHarness(t, nil, backend, true)
		rec = h.do(t, http.MethodPost, "/v1/messages", `{"model":"gpt-6-luna","stream":false,"messages":[]}`)
		if rec.Code != tc.wantCode || gjson.Get(rec.Body.String(), "error.type").String() != tc.wantType {
			t.Fatalf("%s: JSON answer %d %s, want %d %s", tc.name, rec.Code, rec.Body.String(), tc.wantCode, tc.wantType)
		}
	}
}

func TestAStreamCutShortIsAnError(t *testing.T) {
	cut := func(w http.ResponseWriter, r *http.Request) {
		writeSSE(w, `{"type":"response.created","response":{"id":"resp_cut","model":"gpt-6-luna"}}`)
		writeSSE(w, `{"type":"response.output_text.delta","delta":"par"}`)
		// The connection closes cleanly, with no terminal event.
	}
	empty := func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
	}
	for name, backend := range map[string]http.HandlerFunc{"cut": cut, "empty": empty} {
		h := newHarness(t, nil, backend, true)
		rec := h.do(t, http.MethodPost, "/v1/messages", `{"model":"gpt-6-luna","stream":true,"messages":[]}`)
		names, data := sseEvents(rec.Body.String())
		last := len(names) - 1
		if last < 0 || names[last] != "error" || data[last].Get("error.type").String() != "api_error" {
			t.Fatalf("%s: events = %v, want the stream to end in an api_error", name, names)
		}
		for _, event := range names {
			if event == "message_delta" || event == "message_stop" {
				t.Fatalf("%s: events = %v, want no fabricated ending", name, names)
			}
		}

		h = newHarness(t, nil, backend, true)
		rec = h.do(t, http.MethodPost, "/v1/messages", `{"model":"gpt-6-luna","stream":false,"messages":[]}`)
		if rec.Code < 500 || gjson.Get(rec.Body.String(), "type").String() != "error" {
			t.Fatalf("%s: JSON answer %d %s, want a 5xx Anthropic error", name, rec.Code, rec.Body.String())
		}
		if strings.Contains(rec.Body.String(), "end_turn") {
			t.Fatalf("%s: JSON answer reports end_turn: %s", name, rec.Body.String())
		}
	}
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
		if got := h.codexUpstream(t).Get("reasoning.effort").String(); got != tc.want {
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
	message := gjson.Get(rec.Body.String(), "error.message").String()
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
		got := gjson.Get(rec.Body.String(), "error.message").String()
		if got != c.want {
			t.Errorf("%s: message = %q (%d runes), want %q", c.name, got, len([]rune(got)), c.want)
		}
		if n := len([]rune(got)); n > 301 || strings.HasSuffix(got, " …") {
			t.Errorf("%s: message = %q (%d runes)", c.name, got, n)
		}
	}
}
