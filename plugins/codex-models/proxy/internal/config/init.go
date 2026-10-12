package config

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

// secretKeys are the keys `config init` generates, in the order it adds them.
var secretKeys = []string{"auth_token", "session_salt"}

// InitResult says what Init did to the file at Path.
type InitResult struct {
	Path string
	// Created is true when there was no file and Init wrote a new one.
	Created bool
	// Added lists generated secrets in secretKeys order, then codex when
	// stdin-supplied remote settings changed.
	Added []string
	// Tightened is true when an existing file group or others could access
	// is now mode 0600.
	Tightened bool
}

// Init is `ccmproxy config init`: it creates the config file or completes an
// existing one.
//
// A new file gets the defaults, a free port on 127.0.0.1 and two fresh
// secrets. An existing file keeps every member as written, unknown keys
// included; Init only adds the secrets it lacks (absent, null or blank) and
// makes it mode 0600. A file that Load would refuse for any reason but its
// mode is left exactly as it is and the refusal returned.
func Init(path string) (*InitResult, error) {
	return initWithRemote(path, NewSecret, FreeLoopbackAddr, nil)
}

// initWith is Init with the secret and port sources injected for tests.
func initWith(path string, newSecret, freeAddr func() (string, error)) (*InitResult, error) {
	return initWithRemote(path, newSecret, freeAddr, nil)
}

// InitRemote accepts remote settings supplied through stdin, never argv.
func InitRemote(path string, remote Codex) (*InitResult, error) {
	return initWithRemote(path, NewSecret, FreeLoopbackAddr, &remote)
}

func initWithRemote(path string, newSecret, freeAddr func() (string, error), remote *Codex) (*InitResult, error) {
	cfg, data, err := load(path, false)
	if err != nil {
		return nil, err
	}
	changed := false
	var codexAddition string
	if remote != nil {
		next := *remote
		next.Remote = trimURL(next.Remote)
		next.ManagementKey = strings.TrimSpace(next.ManagementKey)
		changed = cfg.Codex != next
		cfg.Codex = next
		if err := cfg.Validate(); err != nil {
			return nil, err
		}
		if data != nil && changed {
			// Preserve unknown members inside codex as well as the top-level object.
			var previous struct {
				Codex map[string]json.RawMessage `json:"codex"`
			}
			_ = json.Unmarshal(data, &previous)
			if previous.Codex == nil {
				previous.Codex = map[string]json.RawMessage{}
			}
			for key := range previous.Codex {
				if strings.EqualFold(key, "remote") || strings.EqualFold(key, "management_key") {
					delete(previous.Codex, key)
				}
			}
			previous.Codex["remote"], _ = json.Marshal(next.Remote)
			previous.Codex["management_key"], _ = json.Marshal(next.ManagementKey)
			encoded, _ := json.Marshal(previous.Codex)
			codexAddition = fmt.Sprintf("%q: %s", "codex", encoded)
		}
	}
	if data == nil {
		return createFile(cfg, newSecret, freeAddr)
	}
	return completeFileWith(cfg, data, newSecret, codexAddition)
}

// createFile writes cfg, the defaults, as a new file with a free port and
// generated secrets.
func createFile(cfg *Config, newSecret, freeAddr func() (string, error)) (*InitResult, error) {
	addr, err := freeAddr()
	if err != nil {
		return nil, err
	}
	cfg.ListenHTTP = addr
	for _, secret := range []*string{&cfg.AuthToken, &cfg.SessionSalt} {
		if *secret, err = newSecret(); err != nil {
			return nil, err
		}
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	if err := cfg.Save(); err != nil {
		return nil, err
	}
	return &InitResult{Path: cfg.Path(), Created: true}, nil
}

// completeFile appends only Load's effectively missing secrets as the last
// members of the original object. Existing bytes, including duplicate keys,
// aliases and formatting, remain unchanged; the appended secret wins under
// the decoder's last-match rule. With no missing secret only the mode may change.
func completeFile(cfg *Config, data []byte, newSecret func() (string, error)) (*InitResult, error) {
	return completeFileWith(cfg, data, newSecret, "")
}

func completeFileWith(cfg *Config, data []byte, newSecret func() (string, error), codexAddition string) (*InitResult, error) {
	path := cfg.Path()
	result := &InitResult{Path: path}
	exposed := requirePrivate(path) != nil

	values := []string{cfg.AuthToken, cfg.SessionSalt}
	var additions []string
	for i, key := range secretKeys {
		if values[i] != "" {
			continue
		}
		value, err := newSecret()
		if err != nil {
			return nil, err
		}
		encoded, err := json.Marshal(value)
		if err != nil {
			return nil, fmt.Errorf("config: encode %s: %w", key, err)
		}
		additions = append(additions, fmt.Sprintf("%q: %s", key, encoded))
		result.Added = append(result.Added, key)
	}

	if codexAddition != "" {
		additions = append(additions, codexAddition)
		result.Added = append(result.Added, "codex")
	}
	switch {
	case len(result.Added) > 0:
		// Load validated a complete top-level object. Insert after its last
		// member, before the whitespace preceding its final closing brace.
		const whitespace = " \t\r\n"
		end := len(bytes.TrimRight(data, whitespace)) - 1
		at := len(bytes.TrimRight(data[:end], whitespace))
		insertion := "\n  " + strings.Join(additions, ",\n  ")
		if data[at-1] != '{' {
			insertion = "," + insertion
		}
		completed := make([]byte, 0, len(data)+len(insertion))
		completed = append(completed, data[:at]...)
		completed = append(completed, insertion...)
		completed = append(completed, data[at:]...)
		// The replacement is always 0600, so an exposed file is tightened
		// by the write itself.
		if err := writePrivateFile(path, completed); err != nil {
			return nil, err
		}
	case exposed:
		if err := os.Chmod(path, 0o600); err != nil {
			return nil, fmt.Errorf("config: chmod %s: %w", path, err)
		}
	}
	result.Tightened = exposed
	return result, nil
}
