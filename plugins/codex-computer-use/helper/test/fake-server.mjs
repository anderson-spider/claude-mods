// A stand-in for cua_repl over stdio: `js` keeps variables per process, and
// `cua.getApp("<name>")` asks for approval through elicitation/create unless the
// app is in FAKE_APPROVED (as node_repl does with its persisted approvals).
import { createInterface } from 'node:readline'

const approved = new Set((process.env.FAKE_APPROVED ?? 'Calculator').split(',').filter(Boolean))
const vars = {}
const waiting = new Map()
let nextId = 1000

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`)
const ask = params =>
  new Promise(resolve => {
    const id = ++nextId
    waiting.set(id, resolve)
    send({ jsonrpc: '2.0', id, method: 'elicitation/create', params })
  })

const run = async code => {
  const set = /^set (\w+)=(.*)$/.exec(code)
  const get = /^get (\w+)$/.exec(code)
  const app = /cua\.getApp\("([^"]+)"\)/.exec(code)
  const sleep = /^sleep (\d+)$/.exec(code)

  if (sleep) {
    await new Promise(resolve => setTimeout(resolve, Number(sleep[1])))

    return { content: [{ type: 'text', text: 'slept' }] }
  }

  if (set) {
    vars[set[1]] = set[2]

    return { content: [{ type: 'text', text: 'ok' }] }
  }

  if (get) {
    return { content: [{ type: 'text', text: String(vars[get[1]]) }] }
  }

  if (app) {
    const name = app[1]
    const bundleId = `com.fake.${name}`

    if (!approved.has(name)) {
      const answer = await ask({
        mode: 'form',
        message: `Allow Computer Use to use "${name}"?`,
        requestedSchema: { type: 'object', properties: {} },
        _meta: {
          connector_id: 'computer-use',
          persist: ['session', 'always'],
          tool_params: { app: bundleId },
          tool_params_display: [{ name: 'app', display_name: 'App', value: name }],
        },
      })

      if (answer.action !== 'accept') {
        return { isError: true, content: [{ type: 'text', text: `Computer Use was not approved to use ${name}` }] }
      }

      vars.lastPersist = answer._meta?.persist
    }

    return {
      content: [{ type: 'text', text: `docs + state of ${name}` }],
      _meta: { 'codex/toolSurface': { kind: 'computerUse', app: { kind: 'appId', appId: bundleId } } },
    }
  }

  return { content: [{ type: 'text', text: `ran: ${code}` }] }
}

createInterface({ input: process.stdin }).on('line', async line => {
  const message = JSON.parse(line)

  if (message.method === undefined && waiting.has(message.id)) {
    waiting.get(message.id)(message.result)
    waiting.delete(message.id)

    return
  }

  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0' } },
    })
  } else if (message.method === 'tools/call') {
    const code = message.params.arguments.code
    send({ jsonrpc: '2.0', id: message.id, result: await run(code) })
  } else if (message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  }
})
