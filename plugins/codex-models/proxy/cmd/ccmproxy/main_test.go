package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jclab-joseph/claude-code-model-proxy/internal/config"
)

func fixedLookup(addrs ...string) lookupFunc {
	return func(ctx context.Context, network, host string) ([]netip.Addr, error) {
		out := make([]netip.Addr, 0, len(addrs))
		for _, a := range addrs {
			out = append(out, netip.MustParseAddr(a))
		}
		return out, nil
	}
}

func TestCheckUpstreamRefusesALocalAnswer(t *testing.T) {
	for _, addrs := range [][]string{
		{"127.0.0.1"},
		{"127.1.0.101"},
		{"::1"},
		{"0.0.0.0"},
		{"::ffff:127.0.0.1"},
		{"160.79.104.10", "127.0.0.1"},
	} {
		err := checkUpstream(context.Background(), config.DefaultUpstream, fixedLookup(addrs...))
		if err == nil || !strings.Contains(err.Error(), "/etc/hosts") {
			t.Fatalf("addrs %v: err = %v, want a refusal naming /etc/hosts", addrs, err)
		}
	}
}

func TestCheckUpstreamAcceptsARemoteAnswer(t *testing.T) {
	if err := checkUpstream(context.Background(), config.DefaultUpstream, fixedLookup("160.79.104.10", "2607:6bc0::10")); err != nil {
		t.Fatalf("checkUpstream: %v", err)
	}
}

func TestCheckUpstreamOnlyWarnsWhenTheLookupFails(t *testing.T) {
	failing := func(ctx context.Context, network, host string) ([]netip.Addr, error) {
		return nil, errors.New("no network")
	}
	if err := checkUpstream(context.Background(), config.DefaultUpstream, failing); err != nil {
		t.Fatalf("a failed lookup must not stop the proxy: %v", err)
	}
}

func TestCheckUpstreamLooksUpTheUpstreamHost(t *testing.T) {
	var asked string
	lookup := func(ctx context.Context, network, host string) ([]netip.Addr, error) {
		asked = host
		return nil, nil
	}
	if err := checkUpstream(context.Background(), config.DefaultUpstream, lookup); err != nil {
		t.Fatalf("checkUpstream: %v", err)
	}
	if asked != "api.anthropic.com" {
		t.Fatalf("looked up %q", asked)
	}
}

func testConfig(t *testing.T, body string) *config.Config {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	cfg, err := config.Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	return cfg
}

const testToken = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func TestEnvVarsNameTheListenerAndTheSecret(t *testing.T) {
	cfg := testConfig(t, `{"listen_http":"127.0.0.1:50123","auth_token":"`+testToken+`"}`)
	vars, err := envVars(cfg)
	if err != nil {
		t.Fatalf("envVars: %v", err)
	}
	want := map[string]string{
		"ANTHROPIC_BASE_URL":       "http://127.0.0.1:50123",
		"ANTHROPIC_CUSTOM_HEADERS": "X-Ccmproxy-Token: " + testToken,
		"ENABLE_TOOL_SEARCH":       "true",
	}
	if len(vars) != len(want) {
		t.Fatalf("vars = %v", vars)
	}
	for _, kv := range vars {
		if want[kv[0]] != kv[1] {
			t.Fatalf("%s = %q, want %q", kv[0], kv[1], want[kv[0]])
		}
	}
}

func TestEnvVarsUseBracketsForIPv6(t *testing.T) {
	cfg := testConfig(t, `{"listen_http":"[::1]:50123","auth_token":"`+testToken+`"}`)
	vars, err := envVars(cfg)
	if err != nil {
		t.Fatalf("envVars: %v", err)
	}
	if vars[0][1] != "http://[::1]:50123" {
		t.Fatalf("base URL = %q", vars[0][1])
	}
}

func TestEnvVarsNeedTheSecret(t *testing.T) {
	cfg := testConfig(t, `{}`)
	if _, err := envVars(cfg); err == nil || !strings.Contains(err.Error(), "config init") {
		t.Fatalf("envVars without auth_token = %v, want a pointer to config init", err)
	}
}

