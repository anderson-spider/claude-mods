// Command ccmproxy routes Claude Code's Anthropic API traffic: everything is
// forwarded to the real API untouched except the model list, which is extended
// with OpenAI Codex models, and requests naming one of those models, which are
// answered by a remote that owns the Codex credentials.
//
// Claude Code reaches the proxy through ANTHROPIC_BASE_URL, on a plain HTTP
// listener bound to a loopback address; `ccmproxy env` prints the settings.
//
// The files split the commands by job: main.go dispatches, flags.go reads the
// flags every command shares, and serve.go, status.go, models.go,
// env.go, version.go and configinit.go each hold one command. The installer
// and the plugin's hooks read the output of `env --shell json`,
// `models --json` and `version`, and the `ccmproxy:` prefix of an error, so
// those texts are contracts.
package main

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/config"
)

const usage = `ccmproxy - add models to Claude Code by proxying the Anthropic API

Usage:
  ccmproxy serve [flags]        run the proxy (default command)
  ccmproxy status               show configuration and remote settings
  ccmproxy models [--settings-json | --json]
                                list the models this proxy adds;
                                --settings-json prints a modelPicker block
                                to merge into Claude Code's settings.json;
                                --json prints the picker rows as
                                [{"id","label","description","behavesAs"}]
  ccmproxy env [--shell SHELL]  print the environment Claude Code needs
                                (posix, fish, powershell or json); it
                                includes the proxy's secret
  ccmproxy config init [--stdin]
                                write a config file with a random port and
                                new secrets, or add the missing secrets to
                                an existing one; --stdin reads
                                {"codex":{"remote","management_key"}} JSON
  ccmproxy version              print the version and build details

Common flags:
  --config PATH   configuration file (default %s)
  --log LEVEL     debug, info, warn or error
`

// version is the release this binary was built from. It is stamped at build
// time with -ldflags "-X main.version=..."; a build without that reports
// "dev", which is what a local `go build` produces.
var version = "dev"

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "ccmproxy: %v\n", err)
		os.Exit(1)
	}
}

// run dispatches args to a command. The first argument names the command
// unless it is a flag; with no command, the flags are serve's.
func run(args []string) error {
	// A lone --version or --help is answered here: the dispatch below would
	// hand a leading flag to serve, whose flag set knows neither.
	if len(args) == 1 {
		switch args[0] {
		case "--version", "-version", "-v":
			return runVersion(os.Stdout)
		case "--help", "-help", "-h":
			return runHelp(os.Stdout)
		}
	}

	command, rest := "serve", args
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		command, rest = args[0], args[1:]
	}

	switch command {
	case "serve":
		return runServe(rest)
	case "status":
		return runStatus(rest)
	case "models":
		return runModels(rest)
	case "env":
		return runEnv(rest)
	case "config":
		return runConfig(rest)
	case "version":
		return runVersion(os.Stdout)
	case "help":
		return runHelp(os.Stdout)
	}
	return fmt.Errorf("unknown command %q (try `ccmproxy help`)", command)
}

// runHelp prints the usage. Like the other commands' plain text, a failed
// write to standard output is not reported.
func runHelp(out io.Writer) error {
	fmt.Fprintf(out, usage, config.DefaultPath())
	return nil
}
