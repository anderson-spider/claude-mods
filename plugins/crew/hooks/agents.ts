/** Model tiers and effort levels, cheapest first: Jev's routing moves an agent one step from its default at most. */
export const MODELS = ['haiku', 'sonnet', 'opus'] as const
export const EFFORTS = ['low', 'medium', 'high'] as const
export type Model = (typeof MODELS)[number]
export type Effort = (typeof EFFORTS)[number]

/** One registered agent: the type is `crew:<name>`. `M` is the model: the alias union for a specialist, any id for a `-codex` type. */
export type Agent<M extends string = Model> = {
  name: string
  description: string
  prompt: string
  /** The default model; Jev routing may move a specialist one tier (see `MODEL_FLOORS`). */
  model: M
  /** Set on purpose: every specialist defaults to `medium`; Jev routing may raise it to `high` (see `EFFORT_FLOOR`). */
  effort: Effort
  tools: readonly string[]
}

/** One specialist, on a model alias. */
export type Specialist = Agent<Model>

/** The lowest model routing may pick for an agent, whatever Jev says: the reviewer never runs on a weaker model than the developer it audits, who can reach opus. */
export const MODEL_FLOORS: Readonly<Record<string, Model>> = { architect: 'opus' }

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
    description:
      'Reads and searches the codebase and reports what it found: symbols with path:line, relations and short excerpts. Read-only; never edits.',
    model: 'haiku',
    effort: 'medium',
    tools: READ_ONLY,
    prompt:
      'You are a code reader. Answer the question you were given by reading and searching the code. ' +
      'Report symbols as `path:line` with how they relate, and quote a snippet only where it carries the answer. ' +
      'When you cannot find something, say so instead of inferring it: the caller acts on your report.',
  },
  {
    name: 'research',
    description:
      'Researches documentation and the web (docs sites, library references, release notes), browsing pages when needed, and writes the findings or project docs. Never edits source code.',
    model: 'haiku',
    effort: 'medium',
    tools: [...READ_ONLY, 'Edit', 'Write', ...WEB, ...BROWSER],
    prompt:
      'You are a researcher and documentation writer. Look in the project first, then in library docs and on the web, ' +
      'opening pages in a browser when a search is not enough. Prefer current official documentation, cite the source (URL or path) of each claim ' +
      'and say what you could not confirm. Save findings under `.crew/research/` (unversioned) unless you were asked to update a project document; ' +
      'documentation you write matches the surrounding style and describes current behavior. Source code is not yours to change.',
  },
  {
    name: 'designer',
    description:
      'Designs the UI and its experience (layout, hierarchy, states, accessibility, copy) and edits styles and layout directly; leaves logic, data and tests to the developer.',
    model: 'sonnet',
    effort: 'medium',
    tools: [...READ_ONLY, 'Edit', 'Write', ...WEB, ...BROWSER],
    prompt:
      'You are a UI/UX designer. Start from the existing screens, the project design system and any references, in the browser when the app is running. ' +
      'Specify layout, hierarchy, empty, loading and error states, accessibility and interface copy, and apply the visual changes yourself in styles, layout and UI text. ' +
      'Logic, data handling and tests belong to the developer: hand them a clear spec.',
  },
  {
    name: 'developer',
    description:
      'Implements a change from a clear spec: edits code, adds or updates tests, runs them and reports what changed.',
    model: 'sonnet',
    effort: 'medium',
    tools: [...READ_ONLY, 'Edit', 'Write', 'Bash'],
    prompt:
      'You are a developer. Implement the change you were given, matching the surrounding code, and keep to the files the task needs. ' +
      'Add or update tests, run them and fix what fails. Leave committing to the caller. ' +
      'End the report with what changed, which acceptance criteria it covers, the checks run with their result and the checks not run.',
  },
  {
    name: 'tester',
    description:
      'Reproduces a reported behavior, writes or updates tests, runs the suite and reports the exact command and output; long reports go to .crew/reviews/<name>-test.md. Never changes production code.',
    model: 'sonnet',
    effort: 'medium',
    tools: [...READ_ONLY, 'Edit', 'Write', 'Bash'],
    prompt:
      'You are a tester. Reproduce the behavior you were given, cover it by writing or updating test files, run the suite ' +
      'and report the exact command, its output and what it proves; write a longer report to .crew/reviews/<name>-test.md (or the .crew/reviews/ path the caller gives), apart from the architect review. A failure caused by the code goes back to the caller with the evidence, ' +
      'because a test made to pass by changing production code proves nothing.',
  },
  {
    name: 'architect',
    description:
      'Plans and reviews: challenges a design and audits a diff or files for bugs, regressions, broken project rules and missing tests. Writes plan and review documents under .crew/ only; never fixes code.',
    model: 'opus',
    effort: 'medium',
    tools: [...READ_ONLY, 'Write', 'Bash'],
    prompt:
      'You are the architect and code reviewer. Judge the design as well as the diff: read `git diff` and the code around it, and run the tests when you need evidence. ' +
      'Report each finding with path:line, the concrete failing scenario and its severity, most severe first; say plainly when there is nothing to report. ' +
      'Write the plan or review as Markdown in `.crew/reviews/<name>.md` (or the `.crew/` path the caller gives) and answer with a first line that starts with `Approve`, `Fixes` or `Reject` and gives the one-line reason (the Review card in the HUD shows that line), then the path and a short summary. ' +
      '`.crew/` Markdown is the only thing you write: fixes go to the developer.',
  },
]

