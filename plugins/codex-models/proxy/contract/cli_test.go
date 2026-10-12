//go:build contract

package contract

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

type cliOut struct{ stdout, stderr string }

func baseEnviron(home string) []string {
	return []string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=" + home,
		"TMPDIR=" + home,
		"CCMPROXY_HOME=" + home,
		"CODEX_HOME=" + filepath.Join(home, "codex-cli"),
	}
}

// runCLI runs the binary and returns its output and exit code.
func runCLI(t *testing.T, home string, environ []string, args ...string) (cliOut, int) {
	t.Helper()
	if environ == nil {
		environ = baseEnviron(home)
	}
	cmd := exec.Command(binPath, args...)
	cmd.Env = environ
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		code := 0
		if ee, ok := err.(*exec.ExitError); ok {
			code = ee.ExitCode()
		} else if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(stderr.String(), "DATA RACE") {
			t.Errorf("ccmproxy %v reported a data race:\n%s", args, stderr.String())
		}
		return cliOut{stdout.String(), stderr.String()}, code
	case <-time.After(20 * time.Second):
		_ = cmd.Process.Kill()
		t.Fatalf("ccmproxy %v did not exit", args)
		return cliOut{}, -1
	}
}

const (
	cliToken = "0123456789abcdef0123456789abcdef-token"
	cliSalt  = "fedcba9876543210fedcba9876543210-salt"
)

// cliHome writes a valid config and returns the home.
func cliHome(t *testing.T, extra map[string]any) string {
	t.Helper()
	home := t.TempDir()
	must(t, os.Chmod(home, 0o700))
	cfg := map[string]any{"listen_http": "127.0.0.1:34567", "auth_token": cliToken, "session_salt": cliSalt}
	for k, v := range extra {
		cfg[k] = v
	}
	writeJSON(t, filepath.Join(home, "config.json"), cfg, 0o600)
	return home
}

func TestCLIVersion(t *testing.T) {
	out, code := runCLI(t, t.TempDir(), nil, "version")
	lines := strings.Split(out.stdout, "\n")
	if code != 0 || lines[0] != "ccmproxy contract" {
		t.Fatalf("exit %d, output %q", code, out.stdout)
	}
	if !strings.HasPrefix(lines[1], "  go ") || !strings.Contains(out.stdout, "  platform ") {
		t.Fatalf("output = %q", out.stdout)
	}
	for _, flag := range []string{"--version", "-version", "-v"} {
		again, code := runCLI(t, t.TempDir(), nil, flag)
		if code != 0 || strings.Split(again.stdout, "\n")[0] != "ccmproxy contract" {
			t.Fatalf("%s: exit %d, %q", flag, code, again.stdout)
		}
	}
}

// `version` prints the commit the binary was built from exactly when the Go
// toolchain stamped one (`vcs.revision` in `go version -m`), and no revision
// line when it did not, as in a build outside a git checkout. The suite's
// binary covers whichever case this checkout gives; a second build with
// -buildvcs=false always covers the unstamped one.
func TestCLIVersionRevisionFollowsTheBuildInfo(t *testing.T) {
	unstamped := filepath.Join(t.TempDir(), "ccmproxy-novcs")
	if b, err := exec.Command("go", "build", "-buildvcs=false", "-tags", "contract", "-o", unstamped, "../cmd/ccmproxy").CombinedOutput(); err != nil {
		t.Fatalf("building without VCS stamping: %v\n%s", err, b)
	}
	for _, bin := range []string{binPath, unstamped} {
		info, err := exec.Command("go", "version", "-m", bin).Output()
		if err != nil {
			t.Fatalf("go version -m %s: %v", bin, err)
		}
		revision := ""
		for _, line := range strings.Split(string(info), "\n") {
			if fields := strings.Fields(line); len(fields) == 2 && fields[0] == "build" && strings.HasPrefix(fields[1], "vcs.revision=") {
				revision = strings.TrimPrefix(fields[1], "vcs.revision=")
			}
		}
		if bin == unstamped && revision != "" {
			t.Fatalf("-buildvcs=false still stamped vcs.revision %s", revision)
		}
		// Outside a git checkout the suite's binary is unstamped too, and the
		// stamped branch goes untested: CI, which runs from a checkout, must
		// not let that pass quietly.
		if bin == binPath && revision == "" {
			if os.Getenv("CI") != "" {
				t.Fatalf("CI is set but the suite's binary carries no vcs.revision, so the stamped branch is not checked:\n%s", info)
			}
			t.Log("the suite's binary carries no vcs.revision (not a git checkout?): the stamped branch was not exercised")
		}

		cmd := exec.Command(bin, "version")
		cmd.Env = baseEnviron(t.TempDir())
		out, err := cmd.Output()
		if err != nil {
			t.Fatalf("%s version: %v", bin, err)
		}
		var printed []string
		for _, line := range strings.Split(string(out), "\n") {
			if strings.HasPrefix(strings.TrimSpace(line), "revision") {
				printed = append(printed, line)
			}
		}
		switch {
		case revision == "" && len(printed) != 0:
			t.Fatalf("%s has no vcs.revision but version printed %q", filepath.Base(bin), printed)
		case revision != "" && (len(printed) != 1 || printed[0] != "  revision "+revision):
			t.Fatalf("%s has vcs.revision %s but version printed %q:\n%s", filepath.Base(bin), revision, printed, out)
		}
		t.Logf("%s: vcs.revision %q", filepath.Base(bin), revision)
	}
}

