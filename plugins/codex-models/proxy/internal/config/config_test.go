package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// validToken is a secret long enough to pass validateSecret.
const validToken = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func writeConfig(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	return path
}

func TestDefaultsAreUsable(t *testing.T) {
	cfg := Default()
	if cfg.Upstream != DefaultUpstream {
		t.Fatalf("upstream = %q", cfg.Upstream)
	}
	if cfg.ListenHTTP != DefaultListenHTTP {
		t.Fatalf("listen_http = %q", cfg.ListenHTTP)
	}
	if cfg.AuthToken != "" || cfg.SessionSalt != "" {
		t.Fatal("the defaults must not carry secrets; only `config init` generates them")
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("Validate(Default()) = %v", err)
	}
}

func TestLoadMissingFileReturnsDefaults(t *testing.T) {
	cfg, err := Load(filepath.Join(t.TempDir(), "absent.json"))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Upstream != DefaultUpstream || cfg.ListenHTTP != DefaultListenHTTP {
		t.Fatalf("upstream = %q, listen_http = %q, want the defaults", cfg.Upstream, cfg.ListenHTTP)
	}
}

func TestLoadFillsUnsetFields(t *testing.T) {
	path := writeConfig(t, `{"codex":{"model_prefix":"codex"}}`)

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	// A file without listen_http still has a listener.
	if cfg.ListenHTTP != DefaultListenHTTP {
		t.Fatalf("listen_http = %q, want the default when the key is absent", cfg.ListenHTTP)
	}
	if cfg.Upstream != DefaultUpstream {
		t.Fatalf("upstream = %q, want the default filled in", cfg.Upstream)
	}
	if cfg.Codex.BaseURL == "" || cfg.Codex.UserAgent == "" || cfg.Codex.Originator == "" {
		t.Fatalf("codex defaults were not filled in: %+v", cfg.Codex)
	}
	if cfg.Codex.ModelPrefix != "codex/" {
		t.Fatalf("model_prefix = %q, want the separator normalized", cfg.Codex.ModelPrefix)
	}
	if cfg.Codex.CallbackPort != 1455 {
		t.Fatalf("callback_port = %d", cfg.Codex.CallbackPort)
	}
}

func TestLoadRejectsBrokenFile(t *testing.T) {
	for _, body := range []string{`{oops`, `null`, `[]`} {
		if _, err := Load(writeConfig(t, body)); err == nil {
			t.Fatalf("Load(%s) succeeded, want a parse error", body)
		}
	}
}

func TestListenHTTPMustBeALiteralLoopbackAddress(t *testing.T) {
	cases := []struct {
		addr string
		ok   bool
	}{
		{"127.0.0.1:8081", true},
		{"127.1.2.3:49152", true},
		{"127.255.255.254:1", true},
		{"[::1]:8081", true},
		{"127.0.0.1:65535", true},

		{":8081", false},
		{"0.0.0.0:8081", false},
		{"[::]:8081", false},
		{"localhost:8081", false},
		{"proxy.example.com:8081", false},
		{"192.168.1.10:8081", false},
		{"10.0.0.1:8081", false},
		{"[::ffff:127.0.0.1]:8081", false},
		{"[fe80::1%lo0]:8081", false},
		{"[::2]:8081", false},
		{"127.0.0.1", false},
		{"127.0.0.1:", false},
		{"127.0.0.1:0", false},
		{"127.0.0.1:65536", false},
		{"127.0.0.1:http", false},
		{"127.0.0.1:+80", false},
		{"[::1]", false},
	}
	for _, tc := range cases {
		err := ValidateListenAddr(tc.addr)
		if tc.ok && err != nil {
			t.Errorf("ValidateListenAddr(%q) = %v, want accepted", tc.addr, err)
		}
		if !tc.ok && err == nil {
			t.Errorf("ValidateListenAddr(%q) accepted, want refused", tc.addr)
		}
	}
}

