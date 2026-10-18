import type { McpToolInputs } from 'claude-code'
import { DEFAULT_CHOICE } from './conversation'
import { ASK_DESCRIPTION, IMAGE_DESCRIPTION } from './prompts'
import type { Request } from './model'
import type { SchemaFor } from './schema'

// The default as the menu labels it ("Medium"); the README repeats this text by hand, and scripts/check-consistency.mjs compares them.
const DEFAULT_EFFORT = DEFAULT_CHOICE.effort[0]!.toUpperCase() + DEFAULT_CHOICE.effort.slice(1)

// `as const` keeps each `type` a literal, which the SchemaFor check below needs.
const COMMON_PROPERTIES = {
  chatUrl: {
    type: 'string',
    description: 'Continue the chat URL returned by an earlier call; omit for a new chat.',
  },
  model: {
    type: 'string',
    description: `New-chat model label prefix from the current menu; omit it and a new chat uses ${DEFAULT_CHOICE.model} at ${DEFAULT_EFFORT} effort. Unknown labels return the available choices.`,
  },
  files: {
    type: 'array',
    items: { type: 'string' },
    description: 'Absolute attachment paths; at most 4 MiB per file.',
  },
  wait: {
    type: 'boolean',
    description: 'Default true. false starts a background job; completion sends a message. Use jobs to check it.',
  },
} as const

// Each inputSchema satisfies SchemaFor of its McpToolInputs entry in types/index.d.ts: tsc fails when they differ.
export const ASK_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    prompt: { type: 'string', description: 'Self-contained question.' },
    ...COMMON_PROPERTIES,
    saveOnly: {
      type: 'boolean',
      description: 'Save the last answer in chatUrl after streaming finishes; sends nothing.',
    },
    out: { type: 'string', description: 'Absolute Markdown output path.' },
    maxChars: {
      type: 'number',
      description: 'Inline excerpt length; default 3000. The file keeps the full answer.',
    },
  },
  required: ['prompt'],
} satisfies SchemaFor<McpToolInputs['mcp__chatgpt__ask']>

export const IMAGE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    prompt: { type: 'string', description: 'Self-contained image request.' },
    reference: {
      type: 'string',
      description: 'Absolute PNG/JPEG/WebP/GIF reference path; at most 4 MiB.',
    },
    ...COMMON_PROPERTIES,
    saveOnly: {
      type: 'boolean',
      description: 'Save the last image in chatUrl after generation; sends nothing, spends no quota. prompt names the file.',
    },
    out: { type: 'string', description: 'Absolute image output path; variants add -1, -2.' },
  },
  required: ['prompt'],
} satisfies SchemaFor<McpToolInputs['mcp__chatgpt__image']>

export const JOBS_DESCRIPTION =
  'Find this session\'s background requests: status, chat URL and saved files, newest first. Local only; sends nothing to ChatGPT and spends no quota.'

export const JOBS_INPUT_SCHEMA = { type: 'object', properties: {} } satisfies SchemaFor<McpToolInputs['mcp__chatgpt__jobs']>

export const ASK_COMMAND_DESCRIPTION = 'Ask ChatGPT: /chatgpt-ask <question>'
export const IMAGE_COMMAND_DESCRIPTION = 'Generate and save an image: /chatgpt-image <prompt>'
export const DOCTOR_COMMAND_DESCRIPTION = 'Diagnose ChatGPT login and page selectors: /chatgpt-doctor [chat URL]'

/** A tool the plugin registers: the name and description the model reads, its input schema, and for a tool served as a request, the request kind and the command that sends the same request. */
export type ToolDef = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /** The request kind `serve` answers the tool's calls with. */
  kind?: 'ask' | 'image'
  command?: { name: string; description: string }
  /** A command's text as a request: the trimmed text is the whole prompt, and a blank text answers the usage, which sends nothing. */
  commandRequest?: (args: string) => Request | string
}

function commandRequestOf(kind: 'ask' | 'image', usage: string): (args: string) => Request | string {
  return args => {
    const prompt = args.trim()
    return prompt ? { kind, input: { prompt }, filePaths: [] } : usage
  }
}

/** Every tool the plugin registers, in the order the model sees them. Adding a tool is one entry here, its tool.call hook in register.tsx and its McpToolInputs entry in types/index.d.ts. */
export const TOOLS = {
  ask: {
    name: 'ask',
    description: ASK_DESCRIPTION,
    inputSchema: ASK_INPUT_SCHEMA,
    kind: 'ask',
    command: { name: 'chatgpt-ask', description: ASK_COMMAND_DESCRIPTION },
    commandRequest: commandRequestOf('ask', 'Usage: /chatgpt-ask <question>'),
  },
  image: {
    name: 'image',
    description: IMAGE_DESCRIPTION,
    inputSchema: IMAGE_INPUT_SCHEMA,
    kind: 'image',
    command: { name: 'chatgpt-image', description: IMAGE_COMMAND_DESCRIPTION },
    commandRequest: commandRequestOf('image', 'Usage: /chatgpt-image <prompt>'),
  },
  jobs: {
    name: 'jobs',
    description: JOBS_DESCRIPTION,
    inputSchema: JOBS_INPUT_SCHEMA,
  },
} satisfies Record<string, ToolDef>
