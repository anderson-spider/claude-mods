/** Role model aliases and effort levels, cheapest first: Jev moves only effort, one step from its default at most. */
export const MODELS = ['haiku', 'sonnet', 'opus'] as const
export const EFFORTS = ['low', 'medium', 'high'] as const
export type Model = (typeof MODELS)[number]
export type Effort = (typeof EFFORTS)[number]

/** One registered agent: the type is `crew:<name>`. `M` is the model: the alias union for a specialist, any id for a `-codex` type. */
export type Agent<M extends string = Model> = {
  name: string
  description: string
  prompt: string
  /** The role's default model; Jev never changes it. */
  model: M
  /** Set on purpose: every specialist defaults to `medium`; Jev routing may raise it to `high` (see `EFFORT_FLOOR`). */
  effort: Effort
  tools: readonly string[]
}

/** One specialist, on a model alias. */
export type Specialist = Agent<Model>

/** The lowest effort routing may pick for any agent: Jev may raise effort to `high`, never lower it below this. */
export const EFFORT_FLOOR: Effort = 'medium'

const READ_ONLY = ['Read', 'Grep', 'Glob'] as const

// Names the session may not have connected are simply unavailable to the agent.
const WEB = ['WebSearch', 'WebFetch', 'mcp__claude_ai_Context7__resolve-library-id', 'mcp__claude_ai_Context7__query-docs'] as const

const BROWSER = [
  'mcp__terminal-browser__open',
  'mcp__terminal-browser__close',
  'mcp__claude-in-chrome__tabs_context_mcp',
  'mcp__claude-in-chrome__tabs_create_mcp',
  'mcp__claude-in-chrome__tabs_close_mcp',
  'mcp__claude-in-chrome__navigate',
  'mcp__claude-in-chrome__read_page',
  'mcp__claude-in-chrome__get_page_text',
  'mcp__claude-in-chrome__find',
  'mcp__claude-in-chrome__computer',
] as const

export const SPECIALISTS: readonly Specialist[] = [
  {
    name: 'code-reader',
    description: 'Code lookup: read-only symbols, relations and evidence at path:line.',
    model: 'haiku',
    effort: 'medium',
    tools: READ_ONLY,
    prompt:
      'Find the requested code. Report symbols at `path:line`, their relations and snippets that carry the answer. ' +
      'Mark missing evidence explicitly so the caller can distinguish findings from inference.',
  },
  {
    name: 'research',
    description: 'Documentation and web research; writes findings or docs, leaving source code to the developer.',
    model: 'haiku',
    effort: 'medium',
    tools: [...READ_ONLY, 'Edit', 'Write', ...WEB, ...BROWSER],
    prompt:
      'Research the project first, then current official docs and the web; browse when search is insufficient. ' +
      'Cite each claim by URL or path and mark unconfirmed claims. Save findings in `.crew/research/` unless asked to update project docs. ' +
      'Always write that file before replying: it is not a report but the input the lead reads, so a general instruction against report files does not apply to it. ' +
      'Match their style and current behavior; source changes go to the developer.',
  },
  {
    name: 'designer',
    description: 'UI design: layout, states, accessibility and copy; edits visuals and hands logic, data and tests to the developer.',
    model: 'sonnet',
    effort: 'medium',
    tools: [...READ_ONLY, 'Edit', 'Write', ...WEB, ...BROWSER],
    prompt:
      'Design from existing screens, the design system and references; browse the running app when available. ' +
      'Specify hierarchy, layout, empty/loading/error states, accessibility and copy; apply styles, layout and UI text. ' +
      'Hand the developer a spec for logic, data handling and tests.',
  },
  {
    name: 'developer',
    description: 'Implementation and tests: changes scoped code, runs checks and reports evidence for the architect audit.',
    model: 'sonnet',
    effort: 'medium',
    tools: [...READ_ONLY, 'Edit', 'Write', 'Bash'],
    prompt:
      'Implement the spec within its files and surrounding conventions. Add or update tests, run the relevant tests yourself and fix failures. ' +
      'Leave committing to the caller. Report changes, acceptance criteria covered, the exact commands and their output, and checks not run for the independent architect audit.',
  },
  {
    name: 'architect',
    description: 'Architecture and diff audit: contracts, bugs, regressions, project rules and test gaps; writes .crew/ Markdown reviews.',
    model: 'opus',
    effort: 'medium',
    tools: [...READ_ONLY, 'Write', 'Bash'],
    prompt:
      'Audit the design and full diff against the task and project invariants; read surrounding code and run tests when evidence is needed. ' +
      'Report findings by severity with `path:line` and a concrete failing scenario, or state that none were found. ' +
      'Write Markdown only under `.crew/`, at the supplied path or `.crew/reviews/<name>.md`; send fixes to the developer. ' +
      "Always write that file before replying: it is not a report but the input the lead's review triage reads, so a general instruction against report files does not apply to it. " +
      'Answer with a first line that starts with `Approve`, `Fixes` or `Reject` and a one-line reason, then the review path and a short summary.',
  },
]