func TestFormatEnvQuotesEveryShell(t *testing.T) {
	vars := [][2]string{{"A", "x: it's"}, {"B", "true"}}
	cases := map[string]string{
		"posix":      "export A='x: it'\\''s'\nexport B='true'\n",
		"fish":       "set -gx A 'x: it\\'s'\nset -gx B 'true'\n",
		"powershell": "$env:A = 'x: it''s'\n$env:B = 'true'\n",
	}
	for shell, want := range cases {
		got, err := formatEnv(vars, shell)
		if err != nil {
			t.Fatalf("%s: %v", shell, err)
		}
		if got != want {
			t.Fatalf("%s:\n%s\nwant:\n%s", shell, got, want)
		}
	}
	got, err := formatEnv(vars, "json")
	if err != nil {
		t.Fatalf("json: %v", err)
	}
	var object map[string]string
	if err := json.Unmarshal([]byte(got), &object); err != nil || object["A"] != "x: it's" || object["B"] != "true" {
		t.Fatalf("json = %q (%v)", got, err)
	}
	if _, err := formatEnv(vars, "tcsh"); err == nil {
		t.Fatal("an unknown shell must be refused")
	}
}

func TestRemovedCommandsAreUnknown(t *testing.T) {
	for _, command := range []string{"ca", "dns"} {
		err := run([]string{command})
		if err == nil || !strings.Contains(err.Error(), "unknown command") {
			t.Fatalf("run(%q) = %v, want unknown command", command, err)
		}
	}
}

func TestServeRefusesWithoutTheSecret(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"listen_http":"127.0.0.1:1"}`), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	err := run([]string{"serve", "--config", path})
	if err == nil || !strings.Contains(err.Error(), "config init") {
		t.Fatalf("serve without auth_token = %v, want a refusal", err)
	}
}

func TestServeRefusesTheRemovedFlags(t *testing.T) {
	for _, flag := range []string{"--experimental-modify-bootstrap-models", "--no-proxy-listener", "--no-tls-listener", "--no-http-listener"} {
		if err := run([]string{"serve", flag, "--config", filepath.Join(t.TempDir(), "absent.json")}); err == nil {
			t.Fatalf("serve %s succeeded, want a flag error", flag)
		}
	}
}

func captureStdout(t *testing.T, fn func() error) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	saved := os.Stdout
	os.Stdout = w
	runErr := fn()
	os.Stdout = saved
	_ = w.Close()
	out, _ := io.ReadAll(r)
	if runErr != nil {
		t.Fatalf("run: %v", runErr)
	}
	return string(out)
}

func TestVersionPrintsTheStampedVersion(t *testing.T) {
	saved := version
	version = "1.2.3-test"
	t.Cleanup(func() { version = saved })

	out := captureStdout(t, func() error { return run([]string{"version"}) })
	if !strings.HasPrefix(out, "ccmproxy 1.2.3-test\n") {
		t.Fatalf("version output = %q", out)
	}
}

func TestConfigInitThenEnv(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ccm", "config.json")
	out := captureStdout(t, func() error { return run([]string{"config", "init", "--config", path}) })
	if !strings.Contains(out, "Wrote "+path) {
		t.Fatalf("init output = %q", out)
	}
	cfg, err := config.Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.AuthToken == "" || cfg.SessionSalt == "" {
		t.Fatal("init did not generate the secrets")
	}

	env := captureStdout(t, func() error { return run([]string{"env", "--shell", "json", "--config", path}) })
	var object map[string]string
	if err := json.Unmarshal([]byte(env), &object); err != nil {
		t.Fatalf("env output %q: %v", env, err)
	}
	if object["ANTHROPIC_BASE_URL"] != "http://"+cfg.ListenHTTP {
		t.Fatalf("env = %v", object)
	}

	again := captureStdout(t, func() error { return run([]string{"config", "init", "--config", path}) })
	if !strings.Contains(again, "up to date") {
		t.Fatalf("second init output = %q", again)
	}
}