func TestLoadRefusesANonLoopbackListener(t *testing.T) {
	for _, addr := range []string{":8081", "0.0.0.0:8081", "[::]:8081", "localhost:8081"} {
		body, _ := json.Marshal(map[string]string{"listen_http": addr})
		_, err := Load(writeConfig(t, string(body)))
		if err == nil || !strings.Contains(err.Error(), "listen_http") {
			t.Fatalf("Load with listen_http %q = %v, want a listen_http error", addr, err)
		}
	}
}

func TestAnEmptyListenHTTPUsesTheDefault(t *testing.T) {
	cfg, err := Load(writeConfig(t, `{"listen_http":"  "}`))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.ListenHTTP != DefaultListenHTTP {
		t.Fatalf("listen_http = %q", cfg.ListenHTTP)
	}
}

func TestRemovedKeysAreRefusedByName(t *testing.T) {
	for key := range removedKeys {
		path := writeConfig(t, `{"`+key+`": null}`)
		_, err := Load(path)
		if err == nil {
			t.Fatalf("a file setting %q loaded, want a refusal", key)
		}
		if !strings.Contains(err.Error(), key) {
			t.Fatalf("error for %q does not name it: %v", key, err)
		}
	}
}

func TestRemovedKeysAreAllNamedTogether(t *testing.T) {
	path := writeConfig(t, `{"listen_tls":"127.0.0.1:8443","dns":{"enabled":true},"proxy_password":"x"}`)
	_, err := Load(path)
	if err == nil {
		t.Fatal("want a refusal")
	}
	for _, key := range []string{"listen_tls", "dns", "proxy_password"} {
		if !strings.Contains(err.Error(), key) {
			t.Fatalf("error does not name %q: %v", key, err)
		}
	}
	if strings.Contains(err.Error(), `"x"`) {
		t.Fatalf("error repeats a removed value: %v", err)
	}
}

func TestUpstreamIsPinned(t *testing.T) {
	for _, upstream := range []string{"https://api.anthropic.com", "https://api.anthropic.com/", " https://api.anthropic.com "} {
		body, _ := json.Marshal(map[string]string{"upstream": upstream})
		cfg, err := Load(writeConfig(t, string(body)))
		if err != nil {
			t.Fatalf("Load with upstream %q: %v", upstream, err)
		}
		if cfg.Upstream != DefaultUpstream {
			t.Fatalf("upstream = %q", cfg.Upstream)
		}
	}
	for _, upstream := range []string{
		"http://api.anthropic.com",
		"https://api.anthropic.com.evil.test",
		"https://evil.test",
		"https://api.anthropic.com:8443",
		"https://api.anthropic.com/v2",
		"https://user:pw@api.anthropic.com",
		"http://127.0.0.1:9000",
	} {
		body, _ := json.Marshal(map[string]string{"upstream": upstream})
		if _, err := Load(writeConfig(t, string(body))); err == nil || !strings.Contains(err.Error(), "upstream") {
			t.Fatalf("Load with upstream %q = %v, want an upstream refusal", upstream, err)
		}
	}
}

func TestCodexBaseURLMustBeHTTPS(t *testing.T) {
	ok := []string{"https://chatgpt.com/backend-api/codex", "https://example.test"}
	bad := []string{"http://chatgpt.com/backend-api/codex", "chatgpt.com/backend-api/codex", "https://", "https://u:p@chatgpt.com", "ftp://chatgpt.com"}
	for _, base := range ok {
		body, _ := json.Marshal(map[string]any{"codex": map[string]string{"base_url": base}})
		if _, err := Load(writeConfig(t, string(body))); err != nil {
			t.Fatalf("Load with codex.base_url %q: %v", base, err)
		}
	}
	for _, base := range bad {
		body, _ := json.Marshal(map[string]any{"codex": map[string]string{"base_url": base}})
		if _, err := Load(writeConfig(t, string(body))); err == nil || !strings.Contains(err.Error(), "codex.base_url") {
			t.Fatalf("Load with codex.base_url %q = %v, want a refusal", base, err)
		}
	}
}

