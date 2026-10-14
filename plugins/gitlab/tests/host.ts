// The host fake the plugin's tests share: records registered tools and answers git, settings and the GitLab API.
import type { On } from 'claude-code'
import { expect } from 'claude-code/testing'

export type Tool = { name: string; description: string; inputSchema: { properties: Record<string, { description?: string }> } }
export type Sent = { url: string; method?: string; headers?: Record<string, string>; body?: string }
type Settings = Record<string, unknown>

/** The MCP name the host gives a tool this plugin registers. */
export const id = (name: string) => `mcp__gitlab__${name}`

type Answer = { status?: number; text: string }

/**
 * A host whose repository has `remote` as origin on `branch`, whose settings are `project` and `local`, and whose
 * network answers `api[url]` (`{ status, text }`, or a list answered in turn with the last one repeated; 404
 * otherwise). Everything is mutable through `host` between calls; `runs` records every process the plugin runs.
 */
export function world(on: On, opts: { remote?: string; branch?: string; project?: Settings; local?: Settings; api?: Record<string, Answer | Answer[]> } = {}) {
  const tools: Tool[] = []
  const sent: Sent[] = []
  const runs: string[] = []
  const host = {
    remote: 'git@gitlab.example.com:team/app.git',
    branch: 'feature/x',
    api: {},
    ...opts,
    settingsFail: false,
    fetchError: undefined as string | undefined,
    /** What `ssh -G <alias>` prints as its hostname line, per alias; ssh fails for any other. */
    ssh: {} as Record<string, string>,
  }

  on('tool.register', (_$, e) => (tools.push(e as unknown as Tool), { value: { tool: id(e.name) } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('settings.read', (_$, e) => {
    if (host.settingsFail) throw new Error('settings unreadable')
    return { value: (e.source === 'project' ? host.project : e.source === 'local' ? host.local : undefined) ?? {} } as never
  })
  on('process.run', (_$, e) => {
    const args = e.argv.join(' ')
    runs.push(args)
    const out = (exitCode: number, stdout: string) => ({ value: { exitCode, stdout, stderr: '' } }) as never
    if (args === 'git remote get-url origin') return host.remote ? out(0, `${host.remote}\n`) : out(2, '')
    if (args === 'git remote') return out(0, '')
    if (args === 'git rev-parse --abbrev-ref HEAD') return out(0, `${host.branch}\n`)
    const alias = /^ssh -G (\S+)$/.exec(args)?.[1]
    if (alias && host.ssh[alias]) return out(0, `user git\nhostname ${host.ssh[alias]}\nport 22\n`)
    if (alias) return out(255, '')
    return out(1, '')
  })
  on('http.fetch', (_$, e) => {
    sent.push({ url: e.url, method: e.init?.method, headers: e.init?.headers, body: e.init?.body })
    if (host.fetchError) throw new Error(host.fetchError)
    const listed = (host.api as Record<string, Answer | Answer[]>)[e.url]
    const answer = Array.isArray(listed) ? (listed.length > 1 ? listed.shift() : listed[0]) : listed
    const status = answer ? (answer.status ?? 200) : 404
    return { value: { status, ok: status < 400, headers: {}, text: answer?.text ?? '{"message":"404 Not Found"}' } }
  })

  return { tools, sent, host, runs }
}

/** Starts the session, so the plugin registers its tools, and returns their names. */
export async function started($: { session: { start: (e: never) => Promise<unknown> } }, tools: Tool[]): Promise<string[]> {
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
  expect(tools.length).toBeGreaterThan(0)

  return tools.map((tool) => tool.name)
}
