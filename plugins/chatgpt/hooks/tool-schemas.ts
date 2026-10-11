// What the session.start hook registers besides the names, which register.tsx spells out at each call:
// the tools' input schemas, the jobs tool's description and the commands' descriptions.

const COMMON_PROPERTIES = {
  chatUrl: {
    type: 'string',
    description:
      'Optional. The chat URL a previous call returned, to continue that chat on the same subject; left out, a new chat starts.',
  },
  model: {
    type: 'string',
    description:
      'Optional. The model menu entry to pick for a new chat, by the start of its label as the menu shows it; an unknown one fails and lists those on offer.',
  },
  files: {
    type: 'array',
    items: { type: 'string' },
    description: 'Optional. Absolute paths of local files to attach (documents, code, images; at most 4 MiB each).',
  },
  wait: {
    type: 'boolean',
    description:
      'Optional, default true. false returns at once with a job id and works in the background; a message arrives when it is saved, and the jobs tool lists every job.',
  },
}

export const ASK_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    prompt: { type: 'string', description: 'The whole question, self-contained.' },
    ...COMMON_PROPERTIES,
    saveOnly: {
      type: 'boolean',
      description: 'Optional. Only save the last answer already in chatUrl, sending nothing (waits while it is still streaming).',
    },
    out: { type: 'string', description: 'Optional absolute path for the Markdown file.' },
    maxChars: {
      type: 'number',
      description: 'How much of the answer to return inline (default 3000); the file has all of it.',
    },
  },
  required: ['prompt'],
}

export const IMAGE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    prompt: { type: 'string', description: 'What to generate or change, self-contained.' },
    reference: {
      type: 'string',
      description: 'Optional absolute path of a PNG, JPEG, WebP or GIF image (at most 4 MiB) to attach.',
    },
    ...COMMON_PROPERTIES,
    saveOnly: {
      type: 'boolean',
      description:
        'Optional. Only save the last image already in chatUrl, sending nothing and spending no quota (waits ' +
        'while it is still generating); prompt only names the file.',
    },
    out: { type: 'string', description: 'Optional absolute path for the image file (variants get -1, -2).' },
  },
  required: ['prompt'],
}

export const JOBS_DESCRIPTION =
  'Lists the ChatGPT requests of this session that ran or run in the background (ask or image with wait: ' +
  'false, or a slow one that moved there): status, chat URL and saved files, newest first. Use it to find ' +
  "a background request's file or chat URL, or to check whether it is still running. It sends nothing to " +
  'ChatGPT, spends no quota and does not list requests from other sessions.'

export const JOBS_INPUT_SCHEMA = { type: 'object', properties: {} }

export const ASK_COMMAND_DESCRIPTION = 'Asks ChatGPT in the browser and shows the answer: /chatgpt-ask <question>'

export const IMAGE_COMMAND_DESCRIPTION = 'Generates an image with ChatGPT in the browser and saves it: /chatgpt-image <prompt>'

export const DOCTOR_COMMAND_DESCRIPTION =
  'Checks that ChatGPT works in the browser and which page parts moved: /chatgpt-doctor [chat URL]'
