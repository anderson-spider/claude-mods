package router

import (
	"bytes"
	"encoding/json"
)

// Reading an upstream answer.
//
// The router reads two kinds of upstream answer itself: a Codex error body,
// for its message, type and code, and Anthropic's model list, to extend it.
// Neither is a request, so the request rule (request.go) does not apply.
// They are read with the rules the router has always read them with: names
// match exactly, the first member on the path counts, and reading stops at
// the value asked for, so a body cut off or broken after it still answers.

// lookup follows path through nested objects of data and returns the first
// value it names, as written. A member of the right name that does not lead
// to the rest of the path is passed over, so a later one of that name can.
func lookup(data []byte, path ...string) (json.RawMessage, bool) {
	dec := json.NewDecoder(bytes.NewReader(data))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		return nil, false
	}
	if found, _ := seek(dec, path); !found {
		return nil, false
	}
	var value json.RawMessage
	if dec.Decode(&value) != nil {
		return nil, false
	}
	return value, true
}

// seek reads the members of an object whose opening brace dec has just
// read, and stops before the value at path. When the object holds no such
// value it reads through the closing brace, and ok is false when the
// document broke first.
func seek(dec *json.Decoder, path []string) (found, ok bool) {
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return false, false
		}
		if name, _ := tok.(string); name != path[0] {
			var skipped json.RawMessage
			if dec.Decode(&skipped) != nil {
				return false, false
			}
			continue
		}
		if len(path) == 1 {
			return true, true
		}
		tok, err = dec.Token()
		if err != nil {
			return false, false
		}
		if tok == json.Delim('{') {
			if found, ok := seek(dec, path[1:]); found || !ok {
				return found, ok
			}
			continue
		}
		if !skipRest(dec, tok) {
			return false, false
		}
	}
	_, err := dec.Token() // the closing brace
	return false, err == nil
}

// skipRest reads the rest of a value whose first token was tok: nothing for
// a scalar, through the matching close for an array or object.
func skipRest(dec *json.Decoder, tok json.Token) bool {
	depth := 0
	if tok == json.Delim('[') || tok == json.Delim('{') {
		depth = 1
	}
	for depth > 0 {
		tok, err := dec.Token()
		if err != nil {
			return false
		}
		switch tok {
		case json.Delim('['), json.Delim('{'):
			depth++
		case json.Delim(']'), json.Delim('}'):
			depth--
		}
	}
	return true
}

// lookupText is the value at path read as text (see jsonText), or "".
func lookupText(data []byte, path ...string) string {
	value, ok := lookup(data, path...)
	if !ok {
		return ""
	}
	return textOf(value)
}

// member is one name and value of a JSON object, the value as written.
type member struct {
	name  string
	value json.RawMessage
}

// objectMembers reads a JSON object's members in order, so the object can be
// edited and written back without reordering or rewriting what it keeps.
// It reports false when data is not one valid JSON object.
func objectMembers(data []byte) ([]member, bool) {
	if kindOf(data) != '{' || !json.Valid(data) {
		return nil, false
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	if _, err := dec.Token(); err != nil {
		return nil, false
	}
	members := []member{}
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

// writeObject writes members back as one JSON object.
func writeObject(members []member) []byte {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, m := range members {
		if i > 0 {
			b.WriteByte(',')
		}
		b.Write(compactJSON(m.name))
		b.WriteByte(':')
		b.Write(m.value)
	}
	b.WriteByte('}')
	return b.Bytes()
}

// compactJSON writes v as compact JSON without escaping <, > and &. It is
// given strings and structs of strings only, so it cannot fail; a failure
// would leave the output empty.
func compactJSON(v any) []byte {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if enc.Encode(v) != nil {
		return nil
	}
	return bytes.TrimSuffix(b.Bytes(), []byte{'\n'})
}
