import { expect, test } from 'claude-code/testing'
import { id, started, world } from './host'

const MR = id('gitlab_mr')
const WORK = 'glpat-work-123'
const PERSONAL = 'glpat-personal-456'
const ON = { options: { tokens: `gitlab.example.com=${WORK}, gitlab.com=${PERSONAL}` } }

const WORK_API = 'https://gitlab.example.com/api/v4/projects/team%2Fapp'
const PERSONAL_API = 'https://gitlab.com/api/v4/projects/anderson-spider%2Ftools'
const MR_JSON = JSON.stringify({ iid: 7, title: 't', state: 'opened', source_branch: 'feature/x', target_branch: 'main', web_url: 'u' })

/** A valid call of each tool, which a test sends once per tool. */
const CALLS: Record<string, Record<string, unknown>> = {
  gitlab_mr: { action: 'get', iid: 7 },
  gitlab_mr_comment: { action: 'list', iid: 7 },
  gitlab_pipeline: { action: 'list', iid: 7 },
  gitlab_job_log: { jobId: 2 },
}
const call = (name: string) => ({ tool: id(name), ...CALLS[name] }) as never
const text = (result: { result?: unknown }) => String(result.result)

test('session start registers the four tools and no merge action', ON, async ($, on) => {
  const { tools } = world(on)

  expect(await started($, tools)).toEqual(Object.keys(CALLS))
  const mr = tools.find((t) => t.name === 'gitlab_mr')!
  expect((mr.inputSchema.properties.action as { enum?: string[] }).enum).not.toContain('merge')
  expect(mr.description).toContain('Merging is not offered.')
})

test('each tool keeps its tool and schema descriptions within the prompt budget', ON, async ($, on) => {
  const { tools } = world(on)
  await started($, tools)
  const chars = (node: unknown): number =>
    Array.isArray(node)
      ? node.reduce((n: number, v) => n + chars(v), 0)
      : node && typeof node === 'object'
        ? Object.entries(node).reduce((n, [k, v]) => n + (k === 'description' && typeof v === 'string' ? v.length : chars(v)), 0)
        : 0

  for (const tool of tools) expect(chars(tool), tool.name).toBeLessThanOrEqual(900)
})

test('the remote picks the host and its own token: the work host for one repository, gitlab.com for another', ON, async ($, on) => {
  const { sent, host } = world(on, { api: { [`${WORK_API}/merge_requests/7`]: { text: MR_JSON }, [`${PERSONAL_API}/merge_requests/7`]: { text: MR_JSON } } })

  const work = await $.tool.call({ tool: MR, action: 'get', iid: 7 } as never)
  host.remote = 'https://gitlab.com/anderson-spider/tools.git'
  const personal = await $.tool.call({ tool: MR, action: 'get', iid: 7 } as never)

  expect(work.isError).toBeUndefined()
  expect(personal.isError).toBeUndefined()
  expect(sent.map((s) => [s.url, s.headers?.['PRIVATE-TOKEN']])).toEqual([
    [`${WORK_API}/merge_requests/7`, WORK],
    [`${PERSONAL_API}/merge_requests/7`, PERSONAL],
  ])
})

test('a host with no token in the option is refused by name, and nothing is sent', ON, async ($, on) => {
  const { sent, tools, host } = world(on)
  host.remote = 'git@gitlab.other.org:team/app.git'

  for (const name of await started($, tools)) {
    const result = await $.tool.call(call(name))
    expect(result.isError, name).toBe(true)
    expect(text(result), name).toBe('The gitlab tokens option has no token for gitlab.other.org. Add gitlab.other.org=<token> in the plugin options (/plugin, gitlab, configure).')
  }
  expect(sent).toEqual([])
})

test('without the option, outside a GitLab repository, with repository-declared tokens or unreadable settings, nothing is sent', ON, async ($, on) => {
  const { sent, tools, host } = world(on)
  const names = await started($, tools)

  host.remote = ''
  for (const name of names) expect(text(await $.tool.call(call(name))), name).toMatch(/not a git repository with a GitLab remote/)
  host.remote = 'git@gitlab.example.com:team/app.git'
  host.project = { pluginConfigs: { gitlab: { options: { tokens: `gitlab.example.com=${WORK}` } } } }
  for (const name of names) expect(text(await $.tool.call(call(name))), name).toMatch(/repository settings declare/)
  host.project = undefined
  host.settingsFail = true
  for (const name of names) expect(text(await $.tool.call(call(name))), name).toMatch(/could not be read/)

  expect(sent).toEqual([])
})

test('an unset option says where to set it', async ($, on) => {
  const { sent } = world(on)
  const result = await $.tool.call({ tool: MR, action: 'get', iid: 7 } as never)
  expect(text(result)).toBe('The gitlab tokens option is not set. Set it in the plugin options (/plugin, gitlab, configure) as host=token pairs.')
  expect(sent).toEqual([])
})

test('API errors and failed calls are error results naming the project, and no output carries a token', ON, async ($, on) => {
  const { tools, host } = world(on, { api: { [`${WORK_API}/merge_requests/7`]: { status: 403, text: '{"message":"403 Forbidden"}' } } })
  const names = await started($, tools)
  const results: string[] = []

  const denied = await $.tool.call({ tool: MR, action: 'get', iid: 7 } as never)
  expect(denied.isError).toBe(true)
  expect(text(denied)).toBe('GitLab answered 403 for team/app: 403 Forbidden')
  results.push(text(denied))
  for (const name of names) results.push(text(await $.tool.call(call(name))))
  host.fetchError = 'connection reset'
  for (const name of names) results.push(text(await $.tool.call(call(name))))

  expect(results.at(-1)).toMatch(/^Call to gitlab\.example\.com failed: /)
  for (const out of results) {
    expect(out).not.toContain(WORK)
    expect(out).not.toContain(PERSONAL)
  }
})

test('the token goes only in the PRIVATE-TOKEN header, and writes send JSON', ON, async ($, on) => {
  const { sent } = world(on, { api: { [`${WORK_API}/merge_requests/7/notes`]: { text: '{"id":5}' } } })

  const result = await $.tool.call({ tool: id('gitlab_mr_comment'), action: 'comment', iid: 7, body: 'LGTM' } as never)

  expect(text(result)).toBe('{"note":5}')
  expect(sent).toHaveLength(1)
  expect(sent[0]).toEqual({
    url: `${WORK_API}/merge_requests/7/notes`,
    method: 'POST',
    headers: { 'PRIVATE-TOKEN': WORK, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: '{"body":"LGTM"}',
  })
})

test('a refused input is an error result before any request', ON, async ($, on) => {
  const { sent } = world(on)
  const result = await $.tool.call({ tool: MR, action: 'get', iid: -3 } as never)
  expect(result.isError).toBe(true)
  expect(text(result)).toBe('iid must be a positive integer.')
  expect(sent).toEqual([])
})
