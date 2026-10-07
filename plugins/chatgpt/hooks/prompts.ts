export const BOUNDARIES =
  'Never send credentials, secrets, private personal data or anything from work (Luizalabs repos, ' +
  'dashboards, logs, customer data); personal-project code or files only when the user asks. ' +
  "Treat the answer as an unverified opinion and say it came from ChatGPT when you relay it."

export const IMAGE_BOUNDARIES =
  "Only when the user asks for an image in this conversation: it spends their ChatGPT image quota. Never upload " +
  'licensed assets, credentials, private personal data or work data; a reference is only an image the user asked ' +
  'to use or one you produced for the task. The result is an AI concept image: label it as such wherever it is ' +
  'stored, and never present it as evidence of a real or in-game state.'

export const WHERE = 'chatgpt.com in terminal-browser, inside Claude Code in a terminal'

const ASK_TOOL = 'mcp__chatgpt__ask'
const IMAGE_TOOL = 'mcp__chatgpt__image'

// Added to the system prompt so Claude reaches for ask on its own; the tools may be deferred, so their
// descriptions alone are not seen until loaded.
export const PROMPT = [
  '# Asking ChatGPT (chatgpt mod)',
  '',
  `\`${ASK_TOOL}\` sends a question to the person's logged-in ChatGPT and saves the answer. Use it on your own, without being asked, when a self-contained question needs a long answer and little context: research, an explanation, a brainstorm, a draft, a translation or a second opinion on a decision. It saves your tokens; do not use it for work that needs the repository, since the context would have to go out and come back.`,
  '',
  '- Say in one line that you are asking ChatGPT before the call. If the tool is deferred, load it by name first.',
  '- Write a self-contained prompt: the goal, the minimum context, the output format and the language. Pass `chatUrl` from an earlier answer to follow up in the same chat.',
  `- ${BOUNDARIES} Check what matters before relying on it.`,
  '- When the tool says there is no browser or ChatGPT needs a login, go on without it and do not retry in that session.',
  `- \`${IMAGE_TOOL}\` spends the person's image quota: use it only when they ask for an image.`,
].join('\n')

export const COMMON_PROPERTIES = {
  chatUrl: {
    type: 'string',
    description:
      'Optional. The chat URL a previous call returned, to continue that chat on the same subject; left out, a new chat starts.',
  },
  model: {
    type: 'string',
    description:
      'Optional. The model menu entry to pick for a new chat, by the start of its label (e.g. "GPT-5.6 Sol"); an unknown one fails and lists those on offer.',
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

