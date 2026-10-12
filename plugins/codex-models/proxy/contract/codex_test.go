//go:build contract

package contract

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

const (
	evMsgPartAdded = `{"type":"response.content_part.added","part":{"type":"output_text"}}`
	evMsgPartDone  = `{"type":"response.content_part.done","part":{"type":"output_text"}}`
)

func evReasoningAdded(enc string) string {
	return `{"type":"response.output_item.added","item":{"type":"reasoning","encrypted_content":` + jsonStr(enc) + `}}`
}

func evReasoningDone(enc string) string {
	return `{"type":"response.output_item.done","item":{"type":"reasoning","encrypted_content":` + jsonStr(enc) + `}}`
}

func evSummaryPart() string { return `{"type":"response.reasoning_summary_part.added"}` }

func evSummary(s string) string {
	return `{"type":"response.reasoning_summary_text.delta","delta":` + jsonStr(s) + `}`
}

func evCallAdded(index int, itemID, callID, name string) string {
	return `{"type":"response.output_item.added","output_index":` + itoa(index) + `,"item":{"type":"function_call","id":` +
		jsonStr(itemID) + `,"call_id":` + jsonStr(callID) + `,"name":` + jsonStr(name) + `,"arguments":""}}`
}

func evArgs(index int, itemID, delta string) string {
	return `{"type":"response.function_call_arguments.delta","output_index":` + itoa(index) + `,"item_id":` + jsonStr(itemID) + `,"delta":` + jsonStr(delta) + `}`
}

func evArgsDone(index int, itemID, args string) string {
	return `{"type":"response.function_call_arguments.done","output_index":` + itoa(index) + `,"item_id":` + jsonStr(itemID) + `,"arguments":` + jsonStr(args) + `}`
}

func evCallDone(index int, itemID, callID, name, args string) string {
	return `{"type":"response.output_item.done","output_index":` + itoa(index) + `,"item":{"type":"function_call","status":"completed","id":` +
		jsonStr(itemID) + `,"call_id":` + jsonStr(callID) + `,"name":` + jsonStr(name) + `,"arguments":` + jsonStr(args) + `}}`
}

func evIncomplete(reason string) string {
	return `{"type":"response.incomplete","response":{"id":"resp_1","incomplete_details":{"reason":` + jsonStr(reason) + `},"usage":{"input_tokens":7,"output_tokens":3}}}`
}

func itoa(i int) string { return string(rune('0' + i)) }

