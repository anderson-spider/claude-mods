// Package jsonread holds the JSON reading rules that routing
// (internal/router) and translation (internal/translate) share, so both read
// a request the same way.
//
// A document is checked for syntax once; after that a field of the wrong
// type reads as if it were absent. encoding/json already keeps decoding the
// other fields when one has the wrong type (it reports only the first such
// error), so Decode drops that error on purpose. Text and Bool go one step
// further and read any JSON value, so a number where text was expected still
// comes through as its digits. Keys match whatever their case, and of two
// equal keys the last one counts, as encoding/json reads them.
package jsonread

import (
	"bytes"
	"encoding/json"
	"strconv"
	"strings"
)

// Decode decodes raw into v and reports whether raw was valid JSON. The
// document is checked first, so a body with a syntax error anywhere decodes
// to nothing rather than to the part before the error. Type mismatches are
// not failures: the field stays at its zero value.
func Decode(raw []byte, v any) bool {
	if !json.Valid(raw) {
		return false
	}
	_ = json.Unmarshal(raw, v)
	return true
}

// Text is a JSON value read as text: a string as its contents, null or absent
// as "", true and false as those words, a number as written (in plain decimal
// when it is not a run of digits), and an object or array as its raw JSON.
type Text string

func (t *Text) UnmarshalJSON(raw []byte) error {
	*t = Text(TextOf(raw))
	return nil
}

// TextOf reads one JSON value as Text does.
func TextOf(raw []byte) string {
	raw = bytes.TrimSpace(raw)
	switch Kind(raw) {
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

// Bool is a JSON value read as a boolean: true, a string that spells a
// boolean in any case, or a non-zero number. Anything else is false.
type Bool bool

func (b *Bool) UnmarshalJSON(raw []byte) error {
	*b = Bool(BoolOf(raw))
	return nil
}

// BoolOf reads one JSON value as Bool does.
func BoolOf(raw []byte) bool {
	raw = bytes.TrimSpace(raw)
	switch Kind(raw) {
	case 't':
		return true
	case '"':
		b, _ := strconv.ParseBool(strings.ToLower(TextOf(raw)))
		return b
	case '-', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9':
		f, _ := strconv.ParseFloat(string(raw), 64)
		return f != 0
	default:
		return false
	}
}

// Kind returns the first byte of a JSON value ('{', '[', '"', 't', 'f', 'n',
// or a number's first character), or 0 when there is none.
func Kind(raw []byte) byte {
	raw = bytes.TrimLeft(raw, " \t\r\n")
	if len(raw) == 0 {
		return 0
	}
	return raw[0]
}
