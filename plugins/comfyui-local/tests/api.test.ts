import { expect, test } from 'claude-code/testing'
import {
  LIMIT,
  cancelJob,
  getJobStatus,
  getOutput,
  getTemplate,
  managerPacks,
  managerTask,
  outputFiles,
  packOf,
  parseWorkflow,
  runManagerTask,
  safeSubfolder,
  searchModels,
  searchNodes,
  searchPacks,
  searchTemplates,
  slug,
  submitWorkflow,
  summarizeNode,
  systemInfo,
  uploadArgv,
  uploadFile,
  viewUrl,
  type Fetch,
  type Run,
} from '../hooks/api'

const BASE = 'http://comfy.local:8188'
const ID = '11111111-2222-4333-8444-555555555555'

type Call = { url: string; method: string; body?: string }

/** A fake server: `routes` maps "METHOD path" (path with query) to a status and body; unlisted routes answer 404. */
function server(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: Call[] = []
  const fetch: Fetch = async (url, init) => {
    const method = init?.method ?? 'GET'
    calls.push({ url, method, body: init?.body })
    const path = url.startsWith(BASE) ? url.slice(BASE.length) : url
    const route = routes[`${method} ${path}`]
    if (!route) return { status: 404, ok: false, text: 'not found' }
    const status = route.status ?? 200
    return { status, ok: status < 400, text: typeof route.body === 'string' ? route.body : JSON.stringify(route.body) }
  }
  return { fetch, calls }
}

const OBJECT_INFO = {
  KSampler: {
    input: { required: { model: ['MODEL'], seed: ['INT', { default: 0 }], sampler_name: [['euler', 'dpmpp_2m', 'ddim', 'uni_pc']] }, optional: { denoise: ['FLOAT', { default: 1 }] } },
    output: ['LATENT'],
    output_name: ['LATENT'],
    display_name: 'KSampler',
    description: 'Samples a latent.',
    python_module: 'nodes',
    category: 'sampling',
  },
  'WAS Image Blend': {
    input: { required: { image_a: ['IMAGE'], image_b: ['IMAGE'] } },
    output: ['IMAGE'],
    output_name: ['IMAGE'],
    display_name: 'Image Blend',
    description: 'Blends two images.',
    python_module: 'custom_nodes.was-node-suite-comfyui.WAS_Node_Suite',
    category: 'WAS Suite/Image',
  },
}

test('systemInfo reports the server, its devices, the queue and the Manager', async () => {
  const { fetch } = server({
    'GET /system_stats': { body: { system: { os: 'linux', comfyui_version: '0.41.0', python_version: '3.12.3 (main)', ram_total: 2 ** 30 * 32, ram_free: 2 ** 30 * 30 }, devices: [{ name: 'cuda:0 AMD Radeon Graphics', vram_total: 2 ** 30 * 16, vram_free: 2 ** 30 * 15 }] } },
    'GET /queue': { body: { queue_running: [[1, ID, {}, {}, []]], queue_pending: [] } },
    'GET /v2/manager/version': { body: 'V4.2.2' },
  })
  const out = await systemInfo(fetch, BASE)
  expect(out.isError).toBe(false)
  expect(out.text).toContain('ComfyUI 0.41.0 on linux (python 3.12.3), RAM 30.0 GiB free of 32.0 GiB')
  expect(out.text).toContain('Device: cuda:0 AMD Radeon Graphics, VRAM 15.0 GiB free of 16.0 GiB')
  expect(out.text).toContain('Queue: 1 running, 0 pending')
  expect(out.text).toContain('ComfyUI-Manager V4.2.2')
})

test('systemInfo says when the Manager is missing and fails when the server is down', async () => {
  const { fetch } = server({ 'GET /system_stats': { body: { system: {}, devices: [] } } })
  expect((await systemInfo(fetch, BASE)).text).toContain('ComfyUI-Manager: not installed')
  const down: Fetch = async () => { throw new Error('ECONNREFUSED') }
  const out = await systemInfo(down, BASE)
  expect(out.isError).toBe(true)
  expect(out.text).toBe(`Could not reach the ComfyUI server at ${BASE}: ECONNREFUSED`)
})

