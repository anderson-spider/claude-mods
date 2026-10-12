// Package jsontest reads values out of JSON text by path, for tests only:
// no production package imports it, so it never reaches the binary.
//
// It answers the way github.com/tidwall/gjson did for the paths the tests
// use, so their assertions read the same: a path is dot-separated keys and
// array indexes ("content.0.text"), and a final "#" counts an array's
// elements ("tools.#"). An object member is the first one with that key. A
// value that is missing, or a path that runs into something that is not an
// object or array, gives a Result that does not exist, whose String is "",
// Int 0 and Bool false. Paths with wildcards, queries, modifiers, pipes or
// escapes are not supported and panic, so a test cannot rely on them by
// mistake.
package jsontest

import (
	"bytes"
	"encoding/json"
	"io"
	"strconv"
	"strings"
)

// Type is the kind of JSON value a Result holds.
type Type int

const (
	// Null is JSON null, and also the type of a Result that does not exist.
	Null Type = iota
	// False is JSON false.
	False
	// Number is a JSON number.
	Number
	// String is a JSON string.
	String
	// True is JSON true.
	True
	// JSON is an object or an array.
	JSON
)

// Result is one value read from JSON text.
type Result struct {
	// Type is the kind of value.
	Type Type
	// Raw is the value's text exactly as it stands in the input (a string
	// keeps its quotes and escapes); "" when the value does not exist.
	Raw string
	// Str is a string value, unescaped.
	Str string
	// Num is a number value.
	Num float64
}

// Valid reports whether json is one well-formed JSON value.
func Valid(json string) bool { return ValidBytes([]byte(json)) }

// ValidBytes reports whether data is one well-formed JSON value.
func ValidBytes(data []byte) bool { return json.Valid(data) }

// Get reads the value at path in json.
func Get(json, path string) Result { return Parse(json).Get(path) }

// GetBytes reads the value at path in data.
func GetBytes(data []byte, path string) Result { return Get(string(data), path) }

// ParseBytes reads data as a value.
func ParseBytes(data []byte) Result { return Parse(string(data)) }

// Parse reads the first value in json. An object or array keeps the rest of
// the input as its Raw, as gjson did; a scalar keeps its own text.
func Parse(json string) Result {
	trimmed := strings.TrimLeft(json, " \t\r\n")
	if trimmed == "" {
		return Result{}
	}
	if trimmed[0] == '{' || trimmed[0] == '[' {
		return Result{Type: JSON, Raw: trimmed}
	}
	raw, ok := firstValue(trimmed)
	if !ok {
		return Result{}
	}
	return fromRaw(raw)
}

// Get reads the value at path inside t.
func (t Result) Get(path string) Result {
	if path == "" {
		return Result{}
	}
	if strings.ContainsAny(path, `*?|@\!=<>()`) {
		panic("jsontest: unsupported path " + strconv.Quote(path))
	}
	current := t
	parts := strings.Split(path, ".")
	for i, part := range parts {
		if part == "#" {
			if i != len(parts)-1 {
				panic("jsontest: '#' is supported only at the end of a path: " + strconv.Quote(path))
			}
			if !current.IsArray() {
				return Result{}
			}
			n := len(current.Array())
			return Result{Type: Number, Raw: strconv.Itoa(n), Num: float64(n)}
		}
		next, ok := current.child(part)
		if !ok {
			return Result{}
		}
		current = next
	}
	return current
}

// child reads one key of an object or one index of an array.
func (t Result) child(part string) (Result, bool) {
	switch {
	case t.IsObject():
		var found Result
		ok := false
		t.members(func(key string, value Result) bool {
			if key == part {
				found, ok = value, true
				return false
			}
			return true
		})
		return found, ok
	case t.IsArray():
		index, err := strconv.Atoi(part)
		if err != nil || index < 0 || strings.HasPrefix(part, "+") {
			return Result{}, false
		}
		var found Result
		ok := false
		n := 0
		t.elements(func(value Result) bool {
			if n == index {
				found, ok = value, true
				return false
			}
			n++
			return true
		})
		return found, ok
	}
	return Result{}, false
}

// Exists reports whether the value was found (a JSON null was).
func (t Result) Exists() bool { return t.Type != Null || len(t.Raw) != 0 }

// IsObject reports whether t is a JSON object.
func (t Result) IsObject() bool { return t.Type == JSON && len(t.Raw) > 0 && t.Raw[0] == '{' }

// IsArray reports whether t is a JSON array.
func (t Result) IsArray() bool { return t.Type == JSON && len(t.Raw) > 0 && t.Raw[0] == '[' }