func TestSecretsAreValidatedWithoutBeingEchoed(t *testing.T) {
	for _, key := range []string{"auth_token", "session_salt"} {
		for _, value := range []string{"short-secret-value", strings.Repeat("a", 31), strings.Repeat("a", 40) + " " + strings.Repeat("b", 10), strings.Repeat("é", 20)} {
			body, _ := json.Marshal(map[string]string{key: value})
			_, err := Load(writeConfig(t, string(body)))
			if err == nil {
				t.Fatalf("%s %q loaded, want a refusal", key, value)
			}
			if !strings.Contains(err.Error(), key) {
				t.Fatalf("error does not name %s: %v", key, err)
			}
			if strings.Contains(err.Error(), value) {
				t.Fatalf("error repeats the %s value: %v", key, err)
			}
		}
		body, _ := json.Marshal(map[string]string{key: validToken})
		if _, err := Load(writeConfig(t, string(body))); err != nil {
			t.Fatalf("a valid %s was refused: %v", key, err)
		}
	}
}

func TestLoadRefusesAFileOthersCanRead(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("file modes are POSIX")
	}
	for _, mode := range []os.FileMode{0o644, 0o640, 0o604, 0o620} {
		path := writeConfig(t, `{}`)
		if err := os.Chmod(path, mode); err != nil {
			t.Fatalf("chmod: %v", err)
		}
		_, err := Load(path)
		if err == nil || !strings.Contains(err.Error(), "chmod 600") {
			t.Fatalf("Load of a %03o file = %v, want a refusal that says how to fix it", mode, err)
		}
	}
	path := writeConfig(t, `{}`)
	if err := os.Chmod(path, 0o400); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	if _, err := Load(path); err != nil {
		t.Fatalf("a 0400 file was refused: %v", err)
	}
}

func TestCodexAuthDefaults(t *testing.T) {
	cfg := Default()
	if cfg.Codex.UseCLIAuth {
		t.Fatal("codex.use_codex_cli_auth must default to false: the proxy keeps its own login")
	}
	if cfg.Codex.AuthFile != "" {
		t.Fatalf("codex.auth_file = %q, want empty so discovery applies", cfg.Codex.AuthFile)
	}
	cfg, err := Load(writeConfig(t, `{"codex":{"use_codex_cli_auth":true}}`))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !cfg.Codex.UseCLIAuth {
		t.Fatal("an explicit true must be honoured")
	}
}

func TestSaveRoundTripAndMode(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "config.json")
	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	cfg.ListenHTTP = "127.0.0.1:50123"
	cfg.AuthToken = validToken
	if err := cfg.Save(); err != nil {
		t.Fatalf("Save: %v", err)
	}
	assertMode(t, path, 0o600)
	assertMode(t, filepath.Dir(path), 0o700)

	reloaded, err := Load(path)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if reloaded.ListenHTTP != "127.0.0.1:50123" || reloaded.AuthToken != validToken {
		t.Fatalf("did not round-trip: %q %q", reloaded.ListenHTTP, reloaded.AuthToken)
	}
}

func TestSaveTightensAnOpenFile(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("file modes are POSIX")
	}
	path := writeConfig(t, `{}`)
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	cfg := Default()
	cfg.path = path
	if err := cfg.Save(); err != nil {
		t.Fatalf("Save: %v", err)
	}
	assertMode(t, path, 0o600)
}

