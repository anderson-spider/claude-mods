# spider-progress

Progress band under the session card and an agents pane for spider-team runs and any subagent

```text
/plugin install spider-progress --marketplace anderson-spider/claude-mods
```

## Use

- `mcp__spider-progress__spider_progress_echo`: a sample tool that returns its text, upper-cased in `upper` mode, followed by its tags. Replace it with this plugin's first tool.

## Privacy

The sample tool reads and sends nothing outside the session.

## Tests

Pure logic tests call `hooks/echo.ts` directly; host tests run the plugin against a fake host (`tests/host.ts`) with no network. For editing pointers and check commands, see [AGENTS.md](AGENTS.md).
