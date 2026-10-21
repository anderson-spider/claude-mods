// The ComfyUI and ComfyUI-Manager HTTP calls, pure: the fetch and the process runner are injected. Each tool is one
// exported function that takes the model's raw input (nothing trusted until checked) and answers text for the host.
// Endpoints: ComfyUI server.py (/system_stats, /object_info, /models, /prompt, /history, /queue, /interrupt,
// /upload/image, /view, /templates, /api/workflow_templates), its app/user_manager.py (/api/userdata) and
// ComfyUI-Manager 4 (/v2/customnode/installed, /v2/customnode/import_fail_info_bulk, /v2/manager/queue/{task,start,status,history},
// /v2/manager/version, /v2/manager/reboot); the pack catalog is the public Comfy Registry.
// Binary transfers (the multipart upload, the downloads) go through curl, since the host's fetch carries text only.

export type FetchResponse = { status: number; ok: boolean; text: string }
export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<FetchResponse>
export type Run = (argv: readonly string[], init?: { timeoutMs?: number }) => Promise<{ exitCode: number; stdout: string; stderr: string }>

export type Out = { text: string; isError: boolean }

/** The most characters one answer carries: past it the text is cut and says so. */
export const LIMIT = 60_000
/** Results per search, unless the input says otherwise; `MAX_LIMIT` caps it. */
export const DEFAULT_LIMIT = 20
export const MAX_LIMIT = 200
/** Where `get_output` saves files unless the input names a folder, relative to the session's working directory. */
export const OUTPUT_DIR = 'comfyui-outputs'
/** The public catalog ComfyUI-Manager 4 searches: the only catalog call, so a pack id can be found to install. */
export const REGISTRY = 'https://api.comfy.org'

export const MANAGER_ACTIONS = ['install', 'update', 'uninstall', 'disable', 'enable', 'fix'] as const
/** How long an upload and a download may take, in milliseconds: the host kills the process at ten minutes at most. */
export const UPLOAD_MS = 300_000
export const DOWNLOAD_MS = 600_000
export type ManagerAction = (typeof MANAGER_ACTIONS)[number]

const ok = (text: string): Out => ({ text: cut(text), isError: false })
const fail = (text: string): Out => ({ text: cut(text), isError: true })

export function cut(text: string): string {
  return text.length > LIMIT ? `${text.slice(0, LIMIT)}\n... [cut at ${LIMIT} characters]` : text
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined)

function limitOf(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : DEFAULT_LIMIT
  return Math.min(Math.max(n, 1), MAX_LIMIT)
}

/** Whether `text` holds every word of `query` (or any word, with `any`), case-insensitively. */
function matches(query: string | undefined, text: string, any = false): boolean {
  if (!query) return true
  const hay = text.toLowerCase()
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return any ? words.some((word) => hay.includes(word)) : words.every((word) => hay.includes(word))
}

/** Reads `path` on the server as JSON; a network failure or a non-JSON body is an `Out` error, an error answer also carries its status. */
async function getJson(fetch: Fetch, base: string, path: string): Promise<{ value: unknown; error?: undefined } | { value?: undefined; error: Out; status?: number }> {
  let res: FetchResponse
  try {
    res = await fetch(base + path)
  } catch (e) {
    return { error: fail(`Could not reach ${base === REGISTRY ? 'the Comfy Registry' : 'the ComfyUI server'} at ${base}: ${e instanceof Error ? e.message : String(e)}`) }
  }
  if (!res.ok) return { error: fail(`GET ${path} answered ${res.status}: ${res.text.slice(0, 2000)}`), status: res.status }
  try {
    return { value: JSON.parse(res.text) }
  } catch {
    return { error: fail(`GET ${path} did not answer JSON: ${res.text.slice(0, 500)}`) }
  }
}

async function postJson(fetch: Fetch, base: string, path: string, body: unknown): Promise<{ res: FetchResponse; error?: undefined } | { res?: undefined; error: Out }> {
  try {
    const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return { res }
  } catch (e) {
    return { error: fail(`Could not reach the ComfyUI server at ${base}: ${e instanceof Error ? e.message : String(e)}`) }
  }
}

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// --- system -----------------------------------------------------------------------------------------------------------

/** ComfyUI version, devices and queue counts, plus the Manager version when it is installed. */
export async function systemInfo(fetch: Fetch, base: string): Promise<Out> {
  const stats = await getJson(fetch, base, '/system_stats')
  if (stats.error) return stats.error
  const queue = await getJson(fetch, base, '/queue')
  const s = isObject(stats.value) ? stats.value : {}
  const system = isObject(s.system) ? s.system : {}
  const devices = Array.isArray(s.devices) ? s.devices : []
  const gib = (n: unknown) => (typeof n === 'number' ? `${(n / 2 ** 30).toFixed(1)} GiB` : '?')
  const lines = [
    `ComfyUI ${String(system.comfyui_version ?? '?')} on ${String(system.os ?? '?')} (python ${String(system.python_version ?? '?').split(' ')[0]}), RAM ${gib(system.ram_free)} free of ${gib(system.ram_total)}`,
    ...devices.map((d) => {
      const dev = isObject(d) ? d : {}
      return `Device: ${String(dev.name ?? '?')}, VRAM ${gib(dev.vram_free)} free of ${gib(dev.vram_total)}`
    }),
  ]
  if (!queue.error && isObject(queue.value)) {
    const running = Array.isArray(queue.value.queue_running) ? queue.value.queue_running.length : 0
    const pending = Array.isArray(queue.value.queue_pending) ? queue.value.queue_pending.length : 0
    lines.push(`Queue: ${running} running, ${pending} pending`)
  }
  let manager: FetchResponse | undefined
  try {
    manager = await fetch(`${base}/v2/manager/version`)
  } catch {
    manager = undefined
  }
  lines.push(manager?.ok ? `ComfyUI-Manager ${manager.text.replace(/^"|"$/g, '')}` : 'ComfyUI-Manager: not installed (manager_* tools are unavailable)')
  return ok(lines.join('\n'))
}

// --- nodes ------------------------------------------------------------------------------------------------------------

export type NodeSummary = { name: string; display_name: string; category: string; pack: string; description: string; inputs: string[]; outputs: string[] }

/** The pack a node comes from, read from its python module: `custom_nodes.<pack>.<module>`, else `core`. */
export function packOf(pythonModule: unknown): string {
  const parts = typeof pythonModule === 'string' ? pythonModule.split('.') : []
  return parts[0] === 'custom_nodes' && parts[1] ? parts[1] : 'core'
}

