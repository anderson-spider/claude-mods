import { test, expect } from 'claude-code/testing'
import { buildUrl, call, forbidden, redact, transform } from '../hooks/api'

type Seen = { url: string; init: { method: string; headers: Record<string, string>; body?: string } }

function fakeFetch(text: string, headers?: Record<string, string>) {
  const seen: { last?: Seen } = {}
  const fetch = async (url: string, init: Seen['init']) => {
    seen.last = { url, init }
    return { status: 200, ok: true, text, headers }
  }
  return { fetch, seen }
}

const devices = JSON.stringify({
  devices: [
    {
      id: '1',
      hostname: 'a',
      os: 'linux',
      addresses: ['100.1.1.1'],
      machineKey: 'mkey:x',
      nodeKey: 'nodekey:y',
      tailnetLockKey: 'nlpub:z',
      tags: ['tag:t'],
    },
  ],
})

test('buildUrl aceita só caminhos da API', () => {
  expect(buildUrl('/tailnet/-/devices')).toBe('https://api.tailscale.com/api/v2/tailnet/-/devices')
  expect(buildUrl('//evil.com/x')).toBeUndefined()
  expect(buildUrl('/a/../b')).toBeUndefined()
  expect(buildUrl('https://evil.com')).toBeUndefined()
})

test('buildUrl recusa ponto, barra e barra invertida codificados', () => {
  expect(buildUrl('/a/%2e%2e/b')).toBeUndefined()
  expect(buildUrl('/a/%2E%2E/b')).toBeUndefined()
  expect(buildUrl('/a%2Fb')).toBeUndefined()
  expect(buildUrl('/a%5cb')).toBeUndefined()
  expect(buildUrl('/tailnet/-/devices?x=%20')).toBeDefined()
})

test('forbidden recusa só apagar a tailnet inteira', () => {
  expect(forbidden('DELETE', '/tailnet/-')).toBeDefined()
  expect(forbidden('DELETE', '/tailnet/T1234CNTRL/')).toBeDefined()
  expect(forbidden('DELETE', '/tailnet/-?x=1')).toBeDefined()
  expect(forbidden('DELETE', '/tailnet/-/keys/k1')).toBeUndefined()
  expect(forbidden('DELETE', '/device/1')).toBeUndefined()
  expect(forbidden('GET', '/tailnet/-')).toBeUndefined()
})

test('call não chega à rede ao apagar a tailnet', async () => {
  const { fetch, seen } = fakeFetch('{}')
  const r = await call(fetch, 'k', { method: 'DELETE', path: '/tailnet/-' })
  expect(r.isError).toBe(true)
  expect(seen.last).toBeUndefined()
})

test('call envia Bearer e corpo JSON', async () => {
  const { fetch, seen } = fakeFetch('{}')
  const r = await call(fetch, 'k', { method: 'POST', path: '/device/1/tags', body: { tags: ['tag:a'] } })
  expect(r.isError).toBe(false)
  expect(seen.last?.init.headers.Authorization).toBe('Bearer k')
  expect(seen.last?.init.headers['Content-Type']).toBe('application/json')
  expect(seen.last?.init.body).toBe('{"tags":["tag:a"]}')
})

test('call falha sem chave', async () => {
  const { fetch } = fakeFetch('')
  const r = await call(fetch, undefined, { method: 'GET', path: '/x' })
  expect(r.isError).toBe(true)
})

test('call manda If-Match quando há ifMatch', async () => {
  const { fetch, seen } = fakeFetch('{}')
  await call(fetch, 'k', { method: 'POST', path: '/tailnet/-/acl', body: '{}', ifMatch: '"abc"' })
  expect(seen.last?.init.headers['If-Match']).toBe('"abc"')
})

test('call sem ifMatch não manda If-Match', async () => {
  const { fetch, seen } = fakeFetch('{}')
  await call(fetch, 'k', { method: 'POST', path: '/tailnet/-/acl', body: '{}' })
  expect(seen.last?.init.headers['If-Match']).toBeUndefined()
})

