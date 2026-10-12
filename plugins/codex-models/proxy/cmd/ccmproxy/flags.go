package main

import (
	"flag"
	"fmt"
	"strings"

	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/codex"
	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/config"
	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/logx"
)

// parseFlags parses the flags every command takes, --config and --log, plus
// the ones extra adds, and returns the two shared values. It does not load
// the config: `config init` must run on a file Load would refuse.
//
// A bad flag is an error; the flag package has already printed it and the
// command's flags to standard error by then.
func parseFlags(command string, args []string, extra func(*flag.FlagSet)) (configPath, logLevel string, err error) {
	fs := flag.NewFlagSet(command, flag.ContinueOnError)
	fs.StringVar(&configPath, "config", "", "configuration file")
	fs.StringVar(&logLevel, "log", "", "log level: debug, info, warn, error")
	if extra != nil {
		extra(fs)
	}
	if err := fs.Parse(args); err != nil {
		return "", "", err
	}
	return configPath, logLevel, nil
}

// loadConfig parses the flags, loads the config they name (the default path
// when --config is absent) and sets the log level: --log wins over the
// file's log_level.
func loadConfig(command string, args []string, extra func(*flag.FlagSet)) (*config.Config, error) {
	configPath, logLevel, err := parseFlags(command, args, extra)
	if err != nil {
		return nil, err
	}
	cfg, err := config.Load(configPath)
	if err != nil {
		return nil, err
	}
	if logLevel != "" {
		cfg.LogLevel = logLevel
	}
	logx.SetLevel(cfg.LogLevel)
	return cfg, nil
}

// storeOptions maps the config onto the credential lookup order.
func storeOptions(cfg *config.Config) codex.StoreOptions {
	return codex.StoreOptions{
		Dir:          cfg.AuthDir,
		ExplicitPath: cfg.Codex.AuthFile,
		UseCodexCLI:  cfg.Codex.UseCLIAuth,
	}
}

// providerArg takes the optional provider word of `login` and `logout`
// (only codex exists) off the front of args.
func providerArg(args []string) ([]string, error) {
	if len(args) == 0 || strings.HasPrefix(args[0], "-") {
		return args, nil
	}
	if args[0] != "codex" {
		return nil, fmt.Errorf("unknown provider %q; only `codex` is supported", args[0])
	}
	return args[1:], nil
}
