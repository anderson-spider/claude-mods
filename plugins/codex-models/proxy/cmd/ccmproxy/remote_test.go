package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/config"
)

func TestConfigInitReadsRemoteAndKeyOnlyFromStdin(t *testing.T) {
	const key = "private-management-key"
	dir := t.TempDir()
	inputPath := filepath.Join(dir, "input.json")
	os.WriteFile(inputPath, []byte(`{"codex":{"remote":"https://remote.example","management_key":"`+key+`"}}`), 0o600)
	input, err := os.Open(inputPath)
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	old := os.Stdin
	os.Stdin = input
	defer func() { os.Stdin = old }()
	path := filepath.Join(dir, "config.json")
	output := captureStdout(t, func() error { return run([]string{"config", "init", "--stdin", "--config", path}) })
	if strings.Contains(output, key) {
		t.Fatal("config init exposed management credential")
	}
	cfg, err := config.Load(path)
	if err != nil || cfg.Codex.Remote != "https://remote.example" || cfg.Codex.ManagementKey != key {
		t.Fatalf("stdin settings not saved: %v", err)
	}
	status := captureStdout(t, func() error { return run([]string{"status", "--config", path}) })
	env := captureStdout(t, func() error { return run([]string{"env", "--shell", "json", "--config", path}) })
	if strings.Contains(status, key) || strings.Contains(env, key) {
		t.Fatal("management credential escaped through status/env")
	}
	if !strings.Contains(status, "management key") || !strings.Contains(status, "set") {
		t.Fatal("status does not describe management configuration")
	}
}

func TestNativeLoginCommandsNoLongerExist(t *testing.T) {
	for _, command := range []string{"login", "logout"} {
		if err := run([]string{command, "codex"}); err == nil || !strings.Contains(err.Error(), "unknown command") {
			t.Fatalf("removed command remains: %s %v", command, err)
		}
	}
	help := captureStdout(t, func() error { return run([]string{"help"}) })
	if strings.Contains(help, "login codex") || strings.Contains(help, "logout codex") {
		t.Fatal("help still advertises native login")
	}
}
