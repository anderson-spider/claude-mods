# coolify

Query or change your Coolify instance (projects, applications, services, deployments) through the Coolify API.

```text
/plugin install coolify --marketplace anderson-spider/claude-mods
```

Set two plugin options from the plugin's configuration in `/plugin` (or `claude plugin configure coolify`), in your user options, not in a repository's settings:

- `url`: your instance's https address, such as `https://coolify.example.com`, or `https://app.coolify.io` for Coolify Cloud. Plain `http` is refused so the token never travels in clear text.
- `apiKey` (sensitive, kept in secure storage): a token from **Keys & Tokens > API tokens**. Give it only the permissions Claude needs (`read`, `deploy`, `write`) and leave out `read:sensitive` and `root`, so Coolify itself hides secrets from the answers.

Without either option the tools answer with an error that says where to set it.

## Use

- `mcp__coolify__coolify_get`: read the API, such as `/projects`, `/projects/{uuid}`, `/resources`, `/applications/{uuid}` or `/deployments`. Use `fields` to reduce a long answer.
- `mcp__coolify__coolify_write`: change the instance after confirmation. Create a project with `POST /projects` and body `{"name": "web"}`, deploy with `POST /deploy?uuid=<resource uuid>`, create an application with one of the `POST /applications/...` endpoints, delete with `DELETE /projects/{uuid}`.

Paths are relative to `<url>/api/v1` and begin with `/`; external URLs and traversal or encoded path segments are rejected. The endpoints are listed in the [Coolify API reference](https://coolify.io/docs/api-reference).

A `DELETE` is sent only when its `confirm` input repeats the id at the end of the path, which the tool asks for after the user agrees to the deletion, so a mistyped or stray path deletes nothing. Turning the instance's API or MCP server on or off, and creating integration tokens, are refused. Keep reads and writes under separate permission rules if you want read-only calls auto-approved.

## Privacy

The instance and token come only from the `url` and `apiKey` options, not from tool input or the environment. The token is sent only in the `Authorization` header to that instance and never appears in a result or error. On every call the plugin reads the user, project and local settings; if the project or local settings declare `url` or `apiKey` for this plugin with a value your user settings do not give it, or the settings cannot be read, the call is refused and nothing is sent, because a repository could otherwise send your token to a host it chose. A value equal to your own is accepted, so a session opened in your home folder, where the project settings are your own `~/.claude/settings.json`, still works. Read answers remove fields named like a password, secret, token or private key, and the values of environment variables; write answers are unfiltered.

## Tests

Pure API, option and host tests use fake fetches and settings: option sources and refusals, URL refusals, the delete confirmation, forbidden calls, redaction and registration. They do not exercise a real Coolify instance.

For editing pointers and check commands, see [AGENTS.md](AGENTS.md).
