package jsonread

import "testing"

func TestTextReadsAnyValue(t *testing.T) {
	for raw, want := range map[string]string{
		`"a\u0042"`:   "aB",
		` "x" `:       "x",
		`null`:        "",
		``:            "",
		`true`:        "true",
		`false`:       "false",
		`-12`:         "-12",
		`007`:         "007",
		`1e3`:         "1000",
		`1.50`:        "1.5",
		`{"a": [1]}`:  `{"a": [1]}`,
		`[1, "two"]`:  `[1, "two"]`,
		`"\ud800"`:    "\ufffd",
		`"unfinished`: "",
	} {
		if got := TextOf([]byte(raw)); got != want {
			t.Errorf("TextOf(%s) = %q, want %q", raw, got, want)
		}
	}
}

func TestBoolReadsAnyValue(t *testing.T) {
	for raw, want := range map[string]bool{
		`true`: true, `false`: false, `null`: false, ``: false,
		`"TRUE"`: true, `"t"`: true, `"1"`: true, `"yes"`: false, `"false"`: false,
		`1`: true, `0`: false, `-0.5`: true, `0.0`: false,
		`{}`: false, `[true]`: false,
	} {
		if got := BoolOf([]byte(raw)); got != want {
			t.Errorf("BoolOf(%s) = %v, want %v", raw, got, want)
		}
	}
}

func TestDecodeChecksTheWholeDocumentAndSkipsWrongTypes(t *testing.T) {
	var head struct {
		Model  Text            `json:"model"`
		Stream Bool            `json:"stream"`
		Count  int             `json:"count"`
		Name   string          `json:"name"`
		Rest   map[string]bool `json:"rest"`
	}
	if !Decode([]byte(`{"MODEL":"a","model":"b","stream":"true","count":"x","name":"n"}`), &head) {
		t.Fatal("a valid document was refused")
	}
	if head.Model != "b" || !bool(head.Stream) || head.Count != 0 || head.Name != "n" {
		t.Fatalf("head = %+v", head)
	}

	var partial struct {
		Model Text `json:"model"`
	}
	if Decode([]byte(`{"model":"a",}`), &partial) || partial.Model != "" {
		t.Fatalf("a document with a syntax error decoded to %+v", partial)
	}
}

func TestKind(t *testing.T) {
	for raw, want := range map[string]byte{"": 0, " \n\t": 0, ` {"a":1}`: '{', "\r\n[": '[', `"s"`: '"', `-1`: '-', `nul`: 'n'} {
		if got := Kind([]byte(raw)); got != want {
			t.Errorf("Kind(%q) = %q, want %q", raw, got, want)
		}
	}
}
