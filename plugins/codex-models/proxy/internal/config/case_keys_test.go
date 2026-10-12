package config

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestUnknownKeysAreIgnoredUniformly(t *testing.T) {
	cfg, err := Load(writeConfig(t, `{"listen_tls":123,"DNS":false,"future":{},"Codex":{"user_agent":false,"originator":12,"model_prefix":"other/","effort_variants":true,"callback_port":9999,"models":["gpt-daybreak-blue-latest"],"auth_file":"/unreadable","use_codex_cli_auth":true}}`))
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"user_agent", "originator", "model_prefix", "effort_variants", "callback_port", "models", "auth_file", "use_codex_cli_auth", "listen_tls", "DNS", "future"} {
		if strings.Contains(string(data), `"`+key+`"`) {
			t.Fatalf("obsolete key in effective config: %s", key)
		}
	}
}

func TestKnownFieldsUseStandardJSONDecoding(t *testing.T) {
	cfg, err := Load(writeConfig(t, `{"Listen_HTTP":"127.0.0.1:43210","CODEX":{"REMOTE":"https://chatgpt.com/custom"}}`))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ListenHTTP != "127.0.0.1:43210" || cfg.Codex.Remote != "https://chatgpt.com/custom" {
		t.Fatalf("config = %+v", cfg)
	}
	for _, body := range []string{`{"codex":{"management_key":false}}`, `{"codex":{"remote":123}}`, `{"listen_http":[]}`} {
		if _, err := Load(writeConfig(t, body)); err == nil {
			t.Fatalf("wrong known-field type accepted: %s", body)
		}
	}
}
