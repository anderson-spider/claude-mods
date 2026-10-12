package codex

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

// cliWritten is a credential file as the Codex CLI writes it: two-space
// indentation, no trailing newline.
const cliWritten = `{
  "auth_mode": "chatgpt",
  "OPENAI_API_KEY": null,
  "tokens": {
    "id_token": "old.id.token",
    "access_token": "old.access.token",
    "refresh_token": "rt-old",
    "account_id": "acct_old",
    "added_later": [
      1,
      {
        "x": "<&>"
      }
    ]
  },
  "last_refresh": "2026-08-29T01:17:11.660495951Z",
  "zz_unknown": {
    "kept": true
  }
}`

func refreshedToken() *Token {
	return &Token{
		IDToken:      "new.id.token",
		AccessToken:  "new.access.token",
		RefreshToken: "rt-new",
		AccountID:    "acct_new",
		LastRefresh:  time.Date(2026, 10, 12, 3, 4, 5, 6, time.UTC),
	}
}

// Rewriting a file the Codex CLI wrote changes only the four tokens and
// last_refresh; every other member stays, in its place, with its value.
func TestCodexCLILayoutKeepsTheFileAsWritten(t *testing.T) {
	got, err := encodeCredentials(refreshedToken(), formatCodexCLI, []byte(cliWritten))
	if err != nil {
		t.Fatalf("encodeCredentials: %v", err)
	}
	want := `{
  "auth_mode": "chatgpt",
  "OPENAI_API_KEY": null,
  "tokens": {
    "id_token": "new.id.token",
    "access_token": "new.access.token",
    "refresh_token": "rt-new",
    "account_id": "acct_new",
    "added_later": [
      1,
      {
        "x": "<&>"
      }
    ]
  },
  "last_refresh": "2026-10-12T03:04:05.000000006Z",
  "zz_unknown": {
    "kept": true
  }
}
`
	if string(got) != want {
		t.Fatalf("rewritten file:\n%s\nwant:\n%s", got, want)
	}
}

// Writing the same credential again gives the same bytes. (Earlier releases
// added a newline at the end on every write.)
func TestCodexCLILayoutRewriteIsStable(t *testing.T) {
	first, err := encodeCredentials(refreshedToken(), formatCodexCLI, []byte(cliWritten))
	if err != nil {
		t.Fatalf("first write: %v", err)
	}
	second, err := encodeCredentials(refreshedToken(), formatCodexCLI, first)
	if err != nil {
		t.Fatalf("second write: %v", err)
	}
	if !bytes.Equal(first, second) {
		t.Fatalf("second write differs:\n%q\nfirst:\n%q", second, first)
	}
	if !bytes.HasSuffix(second, []byte("}\n")) || bytes.HasSuffix(second, []byte("\n\n")) {
		t.Fatalf("the file should end in one newline: %q", second[len(second)-4:])
	}
}

// Members the file lacks are added after the ones it has; a file that holds
// no JSON object starts from a ChatGPT-mode skeleton.
func TestCodexCLILayoutFillsWhatIsMissing(t *testing.T) {
	got, err := encodeCredentials(refreshedToken(), formatCodexCLI, []byte(`{"auth_mode":"chatgpt","tokens":{"account_id":"a"}}`))
	if err != nil {
		t.Fatalf("encodeCredentials: %v", err)
	}
	root, err := parseObject(got)
	if err != nil {
		t.Fatalf("output is not an object: %v\n%s", err, got)
	}
	tokens, _ := parseObject(root.get(cliTokens))
	var keys []string
	for _, m := range tokens {
		keys = append(keys, m.key)
	}
	if got, want := strings.Join(keys, " "), "account_id id_token access_token refresh_token"; got != want {
		t.Fatalf("tokens keys = %s, want %s", got, want)
	}
	if len(root) != 3 || root[2].key != cliLastRefresh {
		t.Fatalf("root = %s", got)
	}

	for _, previous := range []string{``, `{oops`, `[]`, `"text"`} {
		got, err := encodeCredentials(refreshedToken(), formatCodexCLI, []byte(previous))
		if err != nil {
			t.Fatalf("%q: %v", previous, err)
		}
		root, err := parseObject(got)
		if err != nil || textOf(root.get(cliAuthMode)) != cliChatGPTMode || string(root.get("OPENAI_API_KEY")) != "null" {
			t.Fatalf("%q: got %s", previous, got)
		}
		token, err := decodeCredentials(got, formatCodexCLI)
		if err != nil || token.AccessToken != "new.access.token" || token.RefreshToken != "rt-new" {
			t.Fatalf("%q: decoded %+v, %v", previous, token, err)
		}
	}
}

// The Codex CLI layout is read by exact key, the first of a repeated key
// winning, and a value of another type is read as its text.
func TestCodexCLILayoutReadingRules(t *testing.T) {
	token, err := decodeCodexCLI([]byte(`{"Tokens":{"access_token":"wrong"},"tokens":{"access_token":"first","access_token":"second","Refresh_Token":"no","refresh_token":12,"account_id":true}}`))
	if err != nil {
		t.Fatalf("decodeCodexCLI: %v", err)
	}
	if token.AccessToken != "first" || token.RefreshToken != "12" || token.AccountID != "true" {
		t.Fatalf("token = %+v", token)
	}
	if detectFormat([]byte(`{"Tokens":{}}`)) != formatNative || detectFormat([]byte(`{"tokens":{}, broken`)) != formatCodexCLI {
		t.Fatal("detectFormat must match the key exactly and stop reading once it has found it")
	}
}

// Error codes are read from the body without needing the rest of it to be
// valid, and only when they are short tokens.
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