func TestCLIEnvShells(t *testing.T) {
	home := cliHome(t, nil)
	url, header := "http://127.0.0.1:34567", "X-Ccmproxy-Token: "+cliToken
	posix := "export ANTHROPIC_BASE_URL='" + url + "'\nexport ANTHROPIC_CUSTOM_HEADERS='" + header + "'\nexport ENABLE_TOOL_SEARCH='true'\n"
	want := map[string]string{
		"posix": posix, "sh": posix, "bash": posix, "zsh": posix,
		"fish":       "set -gx ANTHROPIC_BASE_URL '" + url + "'\nset -gx ANTHROPIC_CUSTOM_HEADERS '" + header + "'\nset -gx ENABLE_TOOL_SEARCH 'true'\n",
		"powershell": "$env:ANTHROPIC_BASE_URL = '" + url + "'\n$env:ANTHROPIC_CUSTOM_HEADERS = '" + header + "'\n$env:ENABLE_TOOL_SEARCH = 'true'\n",
		"json":       "{\n  \"ANTHROPIC_BASE_URL\": \"" + url + "\",\n  \"ANTHROPIC_CUSTOM_HEADERS\": \"" + header + "\",\n  \"ENABLE_TOOL_SEARCH\": \"true\"\n}\n",
	}
	want["pwsh"] = want["powershell"]
	for shell, expected := range want {
		out, code := runCLI(t, home, nil, "env", "--shell", shell)
		if code != 0 || out.stdout != expected {
			t.Fatalf("--shell %s: exit %d\n%q\nwant\n%q\nstderr %s", shell, code, out.stdout, expected, out.stderr)
		}
	}
	if out, code := runCLI(t, home, nil, "env"); code != 0 || out.stdout != posix {
		t.Fatalf("default shell: exit %d %q", code, out.stdout)
	}
	if out, code := runCLI(t, home, nil, "env", "--shell", "JSON"); code != 0 || out.stdout != want["json"] {
		t.Fatalf("--shell JSON is case-insensitive: exit %d %q", code, out.stdout)
	}
	out, code := runCLI(t, home, nil, "env", "--shell", "csh")
	if code != 1 || !strings.Contains(out.stderr, `unknown shell "csh"`) || out.stdout != "" {
		t.Fatalf("unknown shell: exit %d, %q / %q", code, out.stdout, out.stderr)
	}
	// Without a secret there is nothing to print.
	bare := t.TempDir()
	writeJSON(t, filepath.Join(bare, "config.json"), map[string]any{"listen_http": "127.0.0.1:34567"}, 0o600)
	out, code = runCLI(t, bare, nil, "env")
	if code != 1 || !strings.Contains(out.stderr, "no auth_token") || !strings.Contains(out.stderr, "config init") {
		t.Fatalf("no auth_token: exit %d, %q", code, out.stderr)
	}
}

