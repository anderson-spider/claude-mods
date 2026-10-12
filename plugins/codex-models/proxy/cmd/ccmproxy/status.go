package main

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/codex"
)

// runStatus prints the config and the Codex login without contacting
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

	store := codex.NewStore(nil, storeOptions(cfg))
	line("codex sources", "%s", strings.Join(store.Sources(), ", "))
	if err := store.Check(); err != nil {
		line("codex", "refused: %v", err)
		return nil
	}
	token, err := store.Peek()
	if err != nil {
		line("codex", "not signed in")
		return nil
	}
	line("codex", "%s (%s)", accountLabel(token), planLabel(token))
	line("codex file", "%s", store.Path())
	if !token.ExpiresAt.IsZero() {
		line("codex token", "expires %s", token.ExpiresAt.Local().Format(time.RFC3339))
	}
	return nil
}

// presence reports whether a secret is set, never its value.
func presence(secret string) string {
	if secret == "" {
		return "missing (run `ccmproxy config init`)"
	}
	return "set"
}
