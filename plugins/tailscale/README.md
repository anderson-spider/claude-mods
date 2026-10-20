# tailscale

Query or modify your tailnet through the Tailscale API.

```text
/plugin install tailscale --marketplace anderson-spider/claude-mods
```

Set the `apiKey` plugin option (a sensitive field, kept in secure storage) with a `tskey-api-...` API key, from the plugin's configuration in `/plugin`. Set it in your user options, not in a repository's settings. `tskey-client-...` OAuth secrets require a token exchange this plugin does not provide. Without the option the tools answer with an error that says where to set it.

## Use

- `mcp__tailscale__tailscale_get`: read resources; use `fields` to reduce an unpaginated response. Reads show the response ETag and filter secret fields.
- `mcp__tailscale__tailscale_write`: change resources after confirmation. Writes retain the full response because new-key secrets are returned only once. Whole-tailnet deletion is refused.

Paths are relative to `https://api.tailscale.com/api/v2`, begin with `/`, and use `-` for the default tailnet (for example `/tailnet/-/devices`). External URLs and traversal/encoded path segments are rejected.

For ACL updates, GET `/tailnet/-/acl`, then POST with its quoted ETag in `ifMatch`; a concurrent edit returns 412 rather than being overwritten. String bodies that are not JSON use HuJSON, allowing policy comments. Keep reads and writes under separate permission rules if you want read-only calls auto-approved.

## Privacy

The key comes only from the `apiKey` option, not from tool input or the environment. It is sent only in the `Authorization` header to the Tailscale API, and the plugin's own messages never include it. On every call the plugin reads the project and local settings; if either declares `apiKey` for this plugin, or the settings cannot be read, the call is refused and nothing is sent, because the repository could otherwise choose which account the key is used under. Requests go only to the Tailscale API. Read responses remove the fields `machineKey`, `nodeKey`, `tailnetLockKey`, `secret`, `s3SecretAccessKey` and `token`, and any field whose name ends in `Key`, `Secret` or `Token`; write responses are unfiltered, so handle new secrets privately.

## Tests

Pure API, key and host tests use fake fetches and settings: key sources and refusals, path refusals, whole-tailnet deletion, redaction, registration and ETag/If-Match behavior. They do not exercise a real tailnet.

For editing pointers and check commands, see [AGENTS.md](AGENTS.md).
