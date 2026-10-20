import { expect, test } from 'claude-code/testing'
import { OFF_TEXT } from '../hooks/access'
import { ON, URL_OPTION, id, started, world } from './host'

const TOOLS = ['system_info', 'search_nodes', 'search_models', 'search_templates', 'get_template', 'submit_workflow', 'get_job_status', 'cancel_job', 'upload_file', 'get_output', 'manager_packs', 'manager_search_packs', 'manager_task', 'restart_server', 'save_workflow', 'list_workflows', 'get_workflow']
const ID = '11111111-2222-4333-8444-555555555555'
const text = (result: { result?: unknown }) => String(result.result)

test('session start registers every tool, each with a described input', ON, async ($, on) => {
  const { tools } = world(on)
  expect(await started($, tools)).toEqual(TOOLS)
  for (const tool of tools) {
    expect(tool.description.length).toBeGreaterThan(20)
    for (const [name, prop] of Object.entries(tool.inputSchema.properties)) {
      if (name !== 'action') expect(prop.description, `${tool.name}.${name}`).toBeTruthy()
    }
  }
})

test('a call without the url option is refused before any request', async ($, on) => {
  const { tools, sent } = world(on)
  await started($, tools)
  const result = await $.tool.call({ tool: id('system_info') } as never)
  expect(result.isError).toBe(true)
  expect(text(result)).toBe(OFF_TEXT['no-url'])
  expect(sent).toEqual([])
})

test('a url the repository chose is refused, and one equal to the user own is used', ON, async ($, on) => {
  const repo = { pluginConfigs: { 'comfyui-local': { options: { url: 'http://evil.example' } } } }
  const { tools, sent, host } = world(on, { project: repo, routes: { 'GET /queue': { body: { queue_running: [], queue_pending: [] } } } })
  await started($, tools)
  expect(text(await $.tool.call({ tool: id('get_job_status') } as never))).toBe(OFF_TEXT['repo-option'])
  expect(sent).toEqual([])
  host.project = { pluginConfigs: { 'comfyui-local': { options: { url: URL_OPTION } } } }
  host.user = host.project
  expect(text(await $.tool.call({ tool: id('get_job_status') } as never))).toBe('0 running, 0 pending.')
  expect(sent[0]?.url).toBe(`${URL_OPTION}/queue`)
  host.settingsFail = true
  expect(text(await $.tool.call({ tool: id('get_job_status') } as never))).toBe(OFF_TEXT.unreadable)
})

test('submit_workflow and get_job_status go through the host fetch to the configured server', ON, async ($, on) => {
  const { tools, sent } = world(on, {
    routes: {
      'POST /prompt': { body: { prompt_id: ID, number: 1 } },
      'GET /queue': { body: { queue_running: [], queue_pending: [] } },
      [`GET /history/${ID}`]: { body: { [ID]: { outputs: { '9': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] } }, status: { status_str: 'success', completed: true } } } },
    },
  })
  await started($, tools)
  const queued = await $.tool.call({ tool: id('submit_workflow'), workflow: { '1': { class_type: 'X', inputs: {} } } } as never)
  expect(text(queued)).toContain(`prompt_id ${ID}`)
  expect(sent[0]).toEqual({ url: `${URL_OPTION}/prompt`, method: 'POST', body: JSON.stringify({ prompt: { '1': { class_type: 'X', inputs: {} } }, client_id: 'comfyui-local' }) })
  expect(text(await $.tool.call({ tool: id('get_job_status'), prompt_id: ID } as never))).toContain('completed:')
})

