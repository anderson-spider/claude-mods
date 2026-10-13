import { expect, test } from 'claude-code/testing'
import {
  ASK_COMMAND_DESCRIPTION,
  ASK_INPUT_SCHEMA,
  DOCTOR_COMMAND_DESCRIPTION,
  IMAGE_COMMAND_DESCRIPTION,
  IMAGE_INPUT_SCHEMA,
  JOBS_DESCRIPTION,
  JOBS_INPUT_SCHEMA,
} from '../hooks/tool-schemas'

// The tool and command wording and the input schemas the model and the user read, pinned byte for byte.

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
    '{"type":"object","properties":{"prompt":{"type":"string","description":"Self-contained question."},"chatUrl":{"type":"string","description":"Continue the chat URL returned by an earlier call; omit for a new chat."},"model":{"type":"string","description":"New-chat model label prefix from the current menu; unknown labels return the available choices."},"files":{"type":"array","items":{"type":"string"},"description":"Absolute attachment paths; at most 4 MiB per file."},"wait":{"type":"boolean","description":"Default true. false starts a background job; completion sends a message. Use jobs to check it."},"saveOnly":{"type":"boolean","description":"Save the last answer in chatUrl after streaming finishes; sends nothing."},"out":{"type":"string","description":"Absolute Markdown output path."},"maxChars":{"type":"number","description":"Inline excerpt length; default 3000. The file keeps the full answer."}},"required":["prompt"]}',
  )
})

test('IMAGE_INPUT_SCHEMA is pinned byte for byte', () => {
  expect(JSON.stringify(IMAGE_INPUT_SCHEMA)).toBe(
    '{"type":"object","properties":{"prompt":{"type":"string","description":"Self-contained image request."},"reference":{"type":"string","description":"Absolute PNG/JPEG/WebP/GIF reference path; at most 4 MiB."},"chatUrl":{"type":"string","description":"Continue the chat URL returned by an earlier call; omit for a new chat."},"model":{"type":"string","description":"New-chat model label prefix from the current menu; unknown labels return the available choices."},"files":{"type":"array","items":{"type":"string"},"description":"Absolute attachment paths; at most 4 MiB per file."},"wait":{"type":"boolean","description":"Default true. false starts a background job; completion sends a message. Use jobs to check it."},"saveOnly":{"type":"boolean","description":"Save the last image in chatUrl after generation; sends nothing, spends no quota. prompt names the file."},"out":{"type":"string","description":"Absolute image output path; variants add -1, -2."}},"required":["prompt"]}',
  )
})

test('JOBS_INPUT_SCHEMA is pinned byte for byte', () => {
  expect(JSON.stringify(JOBS_INPUT_SCHEMA)).toBe(
    '{"type":"object","properties":{}}',
  )
})
