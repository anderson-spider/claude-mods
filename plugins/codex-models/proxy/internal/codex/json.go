package codex

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"strings"
)

// The credential files and the error bodies this package reads come from
// parties it does not control (the Codex CLI, the OAuth server, the Codex
// backend), and the Codex CLI's file must be written back with the fields this
// proxy does not own left as they were. So:
//
//   - keys match exactly and the first occurrence wins, the way earlier
//     releases read them (encoding/json's struct decoding matches keys without
//     regard to case and lets the last duplicate win, so it is not used for
//     these files);
//   - a value of an unexpected type reads as text (textOf) rather than failing;
//   - members this proxy does not own are kept as raw bytes, in file order.

// member is one key of a JSON object with its value as written.
type member struct {
	key   string
	value json.RawMessage
}

// object is a JSON object as an ordered list of members, duplicates included.
type object []member

var errNotObject = errors.New("not a JSON object")

// parseObject reads data, which must be exactly one JSON object.
func parseObject(data []byte) (object, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	if tok, err := dec.Token(); err != nil {
		return nil, err
	} else if tok != json.Delim('{') {
		return nil, errNotObject
	}
	obj := object{}
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		key, _ := tok.(string)
		var value json.RawMessage
		if err := dec.Decode(&value); err != nil {
			return nil, err
		}
		obj = append(obj, member{key: key, value: value})
	}
	if _, err := dec.Token(); err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errNotObject
	}
	return obj, nil
}

// get returns the value of the first member named key, or nil.
func (o object) get(key string) json.RawMessage {
	for _, m := range o {
		if m.key == key {
			return m.value
		}
	}
	return nil
}

// set replaces the value of the first member named key, or appends one.
func (o object) set(key string, value json.RawMessage) object {
	for i := range o {
		if o[i].key == key {
			o[i].value = value
			return o
		}
	}
	return append(o, member{key: key, value: value})
}

// encode renders the object with two-space indentation, the layout the Codex
// CLI writes, so a file it wrote comes back byte for byte apart from the
// values that changed and, since encodeCodexCLI ends the file with a newline
// and the Codex CLI does not, a final newline on the first rewrite.
func (o object) encode() ([]byte, error) {
	var compact bytes.Buffer
	compact.WriteByte('{')
	for i, m := range o {
		if i > 0 {
			compact.WriteByte(',')
		}
		key, err := jsonString(m.key)
		if err != nil {
			return nil, err
		}
		compact.Write(key)
		compact.WriteByte(':')
		compact.Write(m.value)
	}
	compact.WriteByte('}')
	var out bytes.Buffer
	if err := json.Indent(&out, compact.Bytes(), "", "  "); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

// jsonString encodes s as a JSON string, leaving <, > and & as they are.
func jsonString(s string) (json.RawMessage, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(s); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

// isObject reports whether raw holds a JSON object.
func isObject(raw json.RawMessage) bool {
	raw = bytes.TrimSpace(raw)
	return len(raw) > 0 && raw[0] == '{'
}

// textOf reads a JSON value as text: a string as its contents, null or absent
// as "", true and false as those words, a run of digits as written, any other
// number in plain decimal notation, and an object or array as its raw JSON.
func textOf(raw json.RawMessage) string {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return ""
	}
	switch raw[0] {
	case 'n':
		return ""
	case '"':
		var s string
		if json.Unmarshal(raw, &s) != nil {
			return ""
		}
		return s
	case '-', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9':
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

// peek follows path through nested objects of data and returns the first
// token of the value it names. It reads only as far as it must and takes the
// first member of each name, so a body that breaks after the value, or is not
// JSON past it, still answers.
func peek(data []byte, path ...string) (json.Token, bool) {
	dec := json.NewDecoder(bytes.NewReader(data))
	for _, key := range path {
		if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
			return nil, false
		}
		for {
			if !dec.More() {
				return nil, false
			}
			tok, err := dec.Token()
			if err != nil {
				return nil, false
			}
			if name, _ := tok.(string); name == key {
				break
			}
			var skipped json.RawMessage
			if err := dec.Decode(&skipped); err != nil {
				return nil, false
			}
		}
	}
	tok, err := dec.Token()
	if err != nil {
		return nil, false
	}
	return tok, true
}

// peekString returns the string at path, when there is one.
func peekString(data []byte, path ...string) (string, bool) {
	tok, ok := peek(data, path...)
	if !ok {
		return "", false
	}
	s, ok := tok.(string)
	return s, ok
}
