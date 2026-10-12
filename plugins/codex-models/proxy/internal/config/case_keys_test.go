package config

import (
	"os"
	"strings"
	"testing"
)

// R2 review, finding 1: encoding/json reads a key into its field whatever
// its case, while config init, the installer and the hooks read keys
// exactly, so a key that differs from a known one only in case is refused,
// naming the key it resembles.
func TestCaseVariantKeysAreRefusedNamingTheKnownKey(t *testing.T) {
	const secret = "s3cr3t-value-never-echoed-0123456789abcdef"
	for _, tc := range []struct {
		body string
		want []string
	}{
		{`{"Listen_HTTP":"127.0.0.1:2222"}`, []string{"Listen_HTTP: did you mean listen_http?"}},
		{`{"listen_http":"127.0.0.1:1111","LISTEN_HTTP":"127.0.0.1:2222"}`, []string{"LISTEN_HTTP: did you mean listen_http?"}},
		{`{"Auth_Token":"` + secret + `"}`, []string{"Auth_Token: did you mean auth_token?"}},
		{`{"CODEX":{}}`, []string{"CODEX: did you mean codex?"}},
		{`{"codex":{"Base_URL":"https://chatgpt.com/backend-api/codex","use_codex_cli_auth":false}}`, []string{"codex.Base_URL: did you mean codex.base_url?"}},
		{`{"Listen_Proxy":"127.0.0.1:1"}`, []string{"Listen_Proxy: did you mean listen_proxy?"}},
		{`{"Upstream":"https://api.anthropic.com","codex":{"Use_Codex_CLI_Auth":true}}`, []string{
			"Upstream: did you mean upstream?", "codex.Use_Codex_CLI_Auth: did you mean codex.use_codex_cli_auth?",
		}},
	} {
		path := writeConfig(t, tc.body)
		_, err := Load(path)
		if err == nil {
			t.Fatalf("%s loaded, want a refusal", tc.body)
		}
		for _, want := range tc.want {
			if !strings.Contains(err.Error(), want) {
				t.Errorf("%s: error does not say %q: %v", tc.body, want, err)
			}
		}
		if !strings.HasPrefix(err.Error(), "config: "+path+" has keys that differ from a known key only in case") {
			t.Errorf("%s: error = %v", tc.body, err)
		}
		if strings.Contains(err.Error(), secret) || strings.Contains(err.Error(), "2222") {
			t.Errorf("%s: error repeats a value: %v", tc.body, err)
		}
		// config init refuses the file too, and leaves it as it was.
		before, _ := os.ReadFile(path)
		if _, err := initWith(path, fakeSecrets(), fixedAddr("127.0.0.1:1")); err == nil {
			t.Errorf("%s: config init accepted it", tc.body)
		}
		if after, _ := os.ReadFile(path); string(after) != string(before) {
			t.Errorf("%s: config init changed the refused file", tc.body)
		}
	}
}

// Keys that match nothing, whatever their case, are still ignored by Load
// and kept by config init; a known key's value may hold any case.
func TestKeysThatMatchNothingAreStillKept(t *testing.T) {
	path := writeConfig(t, `{"Future_Key":1,"listen_httpx":2,"codex":{"Also_New":true,"originator":"Codex-TUI"},"log_level":"debug"}`)
	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Codex.Originator != "Codex-TUI" {
		t.Fatalf("originator = %q", cfg.Codex.Originator)
	}
	if _, err := initWith(path, fakeSecrets(), fixedAddr("127.0.0.1:1")); err != nil {
		t.Fatalf("Init: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{`"Future_Key"`, `"listen_httpx"`, `"Also_New"`} {
		if !strings.Contains(string(data), key) {
			t.Errorf("config init dropped %s: %s", key, data)
		}
	}
}

// The known keys are read from the struct tags, so a field added later is
// covered without a list to keep in step.
func TestKnownKeysComeFromTheStructTags(t *testing.T) {
	path := writeConfig(t, `{"codex":{"Effort_Variants":true}}`)
	if _, err := Load(path); err == nil || !strings.Contains(err.Error(), "codex.effort_variants") {
		t.Fatalf("Load = %v", err)
	}
}
