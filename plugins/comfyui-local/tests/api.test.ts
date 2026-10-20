import { expect, test } from 'claude-code/testing'
import {
  LIMIT,
  cancelJob,
  getJobStatus,
  getOutput,
  getTemplate,
  getWorkflow,
  listWorkflows,
  managerPacks,
  managerTask,
  outputFiles,
  packOf,
  parseWorkflow,
  restartServer,
  runManagerTask,
  safeSubfolder,
  saveWorkflow,
  searchModels,
  searchNodes,
  searchPacks,
  searchTemplates,
  slug,
  submitWorkflow,
  summarizeNode,
  systemInfo,
  uploadArgv,
  uiWorkflow,
  uploadFile,
  viewUrl,
  workflowFile,
  type Clock,
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
  const several = await searchNodes(fetch, BASE, { query: 'KSampler Blend' })
  expect(several.text).toContain('2 nodes match at least one word')
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
  expect((await cancelJob(server({ 'GET /queue': { body: {} } }).fetch, BASE, {})).text).toBe('nothing is running, so there was nothing to interrupt')
  const refused = server({ 'GET /queue': { body: { queue_running: [[1, ID, {}, {}, []]] } }, 'POST /interrupt': { status: 500, body: 'boom' } })
  const err = await cancelJob(refused.fetch, BASE, {})
  expect(err.isError).toBe(true)
  expect(err.text).toBe('POST /interrupt answered 500: boom')
})

test('safeSubfolder, uploadArgv, slug and viewUrl shape what curl sends', () => {
  expect(safeSubfolder(undefined)).toBe('')
  expect(safeSubfolder('refs/cats')).toBe('refs/cats')
  expect(safeSubfolder('../x')).toBeUndefined()
  expect(safeSubfolder('/abs')).toBeUndefined()
  expect(uploadArgv(BASE, '/tmp/my "pic";1.png', 'refs', true)).toEqual(['curl', '-sS', '--max-time', '290', '-F', 'image=@"/tmp/my \\"pic\\";1.png"', '--form-string', 'subfolder=refs', '--form-string', 'overwrite=true', '--form-string', 'type=input', `${BASE}/upload/image`])
  // a text field is never read from a file: a subfolder of "<" or "@" stays a literal under --form-string
  expect(safeSubfolder('</etc/passwd')).toBe('</etc/passwd')
  expect(uploadArgv(BASE, '/tmp/a.png', '@/etc/passwd', false)).toContain('subfolder=@/etc/passwd')
  expect(uploadArgv(BASE, '/tmp/a.png', '@/etc/passwd', false).filter((a) => a === '-F')).toEqual(['-F'])
  expect(slug('Cat Astronaut, in space!', ID)).toBe('cat-astronaut-in-space')
  expect(slug(undefined, ID)).toBe('11111111')
  expect(viewUrl(BASE, { node: '9', kind: 'images', filename: 'a b.png', subfolder: 'sub', type: 'output' })).toBe(`${BASE}/view?filename=a+b.png&subfolder=sub&type=output`)
})

const ran = (exitCode: number, stdout = '', stderr = '') => ({ exitCode, stdout, stderr })