test('upload_file and get_output run curl through the host process', ON, async ($, on) => {
  const { tools, processes } = world(on, {
    files: ['/proj/cat.png'],
    routes: { [`GET /history/${ID}`]: { body: { [ID]: { outputs: { '9': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] } }, status: { status_str: 'success', completed: true } } } } },
  })
  await started($, tools)
  expect(text(await $.tool.call({ tool: id('upload_file'), path: '/proj/cat.png' } as never))).toContain('Uploaded as up.png')
  expect(processes[0]?.slice(0, 2)).toEqual(['curl', '-sS'])
  expect(processes[0]?.at(-1)).toBe(`${URL_OPTION}/upload/image`)
  expect(text(await $.tool.call({ tool: id('get_output'), prompt_id: ID, description: 'cat' } as never))).toBe('Saved 1 file:\ncomfyui-outputs/cat.png')
  expect(processes[1]?.at(-1)).toBe(`${URL_OPTION}/view?filename=a.png&subfolder=&type=output`)
  const missing = await $.tool.call({ tool: id('upload_file'), path: '/proj/none.png' } as never)
  expect(missing.isError).toBe(true)
})

test('manager_task refuses a bad action before any request', ON, async ($, on) => {
  const { tools, sent } = world(on)
  await started($, tools)
  const result = await $.tool.call({ tool: id('manager_task'), action: 'reboot', pack: 'p' } as never)
  expect(result.isError).toBe(true)
  // the installed list is read first, to key the pack the way the Manager does; a bad action still queues nothing
  expect(sent.map((s) => s.method)).toEqual(['GET'])
})

test('restart_server waits through the host process, never the hook clock, and refuses with jobs queued', ON, async ($, on) => {
  const { tools, sent, processes, host } = world(on, { routes: { 'GET /queue': { body: { queue_running: [[1, ID, {}, {}, []]], queue_pending: [] } } } })
  await started($, tools)
  const busy = await $.tool.call({ tool: id('restart_server') } as never)
  expect(busy.isError).toBe(true)
  expect(text(busy)).toContain('1 running and 0 pending job')
  expect(sent.map((s) => s.method)).toEqual(['GET'])
  // a server that answers the reboot and stays up: one poll, slept through the host process
  host.routes = { 'GET /queue': { body: { queue_running: [], queue_pending: [] } }, 'POST /v2/manager/reboot': { body: '' }, 'GET /system_stats': { body: { system: {} } } }
  expect(text(await $.tool.call({ tool: id('restart_server') } as never))).toContain('kept running without restarting')
  expect(sent.find((s) => s.url.endsWith('/v2/manager/reboot'))).toEqual({ url: `${URL_OPTION}/v2/manager/reboot`, method: 'POST', body: '{}' })
  expect(processes).toEqual([['sleep', '2']])
})

test('save_workflow, list_workflows and get_workflow go to the user library through the host fetch', ON, async ($, on) => {
  const file = '/api/userdata/workflows%2F_teste%2Fmcp.json'
  const ui = { nodes: [], links: [] }
  const { tools, sent } = world(on, {
    routes: {
      [`POST ${file}?overwrite=false&full_info=true`]: { body: { path: 'workflows/_teste/mcp.json', size: 25, modified: 0 } },
      'GET /api/userdata?dir=workflows&recurse=true&split=false&full_info=true': { body: [{ path: '_teste/mcp.json', size: 25, modified: 0 }] },
      [`GET ${file}`]: { body: ui },
    },
  })
  await started($, tools)
  expect(text(await $.tool.call({ tool: id('save_workflow'), path: '_teste/mcp', workflow: ui } as never))).toContain('Saved workflows/_teste/mcp.json (25 bytes')
  expect(sent[0]?.body).toBe(JSON.stringify(ui))
  expect(text(await $.tool.call({ tool: id('list_workflows') } as never))).toContain('_teste/mcp.json (25 bytes')
  expect(text(await $.tool.call({ tool: id('get_workflow'), path: '_teste/mcp.json' } as never))).toContain('{"nodes":[],"links":[]}')
  const api = await $.tool.call({ tool: id('save_workflow'), path: 'x', workflow: { '1': { class_type: 'X', inputs: {} } } } as never)
  expect(api.isError).toBe(true)
  expect(sent.length).toBe(3)
})