/** One input as `name: TYPE`; a combo lists how many choices it has and the first three. */
function inputLine(name: string, spec: unknown, optional: boolean): string {
  const type = Array.isArray(spec) ? spec[0] : spec
  let shown: string
  if (Array.isArray(type)) shown = `COMBO[${type.length}: ${type.slice(0, 3).map(String).join(', ')}${type.length > 3 ? ', ...' : ''}]`
  else if (isObject(type) && Array.isArray(type.options)) shown = `COMBO[${type.options.length}]`
  else shown = String(type)
  const opts = Array.isArray(spec) && isObject(spec[1]) ? spec[1] : undefined
  const dflt = opts && opts.default !== undefined && !Array.isArray(type) ? ` = ${JSON.stringify(opts.default)}` : ''
  return `${name}${optional ? '?' : ''}: ${shown}${dflt}`
}

export function summarizeNode(name: string, info: unknown): NodeSummary {
  const node = isObject(info) ? info : {}
  const input = isObject(node.input) ? node.input : {}
  const required = isObject(input.required) ? input.required : {}
  const optional = isObject(input.optional) ? input.optional : {}
  const outputs = Array.isArray(node.output) ? node.output : []
  const outputNames = Array.isArray(node.output_name) ? node.output_name : []
  return {
    name,
    display_name: String(node.display_name ?? name),
    category: String(node.category ?? ''),
    pack: packOf(node.python_module),
    description: String(node.description ?? ''),
    inputs: [...Object.entries(required).map(([k, v]) => inputLine(k, v, false)), ...Object.entries(optional).map(([k, v]) => inputLine(k, v, true))],
    outputs: outputs.map((type, i) => `${String(outputNames[i] ?? type)}: ${Array.isArray(type) ? 'COMBO' : String(type)}`),
  }
}

/** The input types a node takes (`IMAGE`, `LATENT`, ...), for the `input_type` filter. */
function inputTypes(info: unknown): string[] {
  const node = isObject(info) ? info : {}
  const input = isObject(node.input) ? node.input : {}
  const types: string[] = []
  for (const group of ['required', 'optional']) {
    const specs = isObject(input[group]) ? input[group] : {}
    for (const spec of Object.values(specs)) {
      const type = Array.isArray(spec) ? spec[0] : spec
      types.push(Array.isArray(type) ? 'COMBO' : String(type))
    }
  }
  return types
}

export type SearchNodesInput = { query?: unknown; category?: unknown; pack?: unknown; input_type?: unknown; output_type?: unknown; limit?: unknown }

/** Searches /object_info by words in the name, display name, description and category, with the official filters. */
export async function searchNodes(fetch: Fetch, base: string, input: SearchNodesInput): Promise<Out> {
  const got = await getJson(fetch, base, '/object_info')
  if (got.error) return got.error
  const all = isObject(got.value) ? got.value : {}
  const query = str(input.query)
  const category = str(input.category)?.toLowerCase()
  const pack = str(input.pack)?.toLowerCase()
  const inType = str(input.input_type)?.toUpperCase()
  const outType = str(input.output_type)?.toUpperCase()
  const limit = limitOf(input.limit)
  const found: NodeSummary[] = []
  let total = 0
  // Every word first; when nothing holds them all (several node names in one query), any word.
  let any = false
  for (const pass of [false, true]) {
    any = pass
    for (const [name, info] of Object.entries(all)) {
      const node = isObject(info) ? info : {}
      if (category && !String(node.category ?? '').toLowerCase().includes(category)) continue
      if (pack && !packOf(node.python_module).toLowerCase().includes(pack)) continue
      if (inType && !inputTypes(info).some((t) => t.toUpperCase() === inType)) continue
      if (outType && !(Array.isArray(node.output) ? node.output : []).some((t) => String(t).toUpperCase() === outType)) continue
      if (!matches(query, `${name} ${String(node.display_name ?? '')} ${String(node.description ?? '')} ${String(node.category ?? '')} ${Array.isArray(node.search_aliases) ? node.search_aliases.join(' ') : ''}`, any)) continue
      total++
      if (found.length < limit) found.push(summarizeNode(name, info))
    }
    if (total > 0 || !query || query.trim().split(/\s+/).length < 2) break
  }
  if (total === 0) return ok(`No node matches (${Object.keys(all).length} nodes on the server). Try fewer words or another filter.`)
  const lines = found.map((n) =>
    [`## ${n.name}${n.display_name !== n.name ? ` (${n.display_name})` : ''}`, `category: ${n.category} | pack: ${n.pack}`, n.description ? n.description.split('\n')[0] : undefined, `inputs: ${n.inputs.join('; ') || 'none'}`, `outputs: ${n.outputs.join('; ') || 'none'}`]
      .filter(Boolean)
      .join('\n'),
  )
  return ok(`${total} node${total === 1 ? '' : 's'} ${total === 1 ? 'matches' : 'match'}${any ? ' at least one word' : ''}${total > found.length ? `, showing ${found.length} (raise limit or narrow the query)` : ''}.\n\n${lines.join('\n\n')}`)
}

// --- models -----------------------------------------------------------------------------------------------------------

export type SearchModelsInput = { query?: unknown; folder?: unknown; limit?: unknown }

/** Lists model files from /models/{folder}, over every folder or one, filtered by words in the file name. */
export async function searchModels(fetch: Fetch, base: string, input: SearchModelsInput): Promise<Out> {
  const query = str(input.query)
  const folder = str(input.folder)
  const limit = limitOf(input.limit)
  const folders = await getJson(fetch, base, '/models')
  if (folders.error) return folders.error
  const names = (Array.isArray(folders.value) ? folders.value : []).map(String)
  const chosen = folder ? names.filter((n) => n.toLowerCase() === folder.toLowerCase()) : names
  if (folder && chosen.length === 0) return fail(`No model folder "${folder}". Folders: ${names.join(', ')}`)
  const found: string[] = []
  let total = 0
  for (const name of chosen) {
    const files = await getJson(fetch, base, `/models/${encodeURIComponent(name)}`)
    if (files.error) continue
    for (const file of Array.isArray(files.value) ? files.value : []) {
      if (!matches(query, `${name} ${String(file)}`)) continue
      total++
      if (found.length < limit) found.push(`${name}/${String(file)}`)
    }
  }
  if (total === 0) return ok(`No model matches${query ? ` "${query}"` : ''}. Folders on the server: ${names.join(', ')}. Use search_models without a query to list every file.`)
  return ok(`${total} model file${total === 1 ? '' : 's'}${total > found.length ? `, showing ${found.length}` : ''} (folder/file, the file name is what the loader node takes):\n${found.join('\n')}`)
}

// --- templates --------------------------------------------------------------------------------------------------------

export type SearchTemplatesInput = { query?: unknown; tag?: unknown; model?: unknown; limit?: unknown }

type Template = { name: string; title: string; description: string; tags: string[]; models: string[]; source: string; openSource?: boolean }