test('uploadFile runs curl and answers the server file name, or why not', async () => {
  const argvs: string[][] = []
  const inits: unknown[] = []
  const run: Run = async (argv, init) => (argvs.push([...argv]), inits.push(init), ran(0, JSON.stringify({ name: 'cat.png', subfolder: 'refs', type: 'input' })))
  const exists = async (path: string) => path === '/tmp/cat.png'
  const out = await uploadFile(run, exists, BASE, { path: '/tmp/cat.png', subfolder: 'refs' })
  expect(out.text).toBe('Uploaded as refs/cat.png (type input). Use "refs/cat.png" as the image input of a LoadImage node.')
  expect(argvs[0]?.[0]).toBe('curl')
  expect(inits[0]).toEqual({ timeoutMs: 300_000 })
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
  const inits: unknown[] = []
  const run: Run = async (argv, init) => (argvs.push([...argv]), inits.push(init), ran(0))
  const out = await getOutput(fetch, run, BASE, { prompt_id: ID, description: 'Cat astronaut' })
  expect(out.text).toBe('Saved 3 files:\ncomfyui-outputs/cat-astronaut-1.png\ncomfyui-outputs/cat-astronaut-2.png\ncomfyui-outputs/cat-astronaut-3.png')
  // node ids order numerically, so node 5's preview comes first
  expect(argvs[2]).toEqual(['curl', '-sS', '-f', '--max-time', '590', '--create-dirs', '-o', 'comfyui-outputs/cat-astronaut-3.png', `${BASE}/view?filename=b.png&subfolder=x&type=output`])
  expect(inits[0]).toEqual({ timeoutMs: 600_000 })
  const one = server({ [`GET /history/${ID}`]: { body: DONE } })
  expect((await getOutput(one.fetch, run, BASE, { prompt_id: ID, directory: '/out/' })).text).toBe('Saved 1 file:\n/out/11111111.png')
  const failing: Run = async () => ran(22, '', 'curl: (22) 404')
  const err = await getOutput(one.fetch, failing, BASE, { prompt_id: ID })
  expect(err.isError).toBe(true)
  expect(err.text).toBe('Failed:\nComfyUI_00001_.png: curl: (22) 404')
  expect((await getOutput(one.fetch, run, BASE, { prompt_id: 'x' })).isError).toBe(true)
  expect((await getOutput(one.fetch, run, BASE, { prompt_id: ID.toUpperCase(), directory: '/out' })).text).toBe('Saved 1 file:\n/out/11111111.png')
  const empty = server({ [`GET /history/${ID}`]: { body: {} } })
  expect((await getOutput(empty.fetch, run, BASE, { prompt_id: ID })).text).toContain('not in the history yet')
})

test('managerPacks lists the packs with state, the Manager version and its queue, or says the Manager is missing', async () => {
  const { fetch } = server({
    'GET /v2/customnode/installed': { body: { 'ComfyUI-DyPE': { ver: '2.19.1', cnr_id: 'ComfyUI-DyPE', aux_id: null, enabled: true }, old: { ver: 'abc123', cnr_id: null, aux_id: 'me/old', enabled: false } } },
    'GET /v2/manager/version': { body: 'V4.2.2' },
    'GET /v2/manager/queue/status': { body: { total_count: 1, done_count: 0, in_progress_count: 1, pending_count: 0, is_processing: true } },
    'GET /v2/manager/queue/history?max_items=5': { body: { history: { u1: { kind: 'install', params: { id: 'comfyui-pixel' }, status: { status_str: 'success', completed: true, messages: [] } } } } },
  })
  const out = await managerPacks(fetch, BASE, {})
  expect(out.text).toBe('ComfyUI-Manager V4.2.2: 2 packs; task queue: 1 in progress, 0 pending, 0 done, processing.\nComfyUI-DyPE: 2.19.1 (registry id ComfyUI-DyPE)\nold: abc123 (me/old, not from the registry) [disabled]\n\nRecent tasks:\nu1: install comfyui-pixel -> success')
  expect((await managerPacks(fetch, BASE, { state: 'disabled' })).text).toContain('1 pack (disabled);')
  const none = await managerPacks(server({}).fetch, BASE, {})
  expect(none.isError).toBe(true)
  expect(none.text).toContain('not installed on this server, or it is older than version 4')
})

test('searchPacks queries the Comfy Registry', async () => {
  const { fetch, calls } = server({ 'GET https://api.comfy.org/nodes?search=pixel%20art&limit=5': { body: { nodes: [{ id: 'comfyui-pixel', name: 'Pixel Art', description: 'Pixelates.\nMore.', repository: 'https://github.com/x/y', downloads: 12, latest_version: { version: '1.2.0' } }] } } })
  const down: Fetch = async () => { throw new Error('ENOTFOUND') }
  expect((await searchPacks(down, { query: 'x' })).text).toBe('Could not reach the Comfy Registry at https://api.comfy.org: ENOTFOUND')
  const out = await searchPacks(fetch, { query: 'pixel art', limit: 5 })
  expect(out.text).toBe('1 pack (install one with manager_task action install and its id):\n\n## Pixel Art (id: comfyui-pixel, latest 1.2.0)\nPixelates.\nrepository: https://github.com/x/y\ndownloads: 12')
  expect(calls[0]?.url).toBe('https://api.comfy.org/nodes?search=pixel%20art&limit=5')
  expect((await searchPacks(fetch, {})).isError).toBe(true)
})

