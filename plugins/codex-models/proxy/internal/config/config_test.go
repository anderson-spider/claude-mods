package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
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
	if cfg.Codex.Remote != "" || cfg.Codex.ManagementKey != "" {
		t.Fatalf("codex defaults were not filled in: %+v", cfg.Codex)
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

func TestCodexRemoteMustBeHTTPS(t *testing.T) {
	ok := []string{"https://chatgpt.com/backend-api/codex", "https://example.test"}
	bad := []string{"http://chatgpt.com/backend-api/codex", "chatgpt.com/backend-api/codex", "https://", "https://u:p@chatgpt.com", "ftp://chatgpt.com"}
	for _, base := range ok {
		body, _ := json.Marshal(map[string]any{"codex": map[string]string{"remote": base}})
		if _, err := Load(writeConfig(t, string(body))); err != nil {
			t.Fatalf("Load with codex.remote %q: %v", base, err)
		}
	}
	for _, base := range bad {
		body, _ := json.Marshal(map[string]any{"codex": map[string]string{"remote": base}})
		if _, err := Load(writeConfig(t, string(body))); err == nil || !strings.Contains(err.Error(), "codex.remote") {
			t.Fatalf("Load with codex.remote %q = %v, want a refusal", base, err)
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

func TestInitPreservesSecretsIgnoringKeyCase(t *testing.T) {
	for _, tc := range []struct {
		name, authKey, saltKey string
		mode                   os.FileMode
	}{
		{"uppercase", "AUTH_TOKEN", "SESSION_SALT", 0o600},
		{"mixed case", "Auth_Token", "Session_Salt", 0o600},
		{"uppercase exposed", "AUTH_TOKEN", "SESSION_SALT", 0o640},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := `{"` + tc.authKey + `":"` + validToken + `","` + tc.saltKey + `":"` + strings.Repeat("c", 64) + `"}`
			path := writeConfig(t, body)
			before, _, err := load(path, false)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(path, tc.mode); err != nil {
				t.Fatal(err)
			}
			calls := 0
			newSecret := func() (string, error) {
				calls++
				return strings.Repeat("d", 64), nil
			}
			for run := 0; run < 2; run++ {
				result, err := initWith(path, newSecret, fixedAddr("127.0.0.1:1"))
				if err != nil {
					t.Fatal(err)
				}
				if calls != 0 || len(result.Added) != 0 || result.Created {
					t.Fatalf("run %d: generated %d secrets, result = %+v", run, calls, result)
				}
				if result.Tightened != (run == 0 && tc.mode != 0o600) {
					t.Fatalf("run %d: tightened = %v", run, result.Tightened)
				}
				assertMode(t, path, 0o600)
				after, err := Load(path)
				if err != nil {
					t.Fatal(err)
				}
				if after.AuthToken != before.AuthToken || after.SessionSalt != before.SessionSalt {
					t.Fatal("init changed an effective existing secret")
				}
				data, err := os.ReadFile(path)
				if err != nil || string(data) != body {
					t.Fatalf("init rewrote existing members or added aliases: %v", err)
				}
			}
		})
	}
}

func TestInitAppendsMissingSecretsPreservingOriginalBytes(t *testing.T) {
	for _, tc := range []struct {
		name, body, added string
		empty             bool
	}{
		{"empty", `{}`, "auth_token,session_salt", true},
		{"empty with whitespace", " \t\r\n{\t \r\n}\r\n\t", "auth_token,session_salt", true},
		{"null auth", `{"AUTH_TOKEN":null,"SESSION_SALT":"` + validToken + `"}`, "auth_token", false},
		{"blank salt", `{"AUTH_TOKEN":"` + validToken + `","Session_Salt":"   "}`, "session_salt", false},
		{"absent salt with uppercase token", `{"AUTH_TOKEN":"` + validToken + `"}`, "session_salt", false},
		{"both blank", `{"auth_token":"","SESSION_SALT":null}`, "auth_token,session_salt", false},
		{"duplicate null retains token", `{"auth_token":"` + validToken + `","auth_token":null}`, "session_salt", false},
		{"escaped key", `{"auth_token":"` + validToken + `"}`, "session_salt", false},
		{"formatting and duplicate unknown members", " \r\n{\n\t\"AUTH_TOKEN\" : \"" + validToken + "\",\n\t\"unknown\": 2.5000, \"unknown\": [1e+02, {\"marker\":\"}\"}]\n  }\r\n\t", "session_salt", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := writeConfig(t, tc.body)
			before, err := Load(path)
			if err != nil {
				t.Fatal(err)
			}
			result, err := initWith(path, fakeSecrets(), fixedAddr("127.0.0.1:1"))
			if err != nil {
				t.Fatal(err)
			}
			if strings.Join(result.Added, ",") != tc.added {
				t.Fatalf("added = %v", result.Added)
			}
			cfg, err := Load(path)
			if err != nil || cfg.AuthToken == "" || cfg.SessionSalt == "" {
				t.Fatalf("Load after init: %v", err)
			}
			if (before.AuthToken != "" && cfg.AuthToken != before.AuthToken) ||
				(before.SessionSalt != "" && cfg.SessionSalt != before.SessionSalt) {
				t.Fatal("init changed an effective existing secret")
			}
			var members []string
			values := map[string]string{"auth_token": cfg.AuthToken, "session_salt": cfg.SessionSalt}
			for _, key := range result.Added {
				members = append(members, `"`+key+`": "`+values[key]+`"`)
			}
			insertion := "\n  " + strings.Join(members, ",\n  ")
			if !tc.empty {
				insertion = "," + insertion
			}
			data, err := os.ReadFile(path)
			if err != nil || !strings.Contains(string(data), insertion) ||
				strings.Replace(string(data), insertion, "", 1) != tc.body {
				t.Fatalf("init changed existing bytes instead of inserting missing members: %v", err)
			}
			assertMode(t, path, 0o600)
			again, err := initWith(path, fakeSecrets(), fixedAddr("127.0.0.1:1"))
			if err != nil || len(again.Added) != 0 {
				t.Fatalf("second init: %+v, %v", again, err)
			}
			after, err := os.ReadFile(path)
			if err != nil || string(after) != string(data) {
				t.Fatalf("second init was not idempotent: %v", err)
			}
		})
	}
}

func TestInitKeepsEffectiveValuesInOriginalAliasOrder(t *testing.T) {
	body := `{"auth_token":"` + validToken + `","AUTH_TOKEN":"` + strings.Repeat("c", 64) + `","log_level":"warn","LOG_LEVEL":"debug"}`
	path := writeConfig(t, body)
	before, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	result, err := initWith(path, fakeSecrets(), fixedAddr("127.0.0.1:1"))
	if err != nil || strings.Join(result.Added, ",") != "session_salt" {
		t.Fatalf("init: %+v, %v", result, err)
	}
	after, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if after.AuthToken != before.AuthToken || after.LogLevel != before.LogLevel {
		t.Fatal("init changed effective values by reordering aliases")
	}
	if after.SessionSalt == "" {
		t.Fatal("init did not add the missing salt")
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
		`{"codex":{"remote":"https://user:` + pw + `@chatgpt.com"}}`,
		`{"codex":{"remote":"http://user:` + pw + `@chatgpt.com"}}`,
		`{"codex":{"remote":"https://user:` + pw + `@[::1"}}`,
		`{"codex":{"remote":"http://chatgpt.com/?key=` + pw + `"}}`,
	} {
		_, err := Load(writeConfig(t, body))
		if err == nil {
			t.Fatalf("%s accepted", body)
		}
		if strings.Contains(err.Error(), pw) {
			t.Errorf("refusal echoes the URL secret: %v", err)
		}
		if !strings.Contains(err.Error(), "upstream") && !strings.Contains(err.Error(), "codex.remote") {
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

const echoSecret = "S3cretPassw0rdValue"

func TestURLRefusalsNeverEchoSecrets(t *testing.T) {
	shapes := []string{
		"https://user:" + echoSecret + "@api.anthropic.com",
		"https://user:p%40" + echoSecret + "@api.anthropic.com",
		"https://" + echoSecret + "@api.anthropic.com",
		"https://user:" + echoSecret + "@[::1]:443/x",
		"https://user:" + echoSecret + "@[2001:db8::1]/v1",
		"http://user:" + echoSecret + "@api.anthropic.com",
		"//user:" + echoSecret + "@api.anthropic.com",
		"https://api.anthropic.com/?key=" + echoSecret,
		"https://api.anthropic.com/#" + echoSecret,
		"https://user:" + echoSecret + "@api.anthropic.com:badport",
		"https://user:" + echoSecret + "@api.anthropic.com:99999999999",
		"https://[::1" + echoSecret,
		"https://us er:" + echoSecret + "@host",
		"https://user:" + echoSecret + "\x7f@host",
		"https://user:" + echoSecret + "\n@host",
		"%zz" + echoSecret,
		":" + echoSecret,
		"user:" + echoSecret + "@api.anthropic.com",
		echoSecret + "@api.anthropic.com",
		"ftp://user:" + echoSecret + "@host",
	}
	for _, shape := range shapes {
		for _, field := range []string{"upstream", "codex.remote"} {
			var body []byte
			if field == "upstream" {
				body, _ = json.Marshal(map[string]any{"upstream": shape})
			} else {
				body, _ = json.Marshal(map[string]any{"codex": map[string]any{"remote": shape}})
			}
			_, err := Load(writeConfig(t, string(body)))
			if err == nil {
				t.Errorf("%s %q accepted", field, shape)
				continue
			}
			if strings.Contains(err.Error(), echoSecret) {
				t.Errorf("%s %q: refusal echoes the secret: %v", field, shape, err)
			}
		}
	}
}

func TestParseErrorsNeverEchoInput(t *testing.T) {
	for _, body := range []string{
		`{"auth_token": 12345, "x": "` + echoSecret + `"}`,
		`{"codex": {"remote": 12345}, "x":"` + echoSecret + `"}`,
		`{"codex": "` + echoSecret + `"}`,
		`{"auth_token": "` + echoSecret + `"`,
		`{"auth_token": "` + echoSecret + `" "x"}`,
		`["` + echoSecret + `"]`,
		`"` + echoSecret + `"`,
		`{"auth_token": "` + echoSecret + "\x01" + `"}`,
	} {
		_, err := Load(writeConfig(t, body))
		if err == nil {
			t.Errorf("%s loaded", body)
			continue
		}
		if strings.Contains(err.Error(), echoSecret) {
			t.Errorf("%q: error echoes input: %v", body, err)
		}
	}
}

func TestSafeURLKeepsHostShowsRemoval(t *testing.T) {
	got := safeURL("https://user:pw@[::1]:443/x?k=v#f")
	if got != `"https://[::1]:443/x" (credentials removed) (query removed)` {
		t.Fatalf("safeURL = %s", got)
	}
}

func TestListenTable(t *testing.T) {
	cases := []struct {
		addr string
		ok   bool
	}{
		{"127.0.0.1:1", true},
		{"127.255.255.254:65535", true},
		{"[::1]:9", true},
		{" 127.0.0.1:1 ", true},

		{":8081", false},
		{"0.0.0.0:1", false},
		{"[::]:1", false},
		{"localhost:1", false},
		{"::ffff:127.0.0.1", false},
		{"[::ffff:127.0.0.1]:1", false},
		{"127.0.0.1:0", false},
		{"[::1]:0", false},
		{"127.0.0.1", false},
		{"127.0.0.1:", false},
		{"127.0.0.1:99999", false},
		{"fe80::1%lo0", false},
		{"[fe80::1%lo0]:1", false},
		{"[::1%lo0]:1", false},
		{"127.1:1", false},
		{"0127.0.0.1:1", false},
		{"127.0.0.1:-1", false},
		{"127.0.0.1: 80", false},
		{"", false},
	}
	for _, tc := range cases {
		err := ValidateListenAddr(tc.addr)
		if tc.ok != (err == nil) {
			t.Errorf("ValidateListenAddr(%q) = %v, want ok=%v", tc.addr, err, tc.ok)
		}
	}
}

func TestMissingListenHTTPDefaults(t *testing.T) {
	cfg, err := Load(writeConfig(t, `{"log_level":"debug"}`))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.ListenHTTP != "127.0.0.1:8081" {
		t.Fatalf("listen_http = %q, want 127.0.0.1:8081", cfg.ListenHTTP)
	}
	cfg, err = Load(filepath.Join(t.TempDir(), "absent.json"))
	if err != nil || cfg.ListenHTTP != "127.0.0.1:8081" {
		t.Fatalf("no file: %v %v", cfg, err)
	}
}

func TestUpstreamPinned(t *testing.T) {
	bad := []string{
		"http://api.anthropic.com",
		"https://api.anthropic.com/v1",
		"https://api.anthropic.com/v1/",
		"https://api.anthropic.com//",
		"https://example.com",
		"https://api.anthropic.com.example.com",
		"HTTPS://API.ANTHROPIC.COM",
		"https://API.anthropic.com",
		"Https://api.anthropic.com",
		"https://user@api.anthropic.com",
		"https://user:pw@api.anthropic.com",
		"https://api.anthropic.com?x=1",
		"https://api.anthropic.com#frag",
		"https://api.anthropic.com:443",
		"//api.anthropic.com",
		"api.anthropic.com",
	}
	for _, up := range bad {
		body, _ := json.Marshal(map[string]string{"upstream": up})
		if _, err := Load(writeConfig(t, string(body))); err == nil || !strings.Contains(err.Error(), "upstream") {
			t.Errorf("upstream %q: err = %v, want refusal", up, err)
		}
	}
	for _, up := range []string{"https://api.anthropic.com", "https://api.anthropic.com/", ""} {
		body, _ := json.Marshal(map[string]string{"upstream": up})
		cfg, err := Load(writeConfig(t, string(body)))
		if err != nil || cfg.Upstream != "https://api.anthropic.com" {
			t.Errorf("upstream %q: cfg=%v err=%v, want accepted as the pin", up, cfg, err)
		}
	}
}

func TestCodexRemote(t *testing.T) {
	bad := []string{"http://chatgpt.com/backend-api/codex", "https:///backend-api", "https://", "chatgpt.com", "ws://chatgpt.com", "https://u@chatgpt.com"}
	for _, b := range bad {
		body, _ := json.Marshal(map[string]any{"codex": map[string]string{"remote": b}})
		if _, err := Load(writeConfig(t, string(body))); err == nil {
			t.Errorf("codex.remote %q accepted", b)
		}
	}
}

func TestPermissions(t *testing.T) {
	for _, mode := range []os.FileMode{0o644, 0o640, 0o604, 0o660, 0o700, 0o666} {
		path := writeConfig(t, `{}`)
		_ = os.Chmod(path, mode)
		_, err := Load(path)
		wantErr := mode&0o077 != 0
		if wantErr != (err != nil) {
			t.Errorf("mode %03o: err = %v, wantErr %v", mode, err, wantErr)
		}
	}
	path := writeConfig(t, `{}`)
	_ = os.Chmod(path, 0o600)
	if _, err := Load(path); err != nil {
		t.Fatalf("0600: %v", err)
	}
	// A 0644 file holding a token: the refusal must not echo it.
	body, _ := json.Marshal(map[string]string{"auth_token": validToken})
	path = writeConfig(t, string(body))
	_ = os.Chmod(path, 0o644)
	_, err := Load(path)
	if err == nil || strings.Contains(err.Error(), validToken) {
		t.Fatalf("0644 with token: %v", err)
	}
}

func TestSaveAtomicAnd0600(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	if err := os.WriteFile(path, []byte(`{}`), 0o644); err != nil {
		t.Fatal(err)
	}
	before, _ := os.Stat(path)
	cfg, _, err := load(path, false)
	if err != nil {
		t.Fatal(err)
	}
	c := cfg
	c.AuthToken = validToken
	if err := c.Save(); err != nil {
		t.Fatalf("Save: %v", err)
	}
	after, _ := os.Stat(path)
	if after.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %03o", after.Mode().Perm())
	}
	if os.SameFile(before, after) {
		t.Fatal("Save rewrote in place; want a new file renamed over (atomic replace)")
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		names := []string{}
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("leftover files after Save: %v", names)
	}
	// A failing rename (target is a directory) leaves no temp file behind.
	dir2 := t.TempDir()
	target := filepath.Join(dir2, "config.json")
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "x"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	c2 := Default()
	c2.path = target
	if err := c2.Save(); err == nil {
		t.Fatal("Save over a directory succeeded")
	}
	entries, _ = os.ReadDir(dir2)
	if len(entries) != 1 {
		t.Fatalf("temp file left after a failed Save: %d entries", len(entries))
	}
}

func isHex64(s string) bool {
	return len(s) == 64 && strings.Trim(s, "0123456789abcdef") == ""
}

func TestInitNewFileReal(t *testing.T) {
	path := filepath.Join(t.TempDir(), "new", "config.json")
	res, err := Init(path)
	if err != nil {
		t.Fatalf("Init: %v", err)
	}
	if !res.Created {
		t.Fatalf("res = %+v", res)
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode %03o", info.Mode().Perm())
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if !isHex64(cfg.AuthToken) || !isHex64(cfg.SessionSalt) || cfg.AuthToken == cfg.SessionSalt {
		t.Fatalf("secrets not two distinct 64-hex values (lens %d/%d)", len(cfg.AuthToken), len(cfg.SessionSalt))
	}
	if err := ValidateListenAddr(cfg.ListenHTTP); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(cfg.ListenHTTP, "127.0.0.1:") || cfg.ListenHTTP == DefaultListenHTTP {
		t.Fatalf("listen_http = %q, want a random 127.0.0.1 port", cfg.ListenHTTP)
	}
	port, _ := strconv.Atoi(strings.TrimPrefix(cfg.ListenHTTP, "127.0.0.1:"))
	if port < 1024 {
		t.Fatalf("port %d is not high", port)
	}
	// Two inits pick different ports and secrets.
	path2 := filepath.Join(t.TempDir(), "config.json")
	if _, err := Init(path2); err != nil {
		t.Fatal(err)
	}
	cfg2, _ := Load(path2)
	if cfg2.AuthToken == cfg.AuthToken || cfg2.SessionSalt == cfg.SessionSalt {
		t.Fatal("two inits produced the same secret")
	}
}

func TestInitExistingKeepsAndAddsOnlyMissing(t *testing.T) {
	original := `{
  "listen_http": "127.0.0.1:9100",
  "auth_token": "` + validToken + `",
  "codex": {"models": ["a","b"], "unknown_nested": 7},
  "zzz_unknown": {"deep": [1, 2.50, "x"]}
}`
	path := writeConfig(t, original)
	_ = os.Chmod(path, 0o644)
	res, err := Init(path)
	if err != nil {
		t.Fatalf("Init: %v", err)
	}
	if strings.Join(res.Added, ",") != "session_salt" || !res.Tightened || res.Created {
		t.Fatalf("res = %+v, want only session_salt added and tightened", res)
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode %03o", info.Mode().Perm())
	}
	data, _ := os.ReadFile(path)
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatal(err)
	}
	if raw["auth_token"] != validToken {
		t.Fatal("existing auth_token was changed")
	}
	if !isHex64(raw["session_salt"].(string)) {
		t.Fatal("session_salt not 64 hex")
	}
	if raw["listen_http"] != "127.0.0.1:9100" {
		t.Fatal("listen_http changed")
	}
	cx := raw["codex"].(map[string]any)
	if cx["unknown_nested"] != float64(7) || len(cx["models"].([]any)) != 2 {
		t.Fatalf("codex section changed: %v", cx)
	}
	z := raw["zzz_unknown"].(map[string]any)["deep"].([]any)
	if len(z) != 3 || z[2] != "x" {
		t.Fatalf("unknown key changed: %v", z)
	}
	// No default keys were written in.
	for _, k := range []string{"upstream", "log_level"} {
		if _, ok := raw[k]; ok {
			t.Errorf("default %q was written into an existing file", k)
		}
	}
}

func TestInitNullSecretIsFilled(t *testing.T) {
	path := writeConfig(t, `{"auth_token":null,"session_salt":"   "}`)
	res, err := Init(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(res.Added, ",") != "auth_token,session_salt" {
		t.Fatalf("added = %v", res.Added)
	}
}
