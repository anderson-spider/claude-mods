package translate

import (
	"fmt"
	"strings"
	"testing"

	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/logx"
)

// TestEachDroppedCallIsLoggedOnceWithoutItsArguments: two unusable calls,
// one sent twice and listed again in the terminal payload, next to a good
// call; on both paths each drop is one line naming the client's tool and
// the size, and the stop reason comes from the rest of the turn.
func TestEachDroppedCallIsLoggedOnceWithoutItsArguments(t *testing.T) {
	const secret = "PLANTED-ARGUMENT-SECRET"
	bad1 := `["` + secret + `"]`
	bad2 := `"` + secret + `"`
	var logged strings.Builder
	restore := logx.SetOutput(&logged)
	defer restore()

	cases := []struct {
		name     string
		events   []string
		wantStop string
		wantUse  int
	}{
		{"next to a good call", []string{
			codexCreated,
			fcAdded("0", "f1", "call_1", "short_write"),
			fcItemDone("0", "f1", "call_1", "short_write", jsonString(bad1), "completed"),
			fcItemDone("0", "f1", "call_1", "short_write", jsonString(bad1), "completed"),
			fcAdded("1", "f2", "call_2", "Bash"),
			fcItemDone("1", "f2", "call_2", "Bash", jsonString(bad2), ""),
			fcAdded("2", "f3", "call_3", "Read"),
			fcItemDone("2", "f3", "call_3", "Read", `"{\"p\":1}"`, "completed"),
			`{"type":"response.completed","response":{"id":"r","output":[` +
				`{"type":"function_call","id":"f1","call_id":"call_1","name":"short_write","arguments":` + jsonString(bad1) + `}],"usage":{}}}`,
		}, "tool_use", 1},
		{"with a cut", []string{
			codexCreated,
			fcAdded("0", "f1", "call_1", "short_write"),
			fcItemDone("0", "f1", "call_1", "short_write", jsonString(bad1), "completed"),
			fcAdded("1", "f2", "call_2", "Bash"),
			fcItemDone("1", "f2", "call_2", "Bash", jsonString(bad2), ""),
			codexCutByMaxTokens,
		}, "max_tokens", 0},
	}
	for _, c := range cases {
		for _, path := range []string{"stream", "assembled"} {
			logged.Reset()
			var stop string
			var uses int
			if path == "stream" {
				calls, s, _, _ := toolUsesFromStream(t, c.events...)
				stop, uses = s, len(calls)
			} else {
				m := assemble(t, "gpt-6-luna", map[string]string{"short_write": "Write"}, c.events...)
				stop = m.Get("stop_reason").String()
				for _, b := range m.Get("content").Array() {
					if b.Get("type").String() == "tool_use" {
						uses++
					}
				}
			}
			label := c.name + " " + path
			if stop != c.wantStop || uses != c.wantUse {
				t.Fatalf("%s: stop %q uses %d, want %q %d", label, stop, uses, c.wantStop, c.wantUse)
			}
			log := logged.String()
			if strings.Contains(log, secret) {
				t.Fatalf("%s: the log carries the arguments: %q", label, log)
			}
			if got := strings.Count(log, "dropped tool call"); got != 2 {
				t.Fatalf("%s: %d drop lines, want 2:\n%s", label, got, log)
			}
			name := "short_write"
			if path == "assembled" {
				name = "Write"
			}
			for _, want := range []string{
				fmt.Sprintf(`dropped tool call %q: arguments are not a JSON object (%d bytes)`, name, len(bad1)),
				fmt.Sprintf(`dropped tool call "Bash": arguments are not a JSON object (%d bytes)`, len(bad2)),
			} {
				if !strings.Contains(log, want) {
					t.Fatalf("%s: log lacks %q:\n%s", label, want, log)
				}
			}
		}
	}
}