const INSTALLED = [
  { folder: 'ComfyUI-DyPE', cnr_id: 'comfyui-dype', ver: '2.19.1', enabled: true },
  { folder: 'old', aux_id: 'me/old', ver: 'abc123', enabled: false },
  { folder: 'tiles', aux_id: 'me/tiles', ver: 'c10836d', enabled: true },
]

test('managerTask builds the Manager 4 task body per action, keying installed packs the way the worker does', () => {
  expect(managerTask({ action: 'install', pack: 'comfyui-pixel' }, 'u1', INSTALLED).task).toEqual({ ui_id: 'u1', client_id: 'comfyui-local', kind: 'install', params: { id: 'comfyui-pixel', version: 'latest', selected_version: 'latest', mode: 'cache', channel: 'default', skip_post_install: false } })
  expect(managerTask({ action: 'install', pack: 'p', version: 'nightly', repository: 'https://github.com/x/p' }, 'u', INSTALLED).task?.params).toEqual(expect.objectContaining({ selected_version: 'nightly', repository: 'https://github.com/x/p' }))
  expect(managerTask({ action: 'install', pack: 'p', version: 'nightly' }, 'u', INSTALLED).error).toContain('repository')
  // a registry pack goes by its registry id, whether named by folder or id; the version defaults to the installed one
  expect(managerTask({ action: 'update', pack: 'ComfyUI-DyPE' }, 'u', INSTALLED).task?.params).toEqual({ node_name: 'comfyui-dype', node_ver: '2.19.1' })
  expect(managerTask({ action: 'update', pack: 'comfyui-dype', version: '1.0.0' }, 'u', INSTALLED).task?.params).toEqual({ node_name: 'comfyui-dype', node_ver: '1.0.0' })
  expect(managerTask({ action: 'uninstall', pack: 'ComfyUI-DyPE' }, 'u', INSTALLED).task?.params).toEqual({ node_name: 'comfyui-dype', is_unknown: false })
  // a git-cloned pack goes by its folder as unknown
  expect(managerTask({ action: 'uninstall', pack: 'old' }, 'u', INSTALLED).task?.params).toEqual({ node_name: 'old', is_unknown: true })
  expect(managerTask({ action: 'disable', pack: 'old' }, 'u', INSTALLED).task?.kind).toBe('disable')
  expect(managerTask({ action: 'update', pack: 'tiles' }, 'u', INSTALLED).task?.params).toEqual({ node_name: 'tiles', node_ver: 'c10836d' })
  expect(managerTask({ action: 'enable', pack: 'ComfyUI-DyPE' }, 'u', INSTALLED).task?.params).toEqual({ cnr_id: 'comfyui-dype' })
  expect(managerTask({ action: 'enable', pack: 'old' }, 'u', INSTALLED).error).toContain('did not come from the registry')
  expect(managerTask({ action: 'fix', pack: 'ComfyUI-DyPE' }, 'u', INSTALLED).task?.params).toEqual({ node_name: 'comfyui-dype', node_ver: '2.19.1' })
  expect(managerTask({ action: 'update', pack: 'nope' }, 'u', INSTALLED).error).toContain('not an installed pack')
  expect(managerTask({ action: 'reboot', pack: 'p' }, 'u', INSTALLED).error).toContain('action must be one of')
  expect(managerTask({ action: 'install', pack: 'a b' }, 'u', INSTALLED).error).toContain('pack must be')
})