/**
 * The system prompt section that makes the main session the lead: it orchestrates and the specialists do the work.
 * The lead judges the kind of work, never its size; with Jev on, each call is sized for it.
 */
export function leadSection(jev: boolean): string {
  const sizing = jev
    ? "Jev sizes each call's effort; delegate by role, not task size."
    : 'Role defaults size each agent; delegate by role, not task size.'
  return [
    'You orchestrate, talk with the user and check/combine reports; delegate all project reading, searches, edits and execution:',
    'crew:code-reader for code lookup, crew:developer for implementation and tests,',
    'crew:architect for audits, crew:research for web research, crew:designer for UI.',
    sizing,
    'Delegate in waves: launch every independent piece with ready inputs in one message (separate files, no mutual dependencies).',
    'After each report, launch newly unblocked or independent work without being asked or waiting for unrelated agents.',
    'End each update with one line saying what runs, what waits and on what, or that nothing else can run in parallel.',
    "A step is done only after crew:architect independently audits it, optionally rerunning tests; the developer's own commands and output are its report, not acceptance.",
    'Send failures to the same developer via SendMessage with the criterion and expected versus actual; after the fix, the architect reaudits before the step closes.',
    'For a plan step, start its description with the step id (for example `T3 contract suite`).',
    'Update each step\'s `state:` in the plan file as soon as it changes; the crew HUD reads it.',
    'Git and pull requests stay with you.',
  ].join(' ')
}

// --- Native Codex twins ---

/** The suffix of a role's Codex twin: `crew:developer` has `crew:developer-codex`. */
export const NATIVE_SUFFIX = '-codex'

/**
 * True for an `http:` or `https:` base URL other than Anthropic's own API: a gateway that may serve the twins' models
 * besides Claude's. Anything else, or text that is no URL, is false. The gateway's models are not checked.
 */
export function isGatewayBase(text: string | undefined): boolean {
  if (!text) return false
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  return url.hostname.toLowerCase() !== 'api.anthropic.com'
}

/**
 * The `-codex` twin of each role in the supplied model map: the base role's
 * prompt, tools and effort, on that model id. The description is one line, because every registered agent's goes into
 * the Agent tool's listing on each request of the main loop.
 */
export function nativeCodexSpecs(models: Readonly<Partial<Record<string, string>>>): Agent<string>[] {
  const twins: Agent<string>[] = []
  for (const base of SPECIALISTS) {
    const model = models[base.name]
    if (model === undefined) continue
    twins.push({
      ...base,
      name: `${base.name}${NATIVE_SUFFIX}`,
      model,
      description: `crew:${base.name} on ${model} (OpenAI, through the session's gateway): same job, tools and write lane.`,
    })
  }
  return twins
}

/** A twin crew runs itself on the user's Codex login (the `codexLogin` option): only its one-line description changes. */
export function onCodexLogin(twin: Agent<string>): Agent<string> {
  const base = twin.name.slice(0, -NATIVE_SUFFIX.length)
  return { ...twin, description: `crew:${base} on ${twin.model} (OpenAI, on your Codex login): same job, tools and write lane.` }
}

/**
 * The lead's section for the `-codex` types, a section of its own (`leadSection` stays free of Codex). It is the same
 * text on every request, whatever the tools.
 */
export function nativeCodexSection(specs: readonly Pick<Agent<string>, 'name' | 'model'>[]): string {
  return [
    `Registered OpenAI Codex twins: ${specs.map(spec => `crew:${spec.name} (${spec.model})`).join(', ')}.`,
    'Use ordinary foreground/background Agent calls with the base role\'s tools and write lane; never pass `model` to a twin (it overrides the fixed model).',
    'Choose a twin for a user-requested Codex call or a second-family implementation or audit; otherwise use the Claude role.',
    "Only crew:architect or its registered -codex twin independently accepts a step; a developer twin's own commands and output are its report, not acceptance.",
    'Return failures to the same developer, including a -codex developer, then have the architect reaudit.',
    'In the codex crew mode, crew runs a plain crew:<role> call on its registered twin and the task shows it; passing `model` keeps a call on Claude.',
  ].join(' ')
}
