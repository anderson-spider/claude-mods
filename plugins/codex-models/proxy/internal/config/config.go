// Package config holds the on-disk configuration for the proxy along with the
// defaults that make it usable with no configuration at all.
package config

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
)

// DefaultUpstream is the Anthropic API endpoint every request that is not for
// a Codex model is forwarded to verbatim. It is also the only upstream
// accepted: the passthrough carries the person's OAuth bearer, so it may go
// nowhere else.
const DefaultUpstream = "https://api.anthropic.com"

// DefaultListenHTTP is the listener used when the configuration names none.
// `ccmproxy config init` writes a random high port instead.
const DefaultListenHTTP = "127.0.0.1:8081"

// TokenHeader is the request header that carries auth_token. Claude Code
// sends it through ANTHROPIC_CUSTOM_HEADERS. It is never Authorization or
// x-api-key, which carry the OAuth bearer.
const TokenHeader = "X-Ccmproxy-Token"

// removedKeys are top-level keys of earlier versions that no longer mean
// anything. A file that still sets one is refused by name rather than loaded
// as if the setting applied.
var removedKeys = map[string]string{
	"listen_proxy":    "the CONNECT proxy listener was removed; Claude Code reaches the proxy through ANTHROPIC_BASE_URL and listen_http",
	"listen_tls":      "the TLS listener was removed; Claude Code reaches the proxy through ANTHROPIC_BASE_URL and listen_http",
	"intercept_hosts": "TLS interception was removed; the proxy only serves ANTHROPIC_BASE_URL",
	"proxy_username":  "the CONNECT proxy and its credentials were removed; auth_token protects listen_http",
	"proxy_password":  "the CONNECT proxy and its credentials were removed; auth_token protects listen_http",
	"ca_dir":          "the local certificate authority was removed",
	"dns":             "the internal resolver was removed; the operating system resolver is used",
}

// generatedKeys are the secrets `config init` creates and adds to an existing
// file that lacks them.
var generatedKeys = []string{"auth_token", "session_salt"}

// Codex groups the settings of the OpenAI Codex (ChatGPT subscription) backend.
type Codex struct {
	// BaseURL is the ChatGPT backend that serves the Responses API. It must
	// be https: the ChatGPT access token is sent to it.
	BaseURL string `json:"base_url"`
	// UserAgent and Originator identify the request as coming from the Codex
	// CLI, which is the client the subscription endpoint expects.
	UserAgent  string `json:"user_agent"`
	Originator string `json:"originator"`
	// Models restricts the exposed catalog to these ids when non-empty.
	Models []string `json:"models,omitempty"`
	// EffortVariants adds one model entry per supported reasoning level
	// (for example gpt-5.5-high) to the advertised model list.
	//
	// It is off by default: Claude Code selects effort itself, with /effort
	// and --effort, and sends it with the request, so per-effort ids only
	// multiply the picker rows. Turn it on for a client that has no effort
	// control of its own.
	EffortVariants bool `json:"effort_variants"`
	// ModelPrefix, when set, is accepted (and advertised) in front of every
	// Codex model id, e.g. "codex/gpt-5.5".
	ModelPrefix string `json:"model_prefix,omitempty"`
	// CallbackPort is the loopback port the OAuth redirect URI points at. The
	// value is fixed by the registered OAuth client and should not change.
	CallbackPort int `json:"callback_port"`
	// AuthFile, when set, is the only credential file consulted, in either
	// this proxy's layout or the Codex CLI's.
	AuthFile string `json:"auth_file,omitempty"`
	// UseCLIAuth reads the Codex CLI's ~/.codex/auth.json when this proxy
	// has no credentials of its own. Off by default: the proxy keeps its own
	// login, so it never competes with the Codex CLI over one refresh token.
	UseCLIAuth bool `json:"use_codex_cli_auth"`
}