// String returns a string's text, a number's or an object's raw text, "true"
// or "false"; "" for null or a missing value.
func (t Result) String() string {
	switch t.Type {
	case False:
		return "false"
	case True:
		return "true"
	case String:
		return t.Str
	case JSON:
		return t.Raw
	case Number:
		if len(t.Raw) == 0 {
			return strconv.FormatFloat(t.Num, 'f', -1, 64)
		}
		i := 0
		if t.Raw[0] == '-' {
			i++
		}
		for ; i < len(t.Raw); i++ {
			if t.Raw[i] < '0' || t.Raw[i] > '9' {
				return strconv.FormatFloat(t.Num, 'f', -1, 64)
			}
		}
		return t.Raw
	}
	return ""
}

// Int returns a number as an int64, 1 for true, and a string of digits as
// its value; 0 otherwise.
func (t Result) Int() int64 {
	switch t.Type {
	case True:
		return 1
	case String:
		n, _ := parseInt(t.Str)
		return n
	case Number:
		if n, ok := safeInt(t.Num); ok {
			return n
		}
		if n, ok := parseInt(t.Raw); ok {
			return n
		}
		return int64(t.Num)
	}
	return 0
}

// Bool returns true for JSON true, a non-zero number and a string that
// strconv.ParseBool reads as true.
func (t Result) Bool() bool {
	switch t.Type {
	case True:
		return true
	case String:
		b, _ := strconv.ParseBool(strings.ToLower(t.Str))
		return b
	case Number:
		return t.Num != 0
	}
	return false
}

// Array returns an array's elements; a missing value or null gives none, and
// any other value is returned as the only element.
func (t Result) Array() []Result {
	if t.Type == Null {
		return []Result{}
	}
	if !t.IsArray() {
		return []Result{t}
	}
	var out []Result
	t.elements(func(value Result) bool {
		out = append(out, value)
		return true
	})
	return out
}

// ForEach calls iterator with each member of an object (key as a String) or
// each element of an array (key as its index, a Number), in order, until it
// returns false. A scalar is passed once with an empty key; a missing value
// is not passed at all.
func (t Result) ForEach(iterator func(key, value Result) bool) {
	switch {
	case !t.Exists():
	case t.IsObject():
		t.members(func(key string, value Result) bool {
			quoted, _ := json.Marshal(key)
			return iterator(Result{Type: String, Raw: string(quoted), Str: key}, value)
		})
	case t.IsArray():
		n := 0
		t.elements(func(value Result) bool {
			key := Result{Type: Number, Num: float64(n)}
			n++
			return iterator(key, value)
		})
	case t.Type != JSON:
		iterator(Result{}, t)
	}
}

// members walks an object's members in order, stopping at the first one it
// cannot read.
func (t Result) members(visit func(key string, value Result) bool) {
	dec := json.NewDecoder(strings.NewReader(t.Raw))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		return
	}
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return
		}
		key, ok := tok.(string)
		if !ok {
			return
		}
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return
		}
		if !visit(key, fromRaw(raw)) {
			return
		}
	}
}

// elements walks an array's elements in order, stopping at the first one it
// cannot read.
func (t Result) elements(visit func(value Result) bool) {
	dec := json.NewDecoder(strings.NewReader(t.Raw))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('[') {
		return
	}
	for dec.More() {
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return
		}
		if !visit(fromRaw(raw)) {
			return
		}
	}
}

// firstValue returns the text of the first JSON value in s.
func firstValue(s string) ([]byte, bool) {
	var raw json.RawMessage
	if err := json.NewDecoder(strings.NewReader(s)).Decode(&raw); err != nil && err != io.EOF {
		return nil, false
	}
	if len(raw) == 0 {
		return nil, false
	}
	return raw, true
}

// fromRaw builds the Result for one value's text.
func fromRaw(raw []byte) Result {
	raw = bytes.TrimSpace(raw)
	r := Result{Raw: string(raw)}
	if len(raw) == 0 {
		return Result{}
	}
	switch raw[0] {
	case '{', '[':
		r.Type = JSON
	case '"':
		r.Type = String
		_ = json.Unmarshal(raw, &r.Str)
	case 't':
		r.Type = True
	case 'f':
		r.Type = False
	case 'n':
		r.Type = Null
	default:
		r.Type = Number
		r.Num, _ = strconv.ParseFloat(r.Raw, 64)
	}
	return r
}

// safeInt converts f when it is a whole number an int64 and a float64 both
// hold exactly.
func safeInt(f float64) (int64, bool) {
	if f < -9007199254740991 || f > 9007199254740991 {
		return 0, false
	}
	return int64(f), float64(int64(f)) == f
}

// parseInt reads an optional '-' and digits only.
func parseInt(s string) (int64, bool) {
	i, negative := 0, false
	if len(s) > 0 && s[0] == '-' {
		negative = true
		i++
	}
	if i == len(s) {
		return 0, false
	}
	var n int64
	for ; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return 0, false
		}
		n = n*10 + int64(s[i]-'0')
	}
	if negative {
		return -n, true
	}
	return n, true
}
