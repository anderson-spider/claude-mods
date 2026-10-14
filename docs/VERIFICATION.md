# Verification

Run `mise run plugins:validate` and `mise run plugins:test` for current results. Plugin READMEs describe their tests and live gaps; reach them from the [plugins table](../README.md#plugins). Test counts belong to the current run, not this document.

The function hooks API is early access: a Claude Code update can break behavior without a repository test failing. Unit tests and local fakes do not replace validation against real upstreams or visual acceptance.

## What they do not prove

- The plugins use the function hooks API, in early access, so a Claude Code update can break them without a test failing here.
