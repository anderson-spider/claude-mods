package translate

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/tidwall/gjson"
)

// TestStripKeepsEveryOtherByte: only the content arrays that held a
// proxy-issued block change, rebuilt from their other blocks as written;
// spacing, key order, number forms, escapes and look-alike blocks elsewhere
// stay byte for byte.
func TestStripKeepsEveryOtherByte(t *testing.T) {
	ours := `{"type":"thinking","thinking":"codex","signature":"` + SignatureMarker + `ENC"}`
	keep := `{ "type" : "thinking",  "thinking":"real", "signature":"sig" }`
	tool := `{"type":"tool_use","id":"t","name":"Read","input":{"b":1.0e3,  "a":"café"}}`
	nested := `{"type":"tool_result","tool_use_id":"t","content":[` + ours + `]}`
	head := `{ "z" : 1.50, "model":"claude-sonnet-5",` + "\n" + ` "messages" : [ {"role":"user","content":"` + SignatureMarker + ` in text"}, ` +
		`{"role":"assistant", "meta":{"content":[` + ours + `]}, "content" : `
	tail := ` }, {"content":[` + keep + `]} ] , "after": "<" }`

	raw := head + `[ ` + ours + ` , ` + keep + `,` + "\n\t" + tool + `, ` + nested + ` ]` + tail
	want := head + `[` + keep + `,` + tool + `,` + nested + `]` + tail

	got, changed := StripProxySignatures([]byte(raw))
	if !changed {
		t.Fatal("a body with a proxy-issued block must be rewritten")
	}
	if string(got) != want {
		t.Fatalf("stripped body\n got %s\nwant %s", got, want)
	}
}

func TestStripLeavesUnreadableBodiesAlone(t *testing.T) {
	ours := `{"type":"thinking","signature":"` + SignatureMarker + `X"}`
	for _, raw := range []string{
		`[` + ours + `]`,
		`{"messages":{"content":[` + ours + `]}}`,
		`{"messages":[{"content":[` + ours,
		`"` + SignatureMarker + `"`,
		`{"messages":[{"content":"` + SignatureMarker + `"}]}`,
	} {
		got, changed := StripProxySignatures([]byte(raw))
		if changed || string(got) != raw {
			t.Errorf("%s: changed=%v, got %s", raw, changed, got)
		}
	}
}

