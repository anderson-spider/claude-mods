# gitlab

Work on GitLab merge requests, pipelines and labels of the repository you are in, from opening a merge request to merging it. The plugin reads the repository's git remote, so the same tools reach gitlab.com in one repository and a self-managed GitLab in another, each with its own token.

```text
/plugin install gitlab --marketplace anderson-spider/claude-mods
```

Set the `tokens` plugin option (a sensitive field, kept in secure storage) from the plugin's configuration in `/plugin`: one `host=token` pair per GitLab, separated by commas, for example `gitlab.com=glpat-...,gitlab.example.com=glpat-...`. Use personal access tokens with the `api` scope (`read_api` is enough if you only read). Set it in your user options, not in a repository's settings. A host with a port in an https remote is written with it (`gitlab.example.com:8443=...`).

## Use

The project is the `origin` remote (or the first remote when there is no `origin`), in SSH (`git@host:group/project.git`, `ssh://git@host:port/group/project.git`) or https form. An SSH remote that names a host alias from `~/.ssh/config` (`git@work:group/project.git`) is resolved with `ssh -G`, which reads the configuration and connects nowhere, and the real host's token is used; an alias that cannot be resolved is reported as such. The API is always `https://<host>/api/v4`. Without an `iid`, a merge request action works on the open merge request whose source is the current branch.

Every tool takes `project`, the path of another project on the same host (`group/subgroup/project`), which then replaces the remote's project. It is a path, never a URL, so the token never goes to another host. With `project`, actions on a merge request need `iid`: the current branch belongs to the remote's project.

- `mcp__gitlab__gitlab_mr`:
  - `list`: by `state`, branches, `author`, `assignee`, `reviewer` (usernames or `@me`), `labels`, `search` and `scope` (`created_by_me`, `assigned_to_me`, `all`). `allProjects: true` lists across every project on the host (GitLab's own default there is your own MRs; a people filter widens it to `all`) and names each item's project in `ref` (`group/project!7`).
  - `get` (with description), `diff` (optionally only some files), `commits`.
  - `status`: what decides whether it can merge, in one call. That is GitLab's merge status, conflicts, whether blocking discussions are resolved, draft, the head pipeline (id, status, URL) and whether it ran on the head `sha`, approvals (approved, how many are missing, by whom) and approval rules when the instance has them, plus branches, `sha`, people, labels, URL, and `blockers`, the reasons it cannot merge yet. The pipeline counts as a blocker only when GitLab's merge status says the project requires it (`ci_must_pass`, `ci_still_running`).
  - `create` (the source defaults to the current branch and the target to the project's default branch; labels, assignees, reviewers, draft, squash, remove source branch) and `update` (the same fields, plus adding or removing labels, draft on or off, close or reopen). Assignees and reviewers are usernames; `@me` is the token's own user. Labels that do not exist in the project are refused by name; `createMissingLabels: true` creates them first (`#428BCA`). GitLab is never left to create one silently.
  - `approve`, `unapprove`, `rebase`.
  - `merge`, only when the user asks: see [Guards](#guards). Options: `squash`, `removeSourceBranch`, `whenPipelineSucceeds` (auto-merge).
- `mcp__gitlab__gitlab_mr_comment`: `list` the discussions (id, authors, file and line, resolved, optionally only unresolved), `comment`, `reply` to a discussion, `line` (a comment on the diff at a new-side line, an old-side line, or both for an unchanged line), `edit` a note, `resolve`, `unresolve`.
- `mcp__gitlab__gitlab_pipeline`: `list` the pipelines of a merge request (the current branch's by default) or of a ref; `jobs` of a pipeline (the latest by default) with its downstream pipelines and an option for failed jobs only; `run` a merge request pipeline (`iid`, or the current branch's MR) or a pipeline of `ref` (the current branch when it has no MR) with `variables` as `KEY=value`; `retry` or `cancel` a job or a pipeline; `play` a manual job; `artifacts` of a job (type, name, size, expiry) with the download and browse URLs, which carry no token. Downloading them is left to you.
- `mcp__gitlab__gitlab_job_log`: a job's log without terminal colours or section markers. `errors` (the default) shows the lines that look like errors, or match `pattern`, with three lines around each, then the last 30 lines; `tail` the last `lines` lines (100 by default); `full` the whole log, cut at 60,000 characters.
- `mcp__gitlab__gitlab_label`: `list` the project's labels, its groups' included (name, colour, description; `search`); `create` one (`name`, `color` default `#428BCA`, `description`), which answers the existing label when the name is taken.

Answers are compact JSON with the fields worth reading, not GitLab's full objects. Lists take `page` and `perPage` (at most 100) and answer `next` when GitLab has another page. The defaults are 20 merge requests, 10 pipelines, and 100 jobs, discussions, diff files, commits or labels.

### Guards

- Someone else's merge request: every write on one (`update`, `approve`, `unapprove`, `rebase`, `merge`, the comment writes, a merge request pipeline `run`) is refused when its author is not the token's user, unless `allowOthers: true`. Pass it only when the user asked to write on a colleague's merge request. Retrying, cancelling or playing a job or pipeline by id is not guarded.
- `merge` needs an explicit `iid` (it never defaults to the current branch) and the full head `sha` from `status`. The plugin compares it first, and GitLab refuses the merge if the head moved meanwhile. A draft, conflicts, unresolved blocking discussions or a merge request that is not open are refused whatever the flags. A target named `release*`, or any other protected branch than `main`, `master` or `develop`, needs `allowProtectedTarget: true`. Whether a target is protected is read from `GET /repository/branches/:name`, which applies wildcard rules; if it cannot be read, the merge is refused.

### Errors

A refused call names the project and GitLab's status and message, then what to do. A 401 means the token was refused (expired or revoked); a 403 on a write usually means the token lacks the `api` scope or the user's role does not allow it; a 404 means the project or the number is wrong, or the user cannot see it. A missing token names the host to add, and a missing label names the label.

There is no generic API tool: every call goes through an action built for it, so the token cannot be used for reads or writes the plugin does not name. Not covered: a GitLab served under a path (`https://example.com/gitlab`), and OAuth tokens.

## Privacy

Tokens come only from the `tokens` option, never from tool input or the environment. Each token is sent only to the host it is paired with, in the `PRIVATE-TOKEN` header; if an answer echoes it (a proxy's error page, a pasted comment), it reaches the model as `[token]`. On every call the plugin reads the project and local settings; if either declares `tokens` for this plugin, or the settings cannot be read, the call is refused and nothing is sent. A remote URL is never echoed, since an https remote can carry a password. The plugin runs `git remote` and `git rev-parse` in the session's directory, and `ssh -G <host>` only when the remote's host has no token (to resolve an alias), and sends requests only to the remote's GitLab host or the real host of its SSH alias.

## Tests

Pure tests cover remote parsing and SSH aliases, token selection and refusals, each tool's requests and answers against a fake API (paging, labels, status, every guard refused without its `allow*` flag and passing with it), the read-only path checks and the job-log cleanup and excerpt; host tests run the plugin against a fake host (`tests/host.ts`) with fake git, settings and network. They do not reach a real GitLab. For editing pointers and check commands, see [AGENTS.md](AGENTS.md).
