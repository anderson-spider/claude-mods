import { expect, test } from 'claude-code/testing'
import { diagnose, report } from '../hooks/doctor'
import { fakeBrowser, printed } from './helpers'

test('diagnose reports which page parts are in place', async () => {
  const { browser } = fakeBrowser({ tabs: [], pages: [{}], markdown: '' })
  browser.js = async (_tabId, code) =>
    code.includes('imageInput')
      ? printed({ href: 'https://chatgpt.com/', login: false, composer: true, send: 0, imageInput: true, fileInput: false, model: true, answers: 0, images: 0, codeBlocks: 0, blocker: '' })
      : printed({})
  const checks = await diagnose(browser, undefined, {})
  const text = report(checks)

  expect(text).toContain('✓ composer: found')
  expect(text).toContain('✗ file input: not found')
  expect(text).toContain('1 check(s) failed.')
  expect(report(await diagnose(browser, 'https://evil.example/c/1', {}))).toContain('✗ chat link')
})