var codexStreams = []struct {
	name   string
	events []string
	stop   string // expected stop_reason
	blocks []string
}{
	{"text", []string{evCreated, evMsgPartAdded, evText("Hel"), evText("lo"), evMsgPartDone, evCompleted}, "end_turn", []string{"text"}},
	{"thinking", []string{
		evCreated, evReasoningAdded("pre"), evSummaryPart(), evSummary("first"), evSummaryPart(), evSummary("second"),
		evReasoningDone("ENC123"), evMsgPartAdded, evText("answer"), evMsgPartDone, evCompleted,
	}, "end_turn", []string{"thinking", "text"}},
	{"thinking without summary", []string{
		evCreated, evReasoningAdded("pre"), evReasoningDone("ENC-ONLY"), evText("x"), evCompleted,
	}, "end_turn", []string{"thinking", "text"}},
	{"single tool call", []string{
		evCreated, evCallAdded(0, "fc_1", "call_1", "Read"), evArgs(0, "fc_1", `{"path":`), evArgs(0, "fc_1", `"/a"}`),
		evArgsDone(0, "fc_1", `{"path":"/a"}`), evCallDone(0, "fc_1", "call_1", "Read", `{"path":"/a"}`), evCompleted,
	}, "tool_use", []string{"tool_use"}},
	{"text then tool call", []string{
		evCreated, evText("let me look"), evCallAdded(1, "fc_1", "call_1", "Read"),
		evCallDone(1, "fc_1", "call_1", "Read", `{"path":"/a"}`), evCompleted,
	}, "tool_use", []string{"text", "tool_use"}},
	{"parallel tool calls", []string{
		evCreated,
		evCallAdded(0, "fc_a", "call_a", "Read"), evCallAdded(1, "fc_b", "call_b", "Grep"),
		evArgs(1, "fc_b", `{"pattern":`), evArgs(0, "fc_a", `{"path":"/a"`), evArgs(1, "fc_b", `"x"}`), evArgs(0, "fc_a", `}`),
		evCallDone(1, "fc_b", "call_b", "Grep", `{"pattern":"x"}`), evCallDone(0, "fc_a", "call_a", "Read", `{"path":"/a"}`),
		evCompleted,
	}, "tool_use", []string{"tool_use", "tool_use"}},
	{"max tokens in text", []string{evCreated, evText("cut"), evIncomplete("max_output_tokens")}, "max_tokens", []string{"text"}},
	{"max tokens after a finished call", []string{
		evCreated, evCallAdded(0, "fc_1", "call_1", "Read"), evCallDone(0, "fc_1", "call_1", "Read", `{"path":"/a"}`),
		evText("more"), evIncomplete("max_output_tokens"),
	}, "max_tokens", []string{"tool_use", "text"}},
	{"cut off call is dropped", []string{
		evCreated, evCallAdded(0, "fc_1", "call_1", "Read"), evArgs(0, "fc_1", `{"path":"/a`), evIncomplete("max_output_tokens"),
	}, "max_tokens", nil},
	{"arguments not an object", []string{
		evCreated, evCallAdded(0, "fc_1", "call_1", "Read"), evCallDone(0, "fc_1", "call_1", "Read", `[1,2]`), evCompleted,
	}, "end_turn", nil},
	{"arguments not json", []string{
		evCreated, evCallAdded(0, "fc_1", "call_1", "Read"), evCallDone(0, "fc_1", "call_1", "Read", `not json`), evText("t"), evCompleted,
	}, "end_turn", []string{"text"}},
	{"no arguments", []string{
		evCreated, evCallAdded(0, "fc_1", "call_1", "Now"), evCallDone(0, "fc_1", "call_1", "Now", ``), evCompleted,
	}, "tool_use", []string{"tool_use"}},
	{"message without deltas", []string{
		evCreated, `{"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"whole"}]}}`, evCompleted,
	}, "end_turn", []string{"text"}},
}

func TestCodexStreamTranslation(t *testing.T) {
	e := loggedIn(t, opts{})
	for _, c := range codexStreams {
		t.Run(c.name, func(t *testing.T) {
			e.cdx.set(answerWith(c.events...))
			r := e.post("/v1/messages", claudeReq("gpt-6-astra", true, nil))
			if r.Status != 200 {
				t.Fatalf("status = %d: %s", r.Status, r.Body)
			}
			if !strings.HasPrefix(r.Header.Get("Content-Type"), "text/event-stream") {
				t.Fatalf("content-type = %q", r.Header.Get("Content-Type"))
			}
			evs := parseSSE(t, r.Body)
			wellFormed(t, evs)
			if got := stopReason(t, evs); got != c.stop {
				t.Fatalf("stop_reason = %q, want %q", got, c.stop)
			}
			var kinds []string
			for _, b := range blocksOf(evs) {
				kinds = append(kinds, b["type"].(string))
			}
			if strings.Join(kinds, ",") != strings.Join(c.blocks, ",") {
				t.Fatalf("blocks = %v, want %v", kinds, c.blocks)
			}
			golden(t, "codex_stream_"+strings.ReplaceAll(c.name, " ", "_")+".golden", renderEvents(t, evs))
		})
	}
}

func TestCodexThinkingSignatureIsMarked(t *testing.T) {
	e := loggedIn(t, opts{})
	e.cdx.set(answerWith(evCreated, evReasoningAdded("pre"), evSummaryPart(), evSummary("why"), evReasoningDone("ENC123"), evText("a"), evCompleted))
	evs := parseSSE(t, e.post("/v1/messages", claudeReq("gpt-6-astra", true, nil)).Body)
	var sigs []string
	for _, ev := range evs {
		if ev.Name != "content_block_delta" {
			continue
		}
		if d, _ := ev.Data["delta"].(map[string]any); d["type"] == "signature_delta" {
			sigs = append(sigs, d["signature"].(string))
		}
	}
	if len(sigs) != 1 || sigs[0] != "ccmp1:ENC123" {
		t.Fatalf("signatures = %v, want [ccmp1:ENC123]", sigs)
	}
	// The same signature replayed on the next turn reaches Codex as the
	// reasoning item's encrypted content, without the marker.
	next := claudeReq("gpt-6-astra", true, map[string]any{"messages": []any{
		map[string]any{"role": "user", "content": "q"},
		map[string]any{"role": "assistant", "content": []any{
			map[string]any{"type": "thinking", "thinking": "why", "signature": "ccmp1:ENC123"},
			map[string]any{"type": "thinking", "thinking": "other", "signature": "from-anthropic"},
			map[string]any{"type": "text", "text": "a"},
		}},
		map[string]any{"role": "user", "content": "q2"},
	}})
	e.post("/v1/messages", next)
	body := string(e.cdx.last(t).Body)
	if !strings.Contains(body, `"encrypted_content":"ENC123"`) || strings.Contains(body, "ccmp1") || strings.Contains(body, "from-anthropic") {
		t.Fatalf("replayed reasoning: %s", body)
	}
}