test('runManagerTask queues the task, starts the worker and reports the result when it is already there; a 404 means no Manager', async () => {
  // the Manager lists a git-cloned pack the registry does not know with cnr_id "", which is no registry id
  const installed = { 'GET /v2/customnode/installed': { body: { old: { ver: 'abc', cnr_id: '', aux_id: 'me/old', enabled: true } } } }
  const { fetch, calls } = server({ ...installed, 'POST /v2/manager/queue/task': { body: '' }, 'POST /v2/manager/queue/start': { status: 201, body: '' } })
  const out = await runManagerTask(fetch, BASE, { action: 'install', pack: 'comfyui-pixel' }, 'u1')
  expect(out.text).toBe('install of comfyui-pixel queued (task u1). manager_packs shows the task queue and recent results; a restart of ComfyUI (restart_server) is needed before new or removed nodes show in search_nodes.')
  expect(calls.map((c) => `${c.method} ${c.url.slice(BASE.length)}`)).toEqual(['GET /v2/customnode/installed', 'POST /v2/manager/queue/task', 'POST /v2/manager/queue/start', 'GET /v2/manager/queue/history?ui_id=u1'])
  expect(JSON.parse(calls[1]?.body ?? '')).toEqual({ ui_id: 'u1', client_id: 'comfyui-local', kind: 'install', params: expect.objectContaining({ id: 'comfyui-pixel' }) })
  const quick = server({ ...installed, 'POST /v2/manager/queue/task': { body: '' }, 'POST /v2/manager/queue/start': { body: '' }, 'GET /v2/manager/queue/history?ui_id=u2': { body: { history: { u2: { kind: 'disable', params: { node_name: 'old' }, status: { status_str: 'success', completed: true, messages: [] } } } } } })
  expect((await runManagerTask(quick.fetch, BASE, { action: 'disable', pack: 'old' }, 'u2')).text).toBe('disable of old done: u2: disable old -> success. Restart ComfyUI (restart_server) for the nodes to change.')
  const failed = server({ ...installed, 'POST /v2/manager/queue/task': { body: '' }, 'POST /v2/manager/queue/start': { body: '' }, 'GET /v2/manager/queue/history?ui_id=u3': { body: { history: { u3: { kind: 'uninstall', params: { node_name: 'old' }, status: { status_str: 'failed', completed: true, messages: ['security level'] } } } } } })
  const err = await runManagerTask(failed.fetch, BASE, { action: 'uninstall', pack: 'old' }, 'u3')
  expect(JSON.parse(failed.calls[1]?.body ?? '').params).toEqual({ node_name: 'old', is_unknown: true })
  expect(err.isError).toBe(true)
  expect(err.text).toContain('uninstall of old failed: u3: uninstall old -> failed (security level)')
  const none = await runManagerTask(server({}).fetch, BASE, { action: 'install', pack: 'p' }, 'u')
  expect(none.isError).toBe(true)
  expect(none.text).toContain('not installed on this server')
  const refused = await runManagerTask(server({ ...installed, 'POST /v2/manager/queue/task': { status: 400, body: 'Invalid task data' } }).fetch, BASE, { action: 'install', pack: 'p' }, 'u')
  expect(refused.text).toBe('The Manager refused the task (400): Invalid task data')
})

test('an answer past the limit is cut and says so', async () => {
  const many = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`Node${i}`, { ...OBJECT_INFO.KSampler, description: 'x'.repeat(400) }]))
  const { fetch } = server({ 'GET /object_info': { body: many } })
  const out = await searchNodes(fetch, BASE, { limit: 200 })
  expect(out.text.length).toBeLessThan(LIMIT + 100)
  expect(out.text).toContain(`[cut at ${LIMIT} characters]`)
})

/** A clock that moves only when slept on, recording each sleep. */
function clock(start = 1_000_000) {
  const sleeps: number[] = []
  let t = start
  const c: Clock = { sleep: async (ms) => void (sleeps.push(ms), (t += ms)), now: async () => t }
  return { clock: c, sleeps }
}

const EMPTY_QUEUE = { 'GET /queue': { body: { queue_running: [], queue_pending: [] } } }
const STATS = { system: { comfyui_version: '0.41.0' } }

