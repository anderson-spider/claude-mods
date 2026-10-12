package router

import (
	"encoding/json"

	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/jsonread"
)

// Reading a Messages request.
//
// The router reads only what decides where a request goes and how it is
// answered: the model, whether to stream, the user id behind the Codex
// session and, for the log, the effort asked for. It reads them with
// encoding/json, as the relay reads controlled fields, so both see the
// same document: a key matches whatever its case, and of two equal keys the
// last one counts. A body the proxy can read but that is not valid JSON is
// refused before it is read here (refuseInvalidJSON); a body under a coding
// the proxy cannot undo names no model, so it goes upstream as it came.
//
// A value of an unexpected type counts as absent, and the scalar readers
// take any JSON value; both rules come from internal/jsonread.

// messagesHead is the part of a Messages request the router reads.
type messagesHead struct {
	Model        jsonText        `json:"model"`
	Stream       jsonFlag        `json:"stream"`
	Metadata     json.RawMessage `json:"metadata"`
	OutputConfig json.RawMessage `json:"output_config"`
}

// readHead reads a Messages request body. A body that is not valid JSON, or
// not an object, gives the zero head.
func readHead(raw []byte) messagesHead {
	var head messagesHead
	readLenient(raw, &head)
	return head
}

// userID is metadata.user_id, or "" when there is none.
func (h messagesHead) userID() string {
	var metadata struct {
		UserID jsonText `json:"user_id"`
	}
	if kindOf(h.Metadata) == '{' {
		readLenient(h.Metadata, &metadata)
	}
	return string(metadata.UserID)
}

// clientEffort is output_config.effort as the client wrote it, for the log.
func (h messagesHead) clientEffort() string {
	var config struct {
		Effort jsonText `json:"effort"`
	}
	if kindOf(h.OutputConfig) == '{' {
		readLenient(h.OutputConfig, &config)
	}
	return string(config.Effort)
}

// The reading rules are jsonread's, also used by the relay.
type (
	jsonText = jsonread.Text
	jsonFlag = jsonread.Bool
)

func readLenient(raw []byte, v any) bool { return jsonread.Decode(raw, v) }
func textOf(raw []byte) string           { return jsonread.TextOf(raw) }
func kindOf(raw []byte) byte             { return jsonread.Kind(raw) }
