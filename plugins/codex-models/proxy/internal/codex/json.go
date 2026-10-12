package codex

import (
	"bytes"
	"encoding/json"
)

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