func assertMode(t *testing.T, path string, want os.FileMode) {
	t.Helper()
	if runtime.GOOS == "windows" {
		return
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if got := info.Mode().Perm(); got != want {
		t.Fatalf("%s mode = %03o, want %03o", path, got, want)
	}
}

// fakeSecrets returns distinct valid secrets in order.
func fakeSecrets() func() (string, error) {
	n := 0
	return func() (string, error) {
		n++
		return strings.Repeat(string(rune('a'+n)), 64), nil
	}
}

func fixedAddr(addr string) func() (string, error) {
	return func() (string, error) { return addr, nil }
}

func TestInitCreatesAFileWithSecretsAndARandomPort(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dir", "config.json")
	result, err := initWith(path, fakeSecrets(), fixedAddr("127.0.0.1:53111"))
	if err != nil {
		t.Fatalf("Init: %v", err)
	}
	if !result.Created || len(result.Added) != 0 {
		t.Fatalf("result = %+v", result)
	}
	assertMode(t, path, 0o600)
	assertMode(t, filepath.Dir(path), 0o700)

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.ListenHTTP != "127.0.0.1:53111" {
		t.Fatalf("listen_http = %q", cfg.ListenHTTP)
	}
	if cfg.AuthToken == "" || cfg.SessionSalt == "" || cfg.AuthToken == cfg.SessionSalt {
		t.Fatalf("auth_token %q / session_salt %q, want two distinct generated secrets", cfg.AuthToken, cfg.SessionSalt)
	}
	if cfg.Codex.UseCLIAuth {
		t.Fatal("a new file must not opt into the Codex CLI login")
	}
}

func TestInitUpgradesAnExistingFileInPlace(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("file modes are POSIX")
	}
	path := writeConfig(t, `{
  "listen_http": "127.0.0.1:9100",
  "log_level": "debug",
  "codex": {"model_prefix": "codex", "use_codex_cli_auth": true},
  "future_key": {"kept": [1, 2]},
  "session_salt": ""
}`)
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatalf("chmod: %v", err)
	}

	result, err := initWith(path, fakeSecrets(), fixedAddr("127.0.0.1:1"))
	if err != nil {
		t.Fatalf("Init: %v", err)
	}
	if result.Created {
		t.Fatal("an existing file must be upgraded, not recreated")
	}
	if strings.Join(result.Added, ",") != "auth_token,session_salt" {
		t.Fatalf("added = %v", result.Added)
	}
	if !result.Tightened {
		t.Fatal("a 0644 file must be reported as tightened")
	}
	assertMode(t, path, 0o600)

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("parse: %v", err)
	}
	// The person's values and an unknown key survive; nothing is defaulted
	// into the file except the generated secrets.
	if raw["listen_http"] != "127.0.0.1:9100" || raw["log_level"] != "debug" {
		t.Fatalf("values changed: %v", raw)
	}
	if _, ok := raw["future_key"]; !ok {
		t.Fatal("an unknown key was dropped")
	}
	if _, ok := raw["upstream"]; ok {
		t.Fatal("an absent default was written into the file")
	}
	codexSection, _ := raw["codex"].(map[string]any)
	if codexSection["model_prefix"] != "codex" || codexSection["use_codex_cli_auth"] != true {
		t.Fatalf("codex section changed: %v", codexSection)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load after upgrade: %v", err)
	}
	if cfg.AuthToken == "" || cfg.SessionSalt == "" {
		t.Fatal("the generated secrets were not added")
	}

	// A second run finds nothing to do and keeps the secrets.
	again, err := initWith(path, fakeSecrets(), fixedAddr("127.0.0.1:1"))
	if err != nil {
		t.Fatalf("second Init: %v", err)
	}
	if len(again.Added) != 0 || again.Tightened || again.Created {
		t.Fatalf("second run = %+v, want nothing to do", again)
	}
	reloaded, _ := Load(path)
	if reloaded.AuthToken != cfg.AuthToken || reloaded.SessionSalt != cfg.SessionSalt {
		t.Fatal("a second init rotated the secrets")
	}
}

func TestInitTightensAFileThatNeedsNoKeys(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("file modes are POSIX")
	}
	body, _ := json.Marshal(map[string]string{"auth_token": validToken, "session_salt": validToken})
	path := writeConfig(t, string(body))
	if err := os.Chmod(path, 0o640); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	result, err := initWith(path, fakeSecrets(), fixedAddr("127.0.0.1:1"))
	if err != nil {
		t.Fatalf("Init: %v", err)
	}
	if len(result.Added) != 0 || !result.Tightened {
		t.Fatalf("result = %+v", result)
	}
	assertMode(t, path, 0o600)
}

