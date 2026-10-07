import { expect, test } from 'claude-code/testing'
import { generateImage } from '../hooks/image'
import { inputFor } from '../hooks/scripts'
import { fakeImageBrowser } from './helpers'

test('generateImage uploads the reference by path, waits for a finished image and reads it back', async () => {
  const reference = { name: 'ref.png', type: 'image/png', path: '/x/ref.png' }
  const image = 'B'.repeat(5_000_005)
  const { browser, calls } = fakeImageBrowser({
    shots: [{}, { stop: true }, { stop: true, images: 1 }, { images: 1 }],
    base64: image,
  })
  const result = await generateImage(browser, { prompt: 'a lamp', files: [reference] }, { pollMs: 0 })

  expect(calls).toEqual(['navigate https://chatgpt.com/', `upload ${inputFor('image/png')} /x/ref.png`, 'attach', 'send', 'image'])
  expect(result.ok && result.images.map(i => i.base64)).toEqual([image])
  expect(result.ok && [result.images[0]!.width, result.images[0]!.type]).toEqual([1024, 'image/png'])
})

test('generateImage returns the text when ChatGPT answers without an image', async () => {
  const { browser, calls } = fakeImageBrowser({
    shots: [{}, { count: 1, length: 20 }, { count: 1, length: 20 }],
    base64: '',
    text: 'I cannot create that image.',
  })
  const result = await generateImage(browser, { prompt: 'a logo of a brand' }, { pollMs: 0 })

  expect(result.ok).toBe(false)
  expect(!result.ok && result.markdown).toBe('I cannot create that image.')
  expect(!result.ok && result.error).toContain('instead of an image')
  expect(calls).not.toContain('image')
})

test('generateImage stops before sending when the reference does not attach', async () => {
  const { browser, calls } = fakeImageBrowser({ shots: [{}], base64: '', attached: false })
  const reference = { name: 'ref.png', type: 'image/png', path: '/x/ref.png' }
  const result = await generateImage(browser, { prompt: 'a lamp', files: [reference] }, { pollMs: 0 })

  expect(!result.ok && result.error).toContain('did not show up')
  expect(calls).not.toContain('send')
})

test('generateImage with saveOnly reads the chat\'s last image without sending anything', async () => {
  const { browser, calls } = fakeImageBrowser({ shots: [{}], base64: 'C'.repeat(11) })
  const chatUrl = 'https://chatgpt.com/c/6ac53b54-ec00'
  const result = await generateImage(browser, { prompt: 'lamp', chatUrl, saveOnly: true }, { pollMs: 0 })

  expect(calls).toEqual([`navigate ${chatUrl}`, 'image'])
  expect(result.ok && result.images[0]!.base64.length).toBe(11)
  const missing = await generateImage(browser, { prompt: 'lamp', saveOnly: true }, { pollMs: 0 })
  expect(!missing.ok && missing.error).toContain('saveOnly needs the chatUrl')
})

test('generateImage saves every variant ChatGPT drew, oldest first', async () => {
  const { browser, calls } = fakeImageBrowser({ shots: [{}, { stop: true, images: 2 }, { images: 2 }], base64: 'B'.repeat(10) })
  const result = await generateImage(browser, { prompt: 'two lamps' }, { pollMs: 0 })

  expect(result.ok && result.images.length).toBe(2)
  expect(calls.filter(call => call === 'image')).toEqual(['image', 'image'])
})

test('generateImage with saveOnly waits while the image is still generating', async () => {
  const { browser, calls } = fakeImageBrowser({ shots: [{ stop: true }, { stop: true }, { images: 1 }], base64: 'C'.repeat(10) })
  const chatUrl = 'https://chatgpt.com/c/6ac53b54-ec00'
  const result = await generateImage(browser, { prompt: 'lamp', chatUrl, saveOnly: true }, { pollMs: 0 })

  expect(result.ok && result.images[0]!.base64).toBe('C'.repeat(10))
  expect(calls).not.toContain('send')
})