/** The server across a reboot: the POST drops the connection, then /system_stats is refused `down` times before it answers. */
function rebooting(down: number, extra: Record<string, { status?: number; body: unknown }> = {}) {
  const { fetch: routed, calls } = server({ ...EMPTY_QUEUE, ...extra })
  let refused = 0
  const fetch: Fetch = async (url, init) => {
    const path = url.slice(BASE.length)
    if (init?.method === 'POST' && path === '/v2/manager/reboot') {
      calls.push({ url, method: 'POST', body: init.body })
      throw new Error('socket hang up')
    }
    if (path === '/system_stats') {
      calls.push({ url, method: 'GET' })
      if (refused++ < down) throw new Error('ECONNREFUSED')
      return { status: 200, ok: true, text: JSON.stringify(STATS) }
    }
    return routed(url, init)
  }
  return { fetch, calls }
}

test('restartServer posts the reboot as JSON, polls soon after the dropped connection and reports once the server is back', async () => {
  const installed = { 'GET /v2/customnode/installed': { body: { a: { ver: '1', cnr_id: 'a', aux_id: null, enabled: true }, b: { ver: 'x', cnr_id: '', aux_id: 'me/b', enabled: true } } } }
  const { fetch, calls } = rebooting(10, { ...installed, 'POST /v2/customnode/import_fail_info_bulk': { body: { a: null, 'me/b': { error: 'ModuleNotFoundError: no module named onnxruntime\nmore', traceback: '...' } } } })
  const { clock: c, sleeps } = clock()
  const out = await restartServer(fetch, BASE, {}, c)
  expect(out.isError).toBe(false)
  expect(out.text).toBe('Restarted in 21 s: ComfyUI 0.41.0.\n1 node pack failed to import (the server log has the traceback):\nme/b: ModuleNotFoundError: no module named onnxruntime')
  // the first poll comes soon, to see the re-executed process down, then one every 2 s
  expect(sleeps).toEqual([500, ...Array(10).fill(2_000)])
  const reboot = calls.find((call) => call.url.endsWith('/v2/manager/reboot'))
  expect(reboot).toEqual({ url: `${BASE}/v2/manager/reboot`, method: 'POST', body: '{}' })
  expect(JSON.parse(calls.at(-1)?.body ?? '')).toEqual({ cnr_ids: ['a'], urls: ['me/b'] })
  // with no import info to read, the answer leaves the packs out
  expect((await restartServer(rebooting(1).fetch, BASE, {}, clock().clock)).text).toBe('Restarted in 3 s: ComfyUI 0.41.0.')
  const clean = rebooting(1, { ...installed, 'POST /v2/customnode/import_fail_info_bulk': { body: { a: null, 'me/b': null } } })
  expect((await restartServer(clean.fetch, BASE, {}, clock().clock)).text).toBe('Restarted in 3 s: ComfyUI 0.41.0.\nNo node pack reports an import error.')
  // a dropped connection proves nothing alone: an answer before any poll found the server down is the old process
  const stayed = await restartServer(rebooting(0).fetch, BASE, {}, clock().clock)
  expect(stayed.isError).toBe(true)
  expect(stayed.text).toBe('The reboot was sent, but ComfyUI kept running without restarting (see the server log).')
})

test('restartServer refuses while a job is queued unless forced, and says how many', async () => {
  const busy = { 'GET /queue': { body: { queue_running: [[1, ID, {}, {}, []]], queue_pending: [[2, 'p', {}, {}, []], [3, 'q', {}, {}, []]] } } }
  const { fetch, calls } = rebooting(1, busy)
  const refused = await restartServer(fetch, BASE, {}, clock().clock)
  expect(refused.isError).toBe(true)
  expect(refused.text).toContain('the queue holds 1 running and 2 pending jobs')
  expect(calls.map((call) => call.method)).toEqual(['GET'])
  expect((await restartServer(fetch, BASE, { force: true }, clock().clock)).text).toBe('Forced past 1 running and 2 pending jobs, which the restart dropped. Restarted in 3 s: ComfyUI 0.41.0.')
})