// TestReplayedReasoningSpellsOutNullAndEmpty: the backend expects the
// reasoning item's "summary": [] and "content": null written out.
func TestReplayedReasoningSpellsOutNullAndEmpty(t *testing.T) {
	request, err := ClaudeToCodex(Options{Model: "m"}, []byte(`{"messages":[{"role":"assistant","content":[`+
		`{"type":"thinking","thinking":"x","signature":"`+SignatureMarker+`ENC"}]}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"type":"reasoning","summary":[],"content":null,"encrypted_content":"ENC"}`; !strings.Contains(string(request.Body), want) {
		t.Fatalf("body %s lacks %s", request.Body, want)
	}
}

// TestToolInputTravelsAsWritten: the function_call arguments are the client's
// input JSON text, spacing and number forms included.
func TestToolInputTravelsAsWritten(t *testing.T) {
	input := `{ "n" : 1.0e3, "s":"<a & b>" }`
	request, err := ClaudeToCodex(Options{Model: "m"}, []byte(`{"messages":[{"role":"assistant","content":[`+
		`{"type":"tool_use","id":"toolu_1","name":"Read","input":`+input+`}]}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if got := gjson.GetBytes(request.Body, "input.0.arguments").String(); got != input {
		t.Fatalf("arguments = %q, want %q", got, input)
	}
}

// TestSchemaEditsKeepTheRest: a schema the Responses API needs adjusted keeps
// its other members in their order with their values as written.
func TestSchemaEditsKeepTheRest(t *testing.T) {
	cases := map[string]string{
		`{"$schema":"x","properties":{"n":{"maximum":1.0e3}},"title":"T"}`: `{"properties":{"n":{"maximum":1.0e3}},"title":"T","type":"object"}`,
		`{"type":"","description":"d"}`:                                    `{"type":"object","description":"d","properties":{}}`,
		`{"type":"string","$schema":1}`:                                    `{"type":"string"}`,
		`{"type":"object","properties":null}`:                              `{"type":"object","properties":null}`,
		`{"type":["object","null"]}`:                                       `{"type":["object","null"]}`,
		`[1]`:                                                              `[1]`,
		`true`:                                                             `{"type":"object","properties":{}}`,
		`null`:                                                             `{"type":"object","properties":{}}`,
	}
	for schema, want := range cases {
		request, err := ClaudeToCodex(Options{Model: "m"}, []byte(`{"messages":[],"tools":[{"name":"T","input_schema":`+schema+`}]}`))
		if err != nil {
			t.Fatal(err)
		}
		if got := gjson.GetBytes(request.Body, "tools.0.parameters").Raw; got != want {
			t.Errorf("schema %s became %s, want %s", schema, got, want)
		}
	}
}

// TestValuesOfTheWrongTypeReadAsAbsent: one odd value does not fail the
// request; it reads as missing, or as its text where text is expected.
func TestValuesOfTheWrongTypeReadAsAbsent(t *testing.T) {
	body := mustConvert(t, Options{}, `{
		"system": 5,
		"messages": [5, "x", {"role":"user","content":[{"type":"text","text":42}, 7, {"type":"image","source":"nope"}]}, {"role":7,"content":"y"}],
		"tools": [3, {"name":"Read","description":7,"input_schema":{"type":"object","properties":{}}}],
		"tool_choice": {"type":"auto","disable_parallel_tool_use":"true"},
		"thinking": {"type":"enabled","budget_tokens":"20000"}
	}`)
	if got := body.Get("input.#").Int(); got != 2 {
		t.Fatalf("input = %s, want the two usable messages", body.Get("input").Raw)
	}
	if got := body.Get("input.0.content.0.text").String(); got != "42" {
		t.Fatalf("a number where text is expected = %q, want its digits", got)
	}
	if got := body.Get("input.1.role").String(); got != "user" {
		t.Fatalf("an odd role = %q, want user", got)
	}
	if got := body.Get("tools.#").Int(); got != 1 || body.Get("tools.0.description").String() != "7" {
		t.Fatalf("tools = %s", body.Get("tools").Raw)
	}
	if body.Get("parallel_tool_calls").Bool() {
		t.Fatal(`disable_parallel_tool_use "true" must turn parallel calls off`)
	}
	if got := body.Get("reasoning.effort").String(); got != "high" {
		t.Fatalf("a budget written as a string = %q, want high", got)
	}
}

// TestFramesKeepTextAsIs: text with HTML characters goes out unescaped and
// every frame is one valid JSON payload.
func TestFramesKeepTextAsIs(t *testing.T) {
	stream := NewStreamTranslator("m", nil)
	out := string(stream.Event([]byte(`{"type":"response.output_text.delta","delta":"a <b> & c"}`)))
	if !strings.Contains(out, `"text":"a <b> & c"`) {
		t.Fatalf("frames = %s", out)
	}
	for _, f := range parseFrames(t, out) {
		if !json.Valid([]byte(f.data)) {
			t.Fatalf("frame %q", f.data)
		}
	}
}

func TestAssembledToolInputIsTheStreamedObject(t *testing.T) {
	message := assemble(t, "m", nil,
		`{"type":"response.created","response":{"id":"r"}}`,
		`{"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"f","call_id":"c","name":"Read","arguments":"{\"n\": 1.0e3, \"s\": \"<&>\"}"}}`,
		`{"type":"response.completed","response":{"id":"r","usage":{}}}`,
	)
	if got := message.Get("content.0.input").Raw; got != `{"n":1.0e3,"s":"<&>"}` {
		t.Fatalf("input = %s", got)
	}
}

// TestNoBlockBeforeMessageStart: whatever the first Codex event is, the
// client sees message_start before any content block.
func TestNoBlockBeforeMessageStart(t *testing.T) {
	cases := map[string][]string{
		"function call done first": {
			`{"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc","call_id":"call_1","name":"Read","arguments":"{\"path\":\"/a\"}"}}`,
		},
		"arguments done first": {
			`{"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc","call_id":"call_1","name":"Read"}}`,
			`{"type":"response.function_call_arguments.done","output_index":0,"item_id":"fc","arguments":"{\"path\":\"/a\"}"}`,
		},
		"reasoning done first": {
			`{"type":"response.output_item.done","item":{"type":"reasoning","encrypted_content":"STATE"}}`,
		},
	}
	completed := `{"type":"response.completed","response":{"id":"r","usage":{"input_tokens":1,"output_tokens":1}}}`
	for name, events := range cases {
		frames := runStream(t, NewStreamTranslator("gpt-6-luna", nil), append(events, completed)...)
		if len(frames) < 2 || frames[0].event != "message_start" || frames[1].event != "content_block_start" {
			t.Fatalf("%s: events = %v, want message_start then the block", name, eventNames(frames))
		}
		if got := gjson.Parse(frames[0].data).Get("message.model").String(); got != "gpt-6-luna" {
			t.Fatalf("%s: message.model = %q", name, got)
		}
	}

	// The reasoning state still reaches the client, marked, for the next turn.
	frames := runStream(t, NewStreamTranslator("gpt-6-luna", nil), cases["reasoning done first"][0], completed)
	assertEvents(t, frames, "message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop")
	if got := gjson.Parse(frames[2].data).Get("delta.signature").String(); got != SignatureMarker+"STATE" {
		t.Fatalf("signature = %q, want %q", got, SignatureMarker+"STATE")
	}
	message := assemble(t, "gpt-6-luna", nil, cases["reasoning done first"][0], completed)
	if got := message.Get("content.0.signature").String(); got != SignatureMarker+"STATE" {
		t.Fatalf("assembled signature = %q", got)
	}
}