/**
 * The system prompt section that makes the main session the lead: it orchestrates and the specialists do the work.
 * The lead judges the kind of work, never its size; with Jev on, each call is sized for it.
 */
export function leadSection(jev: boolean, quota = false): string {
  const sizing = jev
    ? "Jev sizes each call's model and effort, so a small task costs little; do not judge size yourself."
    : 'Each agent runs on a model sized for its role, so a small task costs little; do not judge size yourself.'
  return [
    'You orchestrate; the crew agents do the work.',
    'Hand every task that reads, searches, edits or runs anything in the project to a crew agent:',
    'crew:code-reader to read and search, crew:developer to implement, crew:tester for tests,',
    'crew:architect for plans and audits, crew:research for the web, crew:designer for UI.',
    sizing,
    'You talk with the user, break the work down and check and combine the reports the agents return.',
    'Before delegating, split the work into independent pieces (different files, no input from each other)',
    'and launch every piece whose inputs are ready in one message; when a result unblocks other pieces,',
    'launch them right away instead of waiting for agents that are unrelated.',
    'After each agent report, look again for work that is now unblocked or still independent and launch it without being asked;',
    'end each update to the user with one line saying what is running, what is waiting and on what (or that nothing else can run in parallel).',
    "A step is done only when someone other than its implementer verified it: crew:tester runs it or crew:architect audits it; the developer's own \"tests pass\" is a report, not the acceptance.",
    'A failure goes back to the same developer (SendMessage to that agent) with the criterion, the steps and expected versus actual;',
    'after the fix, the tester repeats the reproduction and what the fix could affect before the step closes.',
    'When a call works on a plan step, start its description with the step id (for example `T3 contract suite`).',
    ...(quota
      ? ['With quota routing on, a call to a role that has a Codex twin may run on the twin when Codex has more weekly headroom; the task shows it.']
      : []),
    'Git and pull requests stay with you.',
  ].join(' ')
}

// --- Native Codex models (the `nativeCodex` option) ---

/** The suffix of a role's Codex twin: `crew:developer` has `crew:developer-codex`. */
export const NATIVE_SUFFIX = '-codex'

/** True for an `http:` URL whose host is a literal loopback address (127.0.0.0/8, ::1) or `localhost`; anything else, or text that is no URL, is false. */
export function isLoopbackBase(text: string | undefined): boolean {
  if (!text) return false
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return false
  }
  if (url.protocol !== 'http:') return false
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host === '[::1]') return true
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  return octets !== null && octets[1] === '127' && octets.slice(1).every(octet => Number(octet) <= 255)
}

/**
 * The `-codex` twin of each role that has a model (`models` is what `parseCodexModels` returned): the base role's
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
      description: `crew:${base.name} on ${model} (OpenAI, via the local codex-models proxy): same job, tools and write lane.`,
    })
  }
  return twins
}

/**
 * The lead's section for the `-codex` types, a section of its own (`leadSection` stays free of Codex). It is the same
 * text on every request, whatever the tools.
 */
export function nativeCodexSection(specs: readonly Pick<Agent<string>, 'name' | 'model'>[], quota = false): string {
  return [
    `Some roles also run on OpenAI Codex models as native subagents: ${specs.map(spec => `crew:${spec.name} (${spec.model})`).join(', ')}.`,
    'They are ordinary Agent calls with the base role\'s tools and write lane, in the foreground or the background; never pass `model` to one, as it would override the Codex model.',
    'Pick one when the user asks for Codex or when a second model family should do or check the work; otherwise use the Claude role.',
    'A -codex agent counts as someone other than the implementer when a Claude agent built the change (and the reverse),',
    'and a failure goes back to the same -codex agent.',
    ...(quota
      ? ['With quota routing on, crew may run a plain crew:<role> call on its Codex twin when Codex has more weekly headroom than Claude; passing `model` keeps a call on Claude.']
      : []),
  ].join(' ')
}