test('restartServer explains a 403, a missing Manager, a server that never went down and one that never came back', async () => {
  const { clock: c } = clock()
  const forbidden = await restartServer(server({ ...EMPTY_QUEUE, 'POST /v2/manager/reboot': { status: 403, body: '' } }).fetch, BASE, {}, c)
  expect(forbidden.isError).toBe(true)
  expect(forbidden.text).toBe('The Manager refused the reboot (403): its security_level is below middle in user/__manager/config.ini on the server.')
  expect((await restartServer(server(EMPTY_QUEUE).fetch, BASE, {}, c)).text).toContain('not installed on this server')
  const stayed = await restartServer(server({ ...EMPTY_QUEUE, 'POST /v2/manager/reboot': { body: '' }, 'GET /system_stats': { body: STATS } }).fetch, BASE, {}, c)
  expect(stayed.isError).toBe(true)
  expect(stayed.text).toContain('kept running without restarting')
  // an empty answer to the reboot is the restart starting when the server then goes down
  const empty = server({ ...EMPTY_QUEUE, 'POST /v2/manager/reboot': { body: '' } })
  const { clock: slow, sleeps } = clock()
  const gone = await restartServer(empty.fetch, BASE, {}, slow)
  expect(gone.isError).toBe(true)
  expect(gone.text).toContain('did not answer /system_stats within 120 s')
  expect(sleeps.length).toBe(60)
  const down: Fetch = async () => { throw new Error('ECONNREFUSED') }
  expect((await restartServer(down, BASE, {}, c)).text).toBe(`Could not reach the ComfyUI server at ${BASE}: ECONNREFUSED`)
})

test('restartServer counts an empty answer or a gateway error as a restart only once a poll finds the server down', async () => {
  let polls = 0
  const headers: unknown[] = []
  const answered = (reboot: { status: number; text: string }): Fetch => async (url, init) => {
    const path = url.slice(BASE.length)
    if (path === '/queue') return { status: 200, ok: true, text: JSON.stringify({ queue_running: [], queue_pending: [] }) }
    if (path === '/v2/manager/reboot') return headers.push(init?.headers), { ...reboot, ok: reboot.status < 400 }
    if (path === '/system_stats' && polls++ < 2) throw new Error('ECONNREFUSED')
    if (path === '/system_stats') return { status: 200, ok: true, text: JSON.stringify(STATS) }
    return { status: 404, ok: false, text: 'not found' }
  }
  // an answered reboot gives the process 2 s to go down before the first poll
  const { clock: answeredClock, sleeps } = clock()
  expect((await restartServer(answered({ status: 200, text: '' }), BASE, {}, answeredClock)).text).toBe('Restarted in 6 s: ComfyUI 0.41.0.')
  expect(sleeps).toEqual([2_000, 2_000, 2_000])
  expect(headers[0]).toEqual({ 'Content-Type': 'application/json' })
  // behind a proxy, the dropped connection is a 502; the restart counts once a poll finds the server down
  polls = 0
  expect((await restartServer(answered({ status: 502, text: 'Bad Gateway' }), BASE, {}, clock().clock)).text).toBe('Restarted in 5 s: ComfyUI 0.41.0.')
  // a 504 from a proxy whose Manager hung, with the server still answering, is no restart
  polls = 2
  expect((await restartServer(answered({ status: 504, text: 'Gateway Timeout' }), BASE, {}, clock().clock)).text).toContain('kept running without restarting')
})

const UI = { last_node_id: 1, nodes: [{ id: 1, type: 'SaveImage' }], links: [], version: 0.4 }
const noRead = async (path: string): Promise<string> => { throw new Error(`no file ${path}`) }
const noWrite = async (path: string): Promise<void> => { throw new Error(`cannot write ${path}`) }
const SAVED = '/api/userdata/workflows%2F02%20Pixel%20Art%2FPr%C3%A9dio.json'

test('workflowFile keeps subfolders under workflows/, adds .json and refuses .. and absolute paths', () => {
  expect(workflowFile('02 Pixel Art/Prédio')).toBe('workflows/02 Pixel Art/Prédio.json')
  expect(workflowFile('mcp.JSON')).toBe('workflows/mcp.JSON')
  expect(workflowFile('workflows/a/b')).toBe('workflows/a/b.json')
  // the server URL-decodes the name a second time, so an encoded ".." is refused like a plain one
  for (const bad of ['../x', 'a/../../x', '/etc/x', 'C:/x', 'a\\b', 'a//b', './a', '%2e%2e/comfy.settings', 'a%2Fb', 'a:b', 'a\u0001b', '', undefined]) expect(workflowFile(bad), String(bad)).toBeUndefined()
})

