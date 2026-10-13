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
  /** Set on purpose: every helper defaults to `high`; Jev routing may lower it to `medium` (see `EFFORT_FLOOR`). */
  effort: Effort
  tools: readonly string[]
}

/** One specialist, on a model alias. */
export type Specialist = Agent<Model>

/** The lowest effort routing may pick for any agent: Jev may lower effort to `medium`, never below it. */
export const EFFORT_FLOOR: Effort = 'medium'

const READ_ONLY = ['Read', 'Grep', 'Glob'] as const

// Names the session may not have connected are simply unavailable to the agent.
const SOURCES = [
  'WebSearch',
  'WebFetch',
  'mcp__claude_ai_Context7__resolve-library-id',
  'mcp__claude_ai_Context7__query-docs',
  'mcp__plugin_context7_context7__resolve-library-id',
  'mcp__plugin_context7_context7__query-docs',
  'mcp__codegraph__codegraph_explore',
] as const

// Reading pages only: no clicks or typing.
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
] as const

/** The suffix of a role's Codex twin: `crew:digger` has `crew:digger-codex`. */
export const NATIVE_SUFFIX = '-codex'

/**
 * The optional helpers of the main session, which implements everything itself. Each one is read-only (no Write, Edit
 * or Agent in its tools, so it can neither change files nor delegate) and answers only the main session.
 */
export const SPECIALISTS = [
  {
    name: 'planner',
    description: 'Plans complex or ambiguous work: read-only; returns decisions, dependencies, steps and acceptance criteria. Optional.',
    model: 'opus',
    effort: 'high',
    tools: READ_ONLY,
    prompt:
      'Plan the change the main session asks about; the main session implements it. Read the code you need; never edit files or call other agents. ' +
      'Return a concise, executable plan: the decisions and their reasons, the files and existing code to reuse, ordered steps with their dependencies, ' +
      'the risks, and acceptance criteria with how to verify each. Mark every assumption you could not confirm.',
  },
  {
    name: 'challenger',
    description: 'Challenges a decision, design or change when an independent view adds value: premises, real risks, simpler options. Optional, never a gate.',
    model: 'opus',
    effort: 'high',
    tools: READ_ONLY,
    prompt:
      'Challenge the decision or change the main session gives you. Read the code you need; never edit files or call other agents. ' +
      'Question its premises, find significant risks, reasoning gaps and architectural problems, propose simpler alternatives, and disagree when you have a technical reason. ' +
      'Report only what matters, most important first, each with `path:line` evidence or a concrete failing scenario; say plainly when you find nothing significant. ' +
      'Do not restate the request, repeat analysis you were given or approve routine work.',
  },
  {
    name: 'digger',
    description: 'Read-only investigation: code, git history, docs, Context7, web, GitHub, APIs and logs; returns evidence with paths and URLs.',
    model: 'haiku',
    effort: 'high',
    tools: [...READ_ONLY, 'Bash', ...SOURCES, ...BROWSER],
    prompt:
      'Investigate the question the main session gives you, read-only. Choose only the sources it needs (code, git history, local docs, Context7, the web, GitHub, APIs, connected tools, logs) and stop once the evidence answers it. ' +
      'Run only commands that change nothing; never edit files, take decisions for the main session or call other agents. ' +
      'Answer briefly: each finding with its `path:line`, commit or URL, marked confirmed or inferred, then what you could not find.',
  },
] as const satisfies readonly Specialist[]

/** The role names, read from the definitions above. */
export type SpecialistName = (typeof SPECIALISTS)[number]['name']

/**
 * The agent types of the roles: `crew:<name>` and its `crew:<name>-codex` twin, for every specialist. The only list of
 * valid crew types; the guard and the HUD read it instead of rebuilding it.
 */
export const CREW_TYPES: readonly string[] = SPECIALISTS.flatMap(s => [`crew:${s.name}`, `crew:${s.name}${NATIVE_SUFFIX}`])

/**
 * The specialist a bare role name stands for: `digger`, or its twin `digger-codex`. Any other name, a suffixed
 * one whose base is no specialist included, is undefined.
 */
export function specialistOf(role: string): (typeof SPECIALISTS)[number] | undefined {
  const exact = SPECIALISTS.find(s => s.name === role)
  if (exact || !role.endsWith(NATIVE_SUFFIX)) return exact
  const base = role.slice(0, -NATIVE_SUFFIX.length)
  return SPECIALISTS.find(s => s.name === base)
}

/**
 * The system prompt section of the main session: it does the work itself, and the helpers are optional. With Jev on,
 * each helper call's effort is sized for it.
 */
export function mainSection(jev: boolean): string {
  const sizing = jev ? "Jev sizes each helper call's effort." : "Each helper runs on its role's model and effort."
  return [
    'You are the main session: you implement, edit files, run commands and tests, review your own changes, commit and open pull requests.',
    'Simple and medium tasks need no subagent; every helper is optional and none is a required step.',
    'Read-only helpers, each answering only you: crew:planner to plan complex or ambiguous work,',
    'crew:challenger to question a decision or change when an independent challenge adds real value (never a routine review),',
    'crew:digger to investigate code, git history, docs, the web or logs; run several diggers at once only for independent questions.',
    'Do not call a helper for trivial work, to confirm what is settled or to ask the same thing twice; give it the context it needs and use its summary.',
    sizing,
    'For a plan step, start its description with the step id (for example `T3 contract suite`).',
    'Update each step\'s `state:` in the plan file as soon as it changes; the crew HUD reads it.',
  ].join(' ')
}

// --- Native Codex twins ---

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
      description: `crew:${base.name} on ${model} (OpenAI, through the session's gateway): same job, read-only.`,
    })
  }
  return twins
}

/** A twin crew runs itself on the user's Codex login (the `codexLogin` option): only its one-line description changes. */
export function onCodexLogin(twin: Agent<string>): Agent<string> {
  const base = twin.name.slice(0, -NATIVE_SUFFIX.length)
  return { ...twin, description: `crew:${base} on ${twin.model} (OpenAI, on your Codex login): same job, read-only.` }
}

/**
 * The main session's section for the `-codex` types, a section of its own (`mainSection` stays free of Codex). It is the
 * same text on every request, whatever the tools.
 */
export function nativeCodexSection(specs: readonly Pick<Agent<string>, 'name' | 'model'>[]): string {
  return [
    `Registered OpenAI Codex twins: ${specs.map(spec => `crew:${spec.name} (${spec.model})`).join(', ')}.`,
    "Call a twin like its base role, for a user-requested Codex call or a second model family's view; never pass `model` to a twin (it overrides the fixed model).",
    'In the codex crew mode, crew runs a plain crew:<role> call on its registered twin and the task shows it; passing `model` keeps a call on Claude.',
  ].join(' ')
}
