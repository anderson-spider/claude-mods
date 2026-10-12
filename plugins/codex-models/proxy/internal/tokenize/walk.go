package tokenize

import (
	"bytes"
	"encoding/json"
	"strconv"
)

// The helpers below read a request leniently, one value at a time, so a
// field of an unexpected type is counted as well as it can be instead of
// failing the whole estimate. They only see input json.Valid accepted.
//
// A value is a json.RawMessage holding its JSON exactly as written; nil
// means the field is absent, which is not the same as JSON null.

// kindOf returns the first byte of v's JSON ('{', '[', '"', 't', 'f', 'n',
// or a digit or '-'), or 0 when v is absent.
func kindOf(v json.RawMessage) byte {
	v = bytes.TrimLeft(v, " \t\r\n")
	if len(v) == 0 {
		return 0
	}
	return v[0]
}

// fields returns, for each name, the value of the first member of object v
// with that exact (case-sensitive) name, or nil. A v that is not an object
// has no members.
func fields(v json.RawMessage, names ...string) []json.RawMessage {
	found := make([]json.RawMessage, len(names))
	if kindOf(v) != '{' {
		return found
	}
	dec := json.NewDecoder(bytes.NewReader(v))
	if _, err := dec.Token(); err != nil { // the opening brace
		return found
	}
	for dec.More() {
		key, err := dec.Token()
		if err != nil {
			return found
		}
		var value json.RawMessage
		if err := dec.Decode(&value); err != nil {
			return found
		}
		for i, name := range names {
			if found[i] == nil && key == name {
				found[i] = value
			}
		}
	}
	return found
}

// each calls fn with every element of an array, every member value of an
// object, or the value itself when it is a scalar (null included). An
// absent value calls nothing.
func each(v json.RawMessage, fn func(json.RawMessage)) {
	switch kindOf(v) {
	case 0:
		return
	case '[', '{':
	default:
		fn(v)
		return
	}
	isObject := kindOf(v) == '{'
	dec := json.NewDecoder(bytes.NewReader(v))
	if _, err := dec.Token(); err != nil { // the opening bracket or brace
		return
	}
	for dec.More() {
		if isObject {
			if _, err := dec.Token(); err != nil { // the member's name
				return
			}
		}
		var item json.RawMessage
		if err := dec.Decode(&item); err != nil {
			return
		}
		fn(item)
	}
}

// text renders v as the text it carries: a string unquoted, null or absent
// as "", true and false as words, a number in plain decimal (integers as
// written), and an object or array as its JSON.
func text(v json.RawMessage) string {
	switch k := kindOf(v); {
	case k == 0 || k == 'n':
		return ""
	case k == '"':
		var s string
		if json.Unmarshal(v, &s) != nil {
			return ""
		}
		return s
	case k == '-' || (k >= '0' && k <= '9'):
		return number(string(bytes.TrimSpace(v)))
	default:
		return string(bytes.TrimSpace(v))
	}
}

// number keeps an integer as written and renders any other number in plain
// decimal ("1e3" is "1000", "1.50" is "1.5").
func number(raw string) string {
	digits := raw
	if len(digits) > 0 && digits[0] == '-' {
		digits = digits[1:]
	}
	plain := digits != ""
	for i := 0; i < len(digits) && plain; i++ {
		plain = digits[i] >= '0' && digits[i] <= '9'
	}
	if plain {
		return raw
	}
	f, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return raw
	}
	return strconv.FormatFloat(f, 'f', -1, 64)
}