// Config is the complete proxy configuration.
type Config struct {
	// ListenHTTP is the one listener: plain HTTP on a literal loopback
	// address with an explicit port, which Claude Code reaches through
	// ANTHROPIC_BASE_URL.
	ListenHTTP string `json:"listen_http"`

	// Upstream is where pass-through traffic goes. Only DefaultUpstream is
	// accepted.
	Upstream string `json:"upstream"`

	// AuthToken is the shared secret every request must carry in
	// TokenHeader. `serve` refuses to start without it.
	AuthToken string `json:"auth_token,omitempty"`
	// SessionSalt is mixed into the hash that turns Claude Code's
	// metadata.user_id into the session id sent to the Codex backend.
	SessionSalt string `json:"session_salt,omitempty"`

	// AuthDir holds the provider credentials.
	AuthDir string `json:"auth_dir"`

	// LogLevel is one of debug, info, warn, error.
	LogLevel string `json:"log_level"`

	Codex Codex `json:"codex"`

	// path records where the config was loaded from, for Save.
	path string `json:"-"`
}

// ExpandUser resolves a leading "~" to the user's home directory.
//
// Tilde expansion is a shell feature, not a filesystem one: a shell rewrites
// "~/x" before the program is ever started. A path that arrives from a
// configuration file passes through no shell, so without this it would be used
// verbatim as a relative path and create a directory literally named "~" next
// to the working directory.
//
// Only the current user's home is expanded. "~other/x" is left alone, since
// resolving another user's home would need the password database and is not
// something this proxy should be guessing at.
func ExpandUser(path string) string {
	path = strings.TrimSpace(path)
	if path == "" || path[0] != '~' {
		return path
	}
	if len(path) > 1 && path[1] != '/' && path[1] != filepath.Separator {
		return path
	}

	home, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		// Better to leave the path as written than to silently relocate it.
		return path
	}
	if len(path) == 1 {
		return home
	}
	return filepath.Join(home, path[2:])
}

// Root reports the configuration directory, honouring XDG_CONFIG_HOME.
func Root() string {
	if dir := strings.TrimSpace(os.Getenv("CCMPROXY_HOME")); dir != "" {
		return ExpandUser(dir)
	}
	if dir := strings.TrimSpace(os.Getenv("XDG_CONFIG_HOME")); dir != "" {
		return filepath.Join(ExpandUser(dir), "ccmproxy")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ".ccmproxy"
	}
	return filepath.Join(home, ".config", "ccmproxy")
}

// DefaultPath reports the default config file location.
func DefaultPath() string { return filepath.Join(Root(), "config.json") }

// Default returns a fully populated configuration, without the generated
// secrets: those come only from `config init`.
func Default() *Config {
	root := Root()
	return &Config{
		ListenHTTP: DefaultListenHTTP,
		Upstream:   DefaultUpstream,
		AuthDir:    filepath.Join(root, "auth"),
		LogLevel:   "info",
		Codex: Codex{
			BaseURL:        "https://chatgpt.com/backend-api/codex",
			UserAgent:      "codex-tui/0.153.3 (Mac OS 26.5.1; arm64) iTerm.app/3.6.11 (codex-tui; 0.153.3)",
			Originator:     "codex-tui",
			EffortVariants: false,
			CallbackPort:   1455,
			UseCLIAuth:     false,
		},
	}
}

// Load reads path, filling unset fields from Default. A missing file is not an
// error: the defaults are returned. A file that still sets a removed key, that
// group or others can access, or whose values fail Validate is refused.
func Load(path string) (*Config, error) {
	cfg, _, err := load(path, true)
	return cfg, err
}

