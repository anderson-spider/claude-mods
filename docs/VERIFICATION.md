# Verification

Run `mise run plugins:validate` and `mise run plugins:test` for current results. Plugin READMEs describe their tests and live gaps; reach them from the [plugins table](../README.md#plugins). Test counts belong to the current run, not this document.

The function hooks API is early access: a Claude Code update can break behavior without a repository test failing. Unit tests and local fakes do not replace validation against real upstreams or visual acceptance.

## crew

`claude plugin test plugins/crew`

| Plugin | Tests | Host |
| --- | --- | --- |
| crew | See [crew verification](../plugins/crew/README.md#verification) for coverage and live gaps | Test host with fake network access |

## What they do not prove

- Crew: see [verification and live gaps](../plugins/crew/README.md#verification).
- The plugins use the function hooks API, in early access, so a Claude Code update can break them without a test failing here.
