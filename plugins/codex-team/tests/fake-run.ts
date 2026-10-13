// A scripted `herdr`/`git` runner: each call is recorded, and answered by the first rule whose prefix matches its argv.
import type { Run, RunResult } from '../hooks/herdr'

export type Rule = [prefix: readonly string[], answer: RunResult | ((argv: readonly string[]) => RunResult)]

export const ok = (result: unknown): RunResult => ({ exitCode: 0, stdout: JSON.stringify({ result }), stderr: '' })
export const fail = (code: string): RunResult => ({ exitCode: 1, stdout: '', stderr: JSON.stringify({ error: { code, message: 'details' } }) })
export const text = (stdout: string): RunResult => ({ exitCode: 0, stdout, stderr: '' })

export function fakeRun(rules: Rule[]): { run: Run; calls: string[][] } {
  const calls: string[][] = []
  const run: Run = async argv => {
    calls.push([...argv])
    const rule = rules.find(([prefix]) => prefix.every((word, i) => argv[i] === word))
    if (!rule) return { exitCode: 127, stdout: '', stderr: `no rule for ${argv.slice(0, 3).join(' ')}` }
    return typeof rule[1] === 'function' ? rule[1](argv) : rule[1]
  }
  return { run, calls }
}

export const agents = (list: unknown[]): Rule => [['herdr', 'agent', 'list'], ok({ agents: list })]
