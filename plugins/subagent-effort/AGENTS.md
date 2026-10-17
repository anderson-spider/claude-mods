# subagent-effort

Usage/privacy: [README.md](README.md). Each module has a mirror test in `tests/`; `tests/host.ts` is the fake host (`world`, `started`, `call`, `settle`), and fake coverage is not live routing evidence.

## Modules

- `hooks/register.tsx`: every `on(...)` and `$` call. `session.start` registers the `subagent-effort-stats` command; the `tool.call` hook on `Agent` routes the effort and its `.catch` dispatches the call as it came when routing fails; `turn.complete` ends background runs; `command.run` prints the Jev access of this session and the summary. Host access stays literal here and goes only to top-level functions of this file (`io`, `files`, `observe`, `record`, `accessLine`, `warnOff`, `dispatched`). The hook rewrites the `Agent` call, not `agent.spawn`, because the spawn takes a model but no effort. `tests/register.test.ts` (`Jev sets the effort of any native agent type, shown in its description, and leaves the model alone`, `a routing failure dispatches the call once as it came and writes no record`).
- `hooks/effort.ts`: the whole policy and the assessment: `QUESTION`, `EFFORTS` (one per criterion, `max` never), `POLICY`, `CALIBRATION` (bumped with any change to those three), `levelOf`, `distribution`, `clipped` (key, then `redact`, then the 4000-character cut) and `assessEffort`. `tests/effort.test.ts`: `every assessment failure picks no effort, names the reason, and a logging failure changes nothing`.
- `hooks/ledger.ts`: pure line builders (`decisionLine`, `afterAgentCall`, `afterTurn`), `createPending`, `appendLine` (one process-wide queue, rotation at `ROTATE_AT`), `parseLedger`, `summarize` and `formatSummary`. `tests/ledger.test.ts`: `the summary groups outcomes by model family and effort and counts decisions per source`.
- `hooks/jev.ts`, `hooks/key.ts`, `hooks/redact.ts`: fixed endpoint, user-environment key only, whole-text redaction before clipping, deadline, retry, gate and breaker. `key.ts` also owns `OFFS`, `isOff` and the fix text of each reason (`OFF_TEXT`). `tests/key.test.ts` (`any repository env declaration of JEV_API_KEY is refused`).

## Invariants

- Only the effort changes: the model and every other field of the call pass as they came. An effort in the call, a fork and an empty task pass untouched, and any routing failure dispatches the call as it came. `tests/register.test.ts` (`an effort already in the call is kept and recorded as the call's, and a fork or an empty task passes untouched`, `when Jev is off the call goes as it came, with one toast per reason in this load`).
- The ledger is the plugin's only file (`~/.claude/subagent-effort/routes.jsonl`, one rotated generation). A decision line goes in before dispatch, an outcome line after the host result; observation never changes the host result, and its failure is one fixed debug line. `tests/register.test.ts` (`observation survives a failing ledger: the dispatch and its result are unchanged and one debug line names the miss`).
- A line never holds the task, a prompt, an answer, a path or the key; the brief appears only as its length. `tests/register.test.ts`: `no line ever holds the task, a prompt, an answer, a path or the key`.
- The stats texts carry no plugin-name prefix: the host adds it. `tests/register.test.ts`: `the stats command checks Jev access the way routing does, summarizes the records and never prints the key`.

## Checks

[Root commands](../../AGENTS.md#commands).
