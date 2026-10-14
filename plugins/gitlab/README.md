# gitlab

Work on GitLab merge requests and pipelines of the repository you are in. The plugin reads the repository's git remote, so the same four tools reach gitlab.com in one repository and a self-managed GitLab in another, each with its own token.

```text
/plugin install gitlab --marketplace anderson-spider/claude-mods
```

Set the `tokens` plugin option (a sensitive field, kept in secure storage) from the plugin's configuration in `/plugin`: one `host=token` pair per GitLab, separated by commas, for example `gitlab.com=glpat-...,gitlab.example.com=glpat-...`. Use personal access tokens with the `api` scope (`read_api` is enough if you only read). Set it in your user options, not in a repository's settings. A host with a port in an https remote is written with it (`gitlab.example.com:8443=...`).

## Use

The project is the `origin` remote (or the first remote when there is no `origin`), in SSH (`git@host:group/project.git`, `ssh://git@host:port/group/project.git`) or https form. The API is always `https://<host>/api/v4`. Without an `iid`, a merge request action works on the open merge request whose source is the current branch.

- `mcp__gitlab__gitlab_mr`: `list` (by state and branches), `get` (with description), `diff` (optionally only some files), `commits`, `create` (the source defaults to the current branch and the target to the project's default branch; labels, assignees, reviewers, draft, squash, remove source branch), `update` (the same fields, plus adding or removing labels, draft on or off, close or reopen), `approve`, `unapprove`, `rebase`. Assignees and reviewers are usernames; `@me` is the token's own user. Merging is not offered.
- `mcp__gitlab__gitlab_mr_comment`: `list` the discussions (id, authors, file and line, resolved, optionally only unresolved), `comment`, `reply` to a discussion, `line` (a comment on the diff at a new-side line, an old-side line, or both for an unchanged line), `edit` a note, `resolve`, `unresolve`. Deleting a comment is not offered.
- `mcp__gitlab__gitlab_pipeline`: `list` the pipelines of a merge request (the current branch's by default) or of a ref, `jobs` of a pipeline (the latest by default) with its downstream pipelines and an option for failed jobs only, `retry` or `cancel` a job or a pipeline, `play` a manual job.
- `mcp__gitlab__gitlab_job_log`: a job's log without terminal colours or section markers. `errors` (the default) shows the lines that look like errors, or match `pattern`, with three lines around each, then the last 30 lines; `tail` the last `lines` lines (100 by default); `full` the whole log, cut at 60,000 characters.

Answers are compact JSON with the fields worth reading, not GitLab's full objects. Lists stop at GitLab's first page (20 merge requests, 10 pipelines, 100 jobs, discussions or diff files).

Not covered: SSH host aliases from `~/.ssh/config` (the remote must name the real host), a GitLab served under a path (`https://example.com/gitlab`), and OAuth tokens.

## Privacy

Tokens come only from the `tokens` option, never from tool input or the environment. Each token is sent only to the host it is paired with, in the `PRIVATE-TOKEN` header, and never appears in a result or error. On every call the plugin reads the project and local settings; if either declares `tokens` for this plugin, or the settings cannot be read, the call is refused and nothing is sent. A remote URL is never echoed, since an https remote can carry a password. The plugin runs `git remote` and `git rev-parse` in the session's directory and sends requests only to the remote's GitLab host.

## Tests

Pure tests cover remote parsing, token selection and refusals, each tool's requests and answers against a fake API, and the job-log cleanup and excerpt; host tests run the plugin against a fake host (`tests/host.ts`) with fake git, settings and network. They do not reach a real GitLab. For editing pointers and check commands, see [AGENTS.md](AGENTS.md).