// load reads and validates the file. checkMode refuses a file group or
// others can access; `config init` skips that check because it fixes it.
// raw holds the file's top-level keys, nil when there is no file.
func load(path string, checkMode bool) (*Config, map[string]json.RawMessage, error) {
	if strings.TrimSpace(path) == "" {
		path = DefaultPath()
	}
	path = ExpandUser(path)

	cfg := Default()
	cfg.path = path

	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			cfg.normalize()
			if err := cfg.Validate(); err != nil {
				return nil, nil, err
			}
			return cfg, nil, nil
		}
		return nil, nil, fmt.Errorf("config: read %s: %w", path, err)
	}
	if checkMode {
		if err := checkPrivate(path); err != nil {
			return nil, nil, err
		}
	}

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, nil, fmt.Errorf("config: parse %s: %w", path, err)
	}
	if raw == nil {
		return nil, nil, fmt.Errorf("config: parse %s: the file must hold a JSON object", path)
	}
	if err := refuseRemovedKeys(path, raw); err != nil {
		return nil, nil, err
	}
	if err := json.Unmarshal(data, cfg); err != nil {
		return nil, nil, fmt.Errorf("config: parse %s: %w", path, err)
	}

	cfg.normalize()
	if err := cfg.Validate(); err != nil {
		return nil, nil, fmt.Errorf("%w (in %s)", err, path)
	}
	return cfg, raw, nil
}

// refuseRemovedKeys names every removed key the file still sets.
func refuseRemovedKeys(path string, raw map[string]json.RawMessage) error {
	var found []string
	for key := range raw {
		if _, removed := removedKeys[key]; removed {
			found = append(found, key)
		}
	}
	if len(found) == 0 {
		return nil
	}
	sort.Strings(found)
	lines := make([]string, 0, len(found))
	for _, key := range found {
		lines = append(lines, fmt.Sprintf("  %s: %s", key, removedKeys[key]))
	}
	return fmt.Errorf("config: %s sets keys this version no longer supports; remove them from the file:\n%s",
		path, strings.Join(lines, "\n"))
}

// checkPrivate refuses a configuration file group or others can access: it
// holds auth_token.
func checkPrivate(path string) error {
	if runtime.GOOS == "windows" {
		return nil
	}
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("config: stat %s: %w", path, err)
	}
	if mode := info.Mode().Perm(); mode&0o077 != 0 {
		return fmt.Errorf("config: %s is accessible by group or others (mode %03o) and holds the proxy's secret; "+
			"run `chmod 600 %s` or `ccmproxy config init`", path, mode, path)
	}
	return nil
}

func (c *Config) normalize() {
	def := Default()
	c.ListenHTTP = strings.TrimSpace(c.ListenHTTP)
	if c.ListenHTTP == "" {
		c.ListenHTTP = def.ListenHTTP
	}
	if strings.TrimSpace(c.Upstream) == "" {
		c.Upstream = def.Upstream
	}
	c.Upstream = strings.TrimSuffix(strings.TrimSpace(c.Upstream), "/")
	c.AuthToken = strings.TrimSpace(c.AuthToken)
	c.SessionSalt = strings.TrimSpace(c.SessionSalt)
	if strings.TrimSpace(c.AuthDir) == "" {
		c.AuthDir = def.AuthDir
	}
	// Path-valued settings come from a file, so "~" has not been expanded
	// by a shell and has to be resolved here.
	c.AuthDir = ExpandUser(c.AuthDir)
	c.Codex.AuthFile = ExpandUser(c.Codex.AuthFile)
	if strings.TrimSpace(c.LogLevel) == "" {
		c.LogLevel = def.LogLevel
	}
	if strings.TrimSpace(c.Codex.BaseURL) == "" {
		c.Codex.BaseURL = def.Codex.BaseURL
	}
	c.Codex.BaseURL = strings.TrimSuffix(strings.TrimSpace(c.Codex.BaseURL), "/")
	if strings.TrimSpace(c.Codex.UserAgent) == "" {
		c.Codex.UserAgent = def.Codex.UserAgent
	}
	if strings.TrimSpace(c.Codex.Originator) == "" {
		c.Codex.Originator = def.Codex.Originator
	}
	if c.Codex.CallbackPort <= 0 {
		c.Codex.CallbackPort = def.Codex.CallbackPort
	}
	if prefix := strings.TrimSpace(c.Codex.ModelPrefix); prefix != "" {
		c.Codex.ModelPrefix = strings.TrimSuffix(prefix, "/") + "/"
	}
}

