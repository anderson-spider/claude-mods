import { expect, test } from 'claude-code/testing'
import type { OutputDeps, Request } from '../hooks/model'
import { saveAnswer, saveImages } from '../hooks/output'

test('answer persistence saves partial Markdown with its chat header and honors an explicit path', async () => {
  const writes: [string, string][] = []
  const files = { write: async (path: string, text: string) => { writes.push([path, text]) }, readBytes: async () => ({ base64: '' }) }
  const result = { ok: false as const, url: 'https://chatgpt.com/c/partial', error: 'still going', markdown: 'partial', timedOut: true }
  const request: Request = { kind: 'ask', input: { prompt: 'question' }, filePaths: [], out: '/out/answer.md' }
  const outcome = await saveAnswer({ files, tmpDir: async () => { throw new Error('unused') } }, result, request)
  expect(writes).toEqual([['/out/answer.md', '<!-- https://chatgpt.com/c/partial -->\n\npartial\n']])
  expect(outcome).toEqual({
    ok: false,
    text: 'still going\nPartial answer saved to /out/answer.md.',
    error: 'still going',
    timedOut: true,
    chatUrl: result.url,
    paths: ['/out/answer.md'],
  })
  writes.length = 0
  await saveAnswer({ files, tmpDir: async () => undefined }, result, { ...request, out: undefined })
  expect(writes[0]?.[0]).toMatch(/^\/tmp\/chatgpt\/\d{8}-\d{6}-question\.md$/)
})

test('image persistence keeps saved variants on a later write failure and cleans up failed previews', async () => {
  const calls: string[][] = []
  const deps: OutputDeps = {
    run: async (argv, init) => {
      calls.push(argv)
      if (argv[0] === 'rm') throw new Error('cleanup failed')
      if (argv[0] === 'openssl') {
        expect(init?.timeoutMs).toBe(60_000)
        expect(init?.stdin).toBe('aW1hZ2U=')
        if (argv.at(-1) === '/out/lamp-2.png') return { exitCode: 1, stdout: '', stderr: ' disk full ' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    },
    files: { write: async () => {}, readBytes: async () => { throw new Error('preview unavailable') } },
    tmpDir: async () => { throw new Error('unused') },
  }
  const image = { base64: 'aW1hZ2U=', type: 'image/png', width: 1024, height: 1024, alt: 'generated' }
  const outcome = await saveImages(deps, { ok: true, url: 'https://chatgpt.com/c/image', images: [image, image] }, {
    kind: 'image', input: { prompt: 'lamp' }, filePaths: [], out: '/out/lamp.png',
  })
  expect(outcome).toEqual({ ok: false, text: 'Could not write /out/lamp-2.png: disk full', error: 'Could not write /out/lamp-2.png: disk full', chatUrl: 'https://chatgpt.com/c/image', paths: ['/out/lamp-1.png'] })
  expect(calls).toEqual([
    ['mkdir', '-p', '/out'],
    ['openssl', 'base64', '-d', '-A', '-out', '/out/lamp-1.png'],
    ['sips', '-Z', '768', '-s', 'format', 'jpeg', '/out/lamp-1.png', '--out', '/out/lamp-1.png.preview.jpg'],
    ['rm', '-f', '/out/lamp-1.png.preview.jpg'],
    ['mkdir', '-p', '/out'],
    ['openssl', 'base64', '-d', '-A', '-out', '/out/lamp-2.png'],
  ])
})
