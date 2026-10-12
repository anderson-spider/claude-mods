package main

import (
	"fmt"
	"os"
)

// runStatus prints the config and remote settings without contacting
// anything. A secret is shown only as set or missing.
func runStatus(args []string) error {
	cfg, err := loadConfig("status", args, nil)
	if err != nil {
		return err
	}
	out := os.Stdout
	line := func(label, format string, a ...any) {
		fmt.Fprintf(out, "%-15s %s\n", label, fmt.Sprintf(format, a...))
	}

	line("version", "%s", version)
	line("config", "%s", cfg.Path())
	line("http listener", "%s", cfg.ListenHTTP)
	line("upstream", "%s", cfg.Upstream)
	line("auth token", "%s", presence(cfg.AuthToken))
	line("session salt", "%s", presence(cfg.SessionSalt))

	line("codex remote", "%s", cfg.Codex.Remote)
	line("management key", "%s", presence(cfg.Codex.ManagementKey))
	return nil
}

// presence reports whether a secret is set, never its value.
func presence(secret string) string {
	if secret == "" {
		return "missing (run `ccmproxy config init`)"
	}
	return "set"
}
