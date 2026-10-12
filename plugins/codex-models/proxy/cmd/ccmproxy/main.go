// Command ccmproxy routes Claude Code's Anthropic API traffic: everything is
// forwarded to the real API untouched except the model list, which is extended
// with OpenAI Codex models, and requests naming one of those models, which are
// answered from a ChatGPT subscription over OAuth.
//
// Claude Code reaches the proxy through ANTHROPIC_BASE_URL, on a plain HTTP
// listener bound to a loopback address; `ccmproxy env` prints the settings.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"os/signal"
	"runtime"
	"runtime/debug"
	"strings"
	"syscall"
	"time"

	"github.com/jclab-joseph/claude-code-model-proxy/internal/codex"
	"github.com/jclab-joseph/claude-code-model-proxy/internal/config"
	"github.com/jclab-joseph/claude-code-model-proxy/internal/httplog"
	"github.com/jclab-joseph/claude-code-model-proxy/internal/logx"
	"github.com/jclab-joseph/claude-code-model-proxy/internal/proxy"
	"github.com/jclab-joseph/claude-code-model-proxy/internal/router"
)

const usage = `ccmproxy - add models to Claude Code by proxying the Anthropic API

Usage:
  ccmproxy serve [flags]        run the proxy (default command)
  ccmproxy login codex [flags]  sign in to a ChatGPT account for Codex models
  ccmproxy logout codex         remove the stored Codex credentials
  ccmproxy status               show configuration and login state
  ccmproxy models [--settings-json | --json]
                                list the models this proxy adds;
                                --settings-json prints a modelPicker block
                                to merge into Claude Code's settings.json;
                                --json prints the picker rows as
                                [{"id","label","description"}]
  ccmproxy env [--shell SHELL]  print the environment Claude Code needs
                                (posix, fish, powershell or json); it
                                includes the proxy's secret
  ccmproxy config init          write a config file with a random port and
                                new secrets, or add the missing secrets to
                                an existing one
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

func run(args []string) error {
	// --version is handled before the command dispatch, which would
	// otherwise read a leading flag as an argument to `serve`.
	if len(args) == 1 && (args[0] == "--version" || args[0] == "-version" || args[0] == "-v") {
		return runVersion()
	}

	command := "serve"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		command, args = args[0], args[1:]
	}

	switch command {
	case "serve":
		return runServe(args)
	case "login":
		return runLogin(args)
	case "logout":
		return runLogout(args)
	case "status":
		return runStatus(args)
	case "models":
		return runModels(args)
	case "env":
		return runEnv(args)
	case "config":
		return runConfig(args)
	case "version":
		return runVersion()
	case "help", "-h", "--help":
		fmt.Printf(usage, config.DefaultPath())
		return nil
	default:
		return fmt.Errorf("unknown command %q (try `ccmproxy help`)", command)
	}
}

// commonFlags registers the flags every subcommand accepts and returns the
// loaded configuration.
func commonFlags(name string, args []string, extra func(*flag.FlagSet)) (*config.Config, *flag.FlagSet, error) {
	fs, configPath, err := parseFlags(name, args, extra)
	if err != nil {
		return nil, nil, err
	}
	cfg, err := config.Load(configPath)
	if err != nil {
		return nil, nil, err
	}
	if level := fs.Lookup("log").Value.String(); level != "" {
		cfg.LogLevel = level
	}
	logx.SetLevel(cfg.LogLevel)
	return cfg, fs, nil
}

// parseFlags parses the common flags without loading the configuration.
func parseFlags(name string, args []string, extra func(*flag.FlagSet)) (*flag.FlagSet, string, error) {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	configPath := fs.String("config", "", "configuration file")
	fs.String("log", "", "log level: debug, info, warn, error")
	if extra != nil {
		extra(fs)
	}
	if err := fs.Parse(args); err != nil {
		return nil, "", err
	}
	return fs, *configPath, nil
}

// storeOptions maps the configuration onto the credential lookup order.
func storeOptions(cfg *config.Config) codex.StoreOptions {
	return codex.StoreOptions{
		Dir:          cfg.AuthDir,
		ExplicitPath: cfg.Codex.AuthFile,
		UseCodexCLI:  cfg.Codex.UseCLIAuth,
	}
}

// directTransport dials upstreams without consulting HTTPS_PROXY and the
// other proxy environment variables: a value left in the shell from an older
// CONNECT setup would otherwise aim the proxy at a listener that no longer
// exists, or at itself.
func directTransport() *http.Transport {
	dialer := &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}
	return &http.Transport{
		Proxy:                 nil,
		DialContext:           dialer.DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          100,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   15 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	}
}

// lookupFunc resolves a host name, as net.Resolver.LookupNetIP does.
type lookupFunc func(ctx context.Context, network, host string) ([]netip.Addr, error)

// checkUpstream refuses to start when the upstream host resolves to a
// loopback or unspecified address: that is a leftover hosts-file redirect,
// which would send the passthrough, and Claude Code itself, back to this
// machine instead of to Anthropic. A failed lookup is only a warning, so a
// proxy started before the network is up still comes up.
func checkUpstream(ctx context.Context, upstream string, lookup lookupFunc) error {
	u, err := url.Parse(upstream)
	if err != nil || u.Hostname() == "" {
		return fmt.Errorf("upstream %q has no host", upstream)
	}
	host := u.Hostname()
	if ip, err := netip.ParseAddr(host); err == nil {
		return refuseLocal(host, []netip.Addr{ip})
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	addrs, err := lookup(ctx, "ip", host)
	if err != nil {
		logx.Warnf("could not resolve %s to check it is not redirected to this machine: %v", host, err)
		return nil
	}
	return refuseLocal(host, addrs)
}

func refuseLocal(host string, addrs []netip.Addr) error {
	for _, addr := range addrs {
		addr = addr.Unmap()
		if addr.IsLoopback() || addr.IsUnspecified() {
			return fmt.Errorf("%s resolves to %s, a local address: remove the %s line from /etc/hosts "+
				"(an older ccmproxy setup redirected it), then start the proxy again", host, addr, host)
		}
	}
	return nil
}

func runServe(args []string) error {
	cfg, _, err := commonFlags("serve", args, nil)
	if err != nil {
		return err
	}
	if cfg.AuthToken == "" || cfg.SessionSalt == "" {
		return fmt.Errorf("%s has no auth_token or session_salt; run `ccmproxy config init` to generate them", cfg.Path())
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := checkUpstream(ctx, cfg.Upstream, net.DefaultResolver.LookupNetIP); err != nil {
		return err
	}

	// Every outbound call the proxy makes — to Anthropic, to the Codex
	// backend, to the OAuth token endpoint — goes through this one
	// transport, so wrapping it here logs all of them with one change.
	transport := &httplog.Transport{Next: directTransport()}

	oauth := codex.NewClient(&http.Client{Transport: transport, Timeout: 30 * time.Second})
	store := codex.NewStore(oauth, storeOptions(cfg))
	backend := codex.NewBackend(cfg.Codex.BaseURL, cfg.Codex.UserAgent, cfg.Codex.Originator, store, transport)
	registry := codex.NewRegistry(cfg.Codex.Models, cfg.Codex.ModelPrefix, cfg.Codex.EffortVariants)

	handler, err := router.New(cfg, registry, backend, transport)
	if err != nil {
		return err
	}
	handler.Version = version
	// Guard checks Host and the secret, and removes the secret, before the
	// router or any upstream sees the request.
	guarded, err := router.Guard(cfg, handler)
	if err != nil {
		return err
	}
	// Every inbound request — refused ones included — passes through this
	// handler, so wrapping it here logs all of them. It logs no headers.
	loggedHandler := httplog.Log(guarded)

	logx.Infof("ccmproxy %s", version)
	logx.Infof("upstream: %s", cfg.Upstream)
	if store.Authenticated() {
		if token, err := store.Peek(); err == nil {
			logx.Infof("codex account: %s (%s)", accountLabel(token), planLabel(token))
		}
	} else {
		logx.Warnf("no Codex credentials yet; run `ccmproxy login codex` to enable the added models")
	}
	logx.Infof("point Claude Code at http://%s (`ccmproxy env` prints the settings)", cfg.ListenHTTP)

	return proxy.Serve(ctx, "http", cfg.ListenHTTP, loggedHandler)
}

func runLogin(args []string) error {
	provider := "codex"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		provider, args = args[0], args[1:]
	}
	if provider != "codex" {
		return fmt.Errorf("unknown provider %q; only `codex` is supported", provider)
	}

	var noBrowser bool
	cfg, _, err := commonFlags("login", args, func(fs *flag.FlagSet) {
		fs.BoolVar(&noBrowser, "no-browser", false, "print the URL instead of opening a browser")
	})
	if err != nil {
		return err
	}

	oauth := codex.NewClient(&http.Client{
		Transport: directTransport(),
		Timeout:   30 * time.Second,
	})
	store := codex.NewStore(oauth, storeOptions(cfg))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	announce := func(url string) {
		if noBrowser {
			fmt.Println("Open this URL to authorize the proxy:")
		} else {
			fmt.Println("Opening your browser. If nothing happens, open this URL:")
		}
		fmt.Println()
		fmt.Println("  " + url)
		fmt.Println()
		fmt.Printf("Waiting for the callback on %s ...\n", codex.RedirectURI(cfg.Codex.CallbackPort))
	}

	result, err := oauth.Login(ctx, cfg.Codex.CallbackPort, !noBrowser, announce)
	if err != nil {
		return err
	}
	if err := store.Save(result.Token); err != nil {
		return err
	}

	fmt.Printf("Signed in as %s (%s).\n", accountLabel(result.Token), planLabel(result.Token))
	fmt.Printf("Credentials stored in %s\n", store.NativePath())
	return nil
}

func runLogout(args []string) error {
	provider := "codex"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		provider, args = args[0], args[1:]
	}
	if provider != "codex" {
		return fmt.Errorf("unknown provider %q; only `codex` is supported", provider)
	}

	cfg, _, err := commonFlags("logout", args, nil)
	if err != nil {
		return err
	}
	store := codex.NewStore(nil, storeOptions(cfg))
	if err := os.Remove(store.NativePath()); err != nil {
		if os.IsNotExist(err) {
			fmt.Println("No Codex credentials were stored.")
			return nil
		}
		return err
	}
	fmt.Printf("Removed %s\n", store.NativePath())
	if path := codex.CodexCLIAuthPath(); cfg.Codex.UseCLIAuth && path != "" {
		if _, err := os.Stat(path); err == nil {
			fmt.Printf("The Codex CLI login at %s is untouched and will still be used.\n", path)
		}
	}
	return nil
}

func runStatus(args []string) error {
	cfg, _, err := commonFlags("status", args, nil)
	if err != nil {
		return err
	}

	fmt.Printf("version         %s\n", version)
	fmt.Printf("config          %s\n", cfg.Path())
	fmt.Printf("http listener   %s\n", cfg.ListenHTTP)
	fmt.Printf("upstream        %s\n", cfg.Upstream)
	fmt.Printf("auth token      %s\n", presence(cfg.AuthToken))
	fmt.Printf("session salt    %s\n", presence(cfg.SessionSalt))

	store := codex.NewStore(nil, storeOptions(cfg))
	fmt.Printf("codex sources   %s\n", strings.Join(store.Sources(), ", "))
	token, err := store.Peek()
	if err != nil {
		fmt.Printf("codex           not signed in\n")
		return nil
	}
	fmt.Printf("codex           %s (%s)\n", accountLabel(token), planLabel(token))
	fmt.Printf("codex file      %s\n", store.Path())
	if !token.ExpiresAt.IsZero() {
		fmt.Printf("codex token     expires %s\n", token.ExpiresAt.Local().Format(time.RFC3339))
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

func runModels(args []string) error {
	var settingsJSON, rowsJSON bool
	cfg, _, err := commonFlags("models", args, func(fs *flag.FlagSet) {
		fs.BoolVar(&settingsJSON, "settings-json", false,
			"print a modelPicker block to merge into Claude Code's settings.json")
		fs.BoolVar(&rowsJSON, "json", false,
			`print the picker rows as [{"id","label","description"}]`)
	})
	if err != nil {
		return err
	}
	if settingsJSON && rowsJSON {
		return fmt.Errorf("--settings-json and --json cannot be combined")
	}
	registry := codex.NewRegistry(cfg.Codex.Models, cfg.Codex.ModelPrefix, cfg.Codex.EffortVariants)

	switch {
	case settingsJSON:
		return printSettingsJSON(registry)
	case rowsJSON:
		return printJSON(modelRows(registry))
	}

	for _, row := range registry.PickerOptions() {
		resolution, ok := registry.Resolve(row.Model)
		if !ok {
			continue
		}
		effort := resolution.Effort
		if effort == "" {
			effort = resolution.Model.DefaultEffort + " (default)"
		}
		fmt.Printf("%-28s %-24s context %7d  effort %-16s behaves as %s\n",
			row.Model, resolution.Model.ID, resolution.Model.ContextLength, effort, row.BehavesAs)
	}
	return nil
}

// modelRow is one line of `ccmproxy models --json`: the id to put in a
// picker row or an agent's `model`, and its label and description.
type modelRow struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Description string `json:"description"`
}

func modelRows(registry *codex.Registry) []modelRow {
	options := registry.PickerOptions()
	rows := make([]modelRow, 0, len(options))
	for _, option := range options {
		rows = append(rows, modelRow{ID: option.Model, Label: option.Label, Description: option.Description})
	}
	return rows
}

// printSettingsJSON emits the settings.json fragment that puts the added
// models in Claude Code's /model picker.
//
// This is the client-side half of the integration and needs no cooperation
// from the proxy: Claude Code's picker is built from its own catalog plus
// `modelPicker.options`, and never from the /v1/models endpoint.
func printSettingsJSON(registry *codex.Registry) error {
	block := map[string]any{
		"modelPicker": map[string]any{
			"options": registry.PickerOptions(),
		},
	}
	if err := printJSON(block); err != nil {
		return err
	}

	settingsPath := "~/.claude/settings.json"
	fmt.Fprintf(os.Stderr, "\n# Merge the block above into %s, for example:\n", settingsPath)
	fmt.Fprintf(os.Stderr, "#   ccmproxy models --settings-json > /tmp/picker.json\n")
	fmt.Fprintf(os.Stderr, "#   jq -s '.[0] * .[1]' %s /tmp/picker.json > /tmp/merged.json\n", settingsPath)
	fmt.Fprintf(os.Stderr, "#   mv /tmp/merged.json %s\n", settingsPath)
	fmt.Fprintf(os.Stderr, "# Restart Claude Code, then open /model.\n")
	fmt.Fprintf(os.Stderr, "# Reasoning effort is Claude Code's own control: /effort or --effort.\n")
	return nil
}

func printJSON(value any) error {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return fmt.Errorf("encode JSON: %w", err)
	}
	return nil
}

func runEnv(args []string) error {
	var shell string
	cfg, _, err := commonFlags("env", args, func(fs *flag.FlagSet) {
		fs.StringVar(&shell, "shell", "posix", "posix, fish, powershell or json")
	})
	if err != nil {
		return err
	}
	vars, err := envVars(cfg)
	if err != nil {
		return err
	}
	out, err := formatEnv(vars, shell)
	if err != nil {
		return err
	}
	fmt.Print(out)
	return nil
}

// envVars lists the environment Claude Code needs to reach the proxy: the
// base URL, the secret header and tool search, which Claude Code turns off
// for a base URL that is not Anthropic's.
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

// formatEnv renders vars for a shell, quoting every value.
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
			fmt.Fprintf(&b, "$env:%s = '%s'\n", kv[0], strings.ReplaceAll(kv[1], "'", "''"))
		}
	case "posix", "sh", "bash", "zsh", "":
		for _, kv := range vars {
			fmt.Fprintf(&b, "export %s='%s'\n", kv[0], strings.ReplaceAll(kv[1], "'", `'\''`))
		}
	default:
		return "", fmt.Errorf("unknown shell %q; use posix, fish, powershell or json", shell)
	}
	return b.String(), nil
}

func quoteFish(value string) string {
	value = strings.ReplaceAll(value, `\`, `\\`)
	value = strings.ReplaceAll(value, `'`, `\'`)
	return "'" + value + "'"
}

