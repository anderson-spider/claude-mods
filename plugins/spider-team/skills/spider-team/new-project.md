# New project

A greenfield run: the request is to build a new project or app, and the working directory is empty. Workers see only files, so the spec lives in files, and the user approves it before any task is delegated.

1. **Git.** Without a repository, run `git init` and add a `.gitignore` for the stack. Commit the docs below as soon as they are written, before approval, then after each accepted task.
2. **Questions.** Ask in one batch what the request does not settle: platform and stack, users, the MVP boundary, non-goals, hard constraints (deadline, hosting, accounts).
3. **`docs/SPEC.md`.** Goals, non-goals, stack with versions, modules and what each owns, data model, external integrations, key user flows, and what done means for the MVP.
4. **`docs/PLAN.md`.** The tasks `T1..Tn` as Plan defines them, each with a one-paragraph brief. `T1` is the scaffold: the code structure, dependencies and the build, test, run and lint commands, since the docs of this list already exist. Its brief requires that the commands in `AGENTS.md` and the entries in `filemap.md` match what it built, updating both where they differ, and Review checks it. It runs alone.
5. **`AGENTS.md`**, with a `CLAUDE.md` holding `@AGENTS.md`. Every session and worker loads it, so it holds 20 to 40 lines of what an agent would get wrong without it: the stack in one line, the exact commands, the non-obvious conventions, and pointers to `docs/SPEC.md`, `docs/PLAN.md` and `filemap.md`. A rule that needs a paragraph goes to `docs/` behind a pointer.
6. **`filemap.md`.** One line per directory and significant file, `path — what lives here`. A brief that adds or moves files tells the worker to update it, and Review checks it.
7. **Design.** With a UI, settle the main screens and flows (Design) and record the decisions in `docs/SPEC.md`.
8. **Approval.** Show the spec and the plan in summary and wait until the user approves both; edit them on feedback.

Understand ends at approval, and Plan publishes the tasks of `docs/PLAN.md`. Run the scaffold, review and commit it, then the rest by `after`. Each brief cites its section of `docs/SPEC.md` and its paragraph of `docs/PLAN.md` instead of restating them. Mark each accepted task in `docs/PLAN.md`, so a later session resumes from it.