/** Core templates from /templates/index.json (one module per category) and the node packs' from /api/workflow_templates. */
async function allTemplates(fetch: Fetch, base: string): Promise<{ templates: Template[]; error?: undefined } | { templates?: undefined; error: Out }> {
  const index = await getJson(fetch, base, '/templates/index.json')
  if (index.error) return { error: index.error }
  const templates: Template[] = []
  for (const mod of Array.isArray(index.value) ? index.value : []) {
    const m = isObject(mod) ? mod : {}
    for (const t of Array.isArray(m.templates) ? m.templates : []) {
      const tpl = isObject(t) ? t : {}
      if (typeof tpl.name !== 'string') continue
      templates.push({
        name: tpl.name,
        title: String(tpl.title ?? tpl.name),
        description: String(tpl.description ?? ''),
        tags: Array.isArray(tpl.tags) ? tpl.tags.map(String) : [],
        models: Array.isArray(tpl.models) ? tpl.models.map(String) : [],
        source: 'core',
        openSource: typeof tpl.openSource === 'boolean' ? tpl.openSource : undefined,
      })
    }
  }
  const packs = await getJson(fetch, base, '/api/workflow_templates')
  if (!packs.error && isObject(packs.value)) {
    for (const [pack, names] of Object.entries(packs.value)) {
      for (const name of Array.isArray(names) ? names : []) templates.push({ name: String(name), title: String(name), description: '', tags: [], models: [], source: pack })
    }
  }
  return { templates }
}

/** Searches the templates by words in title, description, tags and models, with the official `tag` and `model` filters. */
export async function searchTemplates(fetch: Fetch, base: string, input: SearchTemplatesInput): Promise<Out> {
  const all = await allTemplates(fetch, base)
  if (all.error) return all.error
  const query = str(input.query)
  const tag = str(input.tag)?.toLowerCase()
  const model = str(input.model)?.toLowerCase()
  const limit = limitOf(input.limit)
  const found: Template[] = []
  let total = 0
  for (const t of all.templates) {
    if (tag && !t.tags.some((x) => x.toLowerCase().includes(tag))) continue
    if (model && !t.models.some((x) => x.toLowerCase().includes(model))) continue
    if (!matches(query, `${t.name} ${t.title} ${t.description} ${t.tags.join(' ')} ${t.models.join(' ')} ${t.source}`)) continue
    total++
    if (found.length < limit) found.push(t)
  }
  if (total === 0) return ok(`No template matches (${all.templates.length} templates on the server).`)
  const lines = found.map((t) =>
    [
      `## ${t.title} (name: ${t.name}${t.source === 'core' ? '' : `, pack: ${t.source}`})`,
      t.description ? t.description.split('. ')[0] : undefined,
      t.tags.length ? `tags: ${t.tags.join(', ')}` : undefined,
      t.models.length ? `models: ${t.models.join(', ')}` : undefined,
      t.openSource === false ? 'requires a partner API node (paid API key on the server)' : undefined,
    ]
      .filter(Boolean)
      .join('\n'),
  )
  return ok(`${total} template${total === 1 ? '' : 's'} ${total === 1 ? 'matches' : 'match'}${total > found.length ? `, showing ${found.length}` : ''}. Read one with get_template.\n\n${lines.join('\n\n')}`)
}

export type GetTemplateInput = { name?: unknown; pack?: unknown }

/** The workflow JSON of one template (UI format: nodes with type, widgets_values and links), to be read, not submitted. */
export async function getTemplate(fetch: Fetch, base: string, input: GetTemplateInput): Promise<Out> {
  const name = str(input.name)
  if (!name || name.includes('/') || name.includes('..')) return fail('name must be a template name from search_templates (no slashes).')
  const pack = str(input.pack)
  if (pack && (pack.includes('/') || pack.includes('..'))) return fail('pack must be a pack name from search_templates (no slashes).')
  const path = pack ? `/api/workflow_templates/${encodeURIComponent(pack)}/${encodeURIComponent(name)}.json` : `/templates/${encodeURIComponent(name)}.json`
  const got = await getJson(fetch, base, path)
  if (got.error) return got.error
  return ok(
    `Template ${name} in UI format (not the API format submit_workflow takes): each node has type, widgets_values in the node's widget order and links [id, from_node, from_slot, to_node, to_slot, type]. Rebuild it as an API-format prompt with search_nodes for each type's input names.\n${JSON.stringify(got.value)}`,
  )
}

// --- jobs -------------------------------------------------------------------------------------------------------------

export type SubmitInput = { workflow?: unknown; client_id?: unknown }

/** The workflow as an object: the input may be an object or its JSON text. */
export function parseWorkflow(value: unknown): Record<string, unknown> | undefined {
  const parsed = typeof value === 'string' ? parse(value) : value
  if (!isObject(parsed) || Object.keys(parsed).length === 0) return undefined
  // A UI-format export has "nodes" and "links"; the API format maps node ids to { class_type, inputs }.
  if (Array.isArray(parsed.nodes) && Array.isArray(parsed.links)) return undefined
  return parsed
}

/** Queues an API-format workflow with POST /prompt and answers its prompt_id, or the server's validation errors. */
export async function submitWorkflow(fetch: Fetch, base: string, input: SubmitInput): Promise<Out> {
  const workflow = parseWorkflow(input.workflow)
  if (!workflow) return fail('workflow must be a non-empty API-format prompt: an object mapping node ids to { class_type, inputs } (or that JSON as a string). A UI export with "nodes" and "links" is not accepted.')
  const clientId = str(input.client_id) ?? 'comfyui-local'
  const sent = await postJson(fetch, base, '/prompt', { prompt: workflow, client_id: clientId })
  if (sent.error) return sent.error
  const body = parse(sent.res.text)
  if (!sent.res.ok) {
    const b = isObject(body) ? body : {}
    const error = isObject(b.error) ? b.error : {}
    const nodeErrors = isObject(b.node_errors) ? b.node_errors : {}
    const details = Object.entries(nodeErrors).map(([id, e]) => {
      const node = isObject(e) ? e : {}
      const errors = Array.isArray(node.errors) ? node.errors : []
      return `node ${id} (${String(node.class_type ?? '?')}): ${errors.map((x) => (isObject(x) ? `${String(x.message ?? '')}${x.details ? ` (${String(x.details)})` : ''}` : String(x))).join('; ')}`
    })
    return fail(`The server refused the workflow (${sent.res.status}): ${String(error.message ?? sent.res.text.slice(0, 500))}${error.details ? `\n${String(error.details)}` : ''}${details.length ? `\n${details.join('\n')}` : ''}`)
  }
  const b = isObject(body) ? body : {}
  return ok(`Queued: prompt_id ${String(b.prompt_id ?? '?')}, number ${String(b.number ?? '?')}. Poll get_job_status with the prompt_id.`)
}

export type OutputFile = { node: string; kind: string; filename: string; subfolder: string; type: string }