test('uiWorkflow takes a UI export or its JSON and refuses the API format with why', () => {
  expect(uiWorkflow(UI).workflow).toEqual(UI)
  expect(uiWorkflow(JSON.stringify(UI)).workflow).toEqual(UI)
  expect(uiWorkflow(PROMPT).error).toContain('breaks the frontend workflow list ("e is not iterable"): run it with submit_workflow')
  expect(uiWorkflow({ nodes: [] }).error).toContain('must be in UI format')
  expect(uiWorkflow('{').error).toContain('must be in UI format')
})

test('saveWorkflow posts the UI JSON to the URL-encoded userdata path, never overwriting unless asked', async () => {
  const { fetch, calls } = server({
    [`POST ${SAVED}?overwrite=false&full_info=true`]: { body: { path: 'workflows/02 Pixel Art/Prédio.json', size: 81, modified: 1792525594962 } },
    [`POST ${SAVED}?overwrite=true&full_info=true`]: { body: { path: 'workflows/02 Pixel Art/Prédio.json', size: 81, modified: 1792525594962 } },
  })
  const out = await saveWorkflow(fetch, noRead, BASE, { path: '02 Pixel Art/Prédio', workflow: UI })
  expect(out.text).toBe('Saved workflows/02 Pixel Art/Prédio.json (81 bytes, modified 2026-10-20T19:46:34Z). It shows in the Workflows tab of the ComfyUI frontend once its list is reopened.')
  expect(calls[0]).toEqual({ url: `${BASE}${SAVED}?overwrite=false&full_info=true`, method: 'POST', body: JSON.stringify(UI) })
  expect((await saveWorkflow(fetch, noRead, BASE, { path: '02 Pixel Art/Prédio.json', workflow: JSON.stringify(UI), overwrite: true })).isError).toBe(false)
  expect(calls[1]?.url).toBe(`${BASE}${SAVED}?overwrite=true&full_info=true`)
  const taken = await saveWorkflow(server({ [`POST ${SAVED}?overwrite=false&full_info=true`]: { status: 409, body: 'File already exists' } }).fetch, noRead, BASE, { path: '02 Pixel Art/Prédio', workflow: UI })
  expect(taken.isError).toBe(true)
  expect(taken.text).toBe('workflows/02 Pixel Art/Prédio.json already exists. Read it with get_workflow, then save with overwrite: true to replace it, or choose another path.')
  const api = await saveWorkflow(fetch, noRead, BASE, { path: 'x', workflow: PROMPT })
  expect(api.isError).toBe(true)
  expect(api.text).toContain('API format')
  expect((await saveWorkflow(fetch, noRead, BASE, { path: '../x', workflow: UI })).text).toContain('no ".."')
  expect(calls.length).toBe(2)
})

test('listWorkflows lists path, size and date sorted by path, and says when nothing is saved', async () => {
  const route = 'GET /api/userdata?dir=workflows&recurse=true&split=false&full_info=true'
  const { fetch } = server({ [route]: { body: [{ path: 'b/two.json', size: 20, modified: 1792525594962 }, { path: 'a.json', size: 10, modified: 1792525594962 }] } })
  expect((await listWorkflows(fetch, BASE)).text).toBe('2 workflows in workflows/ (the path save_workflow and get_workflow take):\na.json (10 bytes, modified 2026-10-20T19:46:34Z)\nb/two.json (20 bytes, modified 2026-10-20T19:46:34Z)')
  expect((await listWorkflows(server({}).fetch, BASE)).text).toBe('No workflow is saved yet: the workflows/ folder does not exist.')
  expect((await listWorkflows(server({ [route]: { body: [] } }).fetch, BASE)).text).toBe('No workflow is saved yet: the workflows/ folder is empty.')
})

