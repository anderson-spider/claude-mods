import type { Kind } from './model'

/** Codex's own arguments: the sandbox by kind, asking the person when it needs more. */
const SANDBOX: Record<Kind, string> = { execute: 'workspace-write', review: 'read-only' }
export const codexArgs = (kind: Kind): string[] => ['-s', SANDBOX[kind], '-a', 'on-request']

type PromptInput = { task?: string; files?: string[]; target?: string; focus?: string }

const REPORT_RULE = (report: string) =>
  `When you are done, write your final report as Markdown to ${report} and answer with only that path.`

const prompts: Record<Kind, (input: PromptInput, report: string) => string> = {
  execute: (input, report) => {
    const files = input.files?.length ? [`Start from these files: ${input.files.join(', ')}.`] : []
    return [
      `Task: ${input.task ?? ''}`,
      ...files,
      'Work only inside the current directory and stay inside the scope of the task. Do not commit and do not push.',
      REPORT_RULE(report),
    ].join('\n')
  },
  review: (input, report) => [
    `Review ${input.target ? `the changes of ${input.target}` : 'the current uncommitted diff'}.`,
    ...(input.focus ? [`Focus on: ${input.focus}.`] : []),
    'Report only actionable findings, each with the file, the line and why it matters. Do not edit any file.',
    REPORT_RULE(report),
  ].join('\n')
}

/** The prompt sent to Codex: the work, the rules and where to leave the report. */
export const buildPrompt = (kind: Kind, input: PromptInput, report: string): string => prompts[kind](input, report)

const EXECUTE_TOOL = 'mcp__codex-team__execute'
const REVIEW_TOOL = 'mcp__codex-team__review'
const LOOP_TOOL = 'mcp__codex-team__loop'
const JOBS_TOOL = 'mcp__codex-team__jobs'

// Added to the system prompt so Claude leads on its own; the tools may be deferred, so their descriptions
// alone are not seen until loaded.
export const PROMPT = [
  '# Leading Codex agents (codex-team mod)',
  '',
  'You can delegate work to Codex agents that run in their own Herdr panes as background jobs; the person can watch each pane.',
  '',
  `- \`${EXECUTE_TOOL}\` { task, files? }: Codex implements a well-bounded task in the current directory (sandbox workspace-write, it never commits). One execute runs at a time: a second waits in the queue, so do not start a second while one is running or queued in the same directory.`,
  `- \`${REVIEW_TOOL}\` { target?, focus? }: Codex reviews the current diff (or the target) read-only; reviews run in parallel.`,
  `- \`${LOOP_TOOL}\` { task, files?, maxRounds? }: use when work needs QA. Runs dev then read-only QA rounds (maxRounds defaults to 3), holding the execute queue throughout; answers an id at once and one message at the end with a verdict. After the report and final message, it closes its panes once the agents have stopped, whatever the outcome. Use execute and review for manual control; their panes close once the report is written and stay open after a failure, a missing report or a cancel.`,
  `- \`${JOBS_TOOL}\` { id?, action? }: lists jobs and loops, reads one, or cancels it (\`action: "cancel"\`).`,
  '',
  '- Say in one line what you delegate before the call. If the tools are deferred, load them by name first.',
  '- Write a self-contained task: the goal, the files, the constraints and how to check it.',
  '- A call answers with a job id at once: keep working on something else. A message arrives when the job ends; read the job\'s report file (its path is in the message), not the pane, and check the work (run the tests, read the diff) before building on it.',
  '- Call review before integrating an execute result.',
  '- A blocked job waits for the person in its pane: never answer for them.',
].join('\n')

export const qaFocus = (task: string) =>
  [
    `Acceptance criteria:\n${task}`,
    'Report only actionable findings, each with the file, the line and why it matters. Do not edit any file.',
    'End the report with exactly one last line: VERDICT: APPROVED or VERDICT: CHANGES.',
  ].join('\n')

export const fixTask = (task: string, qaReport: string) => `${task}\nRead the QA report at ${qaReport} and fix the findings.`
