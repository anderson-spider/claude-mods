package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"runtime"
	"strings"
)

// Load reads the config file at path ("" means DefaultPath; a leading "~" is
// expanded). A missing file is not an error: the result is the defaults.
//
// The file is refused when group or others can access it (it holds
// auth_token), when it is not a JSON object of the expected types, or when
// Validate rejects it. Unknown keys are ignored uniformly; known fields use
// ordinary encoding/json decoding. Settings left out or blank take the defaults.
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
// trailing "/" and "~" expanded in paths.
func (c *Config) fillDefaults() {
	c.ListenHTTP = orDefault(strings.TrimSpace(c.ListenHTTP), DefaultListenHTTP)
	c.Upstream = trimURL(orDefault(c.Upstream, DefaultUpstream))
	c.AuthToken = strings.TrimSpace(c.AuthToken)
	c.SessionSalt = strings.TrimSpace(c.SessionSalt)
	c.AuthDir = ExpandUser(orDefault(c.AuthDir, defaultAuthDir()))
	c.LogLevel = orDefault(c.LogLevel, defaultLogLevel)

	x := &c.Codex
	x.BaseURL = trimURL(orDefault(x.BaseURL, defaultCodexBaseURL))
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
