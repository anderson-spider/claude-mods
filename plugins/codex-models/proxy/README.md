# ccmproxy standalone

For the managed installation, use the [plugin README](../README.md). This path is for running the proxy without its macOS installer; the proxy supports macOS/Linux. Tool versions come from the repository's `mise.toml`.

## Run

From this directory, with mise tools available:

```sh
GOFLAGS=-tags= GOTOOLCHAIN=local go build -trimpath -ldflags "-X main.version=dev" -o ccmproxy ./cmd/ccmproxy
./ccmproxy config init
./ccmproxy login codex
./ccmproxy serve
```

In another terminal:

```sh
eval "$(./ccmproxy env)"
claude
```

**Secret:** `ccmproxy env` prints the proxy token; handle its output like a password. `--shell fish|powershell|json` supports other shells/settings. Contract-tagged binaries contain test injection points and are not for installation; the normal build above clears ambient tags/toolchain overrides.

## Discover current configuration

Use `./ccmproxy --help` for commands, `./ccmproxy models --json` for catalog/picker rows and `./ccmproxy status` for config/login. `models --settings-json` prints a picker block to merge; `/model` uses `modelPicker.options`, not `/v1/models` discovery. An unknown-model row needs `behavesAs` naming a Claude model the installed client knows.

For Claude Code's assumed context window, append `[1m]` to the model id or set `CLAUDE_CODE_MAX_CONTEXT_TOKENS`; the proxy strips that suffix. Effort and credentials are described in the [plugin README](../README.md#use).

The standalone config defaults under `~/.config/ccmproxy/`; relocate with `CCMPROXY_HOME`/`XDG_CONFIG_HOME` or select a file with `--config`. `config init` generates missing secrets while preserving existing members; use the generated file instead of copying defaults from documentation. Keep configuration/credentials private and load only literal-loopback listener addresses.

## Editing and contracts

Before changing routing, auth, transport, config or installation behavior, read [AGENTS.md](../AGENTS.md#safety-and-contracts). It owns the module map, security invariants and reader/transcript contracts. For black-box expectations and golden changes, read [contract/README.md](contract/README.md).

Test commands, privacy/data flows and live gaps are linked from the [plugin README](../README.md#tests-and-live-gaps).
