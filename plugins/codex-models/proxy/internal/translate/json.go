package translate

import (
	"bytes"
	"encoding/json"
	"strconv"
	"strings"
)

// Reading rules.
//
// Every incoming document is checked for syntax once; after that a field of
// the wrong type reads as if it were absent. encoding/json already keeps
// decoding the other fields when one has the wrong type (it reports only the
// first such error), so readJSON drops that error on purpose. The scalar types
// below go one step further and read any JSON value, so a number where text
// was expected still comes through as its digits.

// readJSON decodes raw into v and reports whether raw was valid JSON. Type
// mismatches are not failures: the field stays at its zero value.
func readJSON(raw []byte, v any) bool {
	if !json.Valid(raw) {
		return false
	}
	_ = json.Unmarshal(raw, v)
	return true
}

// text is a JSON value read as text: a string as its contents, null or absent
// as "", true and false as those words, a number as written, and an object or
// array as its raw JSON.
type text string

func (t *text) UnmarshalJSON(raw []byte) error {
	*t = text(textOf(raw))
	return nil
}

func textOf(raw []byte) string {
	raw = bytes.TrimSpace(raw)
	switch kindOf(raw) {
	case 0, 'n':
		return ""
	case '"':
		var s string
		if json.Unmarshal(raw, &s) != nil {
			return ""
		}
		return s
	case '-', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9':
		return numberText(string(raw))
	default:
		return string(raw)
	}
}

// numberText keeps a run of digits as written and spells any other number in
// plain decimal notation (1e3 becomes 1000).
func numberText(n string) string {
	if digits := strings.TrimPrefix(n, "-"); digits != "" && strings.Trim(digits, "0123456789") == "" {
		return n
	}
	f, err := strconv.ParseFloat(n, 64)
	if err != nil {
		return n
	}
	return strconv.FormatFloat(f, 'f', -1, 64)
}

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

// flag reads a JSON value as a boolean: true, a string that spells a boolean,
// or a non-zero number.
func flag(raw []byte) bool {
	raw = bytes.TrimSpace(raw)
	switch kindOf(raw) {
	case 't':
		return true
	case '"':
		b, _ := strconv.ParseBool(strings.ToLower(textOf(raw)))
		return b
	case '-', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9':
		f, _ := strconv.ParseFloat(string(raw), 64)
		return f != 0
	default:
		return false
	}
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
