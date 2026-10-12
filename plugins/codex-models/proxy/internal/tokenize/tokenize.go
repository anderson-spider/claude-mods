// Package tokenize estimates the prompt tokens of an Anthropic Messages
// request. The proxy answers /v1/messages/count_tokens with it for Codex
// models: the Codex backend has no counting endpoint and its tokenizer is
// not public.
package tokenize

import (
	"encoding/json"
	"unicode/utf8"
)

// charsPerToken turns counted characters into tokens. It leans high on
// purpose: Claude Code compacts a conversation when the count nears the
// context window, so an overestimate only compacts a little early, while an
// underestimate lets a request overflow the window upstream.
const charsPerToken = 3.5

// perBlockOverhead is the tokens each counted block costs for its role and
// framing once serialized, on top of its text.
const perBlockOverhead = 4

// imageChars stands in for an image, which is billed by its size rather
// than by text; it is a flat amount, not a tile count.
const imageChars = 1000

// EstimateClaudeRequest returns the estimated prompt tokens of raw, never
// less than 1.
//
// It counts characters (runes) of: the system prompt; each message's text,
// thinking, tool calls (name and input JSON) and tool results; and each
// declared tool (name, description and schema JSON), which is often the
// largest fixed cost of a Claude Code request. Every system block, content
// block and tool adds perBlockOverhead.
//
// A body that is not valid JSON is estimated from its length alone.
func EstimateClaudeRequest(raw []byte) int64 {
	if !json.Valid(raw) {
		return atLeastOne(int64(float64(utf8.RuneCount(raw)) / charsPerToken))
	}
	var c counter
	c.request(raw)
	return atLeastOne(int64(float64(c.chars)/charsPerToken) + c.blocks*perBlockOverhead)
}

func atLeastOne(n int64) int64 {
	if n < 1 {
		return 1
	}
	return n
}

// counter accumulates characters and blocks as it walks a request.
type counter struct {
	chars  int64
	blocks int64
}

// add counts the runes of text.
func (c *counter) add(text string) { c.chars += int64(utf8.RuneCountInString(text)) }

// addRaw counts the runes of a value's JSON as written in the request.
func (c *counter) addRaw(v json.RawMessage) { c.chars += int64(utf8.RuneCount(v)) }

func (c *counter) request(raw json.RawMessage) {
	top := fields(raw, "system", "messages", "tools")
	system, messages, tools := top[0], top[1], top[2]

	switch kindOf(system) {
	case '"':
		c.add(text(system))
		c.blocks++
	case '[':
		each(system, func(block json.RawMessage) {
			c.add(text(fields(block, "text")[0]))
			c.blocks++
		})
	}

	each(messages, func(message json.RawMessage) {
		content := fields(message, "content")[0]
		if kindOf(content) == '"' {
			c.add(text(content))
			c.blocks++
			return
		}
		each(content, c.block)
	})

	each(tools, func(tool json.RawMessage) {
		f := fields(tool, "name", "description", "input_schema")
		c.blocks++
		c.add(text(f[0]))
		c.add(text(f[1]))
		c.addRaw(f[2])
	})
}

// block counts one content block of a message.
func (c *counter) block(block json.RawMessage) {
	c.blocks++
	f := fields(block, "type", "text", "thinking", "name", "input", "content")
	switch text(f[0]) {
	case "text":
		c.add(text(f[1]))
	case "thinking":
		c.add(text(f[2]))
	case "tool_use":
		c.add(text(f[3]))
		c.addRaw(f[4])
	case "tool_result":
		c.toolResult(f[5])
	case "image":
		c.chars += imageChars
	}
}

// toolResult counts a tool_result's content: a string, or entries whose text
// is counted and whose images each count as one image.
func (c *counter) toolResult(content json.RawMessage) {
	if kindOf(content) == '"' {
		c.add(text(content))
		return
	}
	each(content, func(entry json.RawMessage) {
		f := fields(entry, "type", "text")
		c.add(text(f[1]))
		if text(f[0]) == "image" {
			c.chars += imageChars
		}
	})
}
