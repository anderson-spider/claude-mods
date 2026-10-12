# tailscale

Query or modify your tailnet through the Tailscale API.

```text
/plugin install tailscale --marketplace anderson-spider/claude-mods
```

Export `TS_API_KEY` before starting Claude Code. Use a `tskey-api-...` API key; `tskey-client-...` OAuth secrets require a token exchange this plugin does not provide.

## Use

- `mcp__tailscale__tailscale_get`: read resources; use `fields` to reduce an unpaginated response. Reads show the response ETag and filter secret fields.
- `mcp__tailscale__tailscale_write`: change resources after confirmation. Writes retain the full response because new-key secrets are returned only once. Whole-tailnet deletion is refused.

Paths are relative to `https://api.tailscale.com/api/v2`, begin with `/`, and use `-` for the default tailnet (for example `/tailnet/-/devices`). External URLs and traversal/encoded path segments are rejected.

For ACL updates, GET `/tailnet/-/acl`, then POST with its quoted ETag in `ifMatch`; a concurrent edit returns 412 rather than being overwritten. String bodies that are not JSON use HuJSON, allowing policy comments. Keep reads and writes under separate permission rules if you want read-only calls auto-approved.

## Privacy

`TS_API_KEY` is read from the environment on every call, not from tool input. Requests go only to the Tailscale API. Read responses remove named secrets and fields ending in `Key`, `Secret` or `Token`; write responses are unfiltered, so handle new secrets privately.

## Tests

Pure API and host tests use fake fetches: URL refusals, whole-tailnet deletion, redaction, registration and ETag/If-Match behavior. They do not exercise a real tailnet.

For editing pointers and check commands, see [AGENTS.md](AGENTS.md).
