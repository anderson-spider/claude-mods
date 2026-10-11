// The processes the Codex engine runs, faked over an in-memory file system: git, mkdir, sleep, kill, and the three
// shell scripts of hooks/codex/worker.ts (the worker, the poll and the foreground wait), told apart by their `$0`.
import { CODEX_EXEC_0_162_SUCCESS } from './fixtures/codex-exec-0.162'

export const PID = 4242

export type Run = { argv: string[]; cwd?: string; stdin?: string }
export type Scenario = { jsonl: string; exit?: number; stderr?: string }
export type RunResult = { exitCode: number; stdout: string; stderr: string }

const timers = globalThis as unknown as { setTimeout: (run: () => void, ms: number) => unknown }
/** A real (if short) wait: a macrotask, so a poller of a job still running never starves the test's own timer. */
export const pause = (ms = 1) => new Promise<void>(resolve => { timers.setTimeout(resolve, ms) })
const tick = () => pause(1)

/** The text from byte `from`, at most `cap` bytes, the way `tail -c +N | head -c cap` cuts it. */
function sliceBytes(text: string, from: number, cap: number): string {
  let at = 0
  let out = ''
  let taken = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
    if (at >= from) {
      if (taken + size > cap) break
      out += ch
      taken += size
    }
    at += size
  }
  return out
}

export const byteLength = (text: string) =>
  [...text].reduce((n, ch) => { const c = ch.codePointAt(0) ?? 0; return n + (c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4) }, 0)

export function fakeProcesses(opts: {
  files: Map<string, string>
  dirs: Set<string>
  runs: Run[]
  alive: Set<number>
  /** The repository `git rev-parse --show-toplevel` names; null: not in a git repository. */
  gitTop: () => string | null
  scenario: () => Scenario
  /** The foreground wait reaches its limit at once (the job is still running then). */
  foregroundElapses?: boolean
  /** The worker fails to start: the outer shell gave up waiting for the pid, removed the prompt and left the mark. */
  workerFails?: boolean
  /** The record's private-creation step: seen as it runs, and failing when asked. */
  onRecord?: (path: string) => void
  recordFails?: boolean
  /** `git check-ignore -q .crew` succeeds: the project ignores `.crew`. */
  crewIgnored?: () => boolean
  /** The command `ps` shows for a live pid; a Codex exec by default. */
  psCommand?: (pid: number) => string
  /** A poll that sleeps first (not one asked at once) waits for this: the test moves time by hand. */
  gate?: () => Promise<void>
}) {
  const { files, dirs, runs, alive } = opts
  const out = (stdout = '', exitCode = 0, stderr = ''): RunResult => ({ exitCode, stdout, stderr })

  return async (argv: string[], init?: { cwd?: string; stdin?: string }): Promise<RunResult> => {
    runs.push({ argv, cwd: init?.cwd, stdin: init?.stdin })
    switch (argv[0]) {
      case 'git': {
        if (argv[1] === 'check-ignore') return opts.crewIgnored?.() ? out() : out('', 1)
        const top = opts.gitTop()
        const cwd = init?.cwd ?? '/repo'
        return top !== null && (cwd === top || cwd.startsWith(`${top}/`)) ? out(`${top}\n`) : out('', 128, 'fatal: not a git repository')
      }
      case 'mkdir':
        for (const dir of argv.slice(2)) dirs.add(dir)
        return out()
      case 'sleep':
        await tick()
        return out()
      case 'kill': {
        const pid = Number(argv[2])
        alive.delete(pid)
        // Codex handles the SIGINT and exits 1: the worker writes the exit file of the job with that pid.
        for (const [path, text] of files) {
          if (path.endsWith('.pid') && Number(text.trim()) === pid) files.set(`${path.slice(0, -4)}.exit`, '1\n')
        }
        return out()
      }
      case '/bin/sh':
        break
      default:
        return out('', 127, `unexpected ${argv[0]}`)
    }
    switch (argv[3]) {
      case 'crew-codex': {
        // The worker: argv[4..8] are the prompt, jsonl, err, exit and pid files.
        const [, , , , prompt, jsonl, err, exit, pid] = argv as [string, string, string, string, string, string, string, string, string]
        if (opts.workerFails) {
          // As the real outer shell does after 10 s with no pid: the prompt is gone, the mark stops a late inner shell.
          files.delete(prompt)
          files.set(`${pid}.abandoned`, '')
          return out('', 92, 'the Codex worker did not start')
        }
        const scenario = opts.scenario()
        files.set(jsonl, scenario.jsonl)
        files.set(err, scenario.stderr ?? '')
        files.set(pid, `${PID}\n`)
        if (scenario.exit === undefined) alive.add(PID)
        else files.set(exit, `${scenario.exit}\n`)
        return out(`${PID}\n`)
      }
      case 'crew-codex-record': {
        // The record's private creation: an existing file keeps its content, a new one is empty (umask 077).
        const path = argv[4]!
        opts.onRecord?.(path)
        if (opts.recordFails) return out('', 1, 'chmod failed')
        if (!files.has(path)) files.set(path, '')
        return out()
      }
      case 'crew-codex-wait': {
        const exit = argv[4]!
        if (files.has(exit)) return out()
        if (opts.foregroundElapses) return out('', 3)
        // The real wait ends when the exit file appears; here the call returns once the poller has settled the job.
        return new Promise<never>(() => {})
      }
      case 'crew-codex-poll': {
        const [sleep, marker, cap, pids, ...rest] = argv.slice(4)
        if (sleep !== '0') await (opts.gate ? opts.gate() : tick())
        else await Promise.resolve()
        let text = ''
        for (let i = 0; i + 4 < rest.length; i += 5) {
          const [id, jsonl, offset, exit, pid] = rest.slice(i, i + 5) as [string, string, string, string, string]
          const content = files.get(jsonl) ?? ''
          const size = byteLength(content)
          text += `${marker} J ${id} ${size}\n`
          if (size > Number(offset)) text += sliceBytes(content, Number(offset), Number(cap))
          text += `\n${marker} X ${id} ${(files.get(exit) ?? '').trim().slice(0, 8)} ${(files.get(pid) ?? '').trim().slice(0, 16)}\n`
        }
        if (pids) {
          text += `${marker} P\n`
          for (const pid of pids.split(',')) {
            if (alive.has(Number(pid))) text += `  ${pid} ${opts.psCommand?.(Number(pid)) ?? 'codex exec --json -s read-only -'}\n`
          }
        }
        text += `${marker} E\n`
        return out(text)
      }
      default:
        return out('', 127, `unexpected script ${argv[3]}`)
    }
  }
}

export const DEFAULT_SCENARIO: Scenario = { jsonl: CODEX_EXEC_0_162_SUCCESS.jsonl, exit: 0 }