func TestCLIModels(t *testing.T) {
	home := cliHome(t, nil)

	out, code := runCLI(t, home, nil, "models", "--json")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, out.stderr)
	}
	var rows []struct {
		ID, Label, Description, BehavesAs string
	}
	must(t, json.Unmarshal([]byte(out.stdout), &rows))
	if len(rows) == 0 {
		t.Fatal("no rows")
	}
	for _, r := range rows {
		if r.ID == "" || r.BehavesAs == "" {
			t.Fatalf("row without id or behavesAs: %+v", r)
		}
	}
	var raw []map[string]any
	must(t, json.Unmarshal([]byte(out.stdout), &raw))
	for _, r := range raw {
		if len(r) != 4 {
			t.Fatalf("row keys = %v, want id, label, description, behavesAs", r)
		}
	}
	golden(t, "cli_models_json.golden.json", []byte(out.stdout))

	out, code = runCLI(t, home, nil, "models", "--settings-json")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, out.stderr)
	}
	var block struct {
		ModelPicker struct {
			Options []map[string]string `json:"options"`
		} `json:"modelPicker"`
	}
	must(t, json.Unmarshal([]byte(out.stdout), &block))
	if len(block.ModelPicker.Options) != len(rows) || block.ModelPicker.Options[0]["model"] != rows[0].ID {
		t.Fatalf("settings block = %s", out.stdout)
	}
	if !strings.Contains(out.stderr, "Merge the block above into ~/.claude/settings.json") {
		t.Fatalf("stderr = %q", out.stderr)
	}
	golden(t, "cli_models_settings.golden.json", []byte(out.stdout))

	out, code = runCLI(t, home, nil, "models", "--json", "--settings-json")
	if code != 1 || !strings.Contains(out.stderr, "cannot be combined") {
		t.Fatalf("both flags: exit %d %q", code, out.stderr)
	}

	out, code = runCLI(t, home, nil, "models")
	if code != 0 {
		t.Fatalf("exit %d", code)
	}
	golden(t, "cli_models_plain.golden", []byte(out.stdout))
}

func TestCLIStatusAndHelp(t *testing.T) {
	home := cliHome(t, nil)
	out, code := runCLI(t, home, nil, "status")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, out.stderr)
	}
	for _, want := range []string{"version         contract", "http listener   127.0.0.1:34567", "auth token      set", "session salt    set", "codex           not signed in"} {
		if !strings.Contains(out.stdout, want) {
			t.Fatalf("status lacks %q:\n%s", want, out.stdout)
		}
	}
	if strings.Contains(out.stdout, cliToken) || strings.Contains(out.stdout, cliSalt) {
		t.Fatal("status prints a secret")
	}
	out, code = runCLI(t, home, nil, "help")
	if code != 0 || !strings.HasPrefix(out.stdout, "ccmproxy - add models to Claude Code") {
		t.Fatalf("help: exit %d %q", code, out.stdout)
	}
	out, code = runCLI(t, home, nil, "bogus")
	if code != 1 || !strings.Contains(out.stderr, `unknown command "bogus"`) {
		t.Fatalf("unknown command: exit %d %q", code, out.stderr)
	}
}

var hex64 = regexp.MustCompile(`^[0-9a-f]{64}$`)

func TestCLIConfigInitCreatesTheFile(t *testing.T) {
	parent := t.TempDir()
	home := filepath.Join(parent, "new", "dir")
	out, code := runCLI(t, parent, append(baseEnviron(parent), "CCMPROXY_HOME="+home), "config", "init")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, out.stderr)
	}
	path := filepath.Join(home, "config.json")
	if !strings.HasPrefix(out.stdout, "Wrote "+path+"\n") || !strings.Contains(out.stdout, "Run `ccmproxy env`") {
		t.Fatalf("stdout = %q", out.stdout)
	}
	if m := mode(t, path); m != 0o600 {
		t.Fatalf("config mode = %o", m)
	}
	if m := mode(t, home); m != 0o700 {
		t.Fatalf("config dir mode = %o", m)
	}
	cfg := readLogin(t, path)
	if !hex64.MatchString(cfg["auth_token"].(string)) || !hex64.MatchString(cfg["session_salt"].(string)) || cfg["auth_token"] == cfg["session_salt"] {
		t.Fatalf("secrets = %v / %v", cfg["auth_token"], cfg["session_salt"])
	}
	if !regexp.MustCompile(`^127\.0\.0\.1:\d{4,5}$`).MatchString(cfg["listen_http"].(string)) {
		t.Fatalf("listen_http = %v", cfg["listen_http"])
	}
	if cfg["upstream"] != "https://api.anthropic.com" {
		t.Fatalf("upstream = %v", cfg["upstream"])
	}
	cdx := cfg["codex"].(map[string]any)
	if cdx["base_url"] != "https://chatgpt.com/backend-api/codex" || len(cdx) != 1 {
		t.Fatalf("codex defaults = %v", cdx)
	}
	// The file it wrote is a working config.
	if out, code := runCLI(t, parent, append(baseEnviron(parent), "CCMPROXY_HOME="+home), "env", "--shell", "json"); code != 0 {
		t.Fatalf("env on the new config: exit %d %s", code, out.stderr)
	}
}

