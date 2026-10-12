package tokenize

import (
	"strings"
	"testing"
)

// Exact counts pin the arithmetic: characters / 3.5, rounded down, plus 4
// per block.
func TestEstimateArithmetic(t *testing.T) {
	cases := []struct {
		name string
		body string
		want int64
	}{
		// 7 chars -> 2, one block -> 4.
		{"system string", `{"system":"abcdefg"}`, 2 + 4},
		// 7 + 7 chars -> 4, two blocks -> 8.
		{"system blocks", `{"system":[{"text":"abcdefg"},{"text":"hijklmn"}]}`, 4 + 8},
		// "R" + `{"a":1}` = 8 chars -> 2; one block.
		{"tool_use input as written", `{"messages":[{"content":[{"type":"tool_use","name":"R","input":{"a":1}}]}]}`, 2 + 4},
		// an image stands for 1000 chars -> 285; one block.
		{"image", `{"messages":[{"content":[{"type":"image","source":{}}]}]}`, 285 + 4},
		// tool_result: "ab" + 1000 for its image -> 286; one block.
		{"tool_result entries", `{"messages":[{"content":[{"type":"tool_result","content":[{"type":"text","text":"ab"},{"type":"image"}]}]}]}`, 286 + 4},
		// name 1 + description 2 + schema `{}` 2 -> 1; one block.
		{"tool", `{"tools":[{"name":"a","description":"bc","input_schema":{}}]}`, 1 + 4},
		// "é😀" is two runes, not six bytes: 0 tokens of text, one block.
		{"runes, not bytes", `{"system":"é😀"}`, 0 + 4},
		// An unknown block type costs only its framing.
		{"unknown block", `{"messages":[{"content":[{"type":"server_tool_use","text":"ignored text"}]}]}`, 4},
	}
	for _, tc := range cases {
		if got := EstimateClaudeRequest([]byte(tc.body)); got != tc.want {
			t.Errorf("%s: %d, want %d", tc.name, got, tc.want)
		}
	}
}

// The walk is lenient: a field of an unexpected type is counted as well as
// it can be, and the first of two members with one name is the one read.
func TestEstimateUnusualShapes(t *testing.T) {
	cases := []struct {
		name string
		body string
		want int64
	}{
		{"null content is one block", `{"messages":[{"content":null}]}`, 4},
		{"absent content is nothing", `{"messages":[{"role":"user"}]}`, 1},
		{"messages as an object", `{"messages":{"a":{"content":"abcdefg"}}}`, 2 + 4},
		{"first duplicate wins", `{"system":"abcdefg","system":"` + strings.Repeat("z", 70) + `"}`, 2 + 4},
		{"keys are case-sensitive", `{"System":"abcdefg"}`, 1},
		{"system object is not counted", `{"system":{"text":"abcdefg"}}`, 1},
		{"number text as written", `{"messages":[{"content":[{"type":"text","text":1234567}]}]}`, 2 + 4},
		{"a top-level array counts nothing", `[{"system":"abcdefg"}]`, 1},
	}
	for _, tc := range cases {
		if got := EstimateClaudeRequest([]byte(tc.body)); got != tc.want {
			t.Errorf("%s: %d, want %d", tc.name, got, tc.want)
		}
	}
}

// A body that is not JSON is estimated from its length, never below what
// its text alone would count.
func TestEstimateInvalidJSONFromLength(t *testing.T) {
	text := strings.Repeat("hello ", 100)
	cut := `{"messages":[{"role":"user","content":"` + text + `"}`
	whole := cut + `]}`
	if got, valid := EstimateClaudeRequest([]byte(cut)), EstimateClaudeRequest([]byte(whole)); got < valid-4 {
		t.Fatalf("truncated body = %d, want about the valid body's %d or more", got, valid)
	}
	if got := EstimateClaudeRequest([]byte("not json")); got != 2 {
		t.Fatalf("8 characters = %d, want 2", got)
	}
	if got := EstimateClaudeRequest(nil); got != 1 {
		t.Fatalf("empty body = %d, want the floor of 1", got)
	}
}
