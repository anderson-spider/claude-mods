package translate

import (
	"encoding/json"
	"strings"
)

// summarySeparator joins the summary parts of one Codex reasoning item, which
// become one thinking block.
const summarySeparator = "\n\n"

// codexEvent holds the fields of every Responses stream event the translator
// reads; each event type uses its own subset.
type codexEvent struct {
	Type        text            `json:"type"`
	Response    codexResponse   `json:"response"`
	Item        codexItem       `json:"item"`
	Part        codexPart       `json:"part"`
	Delta       text            `json:"delta"`
	Arguments   text            `json:"arguments"`
	OutputIndex json.RawMessage `json:"output_index"`
	CallID      text            `json:"call_id"`
	ItemID      text            `json:"item_id"`
	Error       json.RawMessage `json:"error"`
	Code        text            `json:"code"`
	Message     text            `json:"message"`
}

type codexResponse struct {
	ID                text            `json:"id"`
	Model             text            `json:"model"`
	Output            []codexItem     `json:"output"`
	Usage             json.RawMessage `json:"usage"`
	StopReason        text            `json:"stop_reason"`
	IncompleteDetails struct {
		Reason text `json:"reason"`
	} `json:"incomplete_details"`
	Error codexError `json:"error"`
}

// codexItem is one output item: a message, a reasoning item or a function
// call.
type codexItem struct {
	Type             text        `json:"type"`
	ID               text        `json:"id"`
	CallID           text        `json:"call_id"`
	Name             text        `json:"name"`
	Arguments        text        `json:"arguments"`
	Status           text        `json:"status"`
	EncryptedContent text        `json:"encrypted_content"`
	Content          []codexPart `json:"content"`
	Summary          []codexPart `json:"summary"`
}

// codexPart is a message content part or a reasoning summary part.
type codexPart struct {
	Type text `json:"type"`
	Text text `json:"text"`
}

type codexError struct {
	Type    text `json:"type"`
	Code    text `json:"code"`
	Message text `json:"message"`
}

type codexUsage struct {
	InputTokens        count `json:"input_tokens"`
	OutputTokens       count `json:"output_tokens"`
	InputTokensDetails struct {
		CachedTokens     count `json:"cached_tokens"`
		CacheWriteTokens count `json:"cache_write_tokens"`
	} `json:"input_tokens_details"`
}

// blockKind says which text or thinking block is open, if any. A tool_use
// block opens and closes within one step, so it is never left open.
type blockKind int

const (
	noBlock blockKind = iota
	textKind
	thinkingKind
)

// StreamTranslator turns one Codex Responses event stream into the Anthropic
// Messages event stream Claude Code reads. Use one per response, from one
// goroutine.
//
// message_start comes first, whatever the first Codex event is. Content
// blocks open and close one at a time, with increasing indexes, and
// the stream ends with message_delta and message_stop, or with an error event
// after which nothing follows.
type StreamTranslator struct {
	// fallbackModel goes in message_start when the upstream does not name
	// the model that answered.
	fallbackModel string
	// toolNames maps the function names Codex saw to the client's own.
	toolNames map[string]string

	started bool
	stopped bool
	// failed is set once an error event went out.
	failed bool

	open blockKind
	// nextIndex is the index the next content block gets.
	nextIndex int

	// reasoningState is the open reasoning item's encrypted content. Only
	// its output_item.done carries the final value, so it is held until the
	// thinking block closes.
	reasoningState string
	// summarized is set once the open reasoning item streamed summary text.
	summarized bool

	sawText     bool // an output_text delta, or a whole message item, was seen
	sawThinking bool // a thinking block was opened
	sawToolUse  bool // a tool_use block went out

	calls callBook
}

// NewStreamTranslator returns a translator for one response. fallbackModel is
// the Codex model id the request resolved to, reported when the stream does
// not name the model; toolNames maps the names sent to Codex back to the
// client's.
func NewStreamTranslator(fallbackModel string, toolNames map[string]string) *StreamTranslator {
	return &StreamTranslator{
		fallbackModel: fallbackModel,
		toolNames:     toolNames,
		calls:         newCallBook(),
	}
}

// Started reports whether message_start went out: until then a failure can
// still be answered with an HTTP status.
func (t *StreamTranslator) Started() bool { return t.started }

// Ended reports whether the message is over (message_stop or an error went
// out) and nothing more will be written.
func (t *StreamTranslator) Ended() bool { return t.stopped || t.failed }