func TestInitRefusesAFileItWouldHaveToRewrite(t *testing.T) {
	for _, body := range []string{
		`{"listen_proxy":"127.0.0.1:8080"}`,
		`{"listen_http":"0.0.0.0:8081"}`,
		`{"upstream":"https://evil.test"}`,
		`{oops`,
	} {
		path := writeConfig(t, body)
		if _, err := initWith(path, fakeSecrets(), fixedAddr("127.0.0.1:1")); err == nil {
			t.Fatalf("Init over %s succeeded, want a refusal", body)
		}
		data, _ := os.ReadFile(path)
		if string(data) != body {
			t.Fatalf("a refused file was changed: %s", data)
		}
	}
}

func TestNewSecretIsRandomHex(t *testing.T) {
	a, err := NewSecret()
	if err != nil {
		t.Fatalf("NewSecret: %v", err)
	}
	b, _ := NewSecret()
	if len(a) != 64 || strings.Trim(a, "0123456789abcdef") != "" {
		t.Fatalf("NewSecret() = %q, want 64 hex characters", a)
	}
	if a == b {
		t.Fatal("two secrets were equal")
	}
	if err := validateSecret(a); err != nil {
		t.Fatalf("a generated secret fails validation: %v", err)
	}
}

func TestFreeLoopbackAddrIsAcceptedAsAListener(t *testing.T) {
	addr, err := FreeLoopbackAddr()
	if err != nil {
		t.Fatalf("FreeLoopbackAddr: %v", err)
	}
	if !strings.HasPrefix(addr, "127.0.0.1:") {
		t.Fatalf("addr = %q", addr)
	}
	if err := ValidateListenAddr(addr); err != nil {
		t.Fatalf("ValidateListenAddr(%q) = %v", addr, err)
	}
}

func TestRootHonoursEnvironment(t *testing.T) {
	t.Setenv("CCMPROXY_HOME", "/tmp/ccmproxy-test")
	if got := Root(); got != "/tmp/ccmproxy-test" {
		t.Fatalf("Root() = %q", got)
	}

	t.Setenv("CCMPROXY_HOME", "")
	t.Setenv("XDG_CONFIG_HOME", "/tmp/xdg")
	if got := Root(); got != filepath.Join("/tmp/xdg", "ccmproxy") {
		t.Fatalf("Root() = %q", got)
	}
}

func TestExpandUser(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skipf("no home directory: %v", err)
	}

	cases := map[string]string{
		"~":                      home,
		"~/":                     home,
		"~/.config/ccmproxy/x":   filepath.Join(home, ".config", "ccmproxy", "x"),
		"  ~/.codex/auth.json  ": filepath.Join(home, ".codex", "auth.json"),
		"/absolute/path":         "/absolute/path",
		"relative/path":          "relative/path",
		"":                       "",
		// Another user's home needs the password database; left alone.
		"~someone/else": "~someone/else",
		// A tilde anywhere but the front is an ordinary character.
		"/tmp/~backup": "/tmp/~backup",
	}
	for input, want := range cases {
		if got := ExpandUser(input); got != want {
			t.Fatalf("ExpandUser(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestTildePathsInConfigAreExpanded(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skipf("no home directory: %v", err)
	}

	path := writeConfig(t, `{
        "auth_dir": "~/.config/ccmproxy/auth",
        "codex": { "auth_file": "~/.config/ccmproxy/other.json" }
    }`)
	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	// A literal "~" would be created as a directory next to the working
	// directory, which is the bug this guards against.
	for name, got := range map[string]string{
		"auth_dir":  cfg.AuthDir,
		"auth_file": cfg.Codex.AuthFile,
	} {
		if strings.Contains(got, "~") || !filepath.IsAbs(got) || !strings.HasPrefix(got, home) {
			t.Fatalf("%s = %q, want an absolute path under %q", name, got, home)
		}
	}
}

func TestTildeInTheConfigPathIsExpanded(t *testing.T) {
	// A quoted --config value reaches the program unexpanded.
	cfg, err := Load("~/definitely-not-a-real-ccmproxy-config.json")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if strings.Contains(cfg.Path(), "~") {
		t.Fatalf("Path() = %q, want the tilde expanded", cfg.Path())
	}
}

func TestRootExpandsTildeInEnvironment(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skipf("no home directory: %v", err)
	}

	t.Setenv("CCMPROXY_HOME", "~/ccmproxy-env-test")
	if got := Root(); got != filepath.Join(home, "ccmproxy-env-test") {
		t.Fatalf("Root() = %q", got)
	}

	t.Setenv("CCMPROXY_HOME", "")
	t.Setenv("XDG_CONFIG_HOME", "~/xdg-env-test")
	if got := Root(); got != filepath.Join(home, "xdg-env-test", "ccmproxy") {
		t.Fatalf("Root() = %q", got)
	}
}

