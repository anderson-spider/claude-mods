import type { Check, Run } from './model'
import { versionOf } from './herdr'
import { doctorReport } from './presentation'

export async function checkDoctor(run: (argv: string[]) => Promise<Awaited<ReturnType<Run>> | undefined>, inside: boolean): Promise<string> {
  const checks: Check[] = [
    { name: 'inside Herdr', ok: inside, detail: inside ? 'HERDR_ENV=1' : 'HERDR_ENV is not 1: run Claude Code in a Herdr pane' },
  ]
  for (const tool of ['herdr', 'codex']) {
    const version = await versionOf(run, tool)
    checks.push({ name: tool, ok: version !== undefined, detail: version ?? 'not installed or not in PATH' })
  }
  const listed = await run(['herdr', 'agent', 'list'])
  checks.push({ name: 'herdr agent list', ok: listed?.exitCode === 0, detail: listed?.exitCode === 0 ? 'answers' : (listed?.stderr || 'no answer').trim().slice(0, 200) })
  return doctorReport(checks)
}