// Validate checks the values that decide where traffic and credentials go.
// Error messages never include a secret's value.
func (c *Config) Validate() error {
	if err := ValidateListenAddr(c.ListenHTTP); err != nil {
		return fmt.Errorf("config: listen_http: %w", err)
	}
	if c.Upstream != DefaultUpstream {
		return fmt.Errorf("config: upstream %s is not allowed: the passthrough carries the Claude Code login, "+
			"so it goes only to %s (remove the key)", safeURL(c.Upstream), DefaultUpstream)
	}
	if err := validateHTTPSURL(c.Codex.BaseURL); err != nil {
		return fmt.Errorf("config: codex.base_url: %w", err)
	}
	if c.AuthToken != "" {
		if err := validateSecret(c.AuthToken); err != nil {
			return fmt.Errorf("config: auth_token: %w", err)
		}
	}
	if c.SessionSalt != "" {
		if err := validateSecret(c.SessionSalt); err != nil {
			return fmt.Errorf("config: session_salt: %w", err)
		}
	}
	return nil
}

// ValidateListenAddr accepts only a literal loopback IP (127.0.0.0/8 or ::1)
// with an explicit port. A host name is refused even when it resolves to
// loopback, because what it resolves to can change.
func ValidateListenAddr(addr string) error {
	host, port, err := net.SplitHostPort(strings.TrimSpace(addr))
	if err != nil {
		return fmt.Errorf("%q is not host:port: %w", addr, err)
	}
	if host == "" {
		return fmt.Errorf("%q has no host; use a loopback address such as 127.0.0.1", addr)
	}
	ip, err := netip.ParseAddr(host)
	if err != nil {
		return fmt.Errorf("%q: the host must be a literal loopback IP address (127.0.0.0/8 or ::1), not a name", addr)
	}
	if ip.Zone() != "" || ip.Is4In6() || !ip.IsLoopback() {
		return fmt.Errorf("%q is not a loopback address; use 127.0.0.0/8 or ::1", addr)
	}
	if port == "" || strings.Trim(port, "0123456789") != "" {
		return fmt.Errorf("%q needs a numeric port", addr)
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return fmt.Errorf("%q needs a port between 1 and 65535", addr)
	}
	return nil
}

func validateHTTPSURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		// url.Error repeats the whole input, credentials included.
		return errors.New("is not a valid URL")
	}
	if u.User != nil {
		return fmt.Errorf("%s: credentials in the URL are not allowed; remove them", safeURL(raw))
	}
	if u.Scheme != "https" || u.Host == "" {
		return fmt.Errorf("%s must be an https:// URL: the ChatGPT access token is sent to it", safeURL(raw))
	}
	return nil
}

// safeURL renders a configured URL for an error message: scheme, host and
// path only, quoted. Userinfo, query and fragment can carry credentials and
// are never repeated; a value that does not parse is not repeated at all.
func safeURL(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "(not a valid URL)"
	}
	shown := url.URL{Scheme: u.Scheme, Host: u.Host, Path: u.Path}
	rendered := strconv.Quote(shown.String())
	if u.User != nil {
		rendered += " (credentials removed)"
	}
	if u.RawQuery != "" || u.Fragment != "" {
		rendered += " (query removed)"
	}
	return rendered
}

// validateSecret keeps a secret usable as a header value: printable ASCII
// with no spaces, and long enough not to be guessed.
func validateSecret(value string) error {
	if len(value) < 32 || len(value) > 512 {
		return errors.New("must be 32 to 512 characters; run `ccmproxy config init` with the key removed to generate one")
	}
	for i := 0; i < len(value); i++ {
		if value[i] < 0x21 || value[i] > 0x7e {
			return errors.New("must be printable ASCII without spaces")
		}
	}
	return nil
}

// Path reports where the config was loaded from.
func (c *Config) Path() string {
	if c.path == "" {
		return DefaultPath()
	}
	return c.path
}

// Save writes the configuration to disk (0600), creating parent directories
// (0700).
func (c *Config) Save() error {
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return fmt.Errorf("config: encode: %w", err)
	}
	return writePrivate(c.Path(), append(data, '\n'))
}

