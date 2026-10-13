import { expect, test } from 'claude-code/testing'
import { leadingJson, scriptText } from '../hooks/tool-text'

test('leadingJson reads the first object, whatever braces and quotes it holds', () => {
  expect(leadingJson('{"a":"} {\\"x\\"","b":{"c":1}}\n\nTab Context:\n- x {y}')).toEqual({ a: '} {"x"', b: { c: 1 } })
  expect(leadingJson('no json here')).toBeUndefined()
  expect(leadingJson('{"unterminated": 1')).toBeUndefined()
})

test('scriptText cuts the tool note off and decodes a JSON string literal', () => {
  expect(scriptText('{"href":"x"}\n\nTab Context:\n- Executed on tabId: 1')).toBe('{"href":"x"}')
  expect(scriptText('"{\\"href\\":\\"x\\"}"\n\n(captured at origin https://chatgpt.com)\n\nTab Context:')).toBe('{"href":"x"}')
  expect(scriptText('true')).toBe('true')
})
