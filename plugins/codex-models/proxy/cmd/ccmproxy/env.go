package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/config"
)

// runEnv prints the environment Claude Code needs, for one shell. The output
// carries the proxy's secret by design: install.sh reads `--shell json` and
// never echoes it.
func runEnv(args []string) error {
	var shell string
	cfg, err := loadConfig("env", args, func(fs *flag.FlagSet) {
		fs.StringVar(&shell, "shell", "posix", "posix, fish, powershell or json")
	})
	if err != nil {
		return err
	}
	vars, err := envVars(cfg)
	if err != nil {
		return err
	}
	text, err := formatEnv(vars, shell)
	if err != nil {
		return err
	}
	fmt.Fprint(os.Stdout, text)
	return nil
}

// envVars lists, in order, the variables Claude Code needs to reach the
// proxy: the base URL, the secret header, and tool search, which Claude Code
// turns off for a base URL that is not Anthropic's.
func envVars(cfg *config.Config) ([][2]string, error) {
	if cfg.AuthToken == "" {
		return nil, fmt.Errorf("%s has no auth_token; run `ccmproxy config init` to generate it", cfg.Path())
	}
	return [][2]string{
		{"ANTHROPIC_BASE_URL", "http://" + cfg.ListenHTTP},
		{"ANTHROPIC_CUSTOM_HEADERS", config.TokenHeader + ": " + cfg.AuthToken},
		{"ENABLE_TOOL_SEARCH", "true"},
	}, nil
}

// formatEnv renders vars for a shell (case-insensitive), every value quoted.
// JSON is one object with sorted keys, which is what install.sh reads.
func formatEnv(vars [][2]string, shell string) (string, error) {
	var b strings.Builder
	switch strings.ToLower(shell) {
	case "json":
		object := make(map[string]string, len(vars))
		for _, kv := range vars {
			object[kv[0]] = kv[1]
		}
		data, err := json.MarshalIndent(object, "", "  ")
		if err != nil {
			return "", fmt.Errorf("encode JSON: %w", err)
		}
		b.Write(data)
		b.WriteByte('\n')
	case "fish":
		for _, kv := range vars {
			fmt.Fprintf(&b, "set -gx %s %s\n", kv[0], quoteFish(kv[1]))
		}
	case "powershell", "pwsh":
		for _, kv := range vars {
			fmt.Fprintf(&b, "$env:%s = %s\n", kv[0], quoteSingle(kv[1], "''"))
		}
	case "posix", "sh", "bash", "zsh", "":
		for _, kv := range vars {
			fmt.Fprintf(&b, "export %s=%s\n", kv[0], quoteSingle(kv[1], `'\''`))
		}
	default:
		return "", fmt.Errorf("unknown shell %q; use posix, fish, powershell or json", shell)
	}
	return b.String(), nil
}

// quoteSingle wraps value in single quotes, writing each quote inside it as
// the shell's escape for one.
func quoteSingle(value, quote string) string {
	return "'" + strings.ReplaceAll(value, "'", quote) + "'"
}

// quoteFish quotes value for fish, where a backslash and a single quote are
// escaped inside single quotes.
func quoteFish(value string) string {
	value = strings.ReplaceAll(value, `\`, `\\`)
	value = strings.ReplaceAll(value, `'`, `\'`)
	return "'" + value + "'"
}