// runVersion reports the build, which matters when a released binary is
// being compared against a local one.
func runVersion() error {
	fmt.Printf("ccmproxy %s\n", version)
	fmt.Printf("  go       %s\n", runtime.Version())
	fmt.Printf("  platform %s/%s\n", runtime.GOOS, runtime.GOARCH)
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, setting := range info.Settings {
			switch setting.Key {
			case "vcs.revision":
				fmt.Printf("  revision %s\n", setting.Value)
			case "vcs.time":
				fmt.Printf("  built    %s\n", setting.Value)
			}
		}
	}
	return nil
}

func runConfig(args []string) error {
	action := "init"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		action, args = args[0], args[1:]
	}
	if action != "init" {
		return fmt.Errorf("unknown config action %q; only `init` is supported", action)
	}

	// The file is not loaded through commonFlags: Load refuses a file others
	// can read, and init is what fixes that.
	_, configPath, err := parseFlags("config", args, nil)
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
	switch {
	case result.Created:
		fmt.Printf("Wrote %s\n", result.Path)
	case len(result.Added) > 0:
		fmt.Printf("Added %s to %s\n", strings.Join(result.Added, " and "), result.Path)
	case result.Tightened:
		fmt.Printf("%s already had every key\n", result.Path)
	default:
		fmt.Printf("%s is up to date\n", result.Path)
	}
	if result.Tightened {
		fmt.Printf("Restricted %s to mode 600: it holds the proxy's secret\n", result.Path)
	}
	if result.Created || containsString(result.Added, "auth_token") {
		fmt.Println("Run `ccmproxy env` for the settings Claude Code needs.")
	}
	return nil
}

func containsString(list []string, want string) bool {
	for _, item := range list {
		if item == want {
			return true
		}
	}
	return false
}

func accountLabel(token *codex.Token) string {
	if token == nil {
		return "unknown account"
	}
	if token.Email != "" {
		return token.Email
	}
	if token.AccountID != "" {
		return token.AccountID
	}
	return "unknown account"
}

func planLabel(token *codex.Token) string {
	if token == nil || token.PlanType == "" {
		return "plan unknown"
	}
	return token.PlanType + " plan"
}
