package config

import (
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
	// Added lists the secrets written into an existing file, in secretKeys
	// order.
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
	return initWith(path, NewSecret, FreeLoopbackAddr)
}

// initWith is Init with the secret and port sources injected for tests.
func initWith(path string, newSecret, freeAddr func() (string, error)) (*InitResult, error) {
	cfg, keys, err := load(path, false)
	if err != nil {
		return nil, err
	}
	if keys == nil {
		return createFile(cfg, newSecret, freeAddr)
	}
	return completeFile(cfg, keys, newSecret)
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

// completeFile uses Load's effective secrets, including case-insensitive field
// matching, to add only what is missing. Existing key spellings are kept, so
// filling a blank secret never adds a competing alias. Other members remain
// raw JSON; only the layout (key order, indentation) is the encoder's.
func completeFile(cfg *Config, keys map[string]json.RawMessage, newSecret func() (string, error)) (*InitResult, error) {
	path := cfg.Path()
	result := &InitResult{Path: path}
	exposed := requirePrivate(path) != nil

	values := []string{cfg.AuthToken, cfg.SessionSalt}
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
		matched := false
		for name := range keys {
			if strings.EqualFold(name, key) {
				keys[name] = encoded
				matched = true
			}
		}
		if !matched {
			keys[key] = encoded
		}
		result.Added = append(result.Added, key)
	}

	switch {
	case len(result.Added) > 0:
		data, err := json.MarshalIndent(keys, "", "  ")
		if err != nil {
			return nil, fmt.Errorf("config: encode: %w", err)
		}
		// The replacement is always 0600, so an exposed file is tightened
		// by the write itself.
		if err := writePrivateFile(path, append(data, '\n')); err != nil {
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
