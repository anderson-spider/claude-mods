import { expect, test } from 'claude-code/testing'
import { mimeOf } from '../hooks/files'
import { chatUrlOf, readAttachments, requestOf } from '../hooks/input'
import { inputFor } from '../hooks/scripts'

test('attachment checks accept the size boundary and stop before later files on failure', async () => {
  const calls: string[] = []
  const files = { stat: async (path: string) => {
    calls.push(path)
    if (path === '/missing') throw new Error('absent')
    return { size: 4 * 1024 * 1024 + (path === '/large' ? 1 : 0) }
  } }
  expect(await readAttachments(files, ['/ref.PNG'])).toEqual([{ name: 'ref.PNG', type: 'image/png', path: '/ref.PNG' }])
  expect(await readAttachments(files, ['relative', '/later'])).toBe('relative must be an absolute path.')
  expect(await readAttachments(files, ['/large', '/later'])).toBe('/large is over 4 MiB.')
  expect(await readAttachments(files, ['/missing', '/later'])).toBe('Could not read /missing (absent).')
  expect(calls).toEqual(['/ref.PNG', '/large', '/missing'])
})

test('mimeOf and inputFor pick the type and the file input of an attachment', () => {
  expect(mimeOf('/x/notes.md')).toBe('text/markdown')
  expect(mimeOf('/x/report.PDF')).toBe('application/pdf')
  expect(mimeOf('/x/main.rs')).toBe('text/plain')
  expect(mimeOf('/x/ref.png')).toBe('image/png')
  expect(inputFor('image/png')).toBe('input[type=file][accept="image/*"]')
  expect(inputFor('application/pdf')).toContain(':not([accept])')
})

// requestOf: characterization of how a tool call's raw input becomes a request.

const CHAT = 'https://chatgpt.com/c/abc-123'

test('chatUrlOf trims a string and treats blank or non-string values as absent', () => {
  expect(chatUrlOf('  https://chatgpt.com/c/x  ')).toBe('https://chatgpt.com/c/x')
  expect(chatUrlOf('   ')).toBeUndefined()
  expect(chatUrlOf('')).toBeUndefined()
  expect(chatUrlOf(undefined)).toBeUndefined()
  expect(chatUrlOf(42)).toBeUndefined()
  expect(chatUrlOf(['https://chatgpt.com/c/x'])).toBeUndefined()
})

test('requestOf answers the empty-prompt error before it looks at anything else', () => {
  const empty = 'Give a non-empty prompt.'
  expect(requestOf('ask', {})).toBe(empty)
  expect(requestOf('ask', { prompt: '' })).toBe(empty)
  expect(requestOf('ask', { prompt: ' \n\t ' })).toBe(empty)
  expect(requestOf('image', { prompt: 7 })).toBe(empty)
  expect(requestOf('ask', { prompt: null, chatUrl: 'not a url', model: 'x', reference: '/a.txt' })).toBe(empty)
})

test('requestOf trims the prompt, carries the kind and defaults every optional field', () => {
  const ask = requestOf('ask', { prompt: '  what is 2+2?\n' })
  expect(ask).toEqual({
    kind: 'ask',
    input: { prompt: 'what is 2+2?', chatUrl: undefined, model: undefined, saveOnly: false },
    filePaths: [],
    out: undefined,
    maxChars: undefined,
  })
  expect(requestOf('image', { prompt: 'a cat' })).toEqual({
    kind: 'image',
    input: { prompt: 'a cat', chatUrl: undefined, model: undefined, saveOnly: false },
    filePaths: [],
    out: undefined,
    maxChars: undefined,
  })
})

test('requestOf trims chatUrl, ignores a blank one and rejects one that is not a chat link', () => {
  const trimmed = requestOf('ask', { prompt: 'p', chatUrl: `  ${CHAT}  ` })
  expect(typeof trimmed === 'string' ? trimmed : trimmed.input.chatUrl).toBe(CHAT)
  const blank = requestOf('ask', { prompt: 'p', chatUrl: '   ' })
  expect(typeof blank === 'string' ? blank : blank.input.chatUrl).toBeUndefined()
  const numeric = requestOf('ask', { prompt: 'p', chatUrl: 12 })
  expect(typeof numeric === 'string' ? numeric : numeric.input.chatUrl).toBeUndefined()
  expect(requestOf('ask', { prompt: 'p', chatUrl: 'https://example.com/c/abc' })).toBe(
    'chatUrl must be a chat link like https://chatgpt.com/c/<id>, not https://example.com/c/abc.',
  )
  // The error names the trimmed value.
  expect(requestOf('ask', { prompt: 'p', chatUrl: ' nope ' })).toBe('chatUrl must be a chat link like https://chatgpt.com/c/<id>, not nope.')
})

test('requestOf trims model, drops a blank one and refuses a model together with a chatUrl', () => {
  const picked = requestOf('ask', { prompt: 'p', model: '  GPT-5 Thinking ' })
  expect(typeof picked === 'string' ? picked : picked.input.model).toBe('GPT-5 Thinking')
  const blank = requestOf('ask', { prompt: 'p', model: '   ' })
  expect(typeof blank === 'string' ? blank : blank.input.model).toBeUndefined()
  const numeric = requestOf('ask', { prompt: 'p', model: 5 })
  expect(typeof numeric === 'string' ? numeric : numeric.input.model).toBeUndefined()

  expect(requestOf('ask', { prompt: 'p', model: 'GPT-5', chatUrl: CHAT })).toBe('model is picked for a new chat; leave chatUrl out.')
  // A blank model beside a chatUrl is no model, so the chat is continued.
  const continued = requestOf('ask', { prompt: 'p', model: '  ', chatUrl: CHAT })
  expect(typeof continued === 'string' ? continued : continued.input.chatUrl).toBe(CHAT)
  // An invalid chatUrl is reported before the model conflict.
  expect(requestOf('ask', { prompt: 'p', model: 'GPT-5', chatUrl: 'bad' })).toBe(
    'chatUrl must be a chat link like https://chatgpt.com/c/<id>, not bad.',
  )
})