func TestCLIConfigInitKeepsWhatIsThere(t *testing.T) {
	home := t.TempDir()
	must(t, os.Chmod(home, 0o700))
	path := filepath.Join(home, "config.json")
	writeJSON(t, path, map[string]any{
		"listen_http": "127.0.0.1:40000",
		"auth_token":  "keepme-" + strings.Repeat("t", 30),
		"custom":      map[string]any{"x": []any{1, 2}},
		"log_level":   "warn",
		"codex":       map[string]any{"callback_port": 1455, "future_key": "v", "models": []string{"gpt-6-luna"}},
	}, 0o644)

	out, code := runCLI(t, home, nil, "config", "init")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, out.stderr)
	}
	if !strings.Contains(out.stdout, "Added session_salt to "+path) || !strings.Contains(out.stdout, "Restricted "+path+" to mode 600") {
		t.Fatalf("stdout = %q", out.stdout)
	}
	if strings.Contains(out.stdout, "Run `ccmproxy env`") {
		t.Fatal("told to run env though auth_token was already there")
	}
	if m := mode(t, path); m != 0o600 {
		t.Fatalf("mode = %o", m)
	}
	cfg := readLogin(t, path)
	if cfg["auth_token"] != "keepme-"+strings.Repeat("t", 30) || cfg["listen_http"] != "127.0.0.1:40000" || cfg["log_level"] != "warn" {
		t.Fatalf("existing values changed: %v", cfg)
	}
	if !hex64.MatchString(cfg["session_salt"].(string)) {
		t.Fatalf("session_salt = %v", cfg["session_salt"])
	}
	if b, _ := json.Marshal(cfg["custom"]); string(b) != `{"x":[1,2]}` {
		t.Fatalf("unknown key changed: %s", b)
	}
	if cdx := cfg["codex"].(map[string]any); cdx["future_key"] != "v" || cdx["callback_port"].(float64) != 1455 {
		t.Fatalf("codex block changed: %v", cdx)
	}

	// A second run changes nothing.
	before, _ := os.ReadFile(path)
	out, code = runCLI(t, home, nil, "config", "init")
	after, _ := os.ReadFile(path)
	if code != 0 || !strings.Contains(out.stdout, "is up to date") || !bytes.Equal(before, after) {
		t.Fatalf("second run: exit %d %q", code, out.stdout)
	}

	// An empty secret counts as missing.
	writeJSON(t, path, map[string]any{"auth_token": "", "session_salt": cliSalt}, 0o600)
	out, code = runCLI(t, home, nil, "config", "init")
	if code != 0 || !strings.Contains(out.stdout, "Added auth_token to ") {
		t.Fatalf("empty auth_token: exit %d %q", code, out.stdout)
	}
	if cfg := readLogin(t, path); !hex64.MatchString(cfg["auth_token"].(string)) || cfg["session_salt"] != cliSalt {
		t.Fatalf("config = %v", cfg)
	}

	// A file that only needs its mode fixed.
	writeJSON(t, path, map[string]any{"auth_token": cliToken, "session_salt": cliSalt}, 0o640)
	out, code = runCLI(t, home, nil, "config", "init")
	if code != 0 || !strings.Contains(out.stdout, "already had every key") || mode(t, path) != 0o600 {
		t.Fatalf("mode only: exit %d %q mode %o", code, out.stdout, mode(t, path))
	}
}

