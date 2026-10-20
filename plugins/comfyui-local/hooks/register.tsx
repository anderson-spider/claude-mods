import type { EngineInterface, McpToolInputs, Register } from 'claude-code'
import { OFF_TEXT, resolveAccess, type AccessIo } from './access'
import {
  MANAGER_ACTIONS,
  cancelJob,
  getJobStatus,
  getOutput,
  getTemplate,
  managerPacks,
  runManagerTask,
  searchModels,
  searchNodes,
  searchPacks,
  searchTemplates,
  submitWorkflow,
  systemInfo,
  uploadFile,
  type Fetch,
  type Out,
  type Run,
} from './api'
import { allOf, type SchemaFor } from './schema'

type Inputs = McpToolInputs
type Reply = { result: string } | { result: string; isError: true }

/** Shapes a call's output for the host: the result of a custom tool is a string, and `isError` is set only when true (the host rejects `false`). */
function reply(out: Out): Reply {
  return out.isError ? { result: out.text, isError: true as const } : { result: out.text }
}

/** The user's and the repository's settings, which decide whether the url option may be used. */
function accessIo($: EngineInterface): AccessIo {
  return {
    settings: async (source) => {
      const settings = await $.settings.read({ source })
      return { pluginConfigs: settings?.pluginConfigs }
    },
  }
}

/** What a tool does once the server is known: the fetch, the process runner and the file check are the host's, wrapped so the engine's source analysis sees each `$` call. */
type Work = (host: { fetch: Fetch; run: Run; exists: (path: string) => Promise<boolean>; base: string }) => Promise<Out>

/** The host wiring every tool shares: resolves the server from the url option, then runs the tool. `$` is passed only to this top-level function. */
async function run($: EngineInterface, options: { url?: unknown }, work: Work): Promise<Reply> {
  const access = await resolveAccess(accessIo($), options)
  if (access.off !== undefined) return reply({ text: OFF_TEXT[access.off], isError: true })
  return reply(
    await work({
      base: access.base,
      fetch: (url, init) => $.http.fetch(url, init),
      run: (argv, init) => $.process.run(argv, init),
      exists: (path) => $.fs.exists(path),
    }),
  )
}

