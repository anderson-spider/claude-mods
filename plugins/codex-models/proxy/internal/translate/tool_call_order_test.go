package translate

import (
	"strings"
	"testing"

	"github.com/tidwall/gjson"
)

// clientToolUse is a tool_use as the client sees it.
type clientToolUse struct {
	id, name, input string
	deltas          int
}

// streamCalls runs the payloads through the streaming path and returns the
// tool_use blocks with their reassembled input, the number of input_json_delta
// frames each had, the stop_reason and the text.
func toolUsesFromStream(t *testing.T, payloads ...string) ([]clientToolUse, string, string, []frame) {
	t.Helper()
	frames := runStream(t, NewStreamTranslator("gpt-6-luna", nil), payloads...)
	var calls []clientToolUse
	byIndex := map[int64]int{}
	var stop, text string
	open := map[int64]bool{}
	for _, f := range frames {
		data := gjson.Parse(f.data)
		switch f.event {
		case "content_block_start":
			idx := data.Get("index").Int()
			if open[idx] {
				t.Fatalf("block %d opened twice", idx)
			}
			open[idx] = true
			if data.Get("content_block.type").String() == "tool_use" {
				byIndex[idx] = len(calls)
				calls = append(calls, clientToolUse{id: data.Get("content_block.id").String(), name: data.Get("content_block.name").String()})
			}
		case "content_block_delta":
			idx := data.Get("index").Int()
			if !open[idx] {
				t.Fatalf("delta for a block that is not open: %s", f.data)
			}
			switch data.Get("delta.type").String() {
			case "input_json_delta":
				i, ok := byIndex[idx]
				if !ok {
					t.Fatalf("input_json_delta outside a tool_use: %s", f.data)
				}
				calls[i].input += data.Get("delta.partial_json").String()
				calls[i].deltas++
			case "text_delta":
				text += data.Get("delta.text").String()
			}
		case "content_block_stop":
			idx := data.Get("index").Int()
			if !open[idx] {
				t.Fatalf("stop for a block that is not open: %s", f.data)
			}
			delete(open, idx)
		case "message_delta":
			stop = data.Get("delta.stop_reason").String()
		}
		// Blocks never interleave: at most one open at a time.
		if len(open) > 1 {
			t.Fatalf("more than one block open at %s", f.data)
		}
	}
	return calls, stop, text, frames
}

// checkBothPaths asserts the streaming and the assembled answers agree and
// match want, and that every streamed tool_use carried its input in one delta.
func assertBothPathsAgree(t *testing.T, wantStop string, want []clientToolUse, payloads ...string) {
	t.Helper()
	calls, stop, _, frames := toolUsesFromStream(t, payloads...)
	if stop != wantStop {
		t.Fatalf("stream stop_reason = %q, want %q", stop, wantStop)
	}
	if len(calls) != len(want) {
		t.Fatalf("stream tool_use = %+v, want %+v\nframes: %v", calls, want, frames)
	}
	for i, call := range calls {
		if call.deltas != 1 {
			t.Fatalf("stream call %d had %d input_json_delta frames, want exactly one", i, call.deltas)
		}
		if !gjson.Valid(call.input) || !gjson.Parse(call.input).IsObject() {
			t.Fatalf("stream call %d input %q is not a JSON object", i, call.input)
		}
		if call.id != want[i].id || call.name != want[i].name || compactJSONForCompare(call.input) != compactJSONForCompare(want[i].input) {
			t.Fatalf("stream call %d = %+v, want %+v", i, call, want[i])
		}
	}

	message := assemble(t, "gpt-6-luna", nil, payloads...)
	if got := message.Get("stop_reason").String(); got != wantStop {
		t.Fatalf("assembled stop_reason = %q, want %q", got, wantStop)
	}
	var assembled []gjson.Result
	for _, block := range message.Get("content").Array() {
		if block.Get("type").String() == "tool_use" {
			assembled = append(assembled, block)
		}
	}
	if len(assembled) != len(want) {
		t.Fatalf("assembled tool_use = %s, want %d", message.Get("content").Raw, len(want))
	}
	for i, block := range assembled {
		if block.Get("id").String() != want[i].id || block.Get("name").String() != want[i].name ||
			compactJSONForCompare(block.Get("input").Raw) != compactJSONForCompare(want[i].input) {
			t.Fatalf("assembled call %d = %s, want %+v", i, block.Raw, want[i])
		}
	}
}