/** The files a finished job produced, from its history entry's outputs: any list of { filename, subfolder, type } under a node. */
export function outputFiles(entry: unknown): OutputFile[] {
  const outputs = isObject(entry) && isObject(entry.outputs) ? entry.outputs : {}
  const files: OutputFile[] = []
  for (const [node, value] of Object.entries(outputs)) {
    if (!isObject(value)) continue
    for (const [kind, list] of Object.entries(value)) {
      if (!Array.isArray(list)) continue
      for (const item of list) {
        if (!isObject(item) || typeof item.filename !== 'string') continue
        files.push({ node, kind, filename: item.filename, subfolder: typeof item.subfolder === 'string' ? item.subfolder : '', type: typeof item.type === 'string' ? item.type : 'output' })
      }
    }
  }
  return files
}

const PROMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const BAD_PROMPT_ID = 'prompt_id must be the UUID submit_workflow answered.'

/** The prompt_id as the server keys it: lowercase, or undefined when it is not a UUID. */
function promptId(value: unknown): string | undefined {
  const id = str(value)?.toLowerCase()
  return id && PROMPT_ID.test(id) ? id : undefined
}

type QueueItem = { number: number; prompt_id: string }

function queueItems(list: unknown): QueueItem[] {
  return (Array.isArray(list) ? list : [])
    .filter((item): item is unknown[] => Array.isArray(item) && typeof item[1] === 'string')
    .map((item) => ({ number: typeof item[0] === 'number' ? item[0] : -1, prompt_id: String(item[1]) }))
}

export type JobStatusInput = { prompt_id?: unknown }

/** One job's state from /history/{id} and /queue (done with its outputs, failed with its messages, running or pending); without a prompt_id, the queue. */
export async function getJobStatus(fetch: Fetch, base: string, input: JobStatusInput): Promise<Out> {
  const given = str(input.prompt_id)
  const id = promptId(given)
  if (given && !id) return fail(BAD_PROMPT_ID)
  const queue = await getJson(fetch, base, '/queue')
  if (queue.error) return queue.error
  const q = isObject(queue.value) ? queue.value : {}
  const running = queueItems(q.queue_running)
  const pending = queueItems(q.queue_pending)
  if (!id) {
    const lines = [`${running.length} running, ${pending.length} pending.`]
    for (const r of running) lines.push(`running: ${r.prompt_id} (#${r.number})`)
    pending.forEach((p, i) => lines.push(`pending ${i + 1}: ${p.prompt_id} (#${p.number})`))
    return ok(lines.join('\n'))
  }
  const history = await getJson(fetch, base, `/history/${id}`)
  if (history.error) return history.error
  const entry = isObject(history.value) ? history.value[id] : undefined
  if (!isObject(entry)) {
    if (running.some((r) => r.prompt_id === id)) return ok(`running: ${id} is executing now. Poll again in a few seconds.`)
    const at = pending.findIndex((p) => p.prompt_id === id)
    if (at >= 0) return ok(`pending: ${id} is number ${at + 1} of ${pending.length} in the queue, behind ${running.length} running.`)
    return fail(`unknown: ${id} is neither in the queue nor in the history (a server restart clears the history).`)
  }
  const status = isObject(entry.status) ? entry.status : {}
  const messages = Array.isArray(status.messages) ? status.messages : []
  const files = outputFiles(entry)
  if (status.status_str === 'error' || status.completed === false) {
    const errors = messages
      .filter((m): m is [string, unknown] => Array.isArray(m) && m[0] === 'execution_error')
      .map((m) => {
        const d = isObject(m[1]) ? m[1] : {}
        return `${String(d.node_type ?? '?')} (node ${String(d.node_id ?? '?')}): ${String(d.exception_message ?? '')}`
      })
    return fail(`failed: ${id}\n${errors.join('\n') || JSON.stringify(messages).slice(0, 2000)}`)
  }
  return ok(
    `completed: ${id}, ${files.length} output file${files.length === 1 ? '' : 's'}${files.length ? ' (fetch them with get_output):' : '. Add a SaveImage, PreviewImage or other output node wired to the result.'}\n${files
      .map((f) => `node ${f.node} ${f.kind}: ${f.subfolder ? `${f.subfolder}/` : ''}${f.filename} [${f.type}]`)
      .join('\n')}`,
  )
}

export type CancelInput = { prompt_id?: unknown; clear_pending?: unknown }

/** Deletes a pending job from the queue, interrupts a running one, or with no prompt_id interrupts whatever runs; `clear_pending` empties the queue. */
export async function cancelJob(fetch: Fetch, base: string, input: CancelInput): Promise<Out> {
  const given = str(input.prompt_id)
  const id = promptId(given)
  if (given && !id) return fail(BAD_PROMPT_ID)
  const done: string[] = []
  /** A POST the server did not accept is an error, with what it said. */
  const refused = (what: string, res: FetchResponse) => fail(`${what} answered ${res.status}: ${res.text.slice(0, 500)}`)
  if (input.clear_pending === true) {
    const cleared = await postJson(fetch, base, '/queue', { clear: true })
    if (cleared.error) return cleared.error
    if (!cleared.res.ok) return refused('POST /queue', cleared.res)
    done.push('pending queue cleared')
  }
  if (id) {
    const queue = await getJson(fetch, base, '/queue')
    if (queue.error) return queue.error
    const q = isObject(queue.value) ? queue.value : {}
    if (queueItems(q.queue_pending).some((p) => p.prompt_id === id)) {
      const deleted = await postJson(fetch, base, '/queue', { delete: [id] })
      if (deleted.error) return deleted.error
      if (!deleted.res.ok) return refused('POST /queue', deleted.res)
      done.push(`${id} removed from the pending queue`)
    } else if (queueItems(q.queue_running).some((r) => r.prompt_id === id)) {
      const stopped = await postJson(fetch, base, '/interrupt', { prompt_id: id })
      if (stopped.error) return stopped.error
      if (!stopped.res.ok) return refused('POST /interrupt', stopped.res)
      done.push(`${id} interrupted`)
    } else {
      return fail(`${id} is not running or pending.${done.length ? ` (${done.join('; ')})` : ''}`)
    }
  } else if (input.clear_pending !== true) {
    const queue = await getJson(fetch, base, '/queue')
    if (queue.error) return queue.error
    if (!queueItems(isObject(queue.value) ? queue.value.queue_running : undefined).length) return ok('nothing is running, so there was nothing to interrupt')
    const stopped = await postJson(fetch, base, '/interrupt', {})
    if (stopped.error) return stopped.error
    if (!stopped.res.ok) return refused('POST /interrupt', stopped.res)
    done.push('the running job was interrupted')
  }
  return ok(done.join('; '))
}

// --- files ------------------------------------------------------------------------------------------------------------

export type UploadInput = { path?: unknown; subfolder?: unknown; overwrite?: unknown }

/** Whether `name` is safe as a server subfolder: no traversal, no absolute path. */
export function safeSubfolder(value: unknown): string | undefined {
  const name = str(value)
  if (name === undefined) return ''
  if (name.startsWith('/') || name.split(/[\\/]/).some((part) => part === '..' || part === '')) return undefined
  return name
}