// Event translates one Codex event (the JSON of its data line) into the
// Anthropic events it implies, possibly none.
func (t *StreamTranslator) Event(payload []byte) []byte {
	if t.Ended() {
		return nil
	}
	var ev codexEvent
	if !readJSON(payload, &ev) {
		return nil
	}

	var out []byte
	switch ev.Type {
	case "response.created":
		out = t.begin(ev.Response)

	case "response.reasoning_summary_part.added":
		out = append(t.ensureStarted(), t.closeText()...)
		// One reasoning item can stream several summary parts, but its
		// encrypted state comes only at the end, so the parts share one
		// thinking block, a blank line apart.
		if t.open == thinkingKind {
			out = append(out, t.thinkingText(summarySeparator)...)
		} else {
			out = append(out, t.openThinkingBlock()...)
		}
		t.summarized = true

	case "response.reasoning_summary_text.delta":
		out = append(t.ensureStarted(), t.closeText()...)
		out = append(out, t.openThinkingBlock()...)
		out = append(out, t.thinkingText(string(ev.Delta))...)
		t.summarized = true

	case "response.content_part.added":
		if ev.Part.Type == "output_text" {
			out = append(t.ensureStarted(), t.closeThinking()...)
			out = append(out, t.openTextBlock()...)
		}

	case "response.output_text.delta":
		out = append(t.ensureStarted(), t.closeThinking()...)
		out = append(out, t.openTextBlock()...)
		out = append(out, t.text(string(ev.Delta))...)
		t.sawText = true

	case "response.content_part.done":
		if ev.Part.Type == "output_text" {
			out = t.closeText()
		}

	case "response.output_item.added":
		out = t.itemAdded(ev)

	case "response.output_item.done":
		out = t.itemDone(ev)

	case "response.function_call_arguments.delta":
		call := t.calls.findOrAdd(eventKeys(ev, codexItem{}))
		call.addArguments(string(ev.Delta), true)

	case "response.function_call_arguments.done":
		call := t.calls.findOrAdd(eventKeys(ev, codexItem{}))
		call.addArguments(string(ev.Arguments), false)
		call.complete = true
		out = t.releaseCalls()

	case "response.completed":
		out = t.finish(ev.Response, true)

	case "response.incomplete":
		out = t.finish(ev.Response, false)

	case "response.failed":
		failure := ev.Response.Error
		message := string(failure.Message)
		if message == "" {
			message = "the Codex backend reported a failed response"
		}
		out = t.Error(errorKind(string(failure.Type), string(failure.Code)), message)

	case "error":
		// The error is usually an object under "error", and sometimes its
		// fields sit at the top of the event instead.
		var failure codexError
		if len(ev.Error) > 0 {
			readJSON(ev.Error, &failure)
		} else {
			failure.Code = ev.Code
		}
		message := string(failure.Message)
		if message == "" {
			message = string(ev.Message)
		}
		out = t.Error(errorKind(string(failure.Type), string(failure.Code)), message)
	}
	return out
}

func (t *StreamTranslator) itemAdded(ev codexEvent) []byte {
	switch ev.Item.Type {
	case "reasoning":
		out := append(t.ensureStarted(), t.closeText()...)
		// A reasoning item that never reported done must not run into
		// the next one.
		out = append(out, t.closeThinking()...)
		t.summarized = false
		// Only a fallback: the value here is a snapshot from before the
		// reasoning; output_item.done brings the final one.
		t.reasoningState = string(ev.Item.EncryptedContent)
		return out
	case "function_call":
		out := append(t.ensureStarted(), t.closeThinking()...)
		out = append(out, t.closeText()...)
		keys := eventKeys(ev, ev.Item)
		call := t.calls.findOrAdd(keys)
		t.calls.identify(call, ev.Item, keys)
		return append(out, t.releaseCalls()...)
	}
	return nil
}

func (t *StreamTranslator) itemDone(ev codexEvent) []byte {
	item := ev.Item
	switch item.Type {
	case "reasoning":
		out := append(t.ensureStarted(), t.closeText()...)
		if item.EncryptedContent != "" {
			t.reasoningState = string(item.EncryptedContent)
		}
		if !t.summarized && t.reasoningState != "" {
			// Nothing was summarized, but the state still has to reach the
			// client for the next turn to replay it: an empty thinking
			// block carries it.
			out = append(out, t.openThinkingBlock()...)
		}
		out = append(out, t.closeThinking()...)
		t.reasoningState = ""
		t.summarized = false
		return out

	case "function_call":
		out := append(t.closeThinking(), t.closeText()...)
		keys := eventKeys(ev, item)
		call := t.calls.findOrAdd(keys)
		t.calls.identify(call, item, keys)
		call.addArguments(string(item.Arguments), false)
		if item.Status != "incomplete" {
			call.complete = true
		}
		return append(out, t.releaseCalls()...)

	case "message":
		// Some responses deliver a whole message at once, with no
		// output_text deltas before it.
		if t.sawText {
			return nil
		}
		whole := outputText(item)
		if whole == "" {
			return nil
		}
		out := append(t.ensureStarted(), t.closeThinking()...)
		out = append(out, t.openTextBlock()...)
		out = append(out, t.text(whole)...)
		out = append(out, t.closeText()...)
		t.sawText = true
		return out
	}
	return nil
}

