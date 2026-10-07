import { expect, test } from 'claude-code/testing'

import { callerOf } from '../hooks/helper'
import { isOwnDesktopTool, limitMs, parseCommand } from '../hooks/routing'

test('routing pieces: commands, own desktop tools and callers', () => {
  expect(parseCommand('on')).toEqual({ kind: 'on' })
  expect(parseCommand(' OFF ')).toEqual({ kind: 'off' })
  expect(parseCommand('')).toEqual({ kind: 'status' })
  expect(parseCommand('auto-approve on')).toEqual({ kind: 'auto-approve', isOn: true })
  expect(parseCommand('auto-approve maybe')).toEqual({ kind: 'help' })
  expect(parseCommand('forget')).toEqual({ kind: 'forget' })
  expect(parseCommand('forget TextEdit')).toEqual({ kind: 'forget-app', app: 'TextEdit' })
  expect(parseCommand(' FORGET  Foo Bar ')).toEqual({ kind: 'forget-app', app: 'Foo Bar' })

  expect(isOwnDesktopTool('mcp__computer-use__screenshot')).toBe(true)
  expect(isOwnDesktopTool('mcp__remote-devices__computer_click')).toBe(true)
  expect(isOwnDesktopTool('enable__mcp__remote-devices__computer')).toBe(true)
  expect(isOwnDesktopTool('mcp__remote-devices__Claude_Browser__navigate')).toBe(false)
  expect(isOwnDesktopTool('mcp__claude-in-chrome__computer')).toBe(false)
  expect(isOwnDesktopTool('Bash')).toBe(false)

  expect(callerOf('sess-1')).toBe('sess-1')
  expect(callerOf('sess-1', 'agent 7')).toBe('sess-1/agent_7')
})

test('limitMs reads minutes, falls back and caps', () => {
  expect(limitMs(undefined, 5)).toBe(300_000)
  expect(limitMs('abc', 5)).toBe(300_000)
  expect(limitMs(0, 5)).toBe(300_000)
  expect(limitMs(-3, 5)).toBe(300_000)
  expect(limitMs(NaN, 5)).toBe(300_000)
  expect(limitMs(0.5, 5)).toBe(30_000)
  expect(limitMs('12', 5)).toBe(720_000)
  expect(limitMs(1e9, 5)).toBe(86_400_000)
})
