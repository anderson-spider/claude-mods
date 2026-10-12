package translate

import (
	"math/rand"
	"strings"
	"testing"
	"unicode"
	"unicode/utf8"
)

// TestCleanMessageCapHoldsWhereverTheSpacesFall: at most 300 runes of text
// and the ellipsis, never a space before it, whatever lands at position 300.
func TestCleanMessageCapHoldsWhereverTheSpacesFall(t *testing.T) {
	for _, in := range []string{
		strings.Repeat("x", 1000),
		strings.Repeat("a", 299) + " bcdef" + strings.Repeat("y", 50),
		strings.Repeat("w ", 500),
		strings.Repeat("é\t", 400),
		strings.Repeat("界\u0000", 400),
		strings.Repeat("🙂 ", 400),
		strings.Repeat("a", 299) + "\u001b[31m" + strings.Repeat("z", 10),
	} {
		out := CleanMessage(in)
		runes := []rune(out)
		if len(runes) > 301 || !strings.HasSuffix(out, "…") || strings.HasSuffix(out, " …") {
			t.Errorf("CleanMessage(%d-rune input) = %d runes, ends %q", len([]rune(in)), len(runes), string(runes[max(0, len(runes)-3):]))
		}
	}
	if got := CleanMessage(strings.Repeat("z", 300)); got != strings.Repeat("z", 300) {
		t.Errorf("exactly 300 runes must pass untouched, got %d runes", len([]rune(got)))
	}
	if got := CleanMessage("\x00\x1b a\r\n\tb   c\u0085"); got != "a b c" {
		t.Errorf("controls and whitespace = %q", got)
	}
	for _, short := range []string{"", "upstream says no", "a b", "日本語のエラー", "x"} {
		if got := CleanMessage(short); got != short {
			t.Errorf("short message %q became %q", short, got)
		}
	}
}

// referenceClean is CleanMessage stated plainly: split on controls, spaces
// and invalid UTF-8, join with one space, and cut past 300 runes, dropping a
// space left at the cut before the ellipsis.
func referenceClean(message string) string {
	words := strings.FieldsFunc(message, func(r rune) bool {
		return unicode.IsControl(r) || unicode.IsSpace(r) || r == utf8.RuneError
	})
	runes := []rune(strings.Join(words, " "))
	if len(runes) <= maxMessageRunes {
		return string(runes)
	}
	return strings.TrimRight(string(runes[:maxMessageRunes]), " ") + "…"
}

func TestCleanMessageMatchesAReferenceCut(t *testing.T) {
	pieces := []string{"a", "bc", "é", "界", "🙂", " ", "  ", "\t", "\n", "\r\n", "\x00", "\x1b", "\x7f", "\u0085", " ", " ", "​", "\xff", "\xe2\x82"}
	rng := rand.New(rand.NewSource(7))
	for i := 0; i < 5000; i++ {
		var b strings.Builder
		target := 290 + rng.Intn(400)
		if i%10 == 0 {
			target = rng.Intn(20)
		}
		for utf8.RuneCountInString(b.String()) < target {
			b.WriteString(pieces[rng.Intn(len(pieces))])
		}
		in := b.String()
		got, want := CleanMessage(in), referenceClean(in)
		if got != want {
			t.Fatalf("CleanMessage(%q)\n got %q (%d runes)\nwant %q (%d runes)", in, got, len([]rune(got)), want, len([]rune(want)))
		}
	}
}
