/** Model tiers and effort levels, cheapest first: Jev's routing moves an agent one step from its default at most. */
export const MODELS = ['haiku', 'sonnet', 'opus'] as const
export const EFFORTS = ['low', 'medium', 'high'] as const
export type Model = (typeof MODELS)[number]
export type Effort = (typeof EFFORTS)[number]

/** One specialist: the agent type is `crew:<name>`. */
export type Specialist = {
  name: string
  description: string
  prompt: string
  /** The default model; Jev routing may move it one tier (see `MODEL_FLOORS`). */
  model: Model
  /** Set on purpose: every specialist defaults to `medium`; Jev routing may raise it to `high` (see `EFFORT_FLOOR`). */
  effort: Effort
  tools: readonly string[]
}

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
      'Report the files changed, the commands run and their results.',
  },
  {
    name: 'tester',
    description:
      'Reproduces a reported behavior, writes or updates tests, runs the suite and reports the exact command and output. Never changes production code.',
    model: 'sonnet',
    effort: 'medium',
    tools: [...READ_ONLY, 'Edit', 'Write', 'Bash'],
    prompt:
      'You are a tester. Reproduce the behavior you were given, cover it by writing or updating test files, run the suite ' +
      'and report the exact command, its output and what it proves. A failure caused by the code goes back to the caller with the evidence, ' +
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
      'Write the plan or review as Markdown in `.crew/reviews/<name>.md` (or the `.crew/` path the caller gives) and answer with a one-line verdict first (the dashboard shows that line), then the path and a short summary. ' +
      '`.crew/` Markdown is the only thing you write: fixes go to the developer.',
  },
]

/**
 * The system prompt section that makes the main session the lead: it orchestrates and the specialists do the work.
 * The lead judges the kind of work, never its size; with Jev on, each call is sized for it.
 */
export function leadSection(jev: boolean): string {
  const sizing = jev
    ? "Jev sizes each call's model and effort, so a small task costs little; do not judge size yourself."
    : 'Each agent runs on a model sized for its role, so a small task costs little; do not judge size yourself.'
  return [
    'You orchestrate; the crew agents do the work.',
    'Hand every task that reads, searches, edits or runs anything in the project to a crew agent:',
    'crew:code-reader to read and search, crew:developer to implement, crew:tester for tests,',
    'crew:architect for plans and audits, crew:research for the web, crew:designer for UI.',
    sizing,
    'You talk with the user, break the work down, delegate in parallel when tasks are independent,',
    'and check and combine the reports the agents return. Git and pull requests stay with you.',
  ].join(' ')
}
