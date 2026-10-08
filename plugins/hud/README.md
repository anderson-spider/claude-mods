# HUD

One band above the Claude Code prompt, with suggested next prompts above it: the context in tokens, your 5-hour and 7-day limits against the clock, whether the prompt cache is still warm, and which agents are running.

```
next:
  1: Run the tests
  2: Commit the change
  3: Open the PR
  0: dismiss

 Opus 5.5·medium | claude-mods | untitled-session-dc89ef ⎇wt
 ☂ 634k ▃▄▂█▆ ▲ +6.3k | cache 52m | hit 98% | agents 2× Haiku 5.5
 5h ██▏······┊· 22% ▼65 · 40m | 7d ██┊▉······· 29% ▲4 · 5d 6h
```

Three rows, in the same order in the terminal and in the app (where the second and third are tinted pills with hover cards): the session (model, repository, branch), what it is doing (context, cache, agents), and the 5-hour and 7-day limits next to the prompt.

- **Info**: the last request's model and effort (`Opus 5.5·medium`), the repository (its name even inside a worktree; the folder outside git), the git branch (green when clean, red with a `*` when the tree has changes), `⎇wt` in a linked worktree, and with changes the files changed against `HEAD` with the lines added and removed (`· 2 files +70 -4`, Unity YAML assets left out). On a narrow terminal the changes, effort, worktree mark and repository go first, in that order. The git figures refresh every 10 seconds.
- **Context**: tokens in the context with a weather icon (hover the pill for the weather and the share of the window), one bar per recent prompt, the last prompt's change. The icon follows the share, as in Token Weather: ☀ clear (under 25%), ☁ cloudy (25%), ☂ showers (50%), ☇ storm (75%), ↯ compact soon (90%).
- **Cache**: the time before the prompt cache lapses (1 hour on a subscription, 5 minutes on an API key, inferred), behind a bolt in the app. Beside the time, on the short 5-minute lifetime only: `5m TTL · x1.25`, what writing the cache again costs against the input price, also when it is expired (the usual 1 hour goes unsaid). Yellow under a sixth of the lifetime (10 minutes of 1 hour, 50 seconds of 5 minutes), with what is at stake ("107k at stake"); red "expired" with the size of the context to write again ("289k to rewrite"), and the way out from 100k tokens: `/compact`, or a new thread from 300k (on the row in the terminal, in the hover card in the app). In the app, hover the cache pill for the expiry time and the advice. The cache speaks in tokens, never dollars. After a compaction the band updates at once: the context drops, and the cache reads "compacted" until the next message writes a new one.
- **Hit**: the share of the last message read from the cache, in a block of its own while the cache is warm; yellow with "missed" and its cause when the cache was written again. Hover the pill in the app for the tokens read, or what the miss wrote.
- **Agents**: shown while subagents run, after the cache. In the terminal, by model (`agents 2× Haiku 5.5 · Sonnet 5.5`; one before its first request goes by its type); in the app, a count, and hover the pill for their tasks.
- **5h / 7d**: the share of your account's limits already used, as a bar of ten cells filled in eighths, in green, yellow or red by pace, dots for the rest, and `┊` between the cells where the clock stands. Then the percentage, a mark and the gap in points against the clock: ▲ ahead (amber, red beyond 15 points or at 90% used), ▼ behind (green), no mark on pace. A lead of up to the **Pace start** option (0 points by default) counts as on pace. Then the time left; in the app, hover the 5-hour pill for the reset time (machine's time zone). On a narrow terminal the bars go first, then the times left.

Labels are in English (en-US).

## Next steps

After each answer, the mod asks the session's own model (a fork that shares the prompt cache, so it costs about one short reply) for up to three prompts you are likely to type next, and draws them above the usage line:

```
next:
  1: Run the tests
  2: Commit the change
  3: Open the PR
  0: dismiss
```

- Press `1`, `2` or `3` (from an empty prompt box, or click) to write that suggestion directly to the prompt box as a draft and hide the offer. Edit the draft and press Enter yourself; the mod never sends a prompt. If the fill fails, the offer stays hidden and a toast reports the failure. `0` dismisses.
- The first suggestion is also the prompt box's dim ghost text, so Tab takes it.
- A `/skill args` suggestion is filled as it is, so it runs as a command when you send the draft.
- The block goes away while Claude works, when a new turn starts and during a survey. It draws in the terminal and in the app.
- Layout, top to bottom: what other mods draw above the prompt (the order changed: they used to sit below the usage line), the suggestions, a blank line, the three rows of the band, then the prompt. The band stays next to the prompt however the block comes and goes.
- **Shortest answer to suggest after** (`minAnswerChars`, 80): no suggestions after a shorter answer.
- **Suggest skills and slash commands** (`suggestSkills`, on): tell the fork which skills and slash commands the session has, so a suggestion can be one of them.

This replaces the community `next-steps` plugin: turn that one off in `/plugin`, or you get two blocks.

## Privacy

No personal data collected, sent or retained, no network requests of its own. The suggestions are one more request to the session's own model (the fork), carrying the conversation already in the session and the names and descriptions of its skills; nothing else leaves the machine. The mod reads the usage figures Claude Code provides (context, limits, session cost, each request's cache token counts), the list of the session's subagents, the locale variables and the prompt-cache switches, and keeps in the plugin's local storage the latest limits reading and, per session, recent context readings, the last request's cache figures, what the cache saved in the session and the last prompt's cost (deleted after 8 idle days).

## Credits and license

HUD is built on the work of others, adapted or used as the idea:

- **Token Weather**, by Anthropic ([claude-code-playground](https://github.com/anthropics/claude-code-playground), Apache-2.0): the weather icons, the context tokens and the turns chart.
- **Token Weather Usage** 3.10.7, by Eric Cologni ([augiefra/claude-mods](https://github.com/augiefra/claude-mods/tree/main/plugins/token-weather-usage), Apache-2.0): the base of this plugin, which was named `token-weather-usage` until 1.0.0. The changes from it are listed in the [NOTICE](NOTICE).
- **next-steps** 1.0.0, by Thariq Shihipar (claude-community marketplace, MIT): the suggested next prompts (the fork, the text cleaning, the skill list and the buttons), with each suggestion written directly to the prompt box as a draft.
- **usage-meter**, by HolyGrail ([HolyGrail/claude-mods](https://github.com/HolyGrail/claude-mods/tree/main/plugins/usage-meter)): the idea of the limit gauges, written again without copying its code.
- **prompt-cache-control**, by Daniel San ([davila7/claude-code-templates](https://github.com/davila7/claude-code-templates), MIT): the idea of the cache block, written again without copying its code.

Apache-2.0 license: see [LICENSE](LICENSE) and [NOTICE](NOTICE), which also carries the MIT text of next-steps.
