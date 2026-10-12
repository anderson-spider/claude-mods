package config

import (
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
)

func TestRemoteRefusesLocalAddressesAndUnsafeURLs(t *testing.T) {
	for _, remote := range []string{"https://127.0.0.1", "https://127.2.3.4", "https://[::1]", "https://[::ffff:127.0.0.1]", "https://0.0.0.0", "https://[::ffff:0.0.0.0]", "https://[::]", "https://user:private-key@remote.example", "https://remote.example?key=private-key", "https://remote.example#private-key", "https://remote.example?", "https://remote.example#", "http://remote.example", "https://remote.example:0"} {
		cfg := Default()
		cfg.Codex.Remote = remote
		err := cfg.Validate()
		if err == nil || !strings.Contains(err.Error(), "codex.remote") || strings.Contains(err.Error(), "private-key") {
			t.Fatalf("unsafe remote accepted/echoed: %q, %v", remote, err)
		}
	}
	cfg := Default()
	cfg.Codex.Remote = "https://remote.example/prefix"
	cfg.Codex.ManagementKey = "valid-private-key"
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestManagementKeyIsPrivateOptionalAndNeverEchoedOnRefusal(t *testing.T) {
	for _, key := range []string{"private key", "private\nkey", strings.Repeat("x", 513), "private-é-key"} {
		cfg := Default()
		cfg.Codex.ManagementKey = key
		if err := cfg.Validate(); err == nil || strings.Contains(err.Error(), key) {
			t.Fatalf("key accepted or echoed: %v", err)
		}
	}
	path := writeConfig(t, `{"codex":{"management_key":"synthetic-management-key","remote":"https://remote.example"}}`)
	os.Chmod(path, 0o644)
	if _, err := Load(path); err == nil {
		t.Fatal("exposed management key loaded")
	}
}

func TestInitRemotePreservesUnknownMembersAndIsAtomicIdempotent(t *testing.T) {
	original := `{"auth_token":"` + validToken + `","session_salt":"` + validToken + `","other":{"exact": [ 1, 2 ]},"Codex":{"future":{"value":7},"remote":"https://old.example","management_key":"old-key"}}`
	path := writeConfig(t, original)
	remote := Codex{Remote: "https://new.example", ManagementKey: "private-management-key"}
	result, err := InitRemote(path, remote)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(result.Added, ",") != "codex" {
		t.Fatalf("result: %+v", result)
	}
	data, _ := os.ReadFile(path)
	if !strings.HasPrefix(string(data), strings.TrimSuffix(original, "}")) {
		t.Fatal("existing document was reserialized")
	}
	var document struct {
		Codex map[string]json.RawMessage `json:"codex"`
	}
	json.Unmarshal(data, &document)
	if string(document.Codex["future"]) != `{"value":7}` {
		t.Fatalf("unknown nested member lost: %s", data)
	}
	cfg, err := Load(path)
	if err != nil || cfg.Codex != remote {
		t.Fatalf("effective config: %+v %v", cfg, err)
	}
	result, err = InitRemote(path, remote)
	again, _ := os.ReadFile(path)
	if err != nil || len(result.Added) != 0 || string(again) != string(data) {
		t.Fatal("remote init is not byte-idempotent")
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0o600 {
		t.Fatal("secret file is not private")
	}
}

func TestInitRemoteGenerationFailureLeavesOriginalFileUntouched(t *testing.T) {
	original := `{"other":7,"codex":{"remote":"https://old.example"}}`
	path := writeConfig(t, original)
	remote := Codex{Remote: "https://new.example", ManagementKey: "private-management-key"}
	_, err := initWithRemote(path, func() (string, error) { return "", errors.New("random failed") }, nil, &remote)
	data, _ := os.ReadFile(path)
	if err == nil || string(data) != original {
		t.Fatal("failed init partially changed config")
	}
}

func TestOldCredentialSettingsAreUnknownAndNotInEffectiveConfig(t *testing.T) {
	cfg, err := Load(writeConfig(t, `{"auth_dir":false,"codex":{"base_url":12}}`))
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(cfg)
	if strings.Contains(string(data), "auth_dir") || strings.Contains(string(data), "base_url") {
		t.Fatalf("native credential setting survives: %s", data)
	}
}