test('requestOf takes saveOnly only as the boolean true', () => {
  const saveOnly = (value: unknown) => {
    const request = requestOf('ask', { prompt: 'p', saveOnly: value })
    return typeof request === 'string' ? request : request.input.saveOnly
  }
  expect(saveOnly(true)).toBe(true)
  expect(saveOnly(false)).toBe(false)
  expect(saveOnly('true')).toBe(false)
  expect(saveOnly(1)).toBe(false)
  expect(saveOnly(undefined)).toBe(false)
})

test('requestOf trims the files, drops blank and non-string entries and ignores a non-array', () => {
  const filesOf = (files: unknown) => {
    const request = requestOf('ask', { prompt: 'p', files })
    return typeof request === 'string' ? request : request.filePaths
  }
  expect(filesOf(['/a.txt', '  /b.md  ', '', '   ', 3, null, '/c.csv'])).toEqual(['/a.txt', '/b.md', '/c.csv'])
  expect(filesOf('/a.txt')).toEqual([])
  expect(filesOf({ 0: '/a.txt' })).toEqual([])
  expect(filesOf(undefined)).toEqual([])
  // A relative path is kept here: readAttachments rejects it later.
  expect(filesOf(['relative.txt'])).toEqual(['relative.txt'])
})

test('requestOf puts the reference first, trimmed, and accepts only an image type for it', () => {
  const request = requestOf('image', { prompt: 'p', reference: '  /refs/cat.PNG ', files: ['/notes.md', ' /other.pdf'] })
  expect(typeof request === 'string' ? request : request.filePaths).toEqual(['/refs/cat.PNG', '/notes.md', '/other.pdf'])
  for (const path of ['/r.png', '/r.jpg', '/r.jpeg', '/r.webp', '/r.gif']) {
    const ok = requestOf('image', { prompt: 'p', reference: path })
    expect(typeof ok === 'string' ? ok : ok.filePaths).toEqual([path])
  }
  expect(requestOf('image', { prompt: 'p', reference: '/notes.md' })).toBe('/notes.md must be a PNG, JPEG, WebP or GIF image.')
  expect(requestOf('image', { prompt: 'p', reference: ' /doc.pdf ' })).toBe('/doc.pdf must be a PNG, JPEG, WebP or GIF image.')
  const blank = requestOf('image', { prompt: 'p', reference: '   ', files: ['/a.txt'] })
  expect(typeof blank === 'string' ? blank : blank.filePaths).toEqual(['/a.txt'])
  // The reference is read for an ask as well; the kind does not change how the input is read.
  const ask = requestOf('ask', { prompt: 'p', reference: '/r.png' })
  expect(typeof ask === 'string' ? ask : ask.filePaths).toEqual(['/r.png'])
  // The model/chatUrl conflict is reported before the reference is checked.
  expect(requestOf('image', { prompt: 'p', reference: '/notes.md', model: 'm', chatUrl: CHAT })).toBe(
    'model is picked for a new chat; leave chatUrl out.',
  )
})

test('requestOf keeps out only as an absolute path, untrimmed, and floors a positive maxChars', () => {
  const field = (e: Record<string, unknown>, key: 'out' | 'maxChars') => {
    const request = requestOf('ask', { prompt: 'p', ...e })
    return typeof request === 'string' ? request : request[key]
  }
  expect(field({ out: '/tmp/answer.md' }, 'out')).toBe('/tmp/answer.md')
  expect(field({ out: 'relative.md' }, 'out')).toBeUndefined()
  expect(field({ out: ' /tmp/answer.md' }, 'out')).toBeUndefined()
  expect(field({ out: '/tmp/answer.md ' }, 'out')).toBe('/tmp/answer.md ')
  expect(field({ out: 5 }, 'out')).toBeUndefined()

  expect(field({ maxChars: 500 }, 'maxChars')).toBe(500)
  expect(field({ maxChars: 12.9 }, 'maxChars')).toBe(12)
  // A positive fraction passes the `> 0` check and is floored to 0, which the summary then reads as "show none".
  expect(field({ maxChars: 0.5 }, 'maxChars')).toBe(0)
  expect(field({ maxChars: 0 }, 'maxChars')).toBeUndefined()
  expect(field({ maxChars: -3 }, 'maxChars')).toBeUndefined()
  expect(field({ maxChars: '500' }, 'maxChars')).toBeUndefined()
  expect(field({ maxChars: Number.NaN }, 'maxChars')).toBeUndefined()
})

test('requestOf reads a whole ask input into a request', () => {
  expect(
    requestOf('ask', {
      prompt: ' explain ',
      chatUrl: ` ${CHAT} `,
      saveOnly: true,
      files: ['/a.txt'],
      out: '/tmp/x.md',
      maxChars: 100,
      wait: false,
    }),
  ).toEqual({
    kind: 'ask',
    input: { prompt: 'explain', chatUrl: CHAT, model: undefined, saveOnly: true },
    filePaths: ['/a.txt'],
    out: '/tmp/x.md',
    maxChars: 100,
  })
})
