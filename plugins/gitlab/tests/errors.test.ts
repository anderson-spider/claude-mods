import { expect, test } from 'claude-code/testing'
import { GitlabError } from '../hooks/api'
import { errorText } from '../hooks/errors'

const say = (status: number, method = 'GET', message = 'x') => errorText(new GitlabError(status, message, method), 'team/app', 'gitlab.example.com')

test('each refusal says what to do: a refused token, a missing api scope on a write, no access, a missing project', () => {
  expect(say(401, 'GET', '401 Unauthorized')).toBe(
    'GitLab answered 401 for team/app: 401 Unauthorized. The token for gitlab.example.com was refused (expired or revoked?). Replace it in the plugin options (/plugin, gitlab, configure).',
  )
  expect(say(403, 'POST', '403 Forbidden')).toBe(
    "GitLab answered 403 for team/app: 403 Forbidden. The token may lack the api scope (read_api only reads), or the user's role in team/app does not allow this.",
  )
  expect(say(403)).toContain("The token's user may have no access to team/app.")
  expect(say(404, 'GET', '404 Project Not Found')).toBe(
    "GitLab answered 404 for team/app: 404 Project Not Found. team/app may not exist or the token's user cannot see it; check the project path and the iid or id.",
  )
  expect(say(409, 'PUT')).toContain('the head moved')
  expect(say(422, 'POST', 'Bad thing.')).toBe('GitLab answered 422 for team/app: Bad thing')
})