// Error writes an Anthropic error event and ends the stream: nothing is
// written after it, and Close adds nothing. kind is mapped through errorKind,
// so only Anthropic error types go out; message is cleaned and capped.
func (t *StreamTranslator) Error(kind, message string) []byte {
	if t.failed {
		return nil
	}
	t.failed = true
	message = CleanMessage(message)
	if message == "" {
		message = "upstream error"
	}
	return sseFrame("error", errorEvent{Type: "error", Error: errorDetail{Type: errorKind(kind, ""), Message: message}})
}

// Close ends the stream when the upstream stopped sending. A stream that
// stopped before response.completed, response.incomplete or an error was cut
// short, and is reported as an error: an answer that looks finished, with an
// invented end_turn and no usage, would be worse.
func (t *StreamTranslator) Close() []byte {
	if t.Ended() {
		return nil
	}
	return t.Error("api_error", "the Codex stream ended before the response completed")
}

// begin writes message_start once, from response.created. The model is the one the upstream says
// answered, since that is what the transcript, /cost and the log should name.
func (t *StreamTranslator) begin(response codexResponse) []byte {
	if t.started {
		return nil
	}
	t.started = true
	id := string(response.ID)
	if id == "" {
		id = "msg_codex"
	}
	model := strings.TrimSpace(string(response.Model))
	if model == "" {
		model = t.fallbackModel
	}
	return sseFrame("message_start", messageStartEvent{
		Type: "message_start",
		Message: messageHeader{
			ID:      id,
			Type:    "message",
			Role:    "assistant",
			Model:   model,
			Content: []struct{}{},
		},
	})
}

// ensureStarted covers a stream whose first event is not
// response.created: message_start then says only what the translator knows.
func (t *StreamTranslator) ensureStarted() []byte {
	return t.begin(codexResponse{})
}

// finish closes the message on a terminal event. completed is false for
// response.incomplete, where a call the payload lists is not taken as
// finished.
func (t *StreamTranslator) finish(response codexResponse, completed bool) []byte {
	out := t.ensureStarted()
	out = append(out, t.closeThinking()...)
	out = append(out, t.closeText()...)
	// The terminal payload may list items that were never streamed.
	out = append(out, t.adoptContent(response.Output)...)
	out = append(out, t.adoptCalls(response.Output, completed)...)
	out = append(out, t.closeThinking()...)
	out = append(out, t.closeText()...)

	reason := string(response.StopReason)
	if reason == "" {
		reason = string(response.IncompleteDetails.Reason)
	}
	out = append(out, sseFrame("message_delta", messageDeltaEvent{
		Type:  "message_delta",
		Delta: stopDelta{StopReason: stopReason(reason, t.sawToolUse)},
		Usage: anthropicUsage(response.Usage),
	})...)
	out = append(out, sseFrame("message_stop", messageStopEvent{Type: "message_stop"})...)
	t.stopped = true
	return out
}

// adoptContent writes the reasoning and message items that only the terminal
// payload carries. Deployments differ on what the terminal event repeats: the
// production backend repeats nothing it streamed, others list the whole
// output. Taking only what did not stream covers both without duplicates.
func (t *StreamTranslator) adoptContent(output []codexItem) []byte {
	var out []byte
	for _, item := range output {
		switch item.Type {
		case "reasoning":
			if t.sawThinking {
				continue
			}
			var summary []string
			for _, part := range item.Summary {
				if part.Text != "" {
					summary = append(summary, string(part.Text))
				}
			}
			if len(summary) == 0 && item.EncryptedContent == "" {
				continue
			}
			t.reasoningState = string(item.EncryptedContent)
			out = append(out, t.openThinkingBlock()...)
			out = append(out, t.thinkingText(strings.Join(summary, summarySeparator))...)
			out = append(out, t.closeThinking()...)
			t.reasoningState = ""

		case "message":
			if t.sawText {
				continue
			}
			whole := outputText(item)
			if whole == "" {
				continue
			}
			out = append(out, t.openTextBlock()...)
			out = append(out, t.text(whole)...)
			out = append(out, t.closeText()...)
			t.sawText = true
		}
	}
	return out
}

