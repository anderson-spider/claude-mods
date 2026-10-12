package jsontest

import (
	"strings"
	"testing"
)

const doc = `{
  "a": {"b": [10, {"c": "x\u0041"}, true]},
  "dup": 1, "dup": 2,
  "3": "key three",
  "n": null,
  "f": 1.5,
  "big": 12345678901234567890,
  "s": "42",
  "t": "TRUE",
  "spaced": { "k" :  [ 1 , 2 ] },
  "$schema": "s",
  "empty": []
}`

func TestGetPaths(t *testing.T) {
	for _, tc := range []struct {
		path   string
		typ    Type
		raw    string
		str    string
		exists bool
	}{
		{"a.b.0", Number, "10", "10", true},
		{"a.b.1.c", String, `"x\u0041"`, "xA", true},
		{"a.b.2", True, "true", "true", true},
		{"a.b.#", Number, "3", "3", true},
		{"a.b.3", Null, "", "", false},
		{"a.b.-1", Null, "", "", false},
		{"a.b.x", Null, "", "", false},
		{"dup", Number, "1", "1", true},
		{"3", String, `"key three"`, "key three", true},
		{"n", Null, "null", "", true},
		{"f", Number, "1.5", "1.5", true},
		{"spaced", JSON, `{ "k" :  [ 1 , 2 ] }`, `{ "k" :  [ 1 , 2 ] }`, true},
		{"spaced.k", JSON, `[ 1 , 2 ]`, `[ 1 , 2 ]`, true},
		{"spaced.k.1", Number, "2", "2", true},
		{"$schema", String, `"s"`, "s", true},
		{"empty.#", Number, "0", "0", true},
		{"a.#", Null, "", "", false},
		{"missing", Null, "", "", false},
		{"a.b.0.deeper", Null, "", "", false},
		{"s.x", Null, "", "", false},
	} {
		got := Get(doc, tc.path)
		if got.Type != tc.typ || got.Raw != tc.raw || got.String() != tc.str || got.Exists() != tc.exists {
			t.Errorf("Get(%q) = %+v (String %q, Exists %v), want type %v raw %q string %q exists %v",
				tc.path, got, got.String(), got.Exists(), tc.typ, tc.raw, tc.str, tc.exists)
		}
	}
}

func TestConversions(t *testing.T) {
	for _, tc := range []struct {
		path string
		i    int64
		b    bool
	}{
		{"a.b.0", 10, true},
		{"a.b.2", 1, true},
		{"f", 1, true},
		{"s", 42, false},
		{"t", 0, true},
		{"n", 0, false},
		{"missing", 0, false},
		{"big", 0, true},
	} {
		got := Get(doc, tc.path)
		if tc.path == "big" {
			// Too large for an int64 to read exactly; only Bool is pinned.
			if !got.Bool() {
				t.Errorf("Get(big).Bool() = false")
			}
			continue
		}
		if got.Int() != tc.i || got.Bool() != tc.b {
			t.Errorf("Get(%q): Int %d Bool %v, want %d %v", tc.path, got.Int(), got.Bool(), tc.i, tc.b)
		}
	}
	if got := Parse(`1e3`).String(); got != "1000" {
		t.Errorf("String of 1e3 = %q", got)
	}
}

func TestArrayAndForEach(t *testing.T) {
	if got := Get(doc, "a.b").Array(); len(got) != 3 || got[1].Get("c").String() != "xA" {
		t.Errorf("Array = %+v", got)
	}
	if got := Get(doc, "empty").Array(); len(got) != 0 {
		t.Errorf("empty Array = %+v", got)
	}
	if got := Get(doc, "missing").Array(); got == nil || len(got) != 0 {
		t.Errorf("missing Array = %#v, want an empty slice", got)
	}
	if got := Get(doc, "f").Array(); len(got) != 1 || got[0].Raw != "1.5" {
		t.Errorf("scalar Array = %+v", got)
	}
	if got := Get(doc, "a").Array(); len(got) != 1 || !got[0].IsObject() {
		t.Errorf("object Array = %+v", got)
	}

	var keys []string
	Parse(doc).ForEach(func(key, value Result) bool {
		keys = append(keys, key.Str+"="+value.Raw)
		return key.Str != "n"
	})
	if want := `a={"b": [10, {"c": "x\u0041"}, true]} dup=1 dup=2 3="key three" n=null`; strings.Join(keys, " ") != want {
		t.Errorf("ForEach = %q, want %q", strings.Join(keys, " "), want)
	}
	var indexes []float64
	Get(doc, "a.b").ForEach(func(key, _ Result) bool {
		indexes = append(indexes, key.Num)
		return true
	})
	if len(indexes) != 3 || indexes[0] != 0 || indexes[2] != 2 {
		t.Errorf("array keys = %v", indexes)
	}
	calls := 0
	Get(doc, "missing").ForEach(func(_, _ Result) bool { calls++; return true })
	Get(doc, "f").ForEach(func(_, v Result) bool { calls += 10; return v.Raw == "1.5" })
	if calls != 10 {
		t.Errorf("ForEach calls = %d, want only the scalar's", calls)
	}
}

func TestParseAndValid(t *testing.T) {
	if got := Parse("  {\"a\":1}\n"); !got.IsObject() || got.Raw != "{\"a\":1}\n" || got.Get("a").Int() != 1 {
		t.Errorf("Parse object = %+v", got)
	}
	if got := Parse(`"s" trailing`); got.Type != String || got.Str != "s" {
		t.Errorf("Parse string = %+v", got)
	}
	if got := Parse("?x"); got.Exists() {
		t.Errorf("Parse(?x) = %+v", got)
	}
	if got := ParseBytes([]byte("[1,2]")); !got.IsArray() || got.Get("#").Int() != 2 {
		t.Errorf("ParseBytes = %+v", got)
	}
	if got := GetBytes([]byte(doc), "a.b.0").Int(); got != 10 {
		t.Errorf("GetBytes = %d", got)
	}
	// A member past a broken one is not reached; the ones before it are.
	if got := Get(`{"a":1,"b":}`, "a"); got.Int() != 1 {
		t.Errorf("before the break = %+v", got)
	}
	if !Valid(doc) || !ValidBytes([]byte(" 1 ")) || Valid(`{"a":}`) || Valid("") || Valid(`{} {}`) {
		t.Error("Valid disagrees with encoding/json")
	}
}

func TestUnsupportedPathsPanic(t *testing.T) {
	for _, path := range []string{"a.*", "a.b.#.c", "a|b", "@this", `a\.b`, "a.#(c==1)"} {
		func() {
			defer func() {
				if recover() == nil {
					t.Errorf("Get(%q) did not panic", path)
				}
			}()
			Get(doc, path)
		}()
	}
}
