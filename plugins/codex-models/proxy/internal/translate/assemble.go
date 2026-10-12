package translate

import (
	"bytes"
	"encoding/json"
	"strings"
)

// MessageAssembler folds the events a StreamTranslator writes into one
// Messages response, for a client that did not ask to stream.
//
// The Codex backend answers only as a stream, so the non-streaming answer is
// built from the same translated events as the streaming one: one translation
// path for both. Building it from the terminal payload instead would come out
// empty, because the production backend does not repeat streamed items there.
type MessageAssembler struct {
	id    string
	model string

	blocks  []*assembledBlock
	current *assembledBlock

	stopReason   string
	stopSequence string
	usage        json.RawMessage

	errType    string
	errMessage string
}

// assembledBlock gathers one content block's start and deltas.
type assembledBlock struct {
	kind      string
	id        string
	name      string
	text      strings.Builder
	thinking  strings.Builder
	signature string
	input     strings.Builder
}

// translatedEvent holds the fields of every event a StreamTranslator writes
// that the assembler reads.
type translatedEvent struct {
	Type    text `json:"type"`
	Message struct {
		ID    text `json:"id"`
		Model text `json:"model"`
	} `json:"message"`
	ContentBlock struct {
		Type text `json:"type"`
		ID   text `json:"id"`
		Name text `json:"name"`
		Text text `json:"text"`
	} `json:"content_block"`
	Delta struct {
		Type         text            `json:"type"`
		Text         text            `json:"text"`
		Thinking     text            `json:"thinking"`
		Signature    text            `json:"signature"`
		PartialJSON  text            `json:"partial_json"`
		StopReason   json.RawMessage `json:"stop_reason"`
		StopSequence json.RawMessage `json:"stop_sequence"`
	} `json:"delta"`
	Usage json.RawMessage `json:"usage"`
	Error struct {
		Type    text `json:"type"`
		Message text `json:"message"`
	} `json:"error"`
}

// assembledMessage is the Messages response body.
type assembledMessage struct {
	ID           string          `json:"id"`
	Type         string          `json:"type"`
	Role         string          `json:"role"`
	Model        string          `json:"model"`
	Content      []any           `json:"content"`
	StopReason   *string         `json:"stop_reason"`
	StopSequence *string         `json:"stop_sequence"`
	Usage        json.RawMessage `json:"usage"`
}

// NewMessageAssembler returns an assembler for one response.
func NewMessageAssembler() *MessageAssembler {
	return &MessageAssembler{}
}

// Write takes SSE bytes written by a StreamTranslator.
func (a *MessageAssembler) Write(frames []byte) {
	for _, payload := range eventPayloads(frames) {
		var ev translatedEvent
		readJSON(payload, &ev)
		a.take(ev)
	}
}

// Err returns the error type and message when the stream ended in an error.
func (a *MessageAssembler) Err() (kind string, message string, ok bool) {
	if a.errMessage == "" {
		return "", "", false
	}
	return a.errType, a.errMessage, true
}

func (a *MessageAssembler) take(ev translatedEvent) {
	switch ev.Type {
	case "message_start":
		a.id = string(ev.Message.ID)
		a.model = string(ev.Message.Model)

	case "content_block_start":
		block := &assembledBlock{
			kind: string(ev.ContentBlock.Type),
			id:   string(ev.ContentBlock.ID),
			name: string(ev.ContentBlock.Name),
		}
		block.text.WriteString(string(ev.ContentBlock.Text))
		a.blocks = append(a.blocks, block)
		a.current = block

	case "content_block_delta":
		if a.current == nil {
			return
		}
		switch ev.Delta.Type {
		case "text_delta":
			a.current.text.WriteString(string(ev.Delta.Text))
		case "thinking_delta":
			a.current.thinking.WriteString(string(ev.Delta.Thinking))
		case "signature_delta":
			a.current.signature = string(ev.Delta.Signature)
		case "input_json_delta":
			a.current.input.WriteString(string(ev.Delta.PartialJSON))
		}

	case "content_block_stop":
		a.current = nil

	case "message_delta":
		if len(ev.Delta.StopReason) > 0 {
			a.stopReason = textOf(ev.Delta.StopReason)
		}
		if kindOf(ev.Delta.StopSequence) == '"' {
			a.stopSequence = textOf(ev.Delta.StopSequence)
		}
		if kindOf(ev.Usage) == '{' {
			a.usage = ev.Usage
		}

	case "error":
		a.errType = string(ev.Error.Type)
		a.errMessage = string(ev.Error.Message)
	}
}

// Message returns the assembled Messages response.
func (a *MessageAssembler) Message() []byte {
	message := assembledMessage{
		ID:      a.id,
		Type:    "message",
		Role:    "assistant",
		Model:   a.model,
		Content: []any{},
		Usage:   a.usage,
	}
	if message.ID == "" {
		message.ID = "msg_codex"
	}
	for _, block := range a.blocks {
		if content, ok := block.content(); ok {
			message.Content = append(message.Content, content)
		}
	}
	if a.stopReason != "" {
		message.StopReason = &a.stopReason
	}
	if a.stopSequence != "" {
		message.StopSequence = &a.stopSequence
	}
	if len(message.Usage) == 0 {
		message.Usage = encode(tokenUsage{})
	}
	return encode(message)
}

// content is the block as it stands in the message; an empty block, or a
// tool_use whose input is not a JSON object, has no place there.
func (b *assembledBlock) content() (any, bool) {
	switch b.kind {
	case "text":
		if b.text.Len() == 0 {
			return nil, false
		}
		return textBlock{Type: "text", Text: b.text.String()}, true

	case "thinking":
		if b.thinking.Len() == 0 && b.signature == "" {
			return nil, false
		}
		return thinkingBlock{Type: "thinking", Thinking: b.thinking.String(), Signature: b.signature}, true

	case "tool_use":
		if b.name == "" {
			return nil, false
		}
		// No input deltas means no input. Input that is not a JSON object
		// was cut short: the block is dropped, never given an invented {}.
		input := emptyInput
		if s := strings.TrimSpace(b.input.String()); s != "" {
			if !isObject(s) {
				return nil, false
			}
			input = json.RawMessage(s)
		}
		return toolUseBlock{Type: "tool_use", ID: b.id, Name: b.name, Input: input}, true
	}
	return nil, false
}

// eventPayloads returns the data of each event in SSE bytes, a multi-line
// data field joined with newlines.
func eventPayloads(frames []byte) [][]byte {
	var payloads [][]byte
	for _, event := range bytes.Split(frames, []byte("\n\n")) {
		var payload []byte
		for _, line := range bytes.Split(event, []byte("\n")) {
			value, ok := bytes.CutPrefix(line, []byte("data:"))
			if !ok {
				continue
			}
			value = bytes.TrimPrefix(value, []byte(" "))
			if len(payload) > 0 {
				payload = append(payload, '\n')
			}
			payload = append(payload, value...)
		}
		if len(payload) > 0 {
			payloads = append(payloads, payload)
		}
	}
	return payloads
}
