package translate

import (
	"encoding/json"
	"errors"
	"strings"
)

// Request is one Claude request translated for the Codex backend.
type Request struct {
	// Body is the Responses request to POST.
	Body []byte
	// ToolNames maps each tool name sent to Codex back to the client's own,
	// for the names that had to be shortened (and every other tool's).
	ToolNames map[string]string
}

// Options says what to ask Codex for.
type Options struct {
	// Model is the Codex model id.
	Model string
	// Effort is the reasoning effort to send. Empty means: read it from the
	// request (see EffortFrom).
	Effort string
	// DefaultEffort is what EffortFrom falls back to.
	DefaultEffort string
}

// claudeRequest is what the translation reads of a Messages request.
type claudeRequest struct {
	preferences
	System     json.RawMessage `json:"system"`
	Messages   json.RawMessage `json:"messages"`
	Tools      json.RawMessage `json:"tools"`
	ToolChoice json.RawMessage `json:"tool_choice"`
}

type claudeMessage struct {
	Role    text            `json:"role"`
	Content json.RawMessage `json:"content"`
}

// claudeBlock holds the fields of every content block type the translation
// reads; each type uses its own subset.
type claudeBlock struct {
	Type      text            `json:"type"`
	Text      text            `json:"text"`
	Source    json.RawMessage `json:"source"`
	Signature text            `json:"signature"`
	ID        text            `json:"id"`
	Name      text            `json:"name"`
	Input     json.RawMessage `json:"input"`
	ToolUseID text            `json:"tool_use_id"`
	Content   json.RawMessage `json:"content"`
}

type claudeSource struct {
	Type      text `json:"type"`
	MediaType text `json:"media_type"`
	Data      text `json:"data"`
	URL       text `json:"url"`
}

// codexRequest is the Responses request body. The field order is the order
// on the wire.
type codexRequest struct {
	Model string `json:"model"`
	// Instructions stays empty: the system prompt goes in as a developer
	// message instead.
	Instructions      string          `json:"instructions"`
	Input             []any           `json:"input"`
	Tools             *[]any          `json:"tools,omitempty"`
	ToolChoice        any             `json:"tool_choice,omitempty"`
	ParallelToolCalls bool            `json:"parallel_tool_calls"`
	Reasoning         codexReasoning  `json:"reasoning"`
	Store             bool            `json:"store"`
	Stream            bool            `json:"stream"`
	Include           []string        `json:"include"`
	Text              *codexTextBlock `json:"text,omitempty"`
}

type codexReasoning struct {
	Effort  string `json:"effort"`
	Summary string `json:"summary"`
}

type codexTextBlock struct {
	Format json.RawMessage `json:"format"`
}

// Input items.

type messageItem struct {
	Type    string `json:"type"`
	Role    string `json:"role"`
	Content []any  `json:"content"`
}

// reasoningItem replays the reasoning state of an earlier Codex turn. The
// backend expects "summary": [] and "content": null, written out, not left
// absent.
type reasoningItem struct {
	Type             string     `json:"type"`
	Summary          []struct{} `json:"summary"`
	Content          []struct{} `json:"content"`
	EncryptedContent string     `json:"encrypted_content"`
}

