package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"runtime"
	"slices"
	"strings"
)

// removedKeys maps each top-level key that earlier versions read, and that
// means nothing now, to the reason. A file still setting one is refused, so
// nobody runs believing the setting applies.
var removedKeys = map[string]string{
	"listen_proxy":    "the CONNECT listener is gone; Claude Code reaches the proxy at listen_http through ANTHROPIC_BASE_URL",
	"listen_tls":      "the TLS listener is gone; Claude Code reaches the proxy at listen_http through ANTHROPIC_BASE_URL",
	"intercept_hosts": "TLS interception is gone; the proxy serves only ANTHROPIC_BASE_URL",
	"proxy_username":  "the CONNECT listener and its credentials are gone; auth_token guards listen_http",
	"proxy_password":  "the CONNECT listener and its credentials are gone; auth_token guards listen_http",
	"ca_dir":          "the local certificate authority is gone",
	"dns":             "the built-in resolver is gone; the system resolver is used",
}

// Load reads the config file at path ("" means DefaultPath; a leading "~" is
// expanded). A missing file is not an error: the result is the defaults.
//
// The file is refused when group or others can access it (it holds
// auth_token), when it sets one of removedKeys, when it is not a JSON object
// of the expected types, or when Validate rejects it. Unknown keys are
// ignored. Settings the file leaves out or leaves blank take the defaults.
func Load(path string) (*Config, error) {
	cfg, _, err := load(path, true)
	return cfg, err
}

// load is Load for both of its callers. Init passes checkMode false because
// tightening the mode is part of its job. keys holds the file's top-level
// members exactly as written, or nil when there is no file, so Init can write
// them back without dropping or reformatting what it does not own.
func load(path string, checkMode bool) (cfg *Config, keys map[string]json.RawMessage, err error) {
	if strings.TrimSpace(path) == "" {
		path = DefaultPath()
	}
	path = ExpandUser(path)

	cfg = Default()
	cfg.path = path

	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		cfg.fillDefaults()
		if err := cfg.Validate(); err != nil {
			return nil, nil, err
		}
		return cfg, nil, nil
	}
	if err != nil {
		return nil, nil, fmt.Errorf("config: read %s: %w", path, err)
	}

	if checkMode {
		if err := requirePrivate(path); err != nil {
			return nil, nil, err
		}
	}
	// The decoder's errors name a type or one offending character, never a
	// value, so they are safe to show even for a file holding secrets.
	if err := json.Unmarshal(data, &keys); err != nil {
		return nil, nil, fmt.Errorf("config: parse %s: %w", path, err)
	}
	if keys == nil {
		return nil, nil, fmt.Errorf("config: parse %s: the file must hold a JSON object", path)
	}
	if err := removedKeyError(path, keys); err != nil {
		return nil, nil, err
	}
	// Decoding over Default keeps the default of every key the file omits.
	if err := json.Unmarshal(data, cfg); err != nil {
		return nil, nil, fmt.Errorf("config: parse %s: %w", path, err)
	}

	cfg.fillDefaults()
	if err := cfg.Validate(); err != nil {
		return nil, nil, fmt.Errorf("%w (in %s)", err, path)
	}
	return cfg, keys, nil
}

// removedKeyError names, with its reason, every key of removedKeys the file
// sets, and never repeats a value.
func removedKeyError(path string, keys map[string]json.RawMessage) error {
	var lines []string
	for key, reason := range removedKeys {
		if _, set := keys[key]; set {
			lines = append(lines, "  "+key+": "+reason)
		}
	}
	if lines == nil {
		return nil
	}
	slices.Sort(lines)
	return fmt.Errorf("config: %s sets keys this version no longer supports; delete them from the file:\n%s",
		path, strings.Join(lines, "\n"))
}

// requirePrivate refuses a file that group or others can access, since it
// holds auth_token. Windows has no such mode bits and is not checked.
func requirePrivate(path string) error {
	if runtime.GOOS == "windows" {
		return nil
	}
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("config: stat %s: %w", path, err)
	}
	if perm := info.Mode().Perm(); perm&0o077 != 0 {
		return fmt.Errorf("config: %s is accessible by group or others (mode %03o) and holds the proxy's secret; "+
			"run `chmod 600 %s` or `ccmproxy config init`", path, perm, path)
	}
	return nil
}

// fillDefaults gives every blank setting its default and puts the rest in
// the form the other packages expect: trimmed values, URLs without a
// trailing "/", "~" expanded in paths and a model prefix ending in "/".
func (c *Config) fillDefaults() {
	c.ListenHTTP = orDefault(strings.TrimSpace(c.ListenHTTP), DefaultListenHTTP)
	c.Upstream = trimURL(orDefault(c.Upstream, DefaultUpstream))
	c.AuthToken = strings.TrimSpace(c.AuthToken)
	c.SessionSalt = strings.TrimSpace(c.SessionSalt)
	c.AuthDir = ExpandUser(orDefault(c.AuthDir, defaultAuthDir()))
	c.LogLevel = orDefault(c.LogLevel, defaultLogLevel)

	x := &c.Codex
	x.BaseURL = trimURL(orDefault(x.BaseURL, defaultCodexBaseURL))
	x.UserAgent = orDefault(x.UserAgent, defaultUserAgent)
	x.Originator = orDefault(x.Originator, defaultOriginator)
	if x.CallbackPort <= 0 {
		x.CallbackPort = defaultCallbackPort
	}
	x.AuthFile = ExpandUser(x.AuthFile)
	if prefix := strings.TrimSpace(x.ModelPrefix); prefix != "" {
		x.ModelPrefix = strings.TrimSuffix(prefix, "/") + "/"
	}
}

// orDefault is value, or def when value is blank. A value that is not blank
// is returned as it is, untrimmed.
func orDefault(value, def string) string {
	if strings.TrimSpace(value) == "" {
		return def
	}
	return value
}

// trimURL trims spaces and one trailing "/": "https://host/" is "https://host",
// while "https://host//" keeps a path and is still refused where a bare origin
// is required.
func trimURL(raw string) string {
	return strings.TrimSuffix(strings.TrimSpace(raw), "/")
}
