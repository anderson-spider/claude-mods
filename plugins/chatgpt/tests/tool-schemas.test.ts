import { expect, test } from 'claude-code/testing'
import {
  ASK_COMMAND_DESCRIPTION,
  ASK_INPUT_SCHEMA,
  DOCTOR_COMMAND_DESCRIPTION,
  IMAGE_COMMAND_DESCRIPTION,
  IMAGE_INPUT_SCHEMA,
  JOBS_DESCRIPTION,
  JOBS_INPUT_SCHEMA,
  TOOLS,
  type ToolDef,
} from '../hooks/tool-schemas'

// The tool and command wording and the input schemas the model and the user read, pinned byte for byte.

test('TOOLS lists ask, image and jobs in the order the model sees them, and only ask and image have a command', () => {
  const list: ToolDef[] = Object.values(TOOLS)
  expect(list.map(tool => tool.name)).toEqual(['ask', 'image', 'jobs'])
  expect(list.map(tool => tool.command?.name)).toEqual(['chatgpt-ask', 'chatgpt-image', undefined])
  expect(TOOLS.ask.inputSchema).toBe(ASK_INPUT_SCHEMA)
  expect(TOOLS.image.inputSchema).toBe(IMAGE_INPUT_SCHEMA)
  expect(TOOLS.jobs.inputSchema).toBe(JOBS_INPUT_SCHEMA)
  expect(TOOLS.jobs.description).toBe(JOBS_DESCRIPTION)
  expect(TOOLS.ask.command?.description).toBe(ASK_COMMAND_DESCRIPTION)
  expect(TOOLS.image.command?.description).toBe(IMAGE_COMMAND_DESCRIPTION)
})

test('a tool is served as the request kind of its name, and jobs has none', () => {
  expect(TOOLS.ask.kind).toBe('ask')
  expect(TOOLS.image.kind).toBe('image')
  expect((TOOLS.jobs as ToolDef).kind).toBeUndefined()
})

test('commandRequest turns the trimmed text into the whole request, and a blank text into the usage', () => {
  expect(TOOLS.ask.commandRequest('  what is 2+2  ')).toEqual({ kind: 'ask', input: { prompt: 'what is 2+2' }, filePaths: [] })
  expect(TOOLS.image.commandRequest(' a cat ')).toEqual({ kind: 'image', input: { prompt: 'a cat' }, filePaths: [] })
  expect(TOOLS.ask.commandRequest(' \t ')).toBe('Usage: /chatgpt-ask <question>')
  expect(TOOLS.image.commandRequest('')).toBe('Usage: /chatgpt-image <prompt>')
})

test('JOBS_DESCRIPTION is pinned byte for byte', () => {
  expect(JOBS_DESCRIPTION).toBe(
    'Find this session\'s background requests: status, chat URL and saved files, newest first. Local only; sends nothing to ChatGPT and spends no quota.',
  )
})

test('ASK_COMMAND_DESCRIPTION is pinned byte for byte', () => {
  expect(ASK_COMMAND_DESCRIPTION).toBe(
    'Ask ChatGPT: /chatgpt-ask <question>',
  )
})

test('IMAGE_COMMAND_DESCRIPTION is pinned byte for byte', () => {
  expect(IMAGE_COMMAND_DESCRIPTION).toBe(
    'Generate and save an image: /chatgpt-image <prompt>',
  )
})

test('DOCTOR_COMMAND_DESCRIPTION is pinned byte for byte', () => {
  expect(DOCTOR_COMMAND_DESCRIPTION).toBe(
    'Diagnose ChatGPT login and page selectors: /chatgpt-doctor [chat URL]',
  )
})

test('ASK_INPUT_SCHEMA is pinned byte for byte', () => {
  expect(JSON.stringify(ASK_INPUT_SCHEMA)).toBe(
    '{"type":"object","properties":{"prompt":{"type":"string","description":"Self-contained question."},"chatUrl":{"type":"string","description":"Continue the chat URL returned by an earlier call; omit for a new chat."},"model":{"type":"string","description":"New-chat model label prefix from the current menu; omit it and a new chat uses GPT-6 at Medium effort. Unknown labels return the available choices."},"files":{"type":"array","items":{"type":"string"},"description":"Absolute attachment paths; at most 4 MiB per file."},"wait":{"type":"boolean","description":"Default true. false starts a background job; completion sends a message. Use jobs to check it."},"saveOnly":{"type":"boolean","description":"Save the last answer in chatUrl after streaming finishes; sends nothing."},"out":{"type":"string","description":"Absolute Markdown output path."},"maxChars":{"type":"number","description":"Inline excerpt length; default 3000. The file keeps the full answer."}},"required":["prompt"]}',
  )
})

test('IMAGE_INPUT_SCHEMA is pinned byte for byte', () => {
  expect(JSON.stringify(IMAGE_INPUT_SCHEMA)).toBe(
    '{"type":"object","properties":{"prompt":{"type":"string","description":"Self-contained image request."},"reference":{"type":"string","description":"Absolute PNG/JPEG/WebP/GIF reference path; at most 4 MiB."},"chatUrl":{"type":"string","description":"Continue the chat URL returned by an earlier call; omit for a new chat."},"model":{"type":"string","description":"New-chat model label prefix from the current menu; omit it and a new chat uses GPT-6 at Medium effort. Unknown labels return the available choices."},"files":{"type":"array","items":{"type":"string"},"description":"Absolute attachment paths; at most 4 MiB per file."},"wait":{"type":"boolean","description":"Default true. false starts a background job; completion sends a message. Use jobs to check it."},"saveOnly":{"type":"boolean","description":"Save the last image in chatUrl after generation; sends nothing, spends no quota. prompt names the file."},"out":{"type":"string","description":"Absolute image output path; variants add -1, -2."}},"required":["prompt"]}',
  )
})

test('JOBS_INPUT_SCHEMA is pinned byte for byte', () => {
  expect(JSON.stringify(JOBS_INPUT_SCHEMA)).toBe(
    '{"type":"object","properties":{}}',
  )
})