const LIMIT = { type: 'number', description: 'Results to show (default 20, at most 200).' } as const
const PROMPT_ID = 'The prompt_id that submit_workflow answered.'

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'system_info',
      description: 'ComfyUI version, GPU and memory, queue counts, and whether ComfyUI-Manager is installed. Call it first to know what the server can run.',
      inputSchema: { type: 'object', properties: {} } satisfies SchemaFor<Inputs['mcp__comfyui-local__system_info']>,
    })
    await $.tool.register({
      name: 'search_nodes',
      description:
        'Search the nodes installed on the server (core and custom node packs) by words, with their category, pack, inputs (name: TYPE, ? when optional, = default) and outputs. Use the exact input names and class names in submit_workflow.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Words to find in the name, display name, description or category.' },
          category: { type: 'string', description: 'Category filter, such as "sampling", "loaders", "image/upscaling".' },
          pack: { type: 'string', description: 'Pack filter: "core" or part of a custom node pack folder name.' },
          input_type: { type: 'string', description: 'Only nodes taking this input type, such as IMAGE, LATENT, MODEL, CONDITIONING.' },
          output_type: { type: 'string', description: 'Only nodes producing this output type, such as IMAGE, LATENT, AUDIO.' },
          limit: LIMIT,
        },
      } satisfies SchemaFor<Inputs['mcp__comfyui-local__search_nodes']>,
    })
    await $.tool.register({
      name: 'search_models',
      description: 'List the model files on the server as folder/file (checkpoints, diffusion_models, loras, vae, text_encoders, upscale_models, ...). The file name is what the loader node takes.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Words to find in the folder or file name; empty lists everything.' },
          folder: { type: 'string', description: 'One model folder, such as checkpoints or loras.' },
          limit: LIMIT,
        },
      } satisfies SchemaFor<Inputs['mcp__comfyui-local__search_models']>,
    })
    await $.tool.register({
      name: 'search_templates',
      description: 'Search the workflow templates the server ships (core and node packs) by words, tag or model. Read one with get_template; it shows which nodes and models a task needs.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Words to find in the title, description, tags or models.' },
          tag: { type: 'string', description: 'Tag filter, such as "Text to Image", "Image to Video", "Upscale", "Audio", "3D".' },
          model: { type: 'string', description: 'Model filter, such as Flux, SDXL, Wan, LTX.' },
          limit: LIMIT,
        },
      } satisfies SchemaFor<Inputs['mcp__comfyui-local__search_templates']>,
    })
    await $.tool.register({
      name: 'get_template',
      description: 'The workflow JSON of one template, in UI format (nodes with type and widgets_values, links). Use it as the reference to build the API-format prompt for submit_workflow.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The template name from search_templates.' },
          pack: { type: 'string', description: 'The pack from search_templates, for a node pack template; omit for a core one.' },
        },
        required: ['name'],
      } satisfies SchemaFor<Inputs['mcp__comfyui-local__get_template']>,
    })
    await $.tool.register({
      name: 'submit_workflow',
      description:
        'Queue an API-format workflow: an object mapping node ids to { "class_type", "inputs" }, where an input is a value or [from_node_id, output_index]. Include an output node (SaveImage, SaveAudio, SaveAnimatedWEBP, PreviewImage...) or nothing is retrievable. Answers the prompt_id to poll with get_job_status.',
      inputSchema: {
        type: 'object',
        properties: {
          workflow: { description: 'The API-format prompt as a JSON object, or that JSON as a string.' },
          client_id: { type: 'string', description: 'Optional client id recorded with the job.' },
        },
        required: ['workflow'],
      } satisfies SchemaFor<Inputs['mcp__comfyui-local__submit_workflow']>,
    })
    await $.tool.register({
      name: 'get_job_status',
      description: 'The state of a job: pending (with its place), running, completed (with its output files) or failed (with the node error). Poll every few seconds. Without prompt_id, the queue.',
      inputSchema: { type: 'object', properties: { prompt_id: { type: 'string', description: PROMPT_ID } } } satisfies SchemaFor<Inputs['mcp__comfyui-local__get_job_status']>,
    })
    await $.tool.register({
      name: 'cancel_job',
      description: 'Remove a pending job or interrupt a running one; without prompt_id, interrupt whatever runs (or, with clear_pending, empty the pending queue instead).',
      inputSchema: {
        type: 'object',
        properties: {
          prompt_id: { type: 'string', description: PROMPT_ID },
          clear_pending: { type: 'boolean', description: 'Delete every pending job (with no prompt_id, only that).' },
        },
      } satisfies SchemaFor<Inputs['mcp__comfyui-local__cancel_job']>,
    })
    await $.tool.register({
      name: 'upload_file',
      description: 'Upload a local image, video or audio file to the server input folder. Answers the name to put in a LoadImage (or LoadVideo, LoadAudio) node.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'The local file, relative to the working directory or absolute.' },
          subfolder: { type: 'string', description: 'A folder under the server input folder.' },
          overwrite: { type: 'boolean', description: 'Replace a file of the same name instead of renaming the upload.' },
        },
        required: ['path'],
      } satisfies SchemaFor<Inputs['mcp__comfyui-local__upload_file']>,
    })
    await $.tool.register({
      name: 'get_output',
      description: 'Download the output files of a completed job to comfyui-outputs/ (or directory) and answer their paths; open one with the Read tool or the system viewer.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt_id: { type: 'string', description: PROMPT_ID },
          directory: { type: 'string', description: 'Where to save, relative to the working directory or absolute (default comfyui-outputs).' },
          description: { type: 'string', description: 'A few words that name the files, such as "cat astronaut".' },
        },
        required: ['prompt_id'],
      } satisfies SchemaFor<Inputs['mcp__comfyui-local__get_output']>,
    })
    await $.tool.register({
      name: 'manager_packs',
      description: 'The custom node packs installed through ComfyUI-Manager, with version and state, the Manager version and its task queue.',
      inputSchema: {
        type: 'object',
        properties: { state: { type: 'string', enum: allOf<NonNullable<Inputs['mcp__comfyui-local__manager_packs']['state']>>()('enabled', 'disabled'), description: 'Only enabled or only disabled packs.' } },
      } satisfies SchemaFor<Inputs['mcp__comfyui-local__manager_packs']>,
    })
    await $.tool.register({
      name: 'manager_search_packs',
      description: 'Search the public Comfy Registry (api.comfy.org) for node packs to install: id, description, latest version and repository.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Words to search.' }, limit: { type: 'number', description: 'Results to show (default 20, at most 50).' } },
        required: ['query'],
      } satisfies SchemaFor<Inputs['mcp__comfyui-local__manager_search_packs']>,
    })
    await $.tool.register({
      name: 'manager_task',
      description:
        'Queue a ComfyUI-Manager task on a node pack: install (a registry id from manager_search_packs), or update, uninstall, disable, enable or fix an installed pack (a folder or registry id from manager_packs). ComfyUI must be restarted afterwards for the nodes to change.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: allOf<Inputs['mcp__comfyui-local__manager_task']['action']>()(...MANAGER_ACTIONS) },
          pack: { type: 'string', description: 'The registry id (install) or the installed pack folder or registry id from manager_packs (other actions).' },
          version: { type: 'string', description: 'For install: a version, "latest" (default) or "nightly" (needs repository). For update and fix: the current version.' },
          repository: { type: 'string', description: 'The GitHub URL, required for a nightly install.' },
        },
        required: ['action', 'pack'],
      } satisfies SchemaFor<Inputs['mcp__comfyui-local__manager_task']>,
    })
    return next(e)
  })

  on('tool.call', { tool: 'mcp__comfyui-local__system_info' }, async ($) => run($, options, (h) => systemInfo(h.fetch, h.base)))
  on('tool.call', { tool: 'mcp__comfyui-local__search_nodes' }, async ($, e) => run($, options, (h) => searchNodes(h.fetch, h.base, e)))
  on('tool.call', { tool: 'mcp__comfyui-local__search_models' }, async ($, e) => run($, options, (h) => searchModels(h.fetch, h.base, e)))
  on('tool.call', { tool: 'mcp__comfyui-local__search_templates' }, async ($, e) => run($, options, (h) => searchTemplates(h.fetch, h.base, e)))
  on('tool.call', { tool: 'mcp__comfyui-local__get_template' }, async ($, e) => run($, options, (h) => getTemplate(h.fetch, h.base, e)))
  on('tool.call', { tool: 'mcp__comfyui-local__submit_workflow' }, async ($, e) => run($, options, (h) => submitWorkflow(h.fetch, h.base, e)))
  on('tool.call', { tool: 'mcp__comfyui-local__get_job_status' }, async ($, e) => run($, options, (h) => getJobStatus(h.fetch, h.base, e)))
  on('tool.call', { tool: 'mcp__comfyui-local__cancel_job' }, async ($, e) => run($, options, (h) => cancelJob(h.fetch, h.base, e)))
  on('tool.call', { tool: 'mcp__comfyui-local__upload_file' }, async ($, e) => run($, options, (h) => uploadFile(h.run, h.exists, h.base, e)))
  on('tool.call', { tool: 'mcp__comfyui-local__get_output' }, async ($, e) => run($, options, (h) => getOutput(h.fetch, h.run, h.base, e)))
  on('tool.call', { tool: 'mcp__comfyui-local__manager_packs' }, async ($, e) => run($, options, (h) => managerPacks(h.fetch, h.base, e)))
  on('tool.call', { tool: 'mcp__comfyui-local__manager_search_packs' }, async ($, e) => run($, options, (h) => searchPacks(h.fetch, e)))
  on('tool.call', { tool: 'mcp__comfyui-local__manager_task' }, async ($, e) => run($, options, (h) => runManagerTask(h.fetch, h.base, e, `comfyui-local-${Date.now()}`)))
}
