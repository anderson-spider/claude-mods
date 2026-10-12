package router

import (
	"net/http"
	"regexp"
	"strings"
	"testing"

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
		{"effort only", `{"model":"gpt-5.5","messages":[],"output_config":{"effort":"low"}}`, "low"},
		{"adaptive only", `{"model":"gpt-5.5","messages":[],"thinking":{"type":"adaptive"}}`, "xhigh"},
		{"effort and adaptive", `{"model":"gpt-5.5","messages":[],"thinking":{"type":"adaptive"},"output_config":{"effort":"low"}}`, "low"},
		{"medium effort and adaptive", `{"model":"gpt-5.5","messages":[],"thinking":{"type":"adaptive"},"output_config":{"effort":"medium"}}`, "medium"},
		{"effort above the model and adaptive", `{"model":"gpt-5.5","messages":[],"thinking":{"type":"adaptive"},"output_config":{"effort":"max"}}`, "xhigh"},
		{"ultra and adaptive on a max model", `{"model":"gpt-6-astra","messages":[],"thinking":{"type":"adaptive"},"output_config":{"effort":"ultra"}}`, "max"},
		{"effort and a large budget", `{"model":"gpt-5.5","messages":[],"thinking":{"type":"enabled","budget_tokens":64000},"output_config":{"effort":"low"}}`, "low"},
		{"budget 2k", `{"model":"gpt-5.5","messages":[],"thinking":{"type":"enabled","budget_tokens":2000}}`, "low"},
		{"budget 10k", `{"model":"gpt-5.5","messages":[],"thinking":{"type":"enabled","budget_tokens":10000}}`, "medium"},
		{"budget 30k", `{"model":"gpt-5.5","messages":[],"thinking":{"type":"enabled","budget_tokens":30000}}`, "high"},
		{"budget 64k", `{"model":"gpt-5.5","messages":[],"thinking":{"type":"enabled","budget_tokens":64000}}`, "xhigh"},
		{"pinned in the name", `{"model":"gpt-5.5-low","messages":[],"thinking":{"type":"adaptive"},"output_config":{"effort":"high"}}`, "low"},
		{"pinned with a colon", `{"model":"gpt-5.5:high","messages":[],"output_config":{"effort":"low"}}`, "high"},
		{"nothing stated", `{"model":"gpt-5.5","messages":[]}`, "medium"},
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
		body := `{"model":"gpt-5.5","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}`
		if userID != "" {
			body = `{"model":"gpt-5.5","max_tokens":16,"metadata":{"user_id":` + jsonString(userID) + `},"messages":[{"role":"user","content":"hi"}]}`
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
		writeSSE(w, `{"type":"response.created","response":{"id":"resp_tool","model":"gpt-5.5"}}`)
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
		return `{"model":"gpt-5.5","max_tokens":300,"stream":` + s + `,
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
	if message.Get("stop_reason").String() != "tool_use" || message.Get("model").String() != "gpt-5.5" {
		t.Fatalf("message = %s", rec.Body.String())
	}

	// Next turn: the tool_use and its result go back to Codex as a
	// function_call and its output, on the same call id.
	h = newHarness(t, nil, nil, true)
	next := `{"model":"gpt-5.5","max_tokens":300,"stream":true,
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