func TestDefaultsAreAlreadyAbsolute(t *testing.T) {
	cfg, err := Load(filepath.Join(t.TempDir(), "absent.json"))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !filepath.IsAbs(cfg.AuthDir) {
		t.Fatalf("auth_dir = %q, want an absolute path even with no config file", cfg.AuthDir)
	}
}

func TestEffortVariantsAreOffByDefault(t *testing.T) {
	// Claude Code picks effort itself and sends it with the request, so a
	// row per effort would only multiply the picker entries.
	if Default().Codex.EffortVariants {
		t.Fatal("codex.effort_variants must default to false")
	}
}

func TestEffortVariantsCanBeEnabled(t *testing.T) {
	cfg, err := Load(writeConfig(t, `{"codex":{"effort_variants":true}}`))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !cfg.Codex.EffortVariants {
		t.Fatal("an explicit true must be honoured")
	}
}

func TestURLRefusalsDoNotEchoUserinfo(t *testing.T) {
	const pw = "S3cretPassw0rdValue"
	for _, body := range []string{
		`{"upstream":"https://user:` + pw + `@api.anthropic.com"}`,
		`{"upstream":"https://` + pw + `@api.anthropic.com"}`,
		`{"upstream":"http://user:` + pw + `@evil.test/x?token=` + pw + `"}`,
		`{"upstream":"https://api.anthropic.com/?key=` + pw + `"}`,
		`{"upstream":"https://api.anthropic.com/#` + pw + `"}`,
		`{"upstream":"https://user:` + pw + `@[::1"}`,
		`{"upstream":"://user:` + pw + `@x"}`,
		`{"codex":{"base_url":"https://user:` + pw + `@chatgpt.com"}}`,
		`{"codex":{"base_url":"http://user:` + pw + `@chatgpt.com"}}`,
		`{"codex":{"base_url":"https://user:` + pw + `@[::1"}}`,
		`{"codex":{"base_url":"http://chatgpt.com/?key=` + pw + `"}}`,
	} {
		_, err := Load(writeConfig(t, body))
		if err == nil {
			t.Fatalf("%s accepted", body)
		}
		if strings.Contains(err.Error(), pw) {
			t.Errorf("refusal echoes the URL secret: %v", err)
		}
		if !strings.Contains(err.Error(), "upstream") && !strings.Contains(err.Error(), "codex.base_url") {
			t.Errorf("refusal does not name the key: %v", err)
		}
	}
}

func TestSafeURL(t *testing.T) {
	cases := map[string]string{
		"https://api.anthropic.com":  `"https://api.anthropic.com"`,
		"https://u:p@host.test/path": `"https://host.test/path" (credentials removed)`,
		"https://host.test/?k=v":     `"https://host.test/" (query removed)`,
		"https://u:p@[::1":           "(not a valid URL)",
		"http://evil.test:8080/v1":   `"http://evil.test:8080/v1"`,
	}
	for raw, want := range cases {
		if got := safeURL(raw); got != want {
			t.Errorf("safeURL(%q) = %s, want %s", raw, got, want)
		}
	}
}
