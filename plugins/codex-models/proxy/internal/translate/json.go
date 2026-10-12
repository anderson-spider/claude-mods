package translate

import (
	"bytes"
	"encoding/json"
	"strconv"

	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/jsonread"
)

// Reading rules.
//
// Every incoming document is checked for syntax once; after that a field of
// the wrong type reads as if it were absent, and the scalar types read any
// JSON value. The rules are internal/jsonread's, which the router reads a
// request's head by too.

// text is a JSON value read as text (jsonread.Text).
type text = jsonread.Text

func readJSON(raw []byte, v any) bool { return jsonread.Decode(raw, v) }
func textOf(raw []byte) string        { return jsonread.TextOf(raw) }
func flag(raw []byte) bool            { return jsonread.BoolOf(raw) }
func kindOf(raw []byte) byte          { return jsonread.Kind(raw) }

// count is a JSON value read as an integer: a number (a fraction is
// truncated), a numeric string, or true as 1. Anything else is 0.
type count int64

func (c *count) UnmarshalJSON(raw []byte) error {
	raw = bytes.TrimSpace(raw)
	switch kindOf(raw) {
	case '"':
		*c = count(parseCount(textOf(raw)))
	case 't':
		*c = 1
	case '-', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9':
		*c = count(parseCount(string(raw)))
	default:
		*c = 0
	}
	return nil
}

func parseCount(n string) int64 {
	if i, err := strconv.ParseInt(n, 10, 64); err == nil {
		return i
	}
	f, err := strconv.ParseFloat(n, 64)
	if err != nil {
		return 0
	}
	return int64(f)
}

// elements returns the items of a JSON array, each as written, or nil when
// raw is not an array.
func elements(raw []byte) []json.RawMessage {
	if kindOf(raw) != '[' {
		return nil
	}
	var items []json.RawMessage
	if json.Unmarshal(raw, &items) != nil {
		return nil
	}
	return items
}

// fields returns the members of a JSON object keyed by name, or nil when raw
// is not an object. Only for reading: a map loses the order of the members.
func fields(raw []byte) map[string]json.RawMessage {
	if kindOf(raw) != '{' {
		return nil
	}
	var members map[string]json.RawMessage
	if json.Unmarshal(raw, &members) != nil {
		return nil
	}
	return members
}

// isObject reports whether s is exactly one valid JSON object.
func isObject(s string) bool {
	return kindOf([]byte(s)) == '{' && json.Valid([]byte(s))
}

// member is one name and value of a JSON object, the value as written.
type member struct {
	name  string
	value json.RawMessage
}

// orderedMembers reads a JSON object's members in their order, so the object
// can be edited and written back without reordering what it keeps.
func orderedMembers(raw []byte) ([]member, bool) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		return nil, false
	}
	var members []member
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return nil, false
		}
		name, _ := tok.(string)
		var value json.RawMessage
		if err := dec.Decode(&value); err != nil {
			return nil, false
		}
		members = append(members, member{name: name, value: value})
	}
	return members, true
}

// writeMembers writes members back as one JSON object.
func writeMembers(members []member) json.RawMessage {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, m := range members {
		if i > 0 {
			b.WriteByte(',')
		}
		b.Write(encode(m.name))
		b.WriteByte(':')
		b.Write(m.value)
	}
	b.WriteByte('}')
	return b.Bytes()
}

// joinArray writes items as one JSON array, each item as given.
func joinArray(items []json.RawMessage) []byte {
	out := []byte{'['}
	for i, item := range items {
		if i > 0 {
			out = append(out, ',')
		}
		out = append(out, item...)
	}
	return append(out, ']')
}

// encode writes v as compact JSON without escaping <, > and &, which the
// Messages and Responses APIs read as themselves. The values given to it are
// built here from strings, numbers and already validated raw JSON, so it
// cannot fail; a failure would leave the output empty.
func encode(v any) []byte {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil
	}
	return bytes.TrimSuffix(b.Bytes(), []byte{'\n'})
}