func TestCodexMessageStartModel(t *testing.T) {
	e := loggedIn(t, opts{})
	model := func(events ...string) string {
		e.cdx.set(answerWith(events...))
		evs := parseSSE(t, e.post("/v1/messages", claudeReq("gpt-6-astra", true, nil)).Body)
		msg, _ := evs[0].Data["message"].(map[string]any)
		return msg["model"].(string)
	}
	if got := model(evCreated, evText("a"), evCompleted); got != "gpt-6-astra-2026-01-01" {
		t.Fatalf("model = %q, want the one response.created reported", got)
	}
	if got := model(`{"type":"response.created","response":{"id":"resp_2"}}`, evText("a"), evCompleted); got != "gpt-6-astra" {
		t.Fatalf("model = %q, want the resolved id", got)
	}
	// A stream with no response.created still starts the message.
	if got := model(evText("a"), evCompleted); got != "gpt-6-astra" {
		t.Fatalf("model = %q without response.created", got)
	}
}

func TestCodexNonStreamingMessage(t *testing.T) {
	e := loggedIn(t, opts{})
	e.cdx.set(answerWith(evCreated, evReasoningAdded("pre"), evSummaryPart(), evSummary("why"), evReasoningDone("ENC1"),
		evText("Hello"), evCallAdded(1, "fc_1", "call_1", "Read"), evCallDone(1, "fc_1", "call_1", "Read", `{"path":"/a"}`), evCompleted))
	r := e.post("/v1/messages", claudeReq("gpt-6-astra", false, nil))
	if r.Status != 200 || !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		t.Fatalf("response = %d %q", r.Status, r.Header.Get("Content-Type"))
	}
	m := r.json(t)
	if m["type"] != "message" || m["role"] != "assistant" || m["stop_reason"] != "tool_use" {
		t.Fatalf("message = %s", r.Body)
	}
	golden(t, "codex_message_nonstream.golden.json", canonical(t, r.Body))
	// The upstream request is always a stream.
	var sent map[string]any
	must(t, json.Unmarshal(e.cdx.last(t).Body, &sent))
	if sent["stream"] != true {
		t.Fatalf("stream = %v in the Codex request", sent["stream"])
	}
}