func compactJSONForCompare(s string) string {
	var b strings.Builder
	inString := false
	escaped := false
	for _, r := range s {
		if inString {
			b.WriteRune(r)
			if escaped {
				escaped = false
			} else if r == '\\' {
				escaped = true
			} else if r == '"' {
				inString = false
			}
			continue
		}
		switch r {
		case ' ', '\n', '\t', '\r':
			continue
		case '"':
			inString = true
		}
		b.WriteRune(r)
	}
	return b.String()
}

const (
	codexCreated        = `{"type":"response.created","response":{"id":"r","model":"gpt-6-luna"}}`
	codexCompleted      = `{"type":"response.completed","response":{"id":"r","usage":{"input_tokens":1,"output_tokens":1}}}`
	codexCutByMaxTokens = `{"type":"response.incomplete","response":{"id":"r","incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":1,"output_tokens":9}}}`
)

func fcAdded(index, id, callID, name string) string {
	return `{"type":"response.output_item.added","output_index":` + index + `,"item":{"type":"function_call","id":"` + id + `","call_id":"` + callID + `","name":"` + name + `"}}`
}

func fcDelta(index, id, d string) string {
	return `{"type":"response.function_call_arguments.delta","output_index":` + index + `,"item_id":"` + id + `","delta":` + d + `}`
}

func fcArgumentsDone(index, id, args string) string {
	return `{"type":"response.function_call_arguments.done","output_index":` + index + `,"item_id":"` + id + `","arguments":` + args + `}`
}

func fcItemDone(index, id, callID, name, args, status string) string {
	s := `{"type":"response.output_item.done","output_index":` + index + `,"item":{"type":"function_call","id":"` + id + `","call_id":"` + callID + `","name":"` + name + `","arguments":` + args
	if status != "" {
		s += `,"status":"` + status + `"`
	}
	return s + `}}`
}

func TestInterleavedParallelCallsComeOutInOrder(t *testing.T) {
	assertBothPathsAgree(t, "tool_use", []clientToolUse{
		{id: "call_a", name: "Read", input: `{"path":"/a"}`},
		{id: "call_b", name: "Grep", input: `{"q":"b"}`},
	},
		codexCreated,
		fcAdded("0", "fa", "call_a", "Read"),
		fcAdded("1", "fb", "call_b", "Grep"),
		fcDelta("0", "fa", `"{\"pa"`),
		fcDelta("1", "fb", `"{\"q\":"`),
		fcDelta("1", "fb", `"\"b\"}"`),
		fcDelta("0", "fa", `"th\":\"/a\"}"`),
		// The second call finishes first; the first still has to come first
		// and nothing may interleave.
		fcArgumentsDone("1", "fb", `"{\"q\":\"b\"}"`),
		fcItemDone("1", "fb", "call_b", "Grep", `"{\"q\":\"b\"}"`, "completed"),
		fcArgumentsDone("0", "fa", `"{\"path\":\"/a\"}"`),
		fcItemDone("0", "fa", "call_a", "Read", `"{\"path\":\"/a\"}"`, "completed"),
		codexCompleted,
	)
}

func TestArgumentsDeltaAfterDoneIsIgnored(t *testing.T) {
	assertBothPathsAgree(t, "tool_use", []clientToolUse{{id: "call_a", name: "Read", input: `{"path":"/a"}`}},
		codexCreated,
		fcAdded("0", "fa", "call_a", "Read"),
		fcDelta("0", "fa", `"{\"path\":\"/a\"}"`),
		fcItemDone("0", "fa", "call_a", "Read", `"{\"path\":\"/a\"}"`, "completed"),
		fcDelta("0", "fa", `"GARBAGE"`),
		fcDelta("0", "fa", `",\"x\":1}"`),
		codexCompleted,
	)
}