test('saveWorkflow takes the workflow from a local file instead, never both', async () => {
  const route = `POST ${SAVED}?overwrite=true&full_info=true`
  const { fetch, calls } = server({ [route]: { body: { path: 'workflows/02 Pixel Art/Prédio.json', size: 81, modified: 0 } } })
  const read = async (path: string) => (path === 'comfyui-outputs/w.json' ? JSON.stringify(UI, null, 2) : noRead(path))
  expect((await saveWorkflow(fetch, read, BASE, { path: '02 Pixel Art/Prédio', file: 'comfyui-outputs/w.json', overwrite: true })).isError).toBe(false)
  expect(calls[0]?.body).toBe(JSON.stringify(UI))
  expect((await saveWorkflow(fetch, read, BASE, { path: 'x', file: 'none.json' })).text).toBe('Could not read none.json: no file none.json')
  expect((await saveWorkflow(fetch, read, BASE, { path: 'x', file: 'comfyui-outputs/w.json', workflow: UI })).text).toBe('Give the workflow inline or as a local file, not both.')
  expect((await saveWorkflow(fetch, read, BASE, { path: 'x' })).text).toBe('Give the workflow inline (workflow) or as a local JSON file (file).')
  const broken = async () => '{"nodes": [,'
  expect((await saveWorkflow(fetch, broken, BASE, { path: 'x', file: 'w.json' })).text).toMatch(/^w\.json is not valid JSON: /)
  const api = async () => JSON.stringify(PROMPT)
  expect((await saveWorkflow(fetch, api, BASE, { path: 'x', file: 'w.json' })).text).toContain('API format')
  expect(calls.length).toBe(1)
})

test('getWorkflow writes a workflow too large for one answer, or one asked for as a file, to a local file indented', async () => {
  const written: [string, string][] = []
  const write = async (path: string, text: string) => void written.push([path, text])
  const big = { ...UI, notes: 'x'.repeat(LIMIT) }
  const { fetch } = server({ [`GET ${SAVED}`]: { body: big } })
  const out = await getWorkflow(fetch, write, BASE, { path: '02 Pixel Art/Prédio' })
  expect(out.text).toBe(`Workflow workflows/02 Pixel Art/Prédio.json in UI format written to comfyui-outputs/workflows/02 Pixel Art/Prédio.json (${JSON.stringify(big).length} characters, more than one answer carries). Read and edit that file, then save it back with save_workflow, file: "comfyui-outputs/workflows/02 Pixel Art/Prédio.json" and overwrite: true.`)
  expect(written[0]).toEqual(['comfyui-outputs/workflows/02 Pixel Art/Prédio.json', `${JSON.stringify(big, null, 2)}\n`])
  const small = server({ [`GET ${SAVED}`]: { body: UI } })
  expect((await getWorkflow(small.fetch, write, BASE, { path: '02 Pixel Art/Prédio', file: '/tmp/p.json' })).text).toContain('written to /tmp/p.json. Read and edit')
  expect(written[1]?.[0]).toBe('/tmp/p.json')
  const failed = await getWorkflow(fetch, noWrite, BASE, { path: '02 Pixel Art/Prédio' })
  expect(failed.isError).toBe(true)
  expect(failed.text).toBe('Could not write comfyui-outputs/workflows/02 Pixel Art/Prédio.json: cannot write comfyui-outputs/workflows/02 Pixel Art/Prédio.json')
})

test('getWorkflow reads one saved workflow compacted and says when it is missing', async () => {
  const { fetch } = server({ [`GET ${SAVED}`]: { body: JSON.stringify(UI, null, 2) } })
  const out = await getWorkflow(fetch, noWrite, BASE, { path: '02 Pixel Art/Prédio' })
  expect(out.text).toBe(`Workflow workflows/02 Pixel Art/Prédio.json in UI format; edit it and save it back with save_workflow and overwrite: true.\n${JSON.stringify(UI)}`)
  expect((await getWorkflow(fetch, noWrite, BASE, { path: 'none' })).text).toBe('No workflow at workflows/none.json: list_workflows shows the saved ones.')
  expect((await getWorkflow(fetch, noWrite, BASE, { path: '/abs' })).isError).toBe(true)
})
