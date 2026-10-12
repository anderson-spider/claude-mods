package router

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// maxMessageRunes is how much of an upstream error message reaches the
// client.
const maxMessageRunes = 300

// CleanMessage prepares an upstream error message for the client. Control
// characters, whitespace and invalid UTF-8 separate words, which are joined
// by single spaces; past maxMessageRunes the text is cut and ends in "…",
// never in a space. An upstream may echo a prompt or a token in its error, so
// the text goes out bounded, and is never logged.
func CleanMessage(message string) string {
	var out strings.Builder
	written := 0
	gap := false // a separator was seen since the last word character
	for _, r := range message {
		if r == utf8.RuneError || unicode.IsControl(r) || unicode.IsSpace(r) {
			gap = out.Len() > 0
			continue
		}
		need := 1
		if gap {
			need = 2
		}
		if written+need > maxMessageRunes {
			out.WriteString("…")
			return out.String()
		}
		if gap {
			out.WriteByte(' ')
			written++
			gap = false
		}
		out.WriteRune(r)
		written++
	}
	return out.String()
}