func TestCodexToolNamesAreShortenedAndRestored(t *testing.T) {
	e := loggedIn(t, opts{})
	long := strings.Repeat("very_long_tool_name_", 5) // 100 characters
	mcp := "mcp__some_server_with_a_long_name__" + strings.Repeat("x", 40) + "__leaf_tool"
	tools := []any{}
	for _, n := range []string{long, mcp, "Short"} {
		tools = append(tools, map[string]any{"name": n, "description": "d", "input_schema": map[string]any{"type": "object", "properties": map[string]any{}}})
	}
	// The fake echoes back, as a call, every tool name it was sent.
	e.cdx.set(func(w http.ResponseWriter, _ *http.Request, got rec) {
		var sent struct {
			Tools []struct {
				Name string `json:"name"`
			} `json:"tools"`
		}
		_ = json.Unmarshal(got.Body, &sent)
		events := []string{evCreated}
		for i, tool := range sent.Tools {
			id := "fc_" + itoa(i)
			events = append(events, evCallAdded(i, id, "call_"+itoa(i), tool.Name), evCallDone(i, id, "call_"+itoa(i), tool.Name, `{}`))
		}
		sseAnswer(w, append(events, evCompleted)...)
	})
	r := e.post("/v1/messages", claudeReq("gpt-6-astra", true, map[string]any{"tools": tools}))
	evs := parseSSE(t, r.Body)
	wellFormed(t, evs)

	var sent struct {
		Tools []struct {
			Name string `json:"name"`
		} `json:"tools"`
	}
	must(t, json.Unmarshal(e.cdx.last(t).Body, &sent))
	if len(sent.Tools) != 3 {
		t.Fatalf("tools sent = %d", len(sent.Tools))
	}
	seen := map[string]bool{}
	for _, tool := range sent.Tools {
		if len(tool.Name) > 64 {
			t.Fatalf("tool name %q is %d characters", tool.Name, len(tool.Name))
		}
		if seen[tool.Name] {
			t.Fatalf("shortened names collide: %q", tool.Name)
		}
		seen[tool.Name] = true
	}
	var restored []string
	for _, b := range blocksOf(evs) {
		restored = append(restored, b["name"].(string))
	}
	want := map[string]bool{long: true, mcp: true, "Short": true}
	if len(restored) != 3 {
		t.Fatalf("restored names = %v", restored)
	}
	for _, n := range restored {
		if !want[n] {
			t.Fatalf("restored name %q is not one of the client's", n)
		}
	}
	golden(t, "codex_request_longnames.golden.json", canonical(t, e.cdx.last(t).Body))
}

func TestCodexEffortPrecedence(t *testing.T) {
	e := loggedIn(t, opts{})
	e.cdx.set(answerWith(evCreated, evText("a"), evCompleted))
	cases := []struct {
		name  string
		model string
		extra map[string]any
		want  string
	}{
		{"model default", "gpt-6-astra", nil, "medium"},
		{"a model with another default", "gpt-6.1-sol", nil, "low"},
		{"thinking budget small", "gpt-6-astra", map[string]any{"thinking": map[string]any{"type": "enabled", "budget_tokens": 2000}}, "low"},
		{"thinking budget medium", "gpt-6-astra", map[string]any{"thinking": map[string]any{"type": "enabled", "budget_tokens": 10000}}, "medium"},
		{"thinking budget high", "gpt-6-astra", map[string]any{"thinking": map[string]any{"type": "enabled", "budget_tokens": 30000}}, "high"},
		{"thinking budget large", "gpt-6-astra", map[string]any{"thinking": map[string]any{"type": "enabled", "budget_tokens": 90000}}, "xhigh"},
		{"thinking adaptive", "gpt-6-astra", map[string]any{"thinking": map[string]any{"type": "adaptive"}}, "xhigh"},
		{"thinking disabled", "gpt-6-astra", map[string]any{"thinking": map[string]any{"type": "disabled"}}, "low"},
		{"output_config over thinking", "gpt-6-astra", map[string]any{"output_config": map[string]any{"effort": "high"}, "thinking": map[string]any{"type": "enabled", "budget_tokens": 100}}, "high"},
		{"output_config is case-insensitive", "gpt-6-astra", map[string]any{"output_config": map[string]any{"effort": " MAX "}}, "max"},
		{"suffix over output_config", "gpt-6-astra-xhigh", map[string]any{"output_config": map[string]any{"effort": "low"}}, "xhigh"},
		{"colon suffix over thinking", "gpt-6-astra:high", map[string]any{"thinking": map[string]any{"type": "disabled"}}, "high"},
		{"clamped to the model's levels", "gpt-6-luna", map[string]any{"output_config": map[string]any{"effort": "ultra"}}, "max"},
		{"unknown level gets the default", "gpt-6-astra", map[string]any{"output_config": map[string]any{"effort": "turbo"}}, "medium"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := e.post("/v1/messages", claudeReq(c.model, true, c.extra))
			if r.Status != 200 {
				t.Fatalf("status = %d: %s", r.Status, r.Body)
			}
			var sent struct {
				Model     string `json:"model"`
				Reasoning struct {
					Effort  string `json:"effort"`
					Summary string `json:"summary"`
				} `json:"reasoning"`
			}
			must(t, json.Unmarshal(e.cdx.last(t).Body, &sent))
			if sent.Reasoning.Effort != c.want || sent.Reasoning.Summary != "auto" {
				t.Fatalf("reasoning = %+v, want effort %s", sent.Reasoning, c.want)
			}
			wantModel := strings.SplitN(strings.SplitN(c.model, ":", 2)[0], "-xhigh", 2)[0]
			if sent.Model != wantModel {
				t.Fatalf("model sent = %q, want %q", sent.Model, wantModel)
			}
		})
	}
}