type functionCallItem struct {
	Type      string `json:"type"`
	CallID    string `json:"call_id"`
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

// functionCallOutputItem carries a tool result; Output is a string or a list
// of parts.
type functionCallOutputItem struct {
	Type   string `json:"type"`
	CallID string `json:"call_id"`
	Output any    `json:"output"`
}

// Content parts.

type textPart struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type imagePart struct {
	Type     string `json:"type"`
	ImageURL string `json:"image_url"`
}

type filePart struct {
	Type     string `json:"type"`
	FileData string `json:"file_data"`
	Filename string `json:"filename"`
}

// ClaudeToCodex translates a Messages request into a Responses request. The
// Codex backend answers only as a stream, so the body always asks for one,
// whatever the client asked; the router folds the stream back into a single
// message for a client that did not stream.
func ClaudeToCodex(opts Options, raw []byte) (*Request, error) {
	var req claudeRequest
	if !readJSON(raw, &req) {
		return nil, errors.New("translate: request body is not valid JSON")
	}

	short, original := toolNameMaps(req.Tools)
	input := inputBuilder{shortNames: short, items: []any{}}
	input.addSystem(req.System)
	for _, raw := range elements(req.Messages) {
		var message claudeMessage
		readJSON(raw, &message)
		input.addMessage(message)
	}

	body := codexRequest{
		Model:             opts.Model,
		Input:             input.items,
		ParallelToolCalls: parallelToolCalls(req.ToolChoice),
		Reasoning: codexReasoning{
			Effort: opts.Effort,
			// Summaries are opt-in on the Responses API, and they are what
			// Claude Code shows as thinking.
			Summary: "auto",
		},
		Store:  false,
		Stream: true,
		// The encrypted reasoning state has to come back on the next turn
		// for the model to keep its chain of thought across tool calls.
		Include: []string{"reasoning.encrypted_content"},
	}
	if body.Reasoning.Effort == "" {
		body.Reasoning.Effort = req.effort(opts.DefaultEffort)
	}
	if kindOf(req.Tools) == '[' {
		tools := codexTools(req.Tools, short)
		body.Tools = &tools
		body.ToolChoice = codexToolChoice(req.ToolChoice, short)
	}
	if format, ok := req.structuredOutput(); ok {
		body.Text = &codexTextBlock{Format: format}
	}

	encoded := encode(body)
	if encoded == nil {
		return nil, errors.New("translate: the Codex request could not be encoded")
	}
	return &Request{Body: encoded, ToolNames: original}, nil
}

// inputBuilder turns the system prompt and the conversation into Responses
// input items. Consecutive text, image and document blocks of one message
// share a message item; a thinking, tool_use or tool_result block is an item
// of its own and closes the message item before it.
type inputBuilder struct {
	shortNames map[string]string
	items      []any
}

// addSystem puts the system prompt in a developer message, where the
// Responses API takes instructions that are not part of the conversation.
func (b *inputBuilder) addSystem(system json.RawMessage) {
	var parts []any
	add := func(s string) {
		if strings.TrimSpace(s) != "" {
			parts = append(parts, textPart{Type: "input_text", Text: s})
		}
	}
	switch kindOf(system) {
	case '"':
		add(textOf(system))
	case '[':
		for _, raw := range elements(system) {
			var block claudeBlock
			readJSON(raw, &block)
			if block.Type == "text" {
				add(string(block.Text))
			}
		}
	}
	if len(parts) > 0 {
		b.items = append(b.items, messageItem{Type: "message", Role: "developer", Content: parts})
	}
}

func (b *inputBuilder) addMessage(message claudeMessage) {
	role := string(message.Role)
	if role != "user" && role != "assistant" {
		// A Messages request has only user and assistant turns; anything
		// else is read as the user's.
		role = "user"
	}

	var parts []any
	closeMessage := func() {
		if len(parts) > 0 {
			b.items = append(b.items, messageItem{Type: "message", Role: role, Content: parts})
			parts = nil
		}
	}

	switch kindOf(message.Content) {
	case '"':
		parts = append(parts, roleText(role, textOf(message.Content)))
		closeMessage()
		return
	case '[':
	default:
		return
	}

	for _, raw := range elements(message.Content) {
		var block claudeBlock
		readJSON(raw, &block)
		switch block.Type {
		case "text":
			parts = append(parts, roleText(role, string(block.Text)))
		case "image":
			if part, ok := imageFrom(block.Source); ok {
				parts = append(parts, part)
			}
		case "document":
			if part, ok := pdfFrom(block.Source); ok {
				parts = append(parts, part)
			}
		case "thinking":
			// Codex can resume only from reasoning state it produced, which
			// is what the marker says. Anthropic's thinking is left out
			// rather than sent to fail upstream.
			state, ours := codexState(string(block.Signature))
			if !ours || state == "" {
				continue
			}
			closeMessage()
			b.items = append(b.items, reasoningItem{Type: "reasoning", Summary: []struct{}{}, EncryptedContent: state})
		case "tool_use":
			closeMessage()
			b.items = append(b.items, b.toolCall(block))
		case "tool_result":
			closeMessage()
			b.items = append(b.items, toolResult(block))
		}
	}
	closeMessage()
}

// roleText is a text part: input_text from the user, output_text from the
// assistant.
func roleText(role, s string) textPart {
	if role == "assistant" {
		return textPart{Type: "output_text", Text: s}
	}
	return textPart{Type: "input_text", Text: s}
}

// imageFrom reads an image source: a URL as is, base64 data as a data: URL.
func imageFrom(raw json.RawMessage) (imagePart, bool) {
	if len(raw) == 0 {
		return imagePart{}, false
	}
	var source claudeSource
	readJSON(raw, &source)
	if source.URL != "" {
		return imagePart{Type: "input_image", ImageURL: string(source.URL)}, true
	}
	if source.Data == "" {
		return imagePart{}, false
	}
	mediaType := string(source.MediaType)
	if mediaType == "" {
		mediaType = "application/octet-stream"
	}
	return imagePart{Type: "input_image", ImageURL: "data:" + mediaType + ";base64," + string(source.Data)}, true
}

// pdfFrom reads a document source. Only a base64 PDF has a Responses
// equivalent; any other document is left out.
func pdfFrom(raw json.RawMessage) (filePart, bool) {
	var source claudeSource
	readJSON(raw, &source)
	if source.Type != "base64" {
		return filePart{}, false
	}
	mediaType := strings.TrimSpace(string(source.MediaType))
	if !strings.EqualFold(mediaType, "application/pdf") || source.Data == "" {
		return filePart{}, false
	}
	return filePart{Type: "input_file", FileData: "data:" + mediaType + ";base64," + string(source.Data), Filename: "document.pdf"}, true
}

// toolCall replays a tool_use as a function_call. Its input goes over as the
// JSON text the client sent, inside a string.
func (b *inputBuilder) toolCall(block claudeBlock) functionCallItem {
	arguments := string(block.Input)
	if strings.TrimSpace(arguments) == "" {
		arguments = "{}"
	}
	return functionCallItem{
		Type:      "function_call",
		CallID:    fitCallID(string(block.ID)),
		Name:      shortToolName(string(block.Name), b.shortNames),
		Arguments: arguments,
	}
}

// toolResult replays a tool_result as a function_call_output: its text and
// images as parts when it has any, else its content as text.
func toolResult(block claudeBlock) functionCallOutputItem {
	item := functionCallOutputItem{Type: "function_call_output", CallID: fitCallID(string(block.ToolUseID))}
	var parts []any
	for _, raw := range elements(block.Content) {
		var entry claudeBlock
		readJSON(raw, &entry)
		switch entry.Type {
		case "text":
			parts = append(parts, textPart{Type: "input_text", Text: string(entry.Text)})
		case "image":
			if part, ok := imageFrom(entry.Source); ok {
				parts = append(parts, part)
			}
		}
	}
	if len(parts) > 0 {
		item.Output = parts
	} else {
		item.Output = textOf(block.Content)
	}
	return item
}
