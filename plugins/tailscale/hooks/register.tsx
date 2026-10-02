import type { Register } from 'claude-code'
import { WRITE_METHODS, call } from './api'

const PATH_HELP =
  'Caminho relativo a https://api.tailscale.com/api/v2, começando com "/". Use "-" para a tailnet padrão (ex.: /tailnet/-/devices).'

const AREAS =
  'dispositivos, ACL (policy file), DNS, chaves de API e de auth, usuários, convites, configurações da tailnet, ' +
  'webhooks, logs, device posture, services, OAuth apps e contatos'

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'tailscale_get',
      description:
        `Consulta a API da Tailscale (GET, só leitura): ${AREAS}. ` +
        'Exemplos: /tailnet/-/devices, /tailnet/-/acl, /device/{id}, /tailnet/-/keys, /tailnet/-/settings. ' +
        'A API não pagina: a lista vem inteira. Use "fields" para trazer só as chaves que importam. ' +
        'Campos de segredo (machineKey, nodeKey, tailnetLockKey, secret, token) são removidos. ' +
        'Um GET em /tailnet/-/acl mostra o ETag na resposta: guarde-o para o ifMatch do POST.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: PATH_HELP },
          fields: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Opcional. Mantém só estas chaves da resposta JSON, em qualquer nível (ex.: ["hostname","addresses","os","lastSeen"]).',
          },
        },
        required: ['path'],
      },
    })
    await $.tool.register({
      name: 'tailscale_write',
      description:
        'Modifica a tailnet pela API da Tailscale (POST, PUT, PATCH ou DELETE): autorizar/apagar dispositivos, ' +
        'definir tags e rotas, atualizar ACL e DNS, criar/revogar chaves, webhooks e convites. ' +
        'Muda estado real: confirme com a pessoa antes. Apagar a tailnet inteira é recusado. ' +
        'Para atualizar a ACL (POST /tailnet/-/acl), faça antes um GET e passe o ETag em ifMatch; ' +
        'um body em string que não seja JSON válido é enviado como HuJSON.',
      inputSchema: {
        type: 'object',
        properties: {
          method: { type: 'string', enum: [...WRITE_METHODS] },
          path: { type: 'string', description: PATH_HELP },
          body: { description: 'Corpo da requisição, quando houver: objeto JSON ou string (JSON/HuJSON).' },
          ifMatch: {
            type: 'string',
            description: 'Opcional. ETag do GET /tailnet/-/acl, com as aspas, para não sobrescrever uma edição concorrente.',
          },
        },
        required: ['method', 'path'],
      },
    })
    return next(e)
  })

  on('tool.call', { tool: 'mcp__tailscale__tailscale_get' }, async ($, e) => {
    const key = await $.env.get('TS_API_KEY')
    const fields = Array.isArray(e.fields) ? e.fields.filter((f): f is string => typeof f === 'string') : undefined
    const { text, isError } = await call((url, init) => $.http.fetch(url, init), key, {
      method: 'GET',
      path: e.path,
      redact: true,
      fields,
    })
    return isError ? { result: text, isError: true as const } : { result: text }
  })

  on('tool.call', { tool: 'mcp__tailscale__tailscale_write' }, async ($, e) => {
    const method = String(e.method).toUpperCase()
    if (!(WRITE_METHODS as readonly string[]).includes(method)) {
      return { deny: `Método inválido: ${method}. Use ${WRITE_METHODS.join(', ')}.` }
    }
    const key = await $.env.get('TS_API_KEY')
    const ifMatch = typeof e.ifMatch === 'string' ? e.ifMatch : undefined
    const { text, isError } = await call((url, init) => $.http.fetch(url, init), key, {
      method,
      path: e.path,
      body: e.body,
      ifMatch,
    })
    return isError ? { result: text, isError: true as const } : { result: text }
  })
}
