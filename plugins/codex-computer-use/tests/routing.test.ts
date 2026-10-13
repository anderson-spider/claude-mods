import { expect, test } from 'claude-code/testing'

import { parseCommand } from '../hooks/commands'
import { callerOf } from '../hooks/helper'
import { APPROVAL_MS, isOwnDesktopTool } from '../hooks/routing'

test('routing pieces: commands, own desktop tools, callers and answers', () => {
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

test('app approval has a fixed five-minute deadline', () => {
  expect(APPROVAL_MS).toBe(300_000)
})
