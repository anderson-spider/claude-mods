const COMMON_PROPERTIES = {
  chatUrl: {
    type: 'string',
    description: 'Continue the chat URL returned by an earlier call; omit for a new chat.',
  },
  model: {
    type: 'string',
    description: 'New-chat model label prefix from the current menu; unknown labels return the available choices.',
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
}

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
}

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
}

export const JOBS_DESCRIPTION =
  'Find this session\'s background requests: status, chat URL and saved files, newest first. Local only; sends nothing to ChatGPT and spends no quota.'

export const JOBS_INPUT_SCHEMA = { type: 'object', properties: {} }

export const ASK_COMMAND_DESCRIPTION = 'Ask ChatGPT: /chatgpt-ask <question>'
export const IMAGE_COMMAND_DESCRIPTION = 'Generate and save an image: /chatgpt-image <prompt>'
export const DOCTOR_COMMAND_DESCRIPTION = 'Diagnose ChatGPT login and page selectors: /chatgpt-doctor [chat URL]'
