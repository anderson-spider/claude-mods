// Pure logic of the codex-team plugin: names, Codex arguments, prompts and the
// job lifecycle, all against an injected `Herdr` so tests need no real host.

export type Kind = 'execute' | 'review'

export type Request = { kind: Kind; task: string; files: string[]; target?: string; focus?: string }

const PREFIX = 'ct-'

/** The Herdr agent name of job `id`. */
export const agentName = (id: number) => `${PREFIX}${id}`

/** The smallest id from `from` whose agent name is not among the live ones. */
export function nextFreeId(from: number, live: readonly string[]): number {
  let id = from
  while (live.includes(agentName(id))) id++
  return id
}

/** Codex's own arguments: the sandbox by kind, asking the person when it needs more. */
export const codexArgs = (kind: Kind): string[] => ['-s', kind === 'execute' ? 'workspace-write' : 'read-only', '-a', 'on-request']

/** Terminal cells are about twice as tall as wide: split a wide pane to the right, a narrow or tall one down. */
export const splitDirection = (size: { width: number; height: number }): 'right' | 'down' => (size.width >= size.height * 2 ? 'right' : 'down')

/** Where Codex writes the final report of job `id`. */
export const reportPath = (tmpdir: string | undefined, id: number) => `${(tmpdir || '/tmp').replace(/\/+$/, '')}/codex-team/${id}.md`

type PromptInput = { task?: string; files?: string[]; target?: string; focus?: string }

const REPORT_RULE = (report: string) =>
  `When you are done, write your final report as Markdown to ${report} and answer with only that path.`

/** The prompt sent to Codex: the work, the rules and where to leave the report. */
export function buildPrompt(kind: Kind, input: PromptInput, report: string): string {
  if (kind === 'execute') {
    const files = input.files?.length ? [`Start from these files: ${input.files.join(', ')}.`] : []
    return [
      `Task: ${input.task ?? ''}`,
      ...files,
      'Work only inside the current directory and stay inside the scope of the task. Do not commit and do not push.',
      REPORT_RULE(report),
    ].join('\n')
  }
  return [
    `Review ${input.target ? `the changes of ${input.target}` : 'the current uncommitted diff'}.`,
    ...(input.focus ? [`Focus on: ${input.focus}.`] : []),
    'Report only actionable findings, each with the file, the line and why it matters. Do not edit any file.',
    REPORT_RULE(report),
  ].join('\n')
}

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)

/** Reads a tool call's input into a request, or the error to answer. */
export function requestOf(kind: Kind, e: Record<string, unknown>): Request | string {
  const task = text(e.task) ?? ''
  if (kind === 'execute' && !task) return 'Give a non-empty task.'
  const files = Array.isArray(e.files) ? e.files.filter((f): f is string => typeof f === 'string' && f.trim() !== '').map(f => f.trim()) : []
  const target = text(e.target)
  const focus = text(e.focus)
  return { kind, task, files, ...(target ? { target } : {}), ...(focus ? { focus } : {}) }
}