/**
 * The curl argv that uploads `file` as multipart `image` to /upload/image. curl's own quoting keeps odd file names whole,
 * and the text fields go as `--form-string`, which never reads a file: a `-F` value starting with `@` or `<` would.
 */
export function uploadArgv(base: string, file: string, subfolder: string, overwrite: boolean): string[] {
  const quoted = `"${file.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  return [
    'curl', '-sS', '--max-time', String(UPLOAD_MS / 1000 - 10),
    '-F', `image=@${quoted}`,
    '--form-string', `subfolder=${subfolder}`,
    '--form-string', `overwrite=${overwrite ? 'true' : 'false'}`,
    '--form-string', 'type=input',
    `${base}/upload/image`,
  ]
}

/** Uploads a local file to the server's input folder and answers the name a LoadImage node takes. */
export async function uploadFile(run: Run, exists: (path: string) => Promise<boolean>, base: string, input: UploadInput): Promise<Out> {
  const file = str(input.path)
  if (!file) return fail('path must be the local file to upload.')
  if (!(await exists(file))) return fail(`No file at ${file}.`)
  const subfolder = safeSubfolder(input.subfolder)
  if (subfolder === undefined) return fail('subfolder must be a relative folder name without "..".')
  let result: Awaited<ReturnType<Run>>
  try {
    result = await run(uploadArgv(base, file, subfolder, input.overwrite === true), { timeoutMs: UPLOAD_MS })
  } catch (e) {
    return fail(`curl could not run: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (result.exitCode !== 0) return fail(`Upload failed: ${result.stderr.trim() || result.stdout.trim() || `curl exited ${result.exitCode}`}`)
  const body = parse(result.stdout)
  if (!isObject(body) || typeof body.name !== 'string') return fail(`The server did not confirm the upload: ${result.stdout.slice(0, 500)}`)
  const sub = typeof body.subfolder === 'string' && body.subfolder ? `${body.subfolder}/` : ''
  return ok(`Uploaded as ${sub}${body.name} (type ${String(body.type ?? 'input')}). Use "${sub}${body.name}" as the image input of a LoadImage node.`)
}

export type GetOutputInput = { prompt_id?: unknown; directory?: unknown; description?: unknown }

/** A file-name-safe slug of the description, or the prompt_id's first block. */
export function slug(description: unknown, id: string): string {
  const text = str(description)
  const s = text ? text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) : ''
  return s || (id.split('-')[0] ?? id)
}

/** The /view URL of one output file. */
export function viewUrl(base: string, file: OutputFile): string {
  const q = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: file.type })
  return `${base}/view?${q.toString()}`
}