func TestDuplicateDoneEventsEmitTheCallOnce(t *testing.T) {
	assertBothPathsAgree(t, "tool_use", []clientToolUse{{id: "call_a", name: "Read", input: `{"path":"/a"}`}},
		codexCreated,
		fcAdded("0", "fa", "call_a", "Read"),
		fcDelta("0", "fa", `"{\"path\":\"/a\"}"`),
		fcArgumentsDone("0", "fa", `"{\"path\":\"/a\"}"`),
		fcArgumentsDone("0", "fa", `"{\"path\":\"/a\"}"`),
		fcItemDone("0", "fa", "call_a", "Read", `"{\"path\":\"/a\"}"`, "completed"),
		fcItemDone("0", "fa", "call_a", "Read", `"{\"path\":\"/a\"}"`, "completed"),
		`{"type":"response.completed","response":{"id":"r","output":[{"type":"function_call","id":"fa","call_id":"call_a","name":"Read","arguments":"{\"path\":\"/a\"}","status":"completed"}],"usage":{}}}`,
	)
}

func TestAFinishedCallWithNoArgumentsTakesAnEmptyObject(t *testing.T) {
	// Finished by its own done.
	assertBothPathsAgree(t, "tool_use", []clientToolUse{{id: "call_a", name: "Now", input: `{}`}},
		codexCreated,
		fcAdded("0", "fa", "call_a", "Now"),
		fcItemDone("0", "fa", "call_a", "Now", `""`, "completed"),
		codexCompleted,
	)
	// Only in the completed terminal payload, with whitespace arguments.
	assertBothPathsAgree(t, "tool_use", []clientToolUse{{id: "call_t", name: "Now", input: `{}`}},
		codexCreated,
		`{"type":"response.completed","response":{"id":"r","output":[{"type":"function_call","id":"ft","call_id":"call_t","name":"Now","arguments":"  "}],"usage":{}}}`,
	)
}

func TestAnUnfinishedCallIsNeverGivenAnEmptyObject(t *testing.T) {
	// A call that never finished must not be invented as {} on a cut.
	assertBothPathsAgree(t, "max_tokens", nil,
		codexCreated,
		fcAdded("0", "fa", "call_a", "Bash"),
		codexCutByMaxTokens,
	)
	// Nor on a stream that just ends: that is an error, not a tool_use.
	calls, _, _, frames := toolUsesFromStream(t, codexCreated, fcAdded("0", "fa", "call_a", "Bash"))
	if len(calls) != 0 || frames[len(frames)-1].event != "error" {
		t.Fatalf("calls %+v, last frame %v", calls, frames[len(frames)-1])
	}
}

func TestTextThenACutOffCallKeepsOnlyTheText(t *testing.T) {
	payloads := []string{
		codexCreated,
		`{"type":"response.output_text.delta","output_index":0,"delta":"Let me run it."}`,
		fcAdded("1", "fa", "call_a", "Bash"),
		fcDelta("1", "fa", `"{\"command\":\"rm -rf /tmp/x"`),
		codexCutByMaxTokens,
	}
	assertBothPathsAgree(t, "max_tokens", nil, payloads...)
	calls, _, text, frames := toolUsesFromStream(t, payloads...)
	if text != "Let me run it." || len(calls) != 0 {
		t.Fatalf("text %q calls %+v", text, calls)
	}
	for _, f := range frames {
		if strings.Contains(f.data, "tool_use") || strings.Contains(f.data, "input_json_delta") {
			t.Fatalf("cut-off call leaked: %s", f.data)
		}
	}
	message := assemble(t, "gpt-6-luna", nil, payloads...)
	if blocks := message.Get("content").Array(); len(blocks) != 1 || blocks[0].Get("text").String() != "Let me run it." {
		t.Fatalf("content = %s", message.Get("content").Raw)
	}
}