test('packOf and summarizeNode read the pack, inputs, combos and outputs', () => {
  expect(packOf('nodes')).toBe('core')
  expect(packOf('comfy_extras.nodes_mask')).toBe('core')
  expect(packOf('custom_nodes.ComfyUI-Pixaroma.nodes')).toBe('ComfyUI-Pixaroma')
  expect(packOf(undefined)).toBe('core')
  const node = summarizeNode('KSampler', OBJECT_INFO.KSampler)
  expect(node.pack).toBe('core')
  expect(node.inputs).toEqual(['model: MODEL', 'seed: INT = 0', 'sampler_name: COMBO[4: euler, dpmpp_2m, ddim, ...]', 'denoise?: FLOAT = 1'])
  expect(node.outputs).toEqual(['LATENT: LATENT'])
})

test('searchNodes filters by words, category, pack, input and output types, and caps the list', async () => {
  const { fetch } = server({ 'GET /object_info': { body: OBJECT_INFO } })
  const blend = await searchNodes(fetch, BASE, { query: 'blend images' })
  expect(blend.text).toContain('1 node matches')
  expect(blend.text).toContain('## WAS Image Blend (Image Blend)')
  expect(blend.text).toContain('category: WAS Suite/Image | pack: was-node-suite-comfyui')
  expect((await searchNodes(fetch, BASE, { category: 'sampling' })).text).toContain('## KSampler')
  expect((await searchNodes(fetch, BASE, { pack: 'core' })).text).toContain('1 node matches')
  expect((await searchNodes(fetch, BASE, { input_type: 'image' })).text).toContain('WAS Image Blend')
  expect((await searchNodes(fetch, BASE, { output_type: 'LATENT' })).text).toContain('KSampler')
  expect((await searchNodes(fetch, BASE, { query: 'nothing here' })).text).toContain('No node matches (2 nodes on the server)')
  const capped = await searchNodes(fetch, BASE, { limit: 1 })
  expect(capped.text).toContain('2 nodes match, showing 1')
})

test('searchModels lists folder/file across folders or in one, and names the folders when nothing matches', async () => {
  const { fetch } = server({
    'GET /models': { body: ['checkpoints', 'loras'] },
    'GET /models/checkpoints': { body: ['sdxl_base.safetensors', 'anime.safetensors'] },
    'GET /models/loras': { body: ['detail.safetensors'] },
  })
  expect((await searchModels(fetch, BASE, {})).text).toContain('3 model files')
  expect((await searchModels(fetch, BASE, { query: 'sdxl' })).text).toContain('checkpoints/sdxl_base.safetensors')
  expect((await searchModels(fetch, BASE, { folder: 'loras' })).text).toBe('1 model file (folder/file, the file name is what the loader node takes):\nloras/detail.safetensors')
  expect((await searchModels(fetch, BASE, { folder: 'vae' })).isError).toBe(true)
  expect((await searchModels(fetch, BASE, { query: 'flux' })).text).toContain('Folders on the server: checkpoints, loras')
})

const INDEX = [
  { moduleName: 'default', templates: [{ name: 'flux_t2i', title: 'Flux: Text to Image', description: 'Make an image. Fast.', tags: ['Text to Image', 'Image'], models: ['Flux'], openSource: true }, { name: 'api_nb', title: 'Nano Banana', description: 'Paid', tags: ['API'], models: ['Nano Banana'], openSource: false }] },
]

test('searchTemplates merges core and pack templates and filters by tag, model and words', async () => {
  const { fetch } = server({ 'GET /templates/index.json': { body: INDEX }, 'GET /api/workflow_templates': { body: { 'ComfyUI-Pixaroma': ['Paint Pixaroma Workflow'] } } })
  const all = await searchTemplates(fetch, BASE, {})
  expect(all.text).toContain('3 templates match')
  expect(all.text).toContain('## Paint Pixaroma Workflow (name: Paint Pixaroma Workflow, pack: ComfyUI-Pixaroma)')
  expect(all.text).toContain('requires a partner API node')
  expect((await searchTemplates(fetch, BASE, { tag: 'text to image' })).text).toContain('1 template matches')
  expect((await searchTemplates(fetch, BASE, { model: 'flux' })).text).toContain('## Flux: Text to Image (name: flux_t2i)')
  expect((await searchTemplates(fetch, BASE, { query: 'pixaroma paint' })).text).toContain('1 template matches')
  expect((await searchTemplates(fetch, BASE, { query: 'zzz' })).text).toBe('No template matches (3 templates on the server).')
})