func TestCodexRequestHeadersAndBody(t *testing.T) {
	e := loggedIn(t, opts{})
	e.cdx.set(answerWith(evCreated, evText("a"), evCompleted))
	req := `{
  "model": "gpt-6-astra",
  "max_tokens": 4096,
  "stream": true,
  "system": [{"type":"text","text":"You are helpful."},{"type":"text","text":"Be brief."}],
  "tools": [{"name":"Read","description":"Reads a file","input_schema":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}],
  "tool_choice": {"type":"auto","disable_parallel_tool_use":true},
  "output_config": {"effort":"high"},
  "messages": [
    {"role":"user","content":[{"type":"text","text":"read it"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgo="}}]},
    {"role":"assistant","content":[
      {"type":"thinking","thinking":"hm","signature":"ccmp1:ENCRYPTED"},
      {"type":"text","text":"ok"},
      {"type":"tool_use","id":"toolu_01ABC","name":"Read","input":{"path":"/a"}}]},
    {"role":"user","content":[
      {"type":"tool_result","tool_use_id":"toolu_01ABC","content":"file body"},
      {"type":"text","text":"thanks"}]}
  ]
}`
	r := e.post("/v1/messages", []byte(req))
	if r.Status != 200 {
		t.Fatalf("status = %d: %s", r.Status, r.Body)
	}
	got := e.cdx.last(t)
	if got.Method != "POST" || got.Path != "/backend-api/codex/responses" {
		t.Fatalf("codex saw %s %s", got.Method, got.Path)
	}
	for k, v := range map[string]string{
		"Content-Type":       "application/json",
		"Accept":             "text/event-stream",
		"Originator":         "codex-tui",
		"Chatgpt-Account-Id": "acct-1",
	} {
		if got.Header.Get(k) != v {
			t.Fatalf("header %s = %q, want %q", k, got.Header.Get(k), v)
		}
	}
	if !strings.HasPrefix(got.Header.Get("Authorization"), "Bearer ") || strings.Count(got.Header.Get("Authorization"), ".") != 2 {
		t.Fatalf("Authorization = %q, want the stored access token", got.Header.Get("Authorization"))
	}
	if !strings.HasPrefix(got.Header.Get("User-Agent"), "codex-tui/") {
		t.Fatalf("User-Agent = %q", got.Header.Get("User-Agent"))
	}
	golden(t, "codex_request_rich.golden.json", canonical(t, got.Body))
}

func TestCodexSessionID(t *testing.T) {
	e := loggedIn(t, opts{})
	e.cdx.set(answerWith(evCreated, evText("a"), evCompleted))
	send := func(userID string) string {
		extra := map[string]any{}
		if userID != "" {
			extra["metadata"] = map[string]any{"user_id": userID}
		}
		e.post("/v1/messages", claudeReq("gpt-6-astra", true, extra))
		return e.cdx.last(t).Header.Get("Session_id")
	}
	a1, a2, b := send("user_acct_device_session-A"), send("user_acct_device_session-A"), send("user_acct_device_session-B")
	n1, n2 := send(""), send("")
	for _, id := range []string{a1, a2, b, n1, n2} {
		if !uuid4RE.MatchString(id) {
			t.Fatalf("Session_id %q is not a v4 UUID", id)
		}
	}
	if a1 != a2 {
		t.Fatalf("the same user_id gave %q and %q", a1, a2)
	}
	if a1 == b {
		t.Fatal("two user_ids gave one Session_id")
	}
	if n1 == n2 {
		t.Fatal("two requests without a user_id shared a Session_id")
	}
	if strings.Contains(a1, "session-A") {
		t.Fatal("the Session_id carries the user_id")
	}
	for _, r := range e.cdx.all() {
		if strings.Contains(string(r.Body), "session-A") {
			t.Fatal("the user_id reached Codex in a body")
		}
	}
	// The id is keyed by session_salt, so a second proxy with another salt
	// derives another id for the same user_id.
	other := loggedIn(t, opts{})
	other.cdx.set(answerWith(evCreated, evText("a"), evCompleted))
	other.post("/v1/messages", claudeReq("gpt-6-astra", true, map[string]any{"metadata": map[string]any{"user_id": "user_acct_device_session-A"}}))
	if other.cdx.last(t).Header.Get("Session_id") == a1 {
		t.Fatal("the Session_id does not depend on session_salt")
	}
}