func TestCLIConfigInitPreservesUppercaseSecrets(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, "config.json")
	writeJSON(t, path, map[string]any{
		"listen_http":  "127.0.0.1:40000",
		"AUTH_TOKEN":   cliToken,
		"SESSION_SALT": cliSalt,
	}, 0o600)
	before, err := os.ReadFile(path)
	must(t, err)
	envBefore, code := runCLI(t, home, nil, "env", "--shell", "json")
	if code != 0 {
		t.Fatalf("env before init: exit %d, %s", code, envBefore.stderr)
	}
	var values map[string]string
	must(t, json.Unmarshal([]byte(envBefore.stdout), &values))
	if values["ANTHROPIC_CUSTOM_HEADERS"] != "X-Ccmproxy-Token: "+cliToken {
		t.Fatal("env did not decode the existing uppercase auth token")
	}
	for run := 0; run < 2; run++ {
		out, code := runCLI(t, home, nil, "config", "init")
		if code != 0 || !strings.Contains(out.stdout, "is up to date") {
			t.Fatalf("init run %d: exit %d, %s, %s", run, code, out.stdout, out.stderr)
		}
		envAfter, code := runCLI(t, home, nil, "env", "--shell", "json")
		if code != 0 || envAfter.stdout != envBefore.stdout {
			t.Fatalf("env changed after init run %d: exit %d", run, code)
		}
		after, err := os.ReadFile(path)
		must(t, err)
		if !bytes.Equal(before, after) {
			t.Fatal("init changed existing secrets or added case-variant aliases")
		}
		cfg := readLogin(t, path)
		if len(cfg) != 3 || cfg["AUTH_TOKEN"] != cliToken || cfg["SESSION_SALT"] != cliSalt {
			t.Fatal("init did not preserve uppercase secrets")
		}
		if mode(t, path) != 0o600 {
			t.Fatal("config mode changed")
		}
	}
}

func TestCLIRefusesAConfigOthersCanRead(t *testing.T) {
	for _, args := range [][]string{{"env"}, {"models", "--json"}, {"status"}, {"serve"}} {
		home := cliHome(t, nil)
		path := filepath.Join(home, "config.json")
		must(t, os.Chmod(path, 0o644))
		out, code := runCLI(t, home, nil, args...)
		if code != 1 || !strings.Contains(out.stderr, "accessible by group or others") || !strings.Contains(out.stderr, "chmod 600") {
			t.Fatalf("%v: exit %d, stderr %q", args, code, out.stderr)
		}
		if strings.Contains(out.stdout+out.stderr, cliToken) {
			t.Fatalf("%v printed the secret", args)
		}
	}
}

func TestCLIRefusesUnsafeDestinations(t *testing.T) {
	cases := []struct {
		name  string
		extra map[string]any
		want  string
	}{
		{"other upstream", map[string]any{"upstream": "https://example.com"}, "is not allowed"},
		{"loopback upstream", map[string]any{"upstream": "http://127.0.0.1:9"}, "is not allowed"},
		{"http codex base_url", map[string]any{"codex": map[string]any{"base_url": "http://chatgpt.com/backend-api/codex"}}, "must be an https:// URL"},
		{"codex base_url with a query", map[string]any{"codex": map[string]any{"base_url": "https://chatgpt.com/x?a=1"}}, "must not carry a query"},
		{"codex base_url with credentials", map[string]any{"codex": map[string]any{"base_url": "https://u:p@chatgpt.com/x"}}, "credentials in the URL"},
		{"listen on all interfaces", map[string]any{"listen_http": "0.0.0.0:8081"}, "not a loopback address"},
		{"listen on a name", map[string]any{"listen_http": "localhost:8081"}, "literal loopback IP"},
		{"listen without a port", map[string]any{"listen_http": "127.0.0.1"}, "listen_http"},
		{"short secret", map[string]any{"auth_token": "short"}, "auth_token"},
	}
	for _, c := range cases {
		for _, cmd := range [][]string{{"env"}, {"serve"}} {
			home := cliHome(t, c.extra)
			out, code := runCLI(t, home, nil, cmd...)
			if code != 1 || !strings.Contains(out.stderr, c.want) {
				t.Fatalf("%s (%v): exit %d, stderr %q, want %q", c.name, cmd, code, out.stderr, c.want)
			}
			if strings.Contains(out.stderr, "u:p") {
				t.Fatalf("%s: the credentials in the URL were echoed: %s", c.name, out.stderr)
			}
		}
	}
}

func TestCLIServeNeedsSecrets(t *testing.T) {
	home := t.TempDir()
	writeJSON(t, filepath.Join(home, "config.json"), map[string]any{"listen_http": "127.0.0.1:34567", "auth_token": cliToken}, 0o600)
	out, code := runCLI(t, home, nil, "serve")
	if code != 1 || !strings.Contains(out.stderr, "no auth_token or session_salt") {
		t.Fatalf("exit %d, stderr %q", code, out.stderr)
	}
}