/** Downloads a finished job's output files with curl into `directory` (default comfyui-outputs/) and answers their paths. */
export async function getOutput(fetch: Fetch, run: Run, base: string, input: GetOutputInput): Promise<Out> {
  const id = promptId(input.prompt_id)
  if (!id) return fail(BAD_PROMPT_ID)
  const history = await getJson(fetch, base, `/history/${id}`)
  if (history.error) return history.error
  const entry = isObject(history.value) ? history.value[id] : undefined
  if (!isObject(entry)) return fail(`${id} is not in the history yet: check get_job_status first.`)
  const files = outputFiles(entry).filter((f) => f.type !== 'temp' || f.kind === 'images')
  if (!files.length) return fail(`${id} finished without output files. Add a SaveImage, PreviewImage or other output node wired to the result.`)
  const dir = (str(input.directory) ?? OUTPUT_DIR).replace(/\/+$/, '')
  const name = slug(input.description, id)
  const saved: string[] = []
  const failed: string[] = []
  for (const [i, file] of files.entries()) {
    const ext = (/\.[A-Za-z0-9]{1,8}$/.exec(file.filename) ?? [''])[0]
    const target = `${dir}/${name}${files.length > 1 ? `-${i + 1}` : ''}${ext}`
    try {
      const res = await run(['curl', '-sS', '-f', '--max-time', String(DOWNLOAD_MS / 1000 - 10), '--create-dirs', '-o', target, viewUrl(base, file)], { timeoutMs: DOWNLOAD_MS })
      if (res.exitCode === 0) saved.push(target)
      else failed.push(`${file.filename}: ${res.stderr.trim() || `curl exited ${res.exitCode}`}`)
    } catch (e) {
      failed.push(`${file.filename}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const text = [saved.length ? `Saved ${saved.length} file${saved.length === 1 ? '' : 's'}:\n${saved.join('\n')}` : '', failed.length ? `Failed:\n${failed.join('\n')}` : ''].filter(Boolean).join('\n')
  return saved.length ? ok(text) : fail(text)
}

// --- manager ----------------------------------------------------------------------------------------------------------

const MANAGER_OFF = 'ComfyUI-Manager answered 404: it is not installed on this server, or it is older than version 4 (the plugin uses its /v2 API).'

/** The Manager's version text, or undefined when it does not answer. */
async function managerVersion(fetch: Fetch, base: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${base}/v2/manager/version`)
    return res.ok ? res.text.replace(/^"|"$/g, '') : undefined
  } catch {
    return undefined
  }
}

export type InstalledPack = { folder: string; cnr_id?: string; aux_id?: string; ver: string; enabled: boolean }

/** The packs /v2/customnode/installed lists: the folder under custom_nodes, its registry id when it came from the registry, else its git id. */
function installedPacks(value: unknown): InstalledPack[] {
  return Object.entries(isObject(value) ? value : {}).map(([folder, info]) => {
    const p = isObject(info) ? info : {}
    // A git-cloned pack the registry does not know has cnr_id "" (not null), so an empty id is no id.
    return { folder, cnr_id: str(p.cnr_id), aux_id: str(p.aux_id), ver: String(p.ver ?? '?'), enabled: p.enabled !== false }
  })
}

/** The Manager's recent task results from /v2/manager/queue/history, one line each. */
function taskLines(value: unknown): string[] {
  const history = isObject(value) && isObject(value.history) ? value.history : {}
  return Object.entries(history).map(([uiId, item]) => {
    const t = isObject(item) ? item : {}
    const status = isObject(t.status) ? t.status : {}
    const params = isObject(t.params) ? t.params : {}
    const target = String(params.id ?? params.node_name ?? params.cnr_id ?? '')
    return `${uiId}: ${String(t.kind ?? '?')} ${target} -> ${String(status.status_str ?? t.result ?? '?')}${Array.isArray(status.messages) && status.messages.length ? ` (${status.messages.map(String).join('; ')})` : ''}`
  })
}

export type PacksInput = { state?: unknown }

/** The installed node packs with their version and state, the Manager's version and its task queue. */
export async function managerPacks(fetch: Fetch, base: string, input: PacksInput): Promise<Out> {
  const installed = await getJson(fetch, base, '/v2/customnode/installed')
  if (installed.error) return installed.error.text.includes('404') ? fail(MANAGER_OFF) : installed.error
  const state = str(input.state)?.toLowerCase()
  const lines: string[] = []
  for (const p of installedPacks(installed.value)) {
    if (state === 'enabled' && !p.enabled) continue
    if (state === 'disabled' && p.enabled) continue
    lines.push(`${p.folder}: ${p.ver}${p.cnr_id ? ` (registry id ${p.cnr_id})` : p.aux_id ? ` (${p.aux_id}, not from the registry)` : ''}${p.enabled ? '' : ' [disabled]'}`)
  }
  const version = (await managerVersion(fetch, base)) ?? '?'
  const queue = await getJson(fetch, base, '/v2/manager/queue/status')
  const q = !queue.error && isObject(queue.value) ? queue.value : {}
  const head = `ComfyUI-Manager ${version}: ${lines.length} pack${lines.length === 1 ? '' : 's'}${state ? ` (${state})` : ''}; task queue: ${String(q.in_progress_count ?? 0)} in progress, ${String(q.pending_count ?? 0)} pending, ${String(q.done_count ?? 0)} done${q.is_processing ? ', processing' : ''}.`
  const history = await getJson(fetch, base, '/v2/manager/queue/history?max_items=5')
  const tasks = history.error ? [] : taskLines(history.value)
  return ok(`${head}\n${lines.join('\n')}${tasks.length ? `\n\nRecent tasks:\n${tasks.join('\n')}` : ''}`)
}

export type SearchPacksInput = { query?: unknown; limit?: unknown }

/** Searches the Comfy Registry for packs to install: id, name, description, latest version, repository. */
export async function searchPacks(fetch: Fetch, input: SearchPacksInput): Promise<Out> {
  const query = str(input.query)
  if (!query) return fail('query is required.')
  const limit = Math.min(limitOf(input.limit), 50)
  const got = await getJson(fetch, REGISTRY, `/nodes?search=${encodeURIComponent(query)}&limit=${limit}`)
  if (got.error) return got.error
  const nodes = isObject(got.value) && Array.isArray(got.value.nodes) ? got.value.nodes : []
  if (!nodes.length) return ok(`No pack matches "${query}" in the Comfy Registry.`)
  const lines = nodes.map((n) => {
    const p = isObject(n) ? n : {}
    const latest = isObject(p.latest_version) ? p.latest_version : {}
    return [`## ${String(p.name ?? p.id)} (id: ${String(p.id ?? '?')}, latest ${String(latest.version ?? '?')})`, String(p.description ?? '').split('\n')[0], p.repository ? `repository: ${String(p.repository)}` : undefined, typeof p.downloads === 'number' ? `downloads: ${p.downloads}` : undefined]
      .filter(Boolean)
      .join('\n')
  })
  return ok(`${nodes.length} pack${nodes.length === 1 ? '' : 's'} (install one with manager_task action install and its id):\n\n${lines.join('\n\n')}`)
}

export type ManagerTaskInput = { action?: unknown; pack?: unknown; version?: unknown; repository?: unknown }

/**
 * The Manager 4 task body for one action, or why there is none. For install, `pack` is the registry id. For the other
 * actions it names an installed pack (its folder or registry id, as manager_packs lists them): the worker keys a pack
 * from the registry by its registry id (`cnr_map[node_name]`), and one cloned from git by its folder with `is_unknown`.
 */
export function managerTask(input: ManagerTaskInput, uiId: string, installed: readonly InstalledPack[]): { task: Record<string, unknown>; error?: undefined } | { task?: undefined; error: string } {
  const action = str(input.action) as ManagerAction | undefined
  if (!action || !MANAGER_ACTIONS.includes(action)) return { error: `action must be one of ${MANAGER_ACTIONS.join(', ')}.` }
  const pack = str(input.pack)
  if (!pack || /[\s/\\]/.test(pack)) return { error: 'pack must be a registry id (install) or an installed pack name from manager_packs (update, uninstall, disable, enable, fix), without spaces or slashes.' }
  const version = str(input.version)
  const repository = str(input.repository)
  if (action === 'install') {
    const selected = version ?? 'latest'
    if (selected === 'nightly' && !repository) return { error: 'installing the nightly version needs the repository URL.' }
    const params = { id: pack, version: selected, selected_version: selected, mode: 'cache', channel: 'default', skip_post_install: false, ...(repository ? { repository } : {}) }
    return { task: { ui_id: uiId, client_id: 'comfyui-local', kind: action, params } }
  }
  const found = installed.find((p) => p.folder === pack || p.cnr_id === pack)
  if (!found) return { error: `${pack} is not an installed pack: use a folder or registry id that manager_packs lists.` }
  const name = found.cnr_id ?? found.folder
  const unknown = found.cnr_id === undefined
  let params: Record<string, unknown>
  switch (action) {
    case 'update':
      params = { node_name: name, ...(version ? { node_ver: version } : found.ver !== '?' ? { node_ver: found.ver } : {}) }
      break
    case 'uninstall':
    case 'disable':
      params = { node_name: name, is_unknown: unknown }
      break
    case 'enable':
      if (unknown) return { error: `${pack} did not come from the registry, so the Manager cannot enable it by id: enable it from the Manager UI.` }
      params = { cnr_id: name }
      break
    case 'fix':
      params = { node_name: name, node_ver: version ?? found.ver }
      break
  }
  return { task: { ui_id: uiId, client_id: 'comfyui-local', kind: action, params } }
}

/** Queues one Manager task, starts the worker and reports the result when it is already in the history (a quick task), else where to look. */
export async function runManagerTask(fetch: Fetch, base: string, input: ManagerTaskInput, uiId: string): Promise<Out> {
  const installed = await getJson(fetch, base, '/v2/customnode/installed')
  if (installed.error) return installed.error.text.includes('404') ? fail(MANAGER_OFF) : installed.error
  const built = managerTask(input, uiId, installedPacks(installed.value))
  if (built.error !== undefined) return fail(built.error)
  const queued = await postJson(fetch, base, '/v2/manager/queue/task', built.task)
  if (queued.error) return queued.error
  if (!queued.res.ok) return fail(`The Manager refused the task (${queued.res.status}): ${queued.res.text.slice(0, 1000)}`)
  const started = await postJson(fetch, base, '/v2/manager/queue/start', {})
  if (started.error) return started.error
  if (!started.res.ok && started.res.status !== 201) return fail(`Task queued but the worker did not start (${started.res.status}): ${started.res.text.slice(0, 500)}`)
  const history = await getJson(fetch, base, `/v2/manager/queue/history?ui_id=${encodeURIComponent(uiId)}`)
  const done = history.error ? [] : taskLines(history.value)
  const what = `${String(built.task.kind)} of ${String(str(input.pack))}`
  if (done.length) return done.some((line) => /-> (failed|error)/.test(line)) ? fail(`${what} failed: ${done.join('; ')}. The Manager's security level may forbid it (see the server log).`) : ok(`${what} done: ${done.join('; ')}. Restart ComfyUI (restart_server) for the nodes to change.`)
  return ok(`${what} queued (task ${uiId}). manager_packs shows the task queue and recent results; a restart of ComfyUI (restart_server) is needed before new or removed nodes show in search_nodes.`)
}

/**
 * How restart_server waits for the server to come back: one GET /system_stats every `RESTART_POLL_MS`, for
 * `RESTART_TIMEOUT_MS` at most; after a dropped connection the first comes at `RESTART_FIRST_POLL_MS`, while the
 * re-executed process is surely still down. A server that still answers `RESTART_STILL_UP_MS` after the reboot was sent
 * never restarted; before that, an answer may come from the old process while it shuts down.
 */
export const RESTART_FIRST_POLL_MS = 500
export const RESTART_POLL_MS = 2_000
export const RESTART_STILL_UP_MS = 10_000
export const RESTART_TIMEOUT_MS = 120_000

/** The clock restart_server waits on, injected so a test runs at once. */
export type Clock = { sleep: (ms: number) => Promise<void>; now: () => Promise<number> }

const REBOOT_FORBIDDEN = 'The Manager refused the reboot (403): its security_level is below middle in user/__manager/config.ini on the server.'

/** The packs that failed to import at the last start, one line each, from the Manager's import-fail info; undefined when it cannot say. */
async function importFailures(fetch: Fetch, base: string): Promise<string[] | undefined> {
  const installed = await getJson(fetch, base, '/v2/customnode/installed')
  if (installed.error) return undefined
  const packs = installedPacks(installed.value)
  const cnrIds = packs.flatMap((p) => (p.cnr_id ? [p.cnr_id] : []))
  const urls = packs.flatMap((p) => (!p.cnr_id && p.aux_id ? [p.aux_id] : []))
  if (!cnrIds.length && !urls.length) return []
  const sent = await postJson(fetch, base, '/v2/customnode/import_fail_info_bulk', { cnr_ids: cnrIds, urls })
  if (sent.error || !sent.res.ok) return undefined
  const body = parse(sent.res.text)
  if (!isObject(body)) return undefined
  return Object.entries(body).flatMap(([id, info]) => (isObject(info) ? [`${id}: ${String(info.error ?? '').trim().split('\n')[0] || 'failed to import'}`] : []))
}

export type RestartInput = { force?: unknown }

/**
 * Restarts ComfyUI through the Manager's POST /v2/manager/reboot and waits for /system_stats to answer again. It refuses
 * while the queue holds a job, unless `force`. The reboot re-executes the process (or, under comfy-cli, exits and leaves
 * comfy-cli a marker to start it again), so the connection usually drops; the restart counts once a poll finds it down.
 */
export async function restartServer(fetch: Fetch, base: string, input: RestartInput, clock: Clock): Promise<Out> {
  const queue = await getJson(fetch, base, '/queue')
  if (queue.error) return queue.error
  const q = isObject(queue.value) ? queue.value : {}
  const running = queueItems(q.queue_running).length
  const pending = queueItems(q.queue_pending).length
  const busy = `${running} running and ${pending} pending job${running + pending === 1 ? '' : 's'}`
  if (running + pending > 0 && input.force !== true) return fail(`Not restarted: the queue holds ${busy}. A restart kills the running job and drops the pending ones; wait until get_job_status shows the queue empty, or pass force: true.`)
  const started = await clock.now()
  // Sent as JSON: the Manager answers 400 to the content types a plain HTML form can post (its CSRF guard).
  const sent = await postJson(fetch, base, '/v2/manager/reboot', {})
  // A dropped connection, an empty answer or a proxy's gateway error may each be the restart beginning; only a poll
  // that finds the server down proves it, so an answer before that comes from the old process, still shutting down or
  // never restarting.
  const gateway = sent.res !== undefined && sent.res.status >= 502 && sent.res.status <= 504
  const dropped = sent.error !== undefined || gateway
  if (sent.res && !sent.res.ok && !gateway) {
    if (sent.res.status === 403) return fail(REBOOT_FORBIDDEN)
    if (sent.res.status === 404) return fail(MANAGER_OFF)
    return fail(`The Manager refused the reboot (${sent.res.status}): ${sent.res.text.slice(0, 500)}`)
  }
  let stats: unknown
  let wentDown = false
  // The wait counts at least the time slept, so the limits hold even on a clock that does not move.
  let slept = 0
  for (let poll = 0; ; poll++) {
    const pause = poll === 0 && dropped ? RESTART_FIRST_POLL_MS : RESTART_POLL_MS
    await clock.sleep(pause)
    slept += pause
    const got = await getJson(fetch, base, '/system_stats')
    const waited = Math.max((await clock.now()) - started, slept)
    if (!got.error && wentDown) {
      stats = got.value
      break
    }
    if (!got.error) {
      if (waited >= RESTART_STILL_UP_MS) return fail('The reboot was sent, but ComfyUI kept running without restarting (see the server log).')
      continue
    }
    wentDown = true
    if (waited >= RESTART_TIMEOUT_MS) {
      return fail(`The reboot was sent, but ComfyUI did not answer /system_stats within ${RESTART_TIMEOUT_MS / 1000} s. Check the service on the server: under systemd, its status and journal.`)
    }
  }
  const seconds = Math.round(((await clock.now()) - started) / 1000)
  const system = isObject(stats) && isObject(stats.system) ? stats.system : {}
  const lines = [`${running + pending ? `Forced past ${busy}, which the restart dropped. ` : ''}Restarted in ${seconds} s: ComfyUI ${String(system.comfyui_version ?? '?')}.`]
  const failures = await importFailures(fetch, base)
  if (failures?.length) lines.push(`${failures.length} node pack${failures.length === 1 ? '' : 's'} failed to import (the server log has the traceback):`, ...failures)
  else if (failures) lines.push('No node pack reports an import error.')
  return ok(lines.join('\n'))
}

// --- workflows --------------------------------------------------------------------------------------------------------

/** The user's workflow library, under the userdata folder (user/default/workflows on the server): the frontend's Workflows tab. */
const WORKFLOWS = 'workflows'
const BAD_WORKFLOW_PATH = 'path must be relative to workflows/, such as "02 Pixel Art/Isometric building": no leading slash, drive, backslash, colon, "%" or control character, no "..", no empty folder.'
const API_FORMAT = 'workflow is in API format (node ids mapping to { class_type, inputs }). API format inside workflows/ breaks the frontend workflow list ("e is not iterable"): run it with submit_workflow instead, or convert it to UI format first.'

/**
 * The userdata file of a workflow, `workflows/<path>.json` (a leading `workflows/` taken as that folder), or undefined for
 * an absolute path, `..` or an empty segment. `%` is refused too: the server URL-decodes the name again after the route
 * did, so `%2e%2e` would become `..` there; a colon and control characters make no file name on every system.
 */
export function workflowFile(value: unknown): string | undefined {
  const given = str(value)
  const path = given?.startsWith(`${WORKFLOWS}/`) ? given.slice(WORKFLOWS.length + 1) : given
  if (!path || path.startsWith('/') || /[\\:%\u0000-\u001f\u007f]/.test(path)) return undefined
  if (path.split('/').some((part) => part === '' || part === '.' || part === '..')) return undefined
  return `${WORKFLOWS}/${/\.json$/i.test(path) ? path : `${path}.json`}`
}

/** The /api/userdata route of one file: the whole relative path is one URL-encoded segment, slashes included. */
const userdataPath = (file: string) => `/api/userdata/${encodeURIComponent(file)}`

/** The workflow as a UI-format object (what the frontend saves: "nodes" and "links" arrays), or why it is not one. */
export function uiWorkflow(value: unknown): { workflow: Record<string, unknown>; error?: undefined } | { workflow?: undefined; error: string } {
  const parsed = typeof value === 'string' ? parse(value) : value
  if (isObject(parsed) && Array.isArray(parsed.nodes) && Array.isArray(parsed.links)) return { workflow: parsed }
  if (isObject(parsed) && Object.values(parsed).some((node) => isObject(node) && typeof node.class_type === 'string')) return { error: API_FORMAT }
  return { error: 'workflow must be in UI format: an object with "nodes" and "links" arrays, as the frontend saves it and get_template answers (or that JSON as a string).' }
}

/** When a userdata file was last modified, from its milliseconds since the epoch. */
const when = (ms: unknown) => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z') : '?')

/** Reads and writes a local text file: the host's file access, injected. */
export type ReadText = (path: string) => Promise<string>
export type WriteText = (path: string, text: string) => Promise<void>

export type SaveWorkflowInput = { path?: unknown; workflow?: unknown; file?: unknown; overwrite?: unknown }

/**
 * Saves a UI-format workflow to the user's library with POST /api/userdata/workflows%2F<path>.json, refusing to replace
 * a file unless `overwrite`. The workflow comes inline, or from a local JSON `file` (one get_workflow wrote, edited).
 */
export async function saveWorkflow(fetch: Fetch, read: ReadText, base: string, input: SaveWorkflowInput): Promise<Out> {
  const file = workflowFile(input.path)
  if (!file) return fail(BAD_WORKFLOW_PATH)
  const local = str(input.file)
  if (local && input.workflow !== undefined) return fail('Give the workflow inline or as a local file, not both.')
  if (!local && input.workflow === undefined) return fail('Give the workflow inline (workflow) or as a local JSON file (file).')
  let workflow = input.workflow
  if (local) {
    try {
      workflow = await read(local)
    } catch (e) {
      return fail(`Could not read ${local}: ${e instanceof Error ? e.message : String(e)}`)
    }
    try {
      JSON.parse(String(workflow))
    } catch (e) {
      return fail(`${local} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const ui = uiWorkflow(workflow)
  if (ui.error !== undefined) return fail(ui.error)
  // The server replaces an existing file unless the query says overwrite=false, so it is always sent.
  const sent = await postJson(fetch, base, `${userdataPath(file)}?overwrite=${input.overwrite === true}&full_info=true`, ui.workflow)
  if (sent.error) return sent.error
  if (sent.res.status === 409) return fail(`${file} already exists. Read it with get_workflow, then save with overwrite: true to replace it, or choose another path.`)
  if (!sent.res.ok) return fail(`POST /api/userdata answered ${sent.res.status}: ${sent.res.text.slice(0, 500)}`)
  const info = parse(sent.res.text)
  const saved = isObject(info) ? info : {}
  return ok(`Saved ${typeof saved.path === 'string' ? saved.path : file} (${typeof saved.size === 'number' ? `${saved.size} bytes, ` : ''}modified ${when(saved.modified)}). It shows in the Workflows tab of the ComfyUI frontend once its list is reopened.`)
}

/** Lists the user's saved workflows with GET /api/userdata (recursive, with size and date), paths relative to workflows/. */
export async function listWorkflows(fetch: Fetch, base: string): Promise<Out> {
  const got = await getJson(fetch, base, `/api/userdata?dir=${WORKFLOWS}&recurse=true&split=false&full_info=true`)
  if (got.error) return got.status === 404 ? ok('No workflow is saved yet: the workflows/ folder does not exist.') : got.error
  const files = (Array.isArray(got.value) ? got.value : [])
    .filter(isObject)
    .filter((f) => typeof f.path === 'string')
    .sort((a, b) => String(a.path).localeCompare(String(b.path)))
  if (!files.length) return ok('No workflow is saved yet: the workflows/ folder is empty.')
  const lines = files.map((f) => `${String(f.path)} (${typeof f.size === 'number' ? `${f.size} bytes` : '?'}, modified ${when(f.modified)})`)
  return ok(`${files.length} workflow${files.length === 1 ? '' : 's'} in workflows/ (the path save_workflow and get_workflow take):\n${lines.join('\n')}`)
}

export type GetWorkflowInput = { path?: unknown; file?: unknown }

/**
 * One saved workflow's JSON with GET /api/userdata/workflows%2F<path>.json, as the base for an edit saved back with
 * save_workflow: inline and compact when it fits one answer, else (or when `file` names one) written indented to a local
 * file, by default comfyui-outputs/workflows/<path>.json, since a cut JSON is no base for an edit.
 */
export async function getWorkflow(fetch: Fetch, write: WriteText, base: string, input: GetWorkflowInput): Promise<Out> {
  const file = workflowFile(input.path)
  if (!file) return fail(BAD_WORKFLOW_PATH)
  const got = await getJson(fetch, base, userdataPath(file))
  if (got.error) return got.status === 404 ? fail(`No workflow at ${file}: list_workflows shows the saved ones.`) : got.error
  const text = JSON.stringify(got.value)
  const head = `Workflow ${file} in UI format; edit it and save it back with save_workflow and overwrite: true.\n`
  const asked = str(input.file)
  if (!asked && head.length + text.length <= LIMIT) return ok(head + text)
  const local = asked ?? `${OUTPUT_DIR}/${file}`
  try {
    await write(local, `${JSON.stringify(got.value, null, 2)}\n`)
  } catch (e) {
    return fail(`Could not write ${local}: ${e instanceof Error ? e.message : String(e)}`)
  }
  return ok(
    `Workflow ${file} in UI format written to ${local}${asked ? '' : ` (${text.length} characters, more than one answer carries)`}. Read and edit that file, then save it back with save_workflow, file: "${local}" and overwrite: true.`,
  )
}