test('getTemplate reads a core or a pack template and refuses slashes', async () => {
  const { fetch, calls } = server({ 'GET /templates/flux_t2i.json': { body: { nodes: [] } }, 'GET /api/workflow_templates/ComfyUI-Pixaroma/Paint%20Pixaroma%20Workflow.json': { body: { nodes: [1] } } })
  expect((await getTemplate(fetch, BASE, { name: 'flux_t2i' })).text).toContain('{"nodes":[]}')
  expect((await getTemplate(fetch, BASE, { name: 'Paint Pixaroma Workflow', pack: 'ComfyUI-Pixaroma' })).text).toContain('{"nodes":[1]}')
  expect(calls.map((c) => c.url)).toEqual([`${BASE}/templates/flux_t2i.json`, `${BASE}/api/workflow_templates/ComfyUI-Pixaroma/Paint%20Pixaroma%20Workflow.json`])
  expect((await getTemplate(fetch, BASE, { name: '../x' })).isError).toBe(true)
  expect((await getTemplate(fetch, BASE, { name: 'missing' })).text).toContain('answered 404')
})

const PROMPT = { '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'a.safetensors' } } }

test('parseWorkflow takes an API-format object or its JSON and refuses a UI export', () => {
  expect(parseWorkflow(PROMPT)).toEqual(PROMPT)
  expect(parseWorkflow(JSON.stringify(PROMPT))).toEqual(PROMPT)
  expect(parseWorkflow({ nodes: [], links: [] })).toBeUndefined()
  expect(parseWorkflow('{')).toBeUndefined()
  expect(parseWorkflow({})).toBeUndefined()
})

test('submitWorkflow posts the prompt with a client id and answers the prompt_id or the node errors', async () => {
  const { fetch, calls } = server({ 'POST /prompt': { body: { prompt_id: ID, number: 3, node_errors: {} } } })
  const out = await submitWorkflow(fetch, BASE, { workflow: PROMPT })
  expect(out.text).toBe(`Queued: prompt_id ${ID}, number 3. Poll get_job_status with the prompt_id.`)
  expect(JSON.parse(calls[0]?.body ?? '')).toEqual({ prompt: PROMPT, client_id: 'comfyui-local' })
  const refused = server({ 'POST /prompt': { status: 400, body: { error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation', details: '' }, node_errors: { '1': { class_type: 'CheckpointLoaderSimple', errors: [{ message: 'Value not in list', details: "ckpt_name: 'a.safetensors' not in ['b.safetensors']" }] } } } } })
  const err = await submitWorkflow(refused.fetch, BASE, { workflow: PROMPT })
  expect(err.isError).toBe(true)
  expect(err.text).toContain('Prompt outputs failed validation')
  expect(err.text).toContain("node 1 (CheckpointLoaderSimple): Value not in list (ckpt_name: 'a.safetensors' not in ['b.safetensors'])")
  expect((await submitWorkflow(fetch, BASE, { workflow: { nodes: [], links: [] } })).isError).toBe(true)
})

const DONE = { [ID]: { outputs: { '9': { images: [{ filename: 'ComfyUI_00001_.png', subfolder: '', type: 'output' }] } }, status: { status_str: 'success', completed: true, messages: [] } } }

test('outputFiles reads every file list of every node', () => {
  expect(outputFiles(DONE[ID])).toEqual([{ node: '9', kind: 'images', filename: 'ComfyUI_00001_.png', subfolder: '', type: 'output' }])
  expect(outputFiles({ outputs: { '2': { audio: [{ filename: 'a.flac', subfolder: 'audio', type: 'output' }], text: ['x'] } } })).toEqual([{ node: '2', kind: 'audio', filename: 'a.flac', subfolder: 'audio', type: 'output' }])
  expect(outputFiles(undefined)).toEqual([])
})

test('getJobStatus tells pending, running, completed, failed and unknown jobs apart, and lists the queue', async () => {
  const other = '22222222-2222-4333-8444-555555555555'
  const { fetch } = server({
    'GET /queue': { body: { queue_running: [[1, other, {}, {}, []]], queue_pending: [[2, ID, {}, {}, []]] } },
    [`GET /history/${ID}`]: { body: {} },
    [`GET /history/${other}`]: { body: {} },
  })
  expect((await getJobStatus(fetch, BASE, {})).text).toBe(`1 running, 1 pending.\nrunning: ${other} (#1)\npending 1: ${ID} (#2)`)
  expect((await getJobStatus(fetch, BASE, { prompt_id: ID })).text).toBe(`pending: ${ID} is number 1 of 1 in the queue, behind 1 running.`)
  expect((await getJobStatus(fetch, BASE, { prompt_id: other })).text).toContain('running:')
  expect((await getJobStatus(fetch, BASE, { prompt_id: 'nope' })).isError).toBe(true)
  const done = server({ 'GET /queue': { body: { queue_running: [], queue_pending: [] } }, [`GET /history/${ID}`]: { body: DONE }, [`GET /history/${other}`]: { body: {} } })
  expect((await getJobStatus(done.fetch, BASE, { prompt_id: ID })).text).toBe(`completed: ${ID}, 1 output file (fetch them with get_output):\nnode 9 images: ComfyUI_00001_.png [output]`)
  const unknown = await getJobStatus(done.fetch, BASE, { prompt_id: other })
  expect(unknown.isError).toBe(true)
  expect(unknown.text).toContain('unknown:')
  const failed = server({ 'GET /queue': { body: {} }, [`GET /history/${ID}`]: { body: { [ID]: { outputs: {}, status: { status_str: 'error', completed: false, messages: [['execution_start', {}], ['execution_error', { node_id: '3', node_type: 'KSampler', exception_message: 'out of memory' }]] } } } } })
  const out = await getJobStatus(failed.fetch, BASE, { prompt_id: ID })
  expect(out.isError).toBe(true)
  expect(out.text).toBe(`failed: ${ID}\nKSampler (node 3): out of memory`)
})

test('cancelJob deletes a pending job, interrupts a running one, or clears the queue', async () => {
  const other = '22222222-2222-4333-8444-555555555555'
  const { fetch, calls } = server({ 'GET /queue': { body: { queue_running: [[1, other, {}, {}, []]], queue_pending: [[2, ID, {}, {}, []]] } }, 'POST /queue': { body: '' }, 'POST /interrupt': { body: '' } })
  expect((await cancelJob(fetch, BASE, { prompt_id: ID })).text).toBe(`${ID} removed from the pending queue`)
  expect(calls.at(-1)).toEqual({ url: `${BASE}/queue`, method: 'POST', body: JSON.stringify({ delete: [ID] }) })
  expect((await cancelJob(fetch, BASE, { prompt_id: other })).text).toBe(`${other} interrupted`)
  expect(calls.at(-1)?.body).toBe(JSON.stringify({ prompt_id: other }))
  expect((await cancelJob(fetch, BASE, {})).text).toBe('the running job was interrupted')
  expect((await cancelJob(fetch, BASE, { clear_pending: true })).text).toBe('pending queue cleared')
  expect(calls.at(-1)?.body).toBe(JSON.stringify({ clear: true }))
  const gone = await cancelJob(fetch, BASE, { prompt_id: '33333333-2222-4333-8444-555555555555' })
  expect(gone.isError).toBe(true)
})

test('safeSubfolder, uploadArgv, slug and viewUrl shape what curl sends', () => {
  expect(safeSubfolder(undefined)).toBe('')
  expect(safeSubfolder('refs/cats')).toBe('refs/cats')
  expect(safeSubfolder('../x')).toBeUndefined()
  expect(safeSubfolder('/abs')).toBeUndefined()
  expect(uploadArgv(BASE, '/tmp/my "pic";1.png', 'refs', true)).toEqual(['curl', '-sS', '--max-time', '300', '-F', 'image=@"/tmp/my \\"pic\\";1.png"', '-F', 'subfolder=refs', '-F', 'overwrite=true', '-F', 'type=input', `${BASE}/upload/image`])
  expect(slug('Cat Astronaut, in space!', ID)).toBe('cat-astronaut-in-space')
  expect(slug(undefined, ID)).toBe('11111111')
  expect(viewUrl(BASE, { node: '9', kind: 'images', filename: 'a b.png', subfolder: 'sub', type: 'output' })).toBe(`${BASE}/view?filename=a+b.png&subfolder=sub&type=output`)
})

const ran = (exitCode: number, stdout = '', stderr = '') => ({ exitCode, stdout, stderr })

test('uploadFile runs curl and answers the server file name, or why not', async () => {
  const argvs: string[][] = []
  const run: Run = async (argv) => (argvs.push([...argv]), ran(0, JSON.stringify({ name: 'cat.png', subfolder: 'refs', type: 'input' })))
  const exists = async (path: string) => path === '/tmp/cat.png'
  const out = await uploadFile(run, exists, BASE, { path: '/tmp/cat.png', subfolder: 'refs' })
  expect(out.text).toBe('Uploaded as refs/cat.png (type input). Use "refs/cat.png" as the image input of a LoadImage node.')
  expect(argvs[0]?.[0]).toBe('curl')
  expect((await uploadFile(run, exists, BASE, { path: '/tmp/none.png' })).text).toBe('No file at /tmp/none.png.')
  expect((await uploadFile(run, exists, BASE, {})).isError).toBe(true)
  expect((await uploadFile(run, exists, BASE, { path: '/tmp/cat.png', subfolder: '../x' })).isError).toBe(true)
  const failing: Run = async () => ran(7, '', 'curl: (7) Failed to connect')
  expect((await uploadFile(failing, exists, BASE, { path: '/tmp/cat.png' })).text).toBe('Upload failed: curl: (7) Failed to connect')
  const odd: Run = async () => ran(0, '<html>')
  expect((await uploadFile(odd, exists, BASE, { path: '/tmp/cat.png' })).text).toContain('did not confirm the upload')
})

test('getOutput downloads each output file with curl into the folder and names them by the description', async () => {
  const two = { [ID]: { outputs: { '9': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }, { filename: 'b.png', subfolder: 'x', type: 'output' }] }, '5': { images: [{ filename: 'p.png', subfolder: '', type: 'temp' }] } }, status: { status_str: 'success', completed: true } } }
  const { fetch } = server({ [`GET /history/${ID}`]: { body: two } })
  const argvs: string[][] = []
  const run: Run = async (argv) => (argvs.push([...argv]), ran(0))
  const out = await getOutput(fetch, run, BASE, { prompt_id: ID, description: 'Cat astronaut' })
  expect(out.text).toBe('Saved 3 files:\ncomfyui-outputs/cat-astronaut-1.png\ncomfyui-outputs/cat-astronaut-2.png\ncomfyui-outputs/cat-astronaut-3.png')
  // node ids order numerically, so node 5's preview comes first
  expect(argvs[2]).toEqual(['curl', '-sS', '-f', '--max-time', '600', '--create-dirs', '-o', 'comfyui-outputs/cat-astronaut-3.png', `${BASE}/view?filename=b.png&subfolder=x&type=output`])
  const one = server({ [`GET /history/${ID}`]: { body: DONE } })
  expect((await getOutput(one.fetch, run, BASE, { prompt_id: ID, directory: '/out/' })).text).toBe('Saved 1 file:\n/out/11111111.png')
  const failing: Run = async () => ran(22, '', 'curl: (22) 404')
  const err = await getOutput(one.fetch, failing, BASE, { prompt_id: ID })
  expect(err.isError).toBe(true)
  expect(err.text).toBe('Failed:\nComfyUI_00001_.png: curl: (22) 404')
  expect((await getOutput(one.fetch, run, BASE, { prompt_id: 'x' })).isError).toBe(true)
  const empty = server({ [`GET /history/${ID}`]: { body: {} } })
  expect((await getOutput(empty.fetch, run, BASE, { prompt_id: ID })).text).toContain('not in the history yet')
})

test('managerPacks lists the packs with state, the Manager version and its queue, or says the Manager is missing', async () => {
  const { fetch } = server({
    'GET /v2/customnode/installed': { body: { 'ComfyUI-DyPE': { ver: '2.19.1', cnr_id: 'ComfyUI-DyPE', aux_id: null, enabled: true }, old: { ver: 'abc123', cnr_id: null, aux_id: 'me/old', enabled: false } } },
    'GET /v2/manager/version': { body: 'V4.2.2' },
    'GET /v2/manager/queue/status': { body: { total_count: 1, done_count: 0, in_progress_count: 1, pending_count: 0, is_processing: true } },
  })
  const out = await managerPacks(fetch, BASE, {})
  expect(out.text).toBe('ComfyUI-Manager V4.2.2: 2 packs; task queue: 1 in progress, 0 pending, 0 done, processing.\nComfyUI-DyPE: 2.19.1 (registry id ComfyUI-DyPE)\nold: abc123 (me/old) [disabled]')
  expect((await managerPacks(fetch, BASE, { state: 'disabled' })).text).toContain('1 pack (disabled);')
  const none = await managerPacks(server({}).fetch, BASE, {})
  expect(none.isError).toBe(true)
  expect(none.text).toContain('not installed on this server, or it is older than version 4')
})

test('searchPacks queries the Comfy Registry', async () => {
  const { fetch, calls } = server({ 'GET https://api.comfy.org/nodes?search=pixel%20art&limit=5': { body: { nodes: [{ id: 'comfyui-pixel', name: 'Pixel Art', description: 'Pixelates.\nMore.', repository: 'https://github.com/x/y', downloads: 12, latest_version: { version: '1.2.0' } }] } } })
  const out = await searchPacks(fetch, { query: 'pixel art', limit: 5 })
  expect(out.text).toBe('1 pack (install one with manager_task action install and its id):\n\n## Pixel Art (id: comfyui-pixel, latest 1.2.0)\nPixelates.\nrepository: https://github.com/x/y\ndownloads: 12')
  expect(calls[0]?.url).toBe('https://api.comfy.org/nodes?search=pixel%20art&limit=5')
  expect((await searchPacks(fetch, {})).isError).toBe(true)
})

test('managerTask builds the Manager 4 task body per action', () => {
  expect(managerTask({ action: 'install', pack: 'comfyui-pixel' }, 'u1').task).toEqual({ ui_id: 'u1', client_id: 'comfyui-local', kind: 'install', params: { id: 'comfyui-pixel', version: 'latest', selected_version: 'latest', mode: 'cache', channel: 'default', skip_post_install: false } })
  expect(managerTask({ action: 'install', pack: 'p', version: 'nightly', repository: 'https://github.com/x/p' }, 'u').task?.params).toEqual(expect.objectContaining({ selected_version: 'nightly', repository: 'https://github.com/x/p' }))
  expect(managerTask({ action: 'install', pack: 'p', version: 'nightly' }, 'u').error).toContain('repository')
  expect(managerTask({ action: 'update', pack: 'p', version: '1.0.0' }, 'u').task?.params).toEqual({ node_name: 'p', node_ver: '1.0.0' })
  expect(managerTask({ action: 'uninstall', pack: 'p' }, 'u').task?.params).toEqual({ node_name: 'p', is_unknown: false })
  expect(managerTask({ action: 'disable', pack: 'p' }, 'u').task?.kind).toBe('disable')
  expect(managerTask({ action: 'enable', pack: 'p' }, 'u').task?.params).toEqual({ cnr_id: 'p' })
  expect(managerTask({ action: 'fix', pack: 'p' }, 'u').task?.params).toEqual({ node_name: 'p', node_ver: 'unknown' })
  expect(managerTask({ action: 'reboot', pack: 'p' }, 'u').error).toContain('action must be one of')
  expect(managerTask({ action: 'install', pack: 'a b' }, 'u').error).toContain('pack must be')
})

test('runManagerTask queues the task, starts the worker and reports; a 404 means no Manager', async () => {
  const { fetch, calls } = server({ 'POST /v2/manager/queue/task': { body: '' }, 'POST /v2/manager/queue/start': { status: 201, body: '' } })
  const out = await runManagerTask(fetch, BASE, { action: 'install', pack: 'comfyui-pixel' }, 'u1')
  expect(out.text).toBe('install of comfyui-pixel queued (task u1). Check progress with manager_packs; a restart of ComfyUI is needed before new or removed nodes show in search_nodes.')
  expect(calls.map((c) => `${c.method} ${c.url.slice(BASE.length)}`)).toEqual(['POST /v2/manager/queue/task', 'POST /v2/manager/queue/start'])
  const none = await runManagerTask(server({}).fetch, BASE, { action: 'install', pack: 'p' }, 'u')
  expect(none.isError).toBe(true)
  expect(none.text).toContain('not installed on this server')
  const refused = await runManagerTask(server({ 'POST /v2/manager/queue/task': { status: 400, body: 'Invalid task data' } }).fetch, BASE, { action: 'install', pack: 'p' }, 'u')
  expect(refused.text).toBe('The Manager refused the task (400): Invalid task data')
})

test('an answer past the limit is cut and says so', async () => {
  const many = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`Node${i}`, { ...OBJECT_INFO.KSampler, description: 'x'.repeat(400) }]))
  const { fetch } = server({ 'GET /object_info': { body: many } })
  const out = await searchNodes(fetch, BASE, { limit: 200 })
  expect(out.text.length).toBeLessThan(LIMIT + 100)
  expect(out.text).toContain(`[cut at ${LIMIT} characters]`)
})