// outputText is the text of a message item's output_text parts.
func outputText(item codexItem) string {
	var b strings.Builder
	for _, part := range item.Content {
		if part.Type == "output_text" {
			b.WriteString(string(part.Text))
		}
	}
	return b.String()
}

// Text and thinking blocks.

func (t *StreamTranslator) openTextBlock() []byte {
	if t.open == textKind {
		return nil
	}
	t.open = textKind
	return sseFrame("content_block_start", blockStartEvent{
		Type: "content_block_start", Index: t.nextIndex,
		ContentBlock: textBlock{Type: "text"},
	})
}

func (t *StreamTranslator) text(s string) []byte {
	if s == "" {
		return nil
	}
	return sseFrame("content_block_delta", blockDeltaEvent{
		Type: "content_block_delta", Index: t.nextIndex,
		Delta: textDelta{Type: "text_delta", Text: s},
	})
}

func (t *StreamTranslator) closeText() []byte {
	if t.open != textKind {
		return nil
	}
	return t.closeBlock()
}

func (t *StreamTranslator) openThinkingBlock() []byte {
	if t.open == thinkingKind {
		return nil
	}
	t.open = thinkingKind
	t.sawThinking = true
	return sseFrame("content_block_start", blockStartEvent{
		Type: "content_block_start", Index: t.nextIndex,
		ContentBlock: thinkingBlock{Type: "thinking"},
	})
}

func (t *StreamTranslator) thinkingText(s string) []byte {
	if s == "" {
		return nil
	}
	return sseFrame("content_block_delta", blockDeltaEvent{
		Type: "content_block_delta", Index: t.nextIndex,
		Delta: thinkingDelta{Type: "thinking_delta", Thinking: s},
	})
}

// closeThinking ends the thinking block with the reasoning state, marked as
// this proxy's, as its signature.
func (t *StreamTranslator) closeThinking() []byte {
	if t.open != thinkingKind {
		return nil
	}
	var out []byte
	if t.reasoningState != "" {
		out = sseFrame("content_block_delta", blockDeltaEvent{
			Type: "content_block_delta", Index: t.nextIndex,
			Delta: signatureDelta{Type: "signature_delta", Signature: MarkSignature(t.reasoningState)},
		})
	}
	return append(out, t.closeBlock()...)
}

func (t *StreamTranslator) closeBlock() []byte {
	out := sseFrame("content_block_stop", blockStopEvent{Type: "content_block_stop", Index: t.nextIndex})
	t.open = noBlock
	t.nextIndex++
	return out
}

func (t *StreamTranslator) clientToolName(name string) string {
	if original, ok := t.toolNames[name]; ok {
		return original
	}
	return name
}

// sanitizeToolID keeps a tool_use id to the characters Anthropic accepts.
func sanitizeToolID(id string) string {
	if id == "" {
		return "toolu_codex"
	}
	return strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_', r == '-':
			return r
		}
		return '_'
	}, id)
}

// stopReason maps the Responses stop reason. Running out of output tokens
// wins over everything, a finished tool call included: the turn was cut
// short either way.
func stopReason(reason string, toolUse bool) string {
	switch {
	case reason == "max_tokens" || reason == "max_output_tokens":
		return "max_tokens"
	case toolUse:
		return "tool_use"
	case reason == "refusal" || reason == "content_filter":
		return "refusal"
	case reason == "pause_turn":
		return "pause_turn"
	}
	return "end_turn"
}

// splitUsage reads Responses usage as Anthropic counts it. The Responses
// input_tokens includes cache reads and cache writes; Anthropic's counts
// neither, and reports them in fields of their own.
func splitUsage(raw json.RawMessage) (input, output, cacheRead, cacheWrite int64) {
	var u codexUsage
	readJSON(raw, &u)
	cacheRead = int64(u.InputTokensDetails.CachedTokens)
	cacheWrite = int64(u.InputTokensDetails.CacheWriteTokens)
	input = max(int64(u.InputTokens)-cacheRead-cacheWrite, 0)
	return input, int64(u.OutputTokens), cacheRead, cacheWrite
}

func anthropicUsage(raw json.RawMessage) tokenUsage {
	input, output, cacheRead, cacheWrite := splitUsage(raw)
	usage := tokenUsage{InputTokens: input, OutputTokens: output}
	if cacheRead > 0 {
		usage.CacheReadInputTokens = cacheRead
	}
	if cacheWrite > 0 {
		usage.CacheCreationInputTokens = cacheWrite
	}
	return usage
}