// writePrivate replaces path atomically with data, mode 0600. Writing a
// temporary file and renaming it also tightens a file that was readable by
// others, which os.WriteFile would leave as it was.
func writePrivate(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("config: create %s: %w", dir, err)
	}
	tmp, err := os.CreateTemp(dir, ".config-*.json")
	if err != nil {
		return fmt.Errorf("config: write %s: %w", path, err)
	}
	tmpPath := tmp.Name()
	fail := func(err error) error {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
		return fmt.Errorf("config: write %s: %w", path, err)
	}
	if _, err := tmp.Write(data); err != nil {
		return fail(err)
	}
	if err := tmp.Sync(); err != nil {
		return fail(err)
	}
	if err := tmp.Chmod(0o600); err != nil {
		return fail(err)
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("config: write %s: %w", path, err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("config: write %s: %w", path, err)
	}
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}

// NewSecret returns 32 random bytes as hex.
func NewSecret() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("config: generate a secret: %w", err)
	}
	return hex.EncodeToString(buf), nil
}

// FreeLoopbackAddr asks the operating system for a free port on 127.0.0.1;
// it hands out ports from its high, ephemeral range.
func FreeLoopbackAddr() (string, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", fmt.Errorf("config: pick a port: %w", err)
	}
	addr := listener.Addr().String()
	if err := listener.Close(); err != nil {
		return "", fmt.Errorf("config: pick a port: %w", err)
	}
	return addr, nil
}

// InitResult reports what Init did.
type InitResult struct {
	Path string
	// Created is true when no file existed.
	Created bool
	// Added lists the keys written into an existing file.
	Added []string
	// Tightened is true when an existing file's mode was narrowed to 0600.
	Tightened bool
}

// Init writes a new configuration file, or upgrades an existing one in place.
//
// A new file gets the defaults, a random free port on 127.0.0.1 and freshly
// generated auth_token and session_salt. An existing file keeps every key it
// has, unknown ones included; only the generated keys it lacks are added, and
// its mode becomes 0600. A file that fails Load's checks (other than its
// mode) is refused, so nothing is dropped or rewritten behind the person's
// back.
func Init(path string) (*InitResult, error) {
	return initWith(path, NewSecret, FreeLoopbackAddr)
}

func initWith(path string, secret func() (string, error), freeAddr func() (string, error)) (*InitResult, error) {
	cfg, raw, err := load(path, false)
	if err != nil {
		return nil, err
	}
	result := &InitResult{Path: cfg.Path()}

	if raw == nil {
		addr, err := freeAddr()
		if err != nil {
			return nil, err
		}
		cfg.ListenHTTP = addr
		if cfg.AuthToken, err = secret(); err != nil {
			return nil, err
		}
		if cfg.SessionSalt, err = secret(); err != nil {
			return nil, err
		}
		if err := cfg.Validate(); err != nil {
			return nil, err
		}
		if err := cfg.Save(); err != nil {
			return nil, err
		}
		result.Created = true
		return result, nil
	}

	wasOpen := checkPrivate(result.Path) != nil
	for _, key := range generatedKeys {
		if value, ok := raw[key]; ok && !isEmptyString(value) {
			continue
		}
		generated, err := secret()
		if err != nil {
			return nil, err
		}
		encoded, err := json.Marshal(generated)
		if err != nil {
			return nil, fmt.Errorf("config: encode %s: %w", key, err)
		}
		raw[key] = encoded
		result.Added = append(result.Added, key)
	}

	if len(result.Added) > 0 {
		data, err := json.MarshalIndent(raw, "", "  ")
		if err != nil {
			return nil, fmt.Errorf("config: encode: %w", err)
		}
		if err := writePrivate(result.Path, append(data, '\n')); err != nil {
			return nil, err
		}
		// writePrivate always leaves 0600.
		result.Tightened = wasOpen
		return result, nil
	}

	if wasOpen {
		if err := os.Chmod(result.Path, 0o600); err != nil {
			return nil, fmt.Errorf("config: chmod %s: %w", result.Path, err)
		}
		result.Tightened = true
	}
	return result, nil
}

func isEmptyString(raw json.RawMessage) bool {
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
	}
	return strings.TrimSpace(s) == ""
}
