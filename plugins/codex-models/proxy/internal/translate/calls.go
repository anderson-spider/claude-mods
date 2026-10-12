package translate

import (
	"strconv"
	"strings"

	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/logx"
)

// Function calls.
//
// Codex streams a call as several events (item added, argument deltas,
// arguments done, item done) and may stream calls in parallel. Claude Code
// gets each call as one tool_use block, written in a single step once the
// call is finished: content_block_start, the whole input in one
// input_json_delta, content_block_stop. A call that never finishes (cut off
// by max_output_tokens, or by the stream ending) is never written, not even
// partly, and a finished call whose arguments are not a JSON object is
// dropped. Calls go out in the order they were first seen, one at a time, so
// blocks never interleave.

// toolCall is one function call as far as the stream has told it.
type toolCall struct {
	callID    string
	name      string
	arguments string
	// streamed is set once an arguments delta arrived; a final value
	// then has to extend what was streamed to replace it.
	streamed bool
	// complete is set only when the upstream says the call finished: its
	// item done (not incomplete), its arguments done, or a completed
	// terminal response listing it.
	complete bool
	// closed is set once the call was written or dropped.
	closed bool
}

// addArguments records argument text: a delta is appended; a final value
// replaces what was streamed only when it extends it, so a shorter or
// different final value never cuts arguments short.
func (c *toolCall) addArguments(s string, delta bool) {
	switch {
	case s == "":
	case delta:
		c.arguments += s
		c.streamed = true
	case !c.streamed || strings.HasPrefix(s, c.arguments):
		c.arguments = s
	}
}

// callBook finds a call from any event about it. Codex identifies a call
// differently from one event type to the next (output_index, call_id, item
// id), so every identifier seen for a call becomes a key to it.
type callBook struct {
	byKey map[string]*toolCall
	// queue holds the calls not yet written or dropped, in the order they
	// were first seen.
	queue []*toolCall
}

func newCallBook() callBook {
	return callBook{byKey: map[string]*toolCall{}}
}

// eventKeys lists the keys an event identifies a call by.
func eventKeys(ev codexEvent, item codexItem) []string {
	return callKeys(string(ev.OutputIndex), string(item.CallID), string(ev.CallID), string(item.ID), string(ev.ItemID))
}

// callKeys builds the keys from an output index (as written in the event)
// and the call and item ids, skipping empty ones.
func callKeys(outputIndex, itemCallID, eventCallID, itemID, eventItemID string) []string {
	var keys []string
	add := func(prefix, value string) {
		if value == "" {
			return
		}
		key := prefix + value
		for _, k := range keys {
			if k == key {
				return
			}
		}
		keys = append(keys, key)
	}
	add("output:", outputIndex)
	add("call:", itemCallID)
	add("call:", eventCallID)
	add("item:", itemID)
	add("item:", eventItemID)
	return keys
}

// find returns the call any of keys points to.
func (b *callBook) find(keys []string) *toolCall {
	for _, key := range keys {
		if call, ok := b.byKey[key]; ok {
			return call
		}
	}
	return nil
}

// findOrAdd returns the call keys point to, or a new one queued under them.
func (b *callBook) findOrAdd(keys []string) *toolCall {
	if call := b.find(keys); call != nil {
		return call
	}
	call := &toolCall{}
	b.queue = append(b.queue, call)
	b.alias(call, keys)
	return call
}

// identify records what an item says about a call and keeps its keys.
func (b *callBook) identify(call *toolCall, item codexItem, keys []string) {
	if item.CallID != "" {
		call.callID = string(item.CallID)
	}
	if item.Name != "" {
		call.name = string(item.Name)
	}
	b.alias(call, keys)
}

func (b *callBook) alias(call *toolCall, keys []string) {
	for _, key := range keys {
		b.byKey[key] = call
	}
}

// releaseCalls writes the calls at the head of the queue that are finished,
// and stops at the first one that is not: a later call waits for it.
func (t *StreamTranslator) releaseCalls() []byte {
	var out []byte
	for len(t.calls.queue) > 0 {
		call := t.calls.queue[0]
		if call.closed {
			t.calls.queue = t.calls.queue[1:]
			continue
		}
		if call.name == "" || !call.complete {
			return out
		}
		t.calls.queue = t.calls.queue[1:]
		call.closed = true

		input := strings.TrimSpace(call.arguments)
		if input == "" {
			// A finished call with no arguments takes none.
			input = "{}"
		}
		if !isObject(input) {
			// Unusable input is dropped, not repaired. Arguments can hold
			// file contents or secrets, so only their size is logged.
			logx.Warnf("codex stream: dropped tool call %q: arguments are not a JSON object (%d bytes)",
				t.clientToolName(call.name), len(input))
			continue
		}
		out = append(out, t.writeToolUse(call, input)...)
	}
	return out
}

// writeToolUse writes one finished call as a whole tool_use block. Its id is
// the Codex call_id, which comes back as tool_use_id on the next turn.
func (t *StreamTranslator) writeToolUse(call *toolCall, input string) []byte {
	// The call may be the stream's first output (no response.created
	// before it); message_start still goes first.
	out := append(t.ensureStarted(), t.closeThinking()...)
	out = append(out, t.closeText()...)
	index := t.nextIndex
	t.nextIndex++
	t.sawToolUse = true
	out = append(out, sseFrame("content_block_start", blockStartEvent{
		Type: "content_block_start", Index: index,
		ContentBlock: toolUseBlock{
			Type:  "tool_use",
			ID:    sanitizeToolID(call.callID),
			Name:  t.clientToolName(call.name),
			Input: emptyInput,
		},
	})...)
	out = append(out, sseFrame("content_block_delta", blockDeltaEvent{
		Type: "content_block_delta", Index: index,
		Delta: inputJSONDelta{Type: "input_json_delta", PartialJSON: input},
	})...)
	return append(out, sseFrame("content_block_stop", blockStopEvent{Type: "content_block_stop", Index: index})...)
}

// adoptCalls takes in the function calls a terminal payload lists, then
// settles the queue: the response is over, so a call still unfinished was
// cut off and is dropped without being written.
func (t *StreamTranslator) adoptCalls(output []codexItem, completed bool) []byte {
	for i, item := range output {
		if item.Type != "function_call" {
			continue
		}
		keys := callKeys(strconv.Itoa(i), string(item.CallID), "", string(item.ID), "")
		call := t.calls.findOrAdd(keys)
		t.calls.identify(call, item, keys)
		call.addArguments(string(item.Arguments), false)
		if completed && item.Status != "incomplete" {
			call.complete = true
		}
	}

	pending := t.calls.queue[:0]
	for _, call := range t.calls.queue {
		switch {
		case call.closed:
		case call.name == "" || !call.complete:
			call.closed = true
		default:
			pending = append(pending, call)
		}
	}
	t.calls.queue = pending
	return t.releaseCalls()
}
