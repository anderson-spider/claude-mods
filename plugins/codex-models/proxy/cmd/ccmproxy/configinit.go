package main

import (
	"fmt"
	"os"
	"slices"
	"strings"

	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/config"
)

// runConfig runs `config init`: it writes a new config with a random port
// and new secrets, or adds only the missing secrets to an existing one,
// keeping every other value and unknown key (config.Init).
func runConfig(args []string) error {
	action := "init"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		action, args = args[0], args[1:]
	}
	if action != "init" {
		return fmt.Errorf("unknown config action %q; only `init` is supported", action)
	}

	// The file is not loaded: Load refuses a file others can read, and init
	// is what fixes that.
	configPath, _, err := parseFlags("config", args, nil)
	if err != nil {
		return err
	}
	if strings.TrimSpace(configPath) == "" {
		configPath = config.DefaultPath()
	}
	result, err := config.Init(config.ExpandUser(configPath))
	if err != nil {
		return err
	}

	out := os.Stdout
	switch {
	case result.Created:
		fmt.Fprintf(out, "Wrote %s\n", result.Path)
	case len(result.Added) > 0:
		fmt.Fprintf(out, "Added %s to %s\n", strings.Join(result.Added, " and "), result.Path)
	case result.Tightened:
		fmt.Fprintf(out, "%s already had every key\n", result.Path)
	default:
		fmt.Fprintf(out, "%s is up to date\n", result.Path)
	}
	if result.Tightened {
		fmt.Fprintf(out, "Restricted %s to mode 600: it holds the proxy's secret\n", result.Path)
	}
	if result.Created || slices.Contains(result.Added, "auth_token") {
		fmt.Fprintln(out, "Run `ccmproxy env` for the settings Claude Code needs.")
	}
	return nil
}
