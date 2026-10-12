package codex

import "testing"

func TestErrorCodesAreReadLeniently(t *testing.T) {
	for body, want := range map[string]string{
		`{"error":"invalid_grant"`:                   "invalid_grant",
		`{"error":"invalid_grant","error":"second"}`: "invalid_grant",
		`{"x":[{"error":"nested"}],"error":"top"}`:   "top",
		`{"Error":"case"}`:                           "",
		`{"error":7}`:                                "",
		`not json`:                                   "",
	} {
		if got := newTokenError(400, []byte(body)).Code; got != want {
			t.Errorf("%s: code %q, want %q", body, got, want)
		}
	}
	if got := (&APIError{StatusCode: 429, Body: []byte(`{"error":{"code":"c","type":"t"`)}).Error(); got != "codex: backend returned 429 (type t, code c)" {
		t.Errorf("APIError on a cut body = %q", got)
	}
}