test('body em string JSON vai como application/json e HuJSON como application/hujson', async () => {
  const json = fakeFetch('{}')
  await call(json.fetch, 'k', { method: 'POST', path: '/tailnet/-/acl', body: '{"acls":[]}' })
  expect(json.seen.last?.init.headers['Content-Type']).toBe('application/json')

  const hujson = fakeFetch('{}')
  const policy = '{\n  // libera tudo\n  "acls": [],\n}'
  await call(hujson.fetch, 'k', { method: 'POST', path: '/tailnet/-/acl', body: policy })
  expect(hujson.seen.last?.init.headers['Content-Type']).toBe('application/hujson')
  expect(hujson.seen.last?.init.body).toBe(policy)
})

test('call mostra o ETag da resposta', async () => {
  const { fetch } = fakeFetch('{"acls":[]}', { etag: '"e0b2816b418"' })
  const r = await call(fetch, 'k', { method: 'GET', path: '/tailnet/-/acl' })
  expect(r.text).toBe('HTTP 200\nETag: "e0b2816b418"\n{"acls":[]}')
})

test('call sem ETag não inventa a linha', async () => {
  const { fetch } = fakeFetch('{}')
  const r = await call(fetch, 'k', { method: 'GET', path: '/tailnet/-/devices' })
  expect(r.text).toBe('HTTP 200\n{}')
})

test('call devolve erro em 412', async () => {
  const fetch = async () => ({ status: 412, ok: false, text: '{"message":"precondition failed"}' })
  const r = await call(fetch, 'k', { method: 'POST', path: '/tailnet/-/acl', body: '{}', ifMatch: '"x"' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('HTTP 412')
})

test('redact remove os campos de segredo em qualquer nível', () => {
  const out = JSON.parse(redact(devices))
  expect(out.devices[0]).toEqual({ id: '1', hostname: 'a', os: 'linux', addresses: ['100.1.1.1'], tags: ['tag:t'] })
})

test('redact remove secret, s3SecretAccessKey e token', () => {
  const out = JSON.parse(redact('{"a":{"secret":"s","s3SecretAccessKey":"k","token":"t","ok":1}}'))
  expect(out).toEqual({ a: { ok: 1 } })
})

test('redact deixa texto que não é JSON intacto', () => {
  expect(redact('not json')).toBe('not json')
})

test('call com redact:true filtra a resposta', async () => {
  const { fetch } = fakeFetch(devices)
  const r = await call(fetch, 'k', { method: 'GET', path: '/tailnet/-/devices', redact: true })
  expect(r.text).not.toContain('machineKey')
  expect(r.text).not.toContain('nodeKey')
  expect(r.text).not.toContain('tailnetLockKey')
  expect(r.text).toContain('"hostname":"a"')
})

test('call sem redact mantém a resposta como veio', async () => {
  const { fetch } = fakeFetch(devices)
  const r = await call(fetch, 'k', { method: 'GET', path: '/tailnet/-/devices' })
  expect(r.text).toContain('machineKey')
})

test('fields mantém só as chaves pedidas, no meio de um objeto envolvente', () => {
  const out = JSON.parse(transform(devices, { fields: ['hostname', 'addresses'] }))
  expect(out).toEqual({ devices: [{ hostname: 'a', addresses: ['100.1.1.1'] }] })
})

test('fields combina com redact e não traz de volta o que foi removido', () => {
  const out = JSON.parse(transform(devices, { redact: true, fields: ['hostname', 'nodeKey'] }))
  expect(out).toEqual({ devices: [{ hostname: 'a' }] })
})

test('fields sem nenhuma chave casando devolve objeto vazio', () => {
  expect(transform(devices, { fields: ['nada'] })).toBe('{}')
})

test('fields vazio não mexe na resposta', () => {
  expect(transform(devices, { fields: [] })).toBe(devices)
})

test('call corta resposta enorme e sugere fields', async () => {
  const { fetch } = fakeFetch('x'.repeat(70_000))
  const r = await call(fetch, 'k', { method: 'GET', path: '/tailnet/-/devices' })
  expect(r.text).toContain('use "fields"')
  expect(r.text.length).toBeLessThan(61_000)
})