func TestAnIncompleteCallIsNotEmittedWhateverTheTerminalEvent(t *testing.T) {
	// Even a full-looking JSON object is dropped when the item says it was
	// cut, whichever terminal event follows.
	for _, terminal := range []string{codexCutByMaxTokens, codexCompleted} {
		assertBothPathsAgree(t, map[string]string{codexCutByMaxTokens: "max_tokens", codexCompleted: "end_turn"}[terminal], nil,
			codexCreated,
			fcAdded("0", "fa", "call_a", "Bash"),
			fcDelta("0", "fa", `"{\"command\":\"ls\"}"`),
			fcItemDone("0", "fa", "call_a", "Bash", `"{\"command\":\"ls\"}"`, "incomplete"),
			terminal,
		)
	}
	// An incomplete terminal listing a call does not complete it.
	assertBothPathsAgree(t, "max_tokens", nil,
		codexCreated,
		`{"type":"response.incomplete","response":{"id":"r","incomplete_details":{"reason":"max_output_tokens"},"output":[{"type":"function_call","id":"ft","call_id":"call_t","name":"Bash","arguments":"{\"command\":\"ls\"}"}],"usage":{}}}`,
	)
}

func TestACutOffCallDoesNotHoldBackAFinishedOne(t *testing.T) {
	// The first call is cut (head of the queue), the second finished: only
	// the second goes out, and the answer is still max_tokens.
	assertBothPathsAgree(t, "max_tokens", []clientToolUse{{id: "call_b", name: "Read", input: `{"path":"/b"}`}},
		codexCreated,
		fcAdded("0", "fa", "call_a", "Bash"),
		fcDelta("0", "fa", `"{\"comm"`),
		fcAdded("1", "fb", "call_b", "Read"),
		fcItemDone("1", "fb", "call_b", "Read", `"{\"path\":\"/b\"}"`, "completed"),
		codexCutByMaxTokens,
	)
	// Finished call first, then the cut one, streamed.
	assertBothPathsAgree(t, "max_tokens", []clientToolUse{{id: "call_a", name: "Read", input: `{"path":"/a"}`}},
		codexCreated,
		fcAdded("0", "fa", "call_a", "Read"),
		fcItemDone("0", "fa", "call_a", "Read", `"{\"path\":\"/a\"}"`, ""),
		fcAdded("1", "fb", "call_b", "Bash"),
		fcDelta("1", "fb", `"{\"comm"`),
		codexCutByMaxTokens,
	)
}

func TestNonObjectArgumentsDropTheCall(t *testing.T) {
	for _, args := range []string{`"[1,2]"`, `"\"str\""`, `"null"`, `"42"`, `"true"`, `"{bad"`, `"{\"a\":1}{\"b\":2}"`, `"{\"a\":1"`} {
		assertBothPathsAgree(t, "end_turn", nil,
			codexCreated,
			fcAdded("0", "fa", "call_a", "Bash"),
			fcItemDone("0", "fa", "call_a", "Bash", args, "completed"),
			codexCompleted,
		)
		// Next to a good call, only the good one survives.
		assertBothPathsAgree(t, "tool_use", []clientToolUse{{id: "call_b", name: "Read", input: `{"p":1}`}},
			codexCreated,
			fcAdded("0", "fa", "call_a", "Bash"),
			fcItemDone("0", "fa", "call_a", "Bash", args, "completed"),
			fcAdded("1", "fb", "call_b", "Read"),
			fcItemDone("1", "fb", "call_b", "Read", `"{\"p\":1}"`, "completed"),
			codexCompleted,
		)
	}
}

func TestArgumentsDoneBeforeTheNameIsKnown(t *testing.T) {
	// arguments.done arrives for an item the translator has not seen yet;
	// the name comes later with output_item.done.
	assertBothPathsAgree(t, "tool_use", []clientToolUse{{id: "call_a", name: "Read", input: `{"path":"/a"}`}},
		codexCreated,
		fcArgumentsDone("0", "fa", `"{\"path\":\"/a\"}"`),
		fcItemDone("0", "fa", "call_a", "Read", `"{\"path\":\"/a\"}"`, "completed"),
		codexCompleted,
	)
}

func TestAShorterFinalValueKeepsTheStreamedArguments(t *testing.T) {
	// A divergent final value after streamed deltas never truncates them.
	assertBothPathsAgree(t, "tool_use", []clientToolUse{{id: "call_a", name: "Read", input: `{"path":"/abc"}`}},
		codexCreated,
		fcAdded("0", "fa", "call_a", "Read"),
		fcDelta("0", "fa", `"{\"path\":\"/abc\"}"`),
		fcArgumentsDone("0", "fa", `"{\"pa"`),
		codexCompleted,
	)
}
