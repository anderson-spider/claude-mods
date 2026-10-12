package translate

import (
	"bytes"
	"encoding/json"
	"errors"
)

// StripProxySignatures removes, from a request going to Anthropic, the
// thinking blocks whose signature this proxy issued for a Codex turn, and
// reports whether it removed any.
//
// Claude Code replays earlier assistant turns as they were, so a session that
// moves from a Codex model to a Claude model would send Codex reasoning state
// to Anthropic, which refuses the request. Only the content arrays that held
// such a block are rewritten, from their other blocks exactly as written;
// every other byte of the body stays as it came. A body without the marker
// anywhere is returned at once, untouched.
func StripProxySignatures(raw []byte) ([]byte, bool) {
	if !bytes.Contains(raw, []byte(SignatureMarker)) {
		return raw, false
	}
	edits, err := proxyThinkingEdits(raw)
	if err != nil || len(edits) == 0 {
		return raw, false
	}
	out := make([]byte, 0, len(raw))
	from := 0
	for _, e := range edits {
		out = append(out, raw[from:e.start]...)
		out = append(out, e.with...)
		from = e.end
	}
	return append(out, raw[from:]...), true
}

// edit replaces raw[start:end] with with.
type edit struct {
	start, end int
	with       []byte
}

var errUnexpectedJSON = errors.New("translate: unexpected JSON while scanning messages")

// proxyThinkingEdits walks the body's messages[*].content arrays, in order,
// and returns an edit for each one holding a proxy-issued thinking block. It
// reads the body as a token stream, so it knows where each array starts and
// ends in the original bytes.
func proxyThinkingEdits(raw []byte) ([]edit, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	if opened, err := openDelim(dec, '{'); err != nil || !opened {
		return nil, errUnexpectedJSON
	}
	var edits []edit
	for dec.More() {
		name, err := memberName(dec)
		if err != nil {
			return nil, err
		}
		if name != "messages" {
			if err := skipValue(dec); err != nil {
				return nil, err
			}
			continue
		}
		if opened, err := openDelim(dec, '['); err != nil {
			return nil, err
		} else if !opened {
			continue
		}
		for dec.More() {
			if opened, err := openDelim(dec, '{'); err != nil {
				return nil, err
			} else if !opened {
				continue
			}
			for dec.More() {
				name, err := memberName(dec)
				if err != nil {
					return nil, err
				}
				if name != "content" {
					if err := skipValue(dec); err != nil {
						return nil, err
					}
					continue
				}
				if opened, err := openDelim(dec, '['); err != nil {
					return nil, err
				} else if !opened {
					continue
				}
				e, err := contentEdit(dec, raw)
				if err != nil {
					return nil, err
				}
				if e != nil {
					edits = append(edits, *e)
				}
			}
			if !closeDelim(dec, '}') {
				return nil, errUnexpectedJSON
			}
		}
		if !closeDelim(dec, ']') {
			return nil, errUnexpectedJSON
		}
	}
	return edits, nil
}

// contentEdit reads one content array whose '[' was just read, and returns
// the edit that drops its proxy-issued thinking blocks, or nil when it has
// none.
func contentEdit(dec *json.Decoder, raw []byte) (*edit, error) {
	start := int(dec.InputOffset()) - 1
	var kept []json.RawMessage
	dropped := false
	for dec.More() {
		var block json.RawMessage
		if err := dec.Decode(&block); err != nil {
			return nil, err
		}
		if isProxyThinking(block) {
			dropped = true
			continue
		}
		kept = append(kept, block)
	}
	if !closeDelim(dec, ']') {
		return nil, errUnexpectedJSON
	}
	end := int(dec.InputOffset())
	if start < 0 || end > len(raw) || raw[start] != '[' || raw[end-1] != ']' {
		return nil, errUnexpectedJSON
	}
	if !dropped {
		return nil, nil
	}
	return &edit{start: start, end: end, with: joinArray(kept)}, nil
}

func isProxyThinking(block json.RawMessage) bool {
	var b struct {
		Type      text `json:"type"`
		Signature text `json:"signature"`
	}
	readJSON(block, &b)
	if b.Type != "thinking" {
		return false
	}
	_, ours := codexState(string(b.Signature))
	return ours
}

// openDelim reads the next value's first token. It reports true when that is
// the delimiter want, and otherwise consumes the rest of the value and
// reports false.
func openDelim(dec *json.Decoder, want json.Delim) (bool, error) {
	tok, err := dec.Token()
	if err != nil {
		return false, err
	}
	if tok == want {
		return true, nil
	}
	if d, ok := tok.(json.Delim); ok && (d == '{' || d == '[') {
		return false, skipRest(dec)
	}
	return false, nil
}

func closeDelim(dec *json.Decoder, want json.Delim) bool {
	tok, err := dec.Token()
	return err == nil && tok == want
}

func memberName(dec *json.Decoder) (string, error) {
	tok, err := dec.Token()
	if err != nil {
		return "", err
	}
	name, ok := tok.(string)
	if !ok {
		return "", errUnexpectedJSON
	}
	return name, nil
}

func skipValue(dec *json.Decoder) error {
	var skipped json.RawMessage
	return dec.Decode(&skipped)
}

// skipRest consumes the rest of an object or array whose opening delimiter
// was just read.
func skipRest(dec *json.Decoder) error {
	for depth := 1; depth > 0; {
		tok, err := dec.Token()
		if err != nil {
			return err
		}
		switch tok {
		case json.Delim('{'), json.Delim('['):
			depth++
		case json.Delim('}'), json.Delim(']'):
			depth--
		}
	}
	return nil
}
