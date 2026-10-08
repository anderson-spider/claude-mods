import type { Check, Run } from './model'
import { ENGINES, PROFILES } from './engines'
import { versionOf } from './herdr'
import { doctorReport } from './presentation'

export async function checkDoctor(run: (argv: string[]) => Promise<Awaited<ReturnType<Run>> | undefined>, inside: boolean): Promise<string> {
  const checks: Check[] = [
    { name: 'inside Herdr', ok: inside, detail: inside ? 'HERDR_ENV=1' : 'HERDR_ENV is not 1: run Claude Code in a Herdr pane' },
  ]
  const herdr = await versionOf(run, 'herdr')
  checks.push({ name: 'herdr', ok: herdr !== undefined, detail: herdr ?? 'not installed or not in PATH' })
  const versions = await Promise.all(ENGINES.map(engine => versionOf(run, PROFILES[engine].binary)))
  // One agent is enough to work; a missing one only refuses the jobs that ask for it.
  const anyEngine = versions.some(version => version !== undefined)
  ENGINES.forEach((engine, index) => {
    const { binary, label } = PROFILES[engine]
    checks.push({ name: binary, ok: versions[index] !== undefined || anyEngine, detail: versions[index] ?? `not installed or not in PATH: jobs with ${label} will be refused` })
  })
  const listed = await run(['herdr', 'agent', 'list'])
  checks.push({ name: 'herdr agent list', ok: listed?.exitCode === 0, detail: listed?.exitCode === 0 ? 'answers' : (listed?.stderr || 'no answer').trim().slice(0, 200) })
  return doctorReport(checks)
}
