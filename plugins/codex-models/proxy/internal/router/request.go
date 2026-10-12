package router

import (
	"bytes"
	"encoding/json"
	"strconv"
	"strings"
)

// Reading a Messages request.
//
// The router reads only what decides where a request goes and how it is
// answered: the model, whether to stream, the user id behind the Codex
// session and, for the log, the effort asked for. It reads them with
// encoding/json, as translate reads the rest of the body, so both see the
// same document: a key matches whatever its case, and of two equal keys the
// last one counts. A body the proxy can read but that is not valid JSON is
// refused before it is read here (refuseInvalidJSON); a body under a coding
// the proxy cannot undo names no model, so it goes upstream as it came.
//
// A value of an unexpected type counts as absent, and the scalar readers
// below take any JSON value the way translate's do (translate/json.go).

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

// readLenient decodes raw into v and reports whether raw was valid JSON,
// exactly as translate's readJSON does. The document is checked first, so a
// body with a syntax error anywhere decodes to nothing rather than to the
// part before the error. A field of the wrong type is not a failure:
// encoding/json skips it and still decodes the others, and its error is
// dropped on purpose.
func readLenient(raw []byte, v any) bool {
	if !json.Valid(raw) {
		return false
	}
	_ = json.Unmarshal(raw, v)
	return true
}

// jsonText is a JSON value read as text: a string as its contents, null as
// "", true and false as those words, a number as written (in plain decimal
// when it is not a run of digits), and an object or array as its raw JSON.
type jsonText string

func (t *jsonText) UnmarshalJSON(raw []byte) error {
	*t = jsonText(textOf(raw))
	return nil
}

func textOf(raw []byte) string {
	raw = bytes.TrimSpace(raw)
	switch kind := kindOf(raw); {
	case kind == 0 || kind == 'n':
		return ""
	case kind == '"':
		var s string
		if json.Unmarshal(raw, &s) != nil {
			return ""
		}
		return s
	case kind == '-' || kind >= '0' && kind <= '9':
		n := string(raw)
		if digits := strings.TrimPrefix(n, "-"); digits != "" && strings.Trim(digits, "0123456789") == "" {
			return n
		}
		f, err := strconv.ParseFloat(n, 64)
		if err != nil {
			return n
		}
		return strconv.FormatFloat(f, 'f', -1, 64)
	default:
		return string(raw)
	}
}

// jsonFlag is a JSON value read as a boolean: true, a string that spells a
// boolean in any case, or a non-zero number. Anything else is false.
type jsonFlag bool

func (f *jsonFlag) UnmarshalJSON(raw []byte) error {
	raw = bytes.TrimSpace(raw)
	switch kind := kindOf(raw); {
	case kind == 't':
		*f = true
	case kind == '"':
		b, _ := strconv.ParseBool(strings.ToLower(textOf(raw)))
		*f = jsonFlag(b)
	case kind == '-' || kind >= '0' && kind <= '9':
		n, _ := strconv.ParseFloat(string(raw), 64)
		*f = n != 0
	default:
		*f = false
	}
	return nil
}

// kindOf returns the first byte of a JSON value ('{', '[', '"', 't', 'f',
// 'n', or a number's first character), or 0 when there is none.
func kindOf(raw []byte) byte {
	raw = bytes.TrimLeft(raw, " \t\r\n")
	if len(raw) == 0 {
		return 0
	}
	return raw[0]
}