func TestCodexStreamEndedWithoutTerminalEvent(t *testing.T) {
	e := loggedIn(t, opts{})
	e.cdx.set(answerWith(evCreated, evText("partial")))

	t.Run("streaming", func(t *testing.T) {
		evs := parseSSE(t, e.post("/v1/messages", claudeReq("gpt-6-astra", true, nil)).Body)
		last := evs[len(evs)-1]
		if last.Name != "error" {
			t.Fatalf("events = %v, want a closing error", names(evs))
		}
		if indexOf(evs, "message_stop") >= 0 {
			t.Fatal("a truncated stream was closed with message_stop")
		}
		inner, _ := last.Data["error"].(map[string]any)
		if inner["type"] != "api_error" || inner["message"] == "" {
			t.Fatalf("error = %v", inner)
		}
		golden(t, "codex_stream_no_terminal.golden", renderEvents(t, evs))
	})
	t.Run("not streaming", func(t *testing.T) {
		r := e.post("/v1/messages", claudeReq("gpt-6-astra", false, nil))
		if r.Status != http.StatusBadGateway {
			t.Fatalf("status = %d, want 502: %s", r.Status, r.Body)
		}
		if kind, _ := r.errInfo(t); kind != "api_error" {
			t.Fatalf("error type = %q", kind)
		}
	})
}

func TestCodexInStreamErrors(t *testing.T) {
	e := loggedIn(t, opts{})
	cases := []struct{ name, event, wantType, wantMsg string }{
		{"failed rate limit", `{"type":"response.failed","response":{"error":{"code":"rate_limit_exceeded","message":"too  many\nrequests"}}}`, "rate_limit_error", "too many requests"},
		{"failed overloaded", `{"type":"response.failed","response":{"error":{"type":"server_is_overloaded","message":"busy"}}}`, "overloaded_error", "busy"},
		{"failed context", `{"type":"response.failed","response":{"error":{"code":"context_length_exceeded","message":"too long"}}}`, "invalid_request_error", "too long"},
		{"failed unknown", `{"type":"response.failed","response":{"error":{"code":"weird","message":"hm"}}}`, "api_error", "hm"},
		{"failed without message", `{"type":"response.failed","response":{}}`, "api_error", "the Codex backend reported a failed response"},
		{"error event", `{"type":"error","error":{"type":"authentication_error","message":"nope"}}`, "permission_error", "nope"},
		{"error event with code", `{"type":"error","code":"insufficient_quota","message":"out"}`, "rate_limit_error", "out"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e.cdx.set(answerWith(evCreated, evText("a"), c.event))
			evs := parseSSE(t, e.post("/v1/messages", claudeReq("gpt-6-astra", true, nil)).Body)
			last := evs[len(evs)-1]
			inner, _ := last.Data["error"].(map[string]any)
			if last.Name != "error" || inner["type"] != c.wantType || inner["message"] != c.wantMsg {
				t.Fatalf("last event = %s %v, want error %s %q", last.Name, inner, c.wantType, c.wantMsg)
			}
			if indexOf(evs, "message_stop") >= 0 {
				t.Fatal("message_stop after an error")
			}
		})
	}
}

func TestObsoleteHeaderKnobsCannotOverrideBackendConstants(t *testing.T) {
	e := loggedIn(t, opts{codexCfg: map[string]any{"user_agent": "obsolete-agent", "originator": "obsolete-origin"}})
	e.cdx.set(answerWith(evCreated, evText("a"), evCompleted))
	r := e.post("/v1/messages", claudeReq("gpt-6-astra", true, nil))
	if r.Status != 200 {
		t.Fatalf("status = %d", r.Status)
	}
	h := e.cdx.last(t).Header
	if h.Get("Originator") != "codex-tui" || !strings.HasPrefix(h.Get("User-Agent"), "codex-tui/") {
		t.Fatal("obsolete keys overrode protocol headers")
	}
}
