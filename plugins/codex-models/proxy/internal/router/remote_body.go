package router

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
)

// rewriteFields keeps unknown raw values and order, but canonicalizes every
// case alias of a controlled field. This matches readHead's last-match rules
// and prevents a shadow model or raw user_id from surviving the rewrite.
func rewriteFields(raw []byte, rewrite func(string, json.RawMessage) (json.RawMessage, bool)) []byte {
	members, ok := objectMembers(raw)
	if !ok {
		return raw
	}
	out := make([]member, 0, len(members))
	for _, m := range members {
		value, keep := rewrite(strings.ToLower(m.name), m.value)
		if keep {
			out = append(out, member{m.name, value})
		}
	}
	return writeObject(out)
}

func remoteRequest(raw []byte, model, userID string) []byte {
	raw = rewriteFields(raw, func(name string, value json.RawMessage) (json.RawMessage, bool) {
		switch name {
		case "model", "thinking":
			return nil, false
		case "metadata":
			value = rewriteFields(value, func(name string, value json.RawMessage) (json.RawMessage, bool) { return value, name != "user_id" })
			if members, ok := objectMembers(value); ok {
				members = append(members, member{"user_id", compactJSON(userID)})
				value = writeObject(members)
			}
		case "output_config":
			value = rewriteFields(value, func(name string, value json.RawMessage) (json.RawMessage, bool) { return value, name != "effort" })
		case "messages":
			value = rewriteArray(value, func(message json.RawMessage) json.RawMessage {
				return rewriteFields(message, func(name string, value json.RawMessage) (json.RawMessage, bool) {
					if name == "content" {
						value = remoteContent(value)
					}
					return value, true
				})
			})
		}
		return value, true
	})
	members, _ := objectMembers(raw)
	members = append(members, member{"model", compactJSON(model)})
	// The remote does not honor max_tokens; deliberately do not emulate a ceiling.
	return writeObject(members)
}

func rewriteArray(raw []byte, rewrite func(json.RawMessage) json.RawMessage) []byte {
	if kindOf(raw) != '[' {
		return raw
	} // never iterate an object in an array position
	var items []json.RawMessage
	if json.Unmarshal(raw, &items) != nil {
		return raw
	}
	out := []json.RawMessage{}
	for _, item := range items {
		if value := rewrite(item); value != nil {
			out = append(out, value)
		}
	}
	return joinArray(out)
}

func remoteContent(raw []byte) []byte {
	return rewriteArray(raw, func(block json.RawMessage) json.RawMessage {
		var head struct {
			Type      jsonText `json:"type"`
			Signature jsonText `json:"signature"`
		}
		readLenient(block, &head)
		if head.Type == "redacted_thinking" {
			return nil
		}
		if head.Type != "thinking" {
			return block
		}
		signature := string(head.Signature)
		if !strings.HasPrefix(signature, SignatureMarker) {
			return nil
		}
		block = rewriteFields(block, func(name string, value json.RawMessage) (json.RawMessage, bool) { return value, name != "signature" })
		members, _ := objectMembers(block)
		// SSE signature fragments each carry a marker; replay joins those fragments.
		members = append(members, member{"signature", compactJSON(strings.ReplaceAll(signature, SignatureMarker, ""))})
		return writeObject(members)
	})
}

// markAnswer only visits protocol fields, never a tool's input or text values.
// It marks every thinking block/checkpoint, including all signature deltas.
func markAnswer(raw []byte) ([]byte, string, error) {
	if !json.Valid(raw) || kindOf(raw) != '{' {
		return nil, "", errors.New("invalid answer")
	}
	typ := lookupText(raw, "type")
	if typ == "error" {
		kind := lookupText(raw, "error", "type")
		if kind == "authentication_error" || kind == "unauthorized" {
			kind = "permission_error"
		}
		if errorTypeStatus(kind) == http.StatusBadGateway && kind != "api_error" {
			kind = "api_error"
		}
		return compactJSON(anthropicError{Type: "error", Error: errorDetail{Type: kind, Message: upstreamMessage(raw)}}), typ, nil
	}
	raw = rewriteFields(raw, func(name string, value json.RawMessage) (json.RawMessage, bool) {
		switch name {
		case "content":
			value = rewriteArray(value, markBlock)
		case "content_block", "delta":
			value = markBlock(value)
		case "message":
			value = rewriteFields(value, func(name string, value json.RawMessage) (json.RawMessage, bool) {
				if name == "content" {
					value = rewriteArray(value, markBlock)
				}
				return value, true
			})
		}
		return value, true
	})
	return raw, typ, nil
}

func markBlock(raw json.RawMessage) json.RawMessage {
	typ := lookupText(raw, "type")
	if typ != "thinking" && typ != "signature_delta" {
		return raw
	}
	return rewriteFields(raw, func(name string, value json.RawMessage) (json.RawMessage, bool) {
		if name == "signature" || name == "signature_delta" {
			if kindOf(value) == '"' {
				signature := textOf(value)
				if !strings.HasPrefix(signature, SignatureMarker) {
					signature = SignatureMarker + signature
				}
				value = compactJSON(signature)
			}
		}
		return value, true
	})
}

// effortFrom retains the previous preference and thinking-budget mapping.
func effortFrom(raw []byte, fallback string) string {
	if fallback == "" {
		fallback = "medium"
	}
	var head struct {
		OutputConfig json.RawMessage `json:"output_config"`
		Thinking     json.RawMessage `json:"thinking"`
	}
	readLenient(raw, &head)
	var output struct {
		Effort json.RawMessage `json:"effort"`
	}
	readLenient(head.OutputConfig, &output)
	if kindOf(output.Effort) == '"' {
		if value := strings.ToLower(strings.TrimSpace(textOf(output.Effort))); value != "" {
			return value
		}
	}
	var thinking struct {
		Type   jsonText        `json:"type"`
		Budget json.RawMessage `json:"budget_tokens"`
	}
	readLenient(head.Thinking, &thinking)
	switch thinking.Type {
	case "disabled":
		return "low"
	case "adaptive", "auto":
		return "xhigh"
	case "enabled":
		raw := bytes.TrimSpace(thinking.Budget)
		value := string(raw)
		if kindOf(raw) == '"' {
			value = textOf(raw)
		}
		budget, _ := strconv.ParseFloat(value, 64)
		if bytes.Equal(raw, []byte("true")) {
			budget = 1
		}
		switch {
		case budget <= 4096:
			return "low"
		case budget <= 16384:
			return "medium"
		case budget <= 32768:
			return "high"
		default:
			return "xhigh"
		}
	}
	return fallback
}
