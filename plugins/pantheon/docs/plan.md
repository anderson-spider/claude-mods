# Pantheon Mod Implementation Plan

> 2026-10-08: flightdeck was absorbed into the Pantheon panel and removed from the marketplace. `/pantheon` now opens automatically with Agents and Jobs tabs; `/pantheon close` closes it. The original plan below is preserved as history; see [the panel design](../../../docs/superpowers/specs/2026-10-08-pantheon-panel-design.md) for the replacement.

> 2026-10-08: the superpowers integration described below was replaced by the `grill`, `execute`, `debug` and `finish` skills; see [the skills design](../../../docs/superpowers/specs/2026-10-08-pantheon-skills-design.md). This document is preserved as history.

> Design record from the original repository (`anderson-spider/claude-workflow-codex`, PR #4). Paths cited here moved: tests are in `tests/`, not `hooks/*.test.ts`, and the API types come from `.claude-plugin/types/` instead of `vendor/`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transformar este repositório no mod `pantheon` do Claude Code: orchestrator no
estilo oh-my-opencode-slim, especialistas Codex via `delegate` e especialistas Claude
nativos via Agent tool.

**Architecture:** Plugin de function hooks (`hooks/register.tsx`) que registra
ferramentas (`delegate`, `delegate_result`, `delegate_cancel`), agentes nativos
(`pantheon:*`), uma seção de system prompt e um painel. A lógica fica em módulos puros
e testáveis (config, roles, workspace, codex, jobs, prompts); `register.tsx` e
`pane.tsx` só ligam esses módulos aos eventos do engine.

**Tech Stack:** TypeScript sem dependências, API de mods do Claude Code 2.1.295
(`claude-code`, `claude-code/testing`), `codex-cli` ≥ 0.161, `claude plugin test`,
`claude plugin validate`, `tsc` 5.9.

**Spec:** `docs/superpowers/specs/2026-10-08-pantheon-mod-design.md` (revisão 4).
Toda tarefa lê a seção do spec indicada nela.

## Global Constraints

- Zero dependências de runtime; nenhum `package.json` com `dependencies`.
- Módulos de `hooks/` não importam Node (`fs`, `child_process`, `path`): todo I/O vem
  por parâmetro (funções injetadas) ou por `$`.
- Nome do plugin: `pantheon`. Ferramentas: `mcp__pantheon__delegate`,
  `mcp__pantheon__delegate_result`, `mcp__pantheon__delegate_cancel`. Agentes:
  `pantheon:oracle`, `pantheon:designer`, `pantheon:councillor-<seat>`.
- Sandboxes aceitos: `read-only`, `workspace-write`. `danger-full-access` é recusado
  em qualquer lugar.
- Todo argv de `codex exec` contém `-c sandbox_workspace_write.writable_roots=[]` e
  `--ignore-rules`; em `resume`, as opções de `exec` vêm antes do subcomando.
- Padrões: explorer/librarian/fixer `gpt-6-luna`; sandbox explorer e librarian
  `read-only`, fixer `workspace-write`; oracle `opus`; designer `inherit`;
  `sandboxCap` `workspace-write`; `noNetwork` false; `foregroundMinutes` 5.
- Gatilho de council só para `e.origin.kind` ∈ {`composer`, `bridge`}.
- Textos de prompt adaptados do oh-my-opencode-slim (MIT,
  `~/dev/tools/oh-my-opencode-slim` @ `73739208`); crédito no README.
- Commits em Conventional Commits, em inglês, sem menção a IA.
- Papéis Codex não commitam (`.git` é somente leitura em `workspace-write`): nas frentes
  Codex, quem commita é o orchestrator desta sessão. Tudo chega à
  `andersonsilva/pantheon-mod` por cherry-pick.

## Review Focus

1. Config do projeto tentando afrouxar a do usuário (`sandboxCap: "workspace-write"`
   sobre `read-only` do usuário) → o efetivo continua `read-only`. Teste em Task 3.
2. `cwd` que é symlink apontando para fora da raiz → recusado. Teste em Task 3.
3. Codex que encerra com código ≠ 0 sem nenhuma `agent_message` e stderr vazio → job
   `error` com mensagem útil ("codex saiu com código N"), nunca `done` vazio. Teste em
   Task 5.
4. Linha JSONL partida entre dois pedaços do stream (o spawn entrega texto, não linhas)
   → o evento é lido inteiro uma vez só. Teste em Task 4.
5. Mensagem do usuário que cita `council` só dentro de bloco de código ou que começa
   com `/` → não injeta Council Mode. Teste em Task 6.

---

## Fase 0 — Spike (orchestrator, nesta sessão, descartável)

### Task 0: Validar as suposições de runtime

Mod mínimo e descartável em
`/Users/andersonsilva/.claude/dev-mods/87f39a1a-f2e1-4931-b880-bd4abf7a1fdc/pantheon-spike/`
(fora do repositório; não é commitado). Responde três perguntas antes de qualquer
código definitivo.

**Files:**
- Create: `pantheon-spike/.claude-plugin/plugin.json`, `pantheon-spike/hooks/hooks.json`,
  `pantheon-spike/hooks/register.ts`, `pantheon-spike/hooks/spike.test.ts`

- [ ] **Step 1: Escrever o mod.** `register.ts` registra no `session.start` a ferramenta
  `spike_wait({ seconds: number, foregroundSeconds: number })` com `isDeferred: false`.
  O hook `tool.call` roda `$.process.spawn({ argv: ['sleep', String(seconds)] })` num
  loop; se `foregroundSeconds` passar antes do fim, devolve `{ status: 'background' }`
  e deixa o loop seguir desacoplado (`void (async () => …)()`), chamando
  `$.prompt.submit({ text: 'spike: background terminou' })` ao fim. Medir o tempo com
  `$.clock.now()`.
- [ ] **Step 2: Escrever `spike.test.ts`** com um teste que registra no `on` do teste um
  hook `process.spawn` (geradora) que emite `{ stream: 'stdout', text: '{"type":"thread.started","thread_id":"t1"}\n' }`
  e termina com `{ code: 0, signal: null }`, chama `$.tool.call` do `spike_wait` e
  verifica que (a) a geradora foi chamada com `argv` `['sleep', '<seconds>']` e (b) a
  resposta traz o `thread_id` `t1`, que só o fake produz. Rodar:
  `claude plugin test <pasta do spike>`.
- [ ] **Step 3: Carregar com hot reload** (aceitar o "Enable hot reloading for this
  session?" quando o usuário responder) e pedir ao modelo nesta sessão:
  `spike_wait({ seconds: 360, foregroundSeconds: 400 })` (foreground longo) e depois
  `spike_wait({ seconds: 60, foregroundSeconds: 10 })` (vira background).
- [ ] **Step 4: Rodar `claude plugin test` de dentro de um Codex `workspace-write`**
  (pane herdr temporário) para saber se as frentes conseguem rodar os testes.
- [ ] **Step 5: Registrar o resultado** num comentário de topo do plano (seção
  "Resultado da Task 0" abaixo), com sim/não e evidência para:
  1. foreground de 6 minutos completa sem o engine abandonar a chamada;
  2. o loop desacoplado sobrevive e o `prompt.submit` acorda a sessão;
  3. o hook `process.spawn` do teste substitui o spawn real;
  4. `claude plugin test` funciona dentro do sandbox do Codex.
- [ ] **Step 6: Decidir.** Se 1 ou 2 falhar: parar e revisar o spec com o usuário. Se 3
  falhar: a Task 5 já recebe `spawn` injetável e testa com fake; a Task 7 troca o
  teste de integração "delegate runs codex through process.spawn hook" por um teste
  com o `spawn` do `createJobs` substituído via uma fábrica exportada
  (`createRuntime(deps)` em `register.tsx`). Se 4 falhar: as frentes
  rodam só `tsc` e eu rodo `claude plugin test` na integração de cada frente.

#### Resultado da Task 0

Executada em 2026-10-08 com Claude Code 2.1.295 e codex-cli 0.161/0.162.

1. **Foreground longo: sim.** `spike_wait(360, 400)` respondeu `done` em 360013 ms dentro
   do `tool.call`; o engine não abandonou a chamada.
2. **Loop desacoplado + `prompt.submit`: sim.** `spike_wait(30, 10)` respondeu
   `background` em 10 s; 30 s depois o aviso `spike: background terminou após 30 s`
   chegou como um turno novo, com a sessão ociosa.
3. **Hook `process.spawn` do teste substitui o real: sim.** O teste viu o argv
   `['sleep', '7']` e o `thread_id` `t1` que só o fake produz.
4. **`claude plugin test` dentro do sandbox do Codex: sim**, com
   `codex sandbox -P :workspace -C <pasta> -- claude plugin test .` (1 pass).

Decisão: frentes Codex no herdr, como planejado; nenhum fallback necessário.

Regras do runtime descobertas (valem para todas as tasks):

- O `result` de um `tool.call` de plugin precisa ser **string** (ou lista de blocos);
  um objeto é recusado ("does not match its output shape"). `delegate`,
  `delegate_result` e `delegate_cancel` devolvem texto.
- Num teste, todo `$.clock` exige `mock.clock(on)`; sem ele, "no implementation for
  clock.now".
- Um hook geradora de `process.spawn` no teste encerra com
  `return { value: { code, signal } }` (não `{ code, signal }`).
- O argumento do `tool.call` chega achatado no `e` (`e.seconds`, não `e.input.seconds`).
- O mod recarrega só no fim do turno que editou os arquivos.

---

## Fase 1 — Fundação (orchestrator, branch `andersonsilva/pantheon-mod`)

### Task 1: Remover o runner e criar o esqueleto do mod

**Files:**
- Delete: `runner/`, `bin/`, `examples/`, `references/`, `SKILL.md`,
  `scripts/sync-skill.js`, `docs/*.png` e demais arquivos de `docs/` fora de
  `docs/superpowers/`, `.claude/agents/`, `package.json`, `package-lock.json` (se
  existir), conteúdo atual de `.claude-plugin/`
- Move: `docs/superpowers/fixtures/codex-exec-sample.jsonl` →
  `hooks/fixtures/codex-exec-sample.ts` (`export const CODEX_EXEC_SAMPLE = \`...\``,
  conteúdo idêntico; importável pelos testes sem `$.fs`)
- Create: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`,
  `hooks/hooks.json`, `hooks/register.tsx` (stub), `types/index.d.ts`,
  `hooks/types.ts`, `hooks/defaults.ts`, `tsconfig.json`, `hooks/smoke.test.ts`,
  `vendor/claude-code/` (tipos da API copiados), `.gitignore` (com
  `.claude-plugin/types/`)

**Interfaces:**
- Produces: `hooks/types.ts` (abaixo) e `hooks/defaults.ts` com
  `DEFAULT_CONFIG: PantheonConfig` (valores exatos do exemplo de config do spec:
  `sandboxCap` `workspace-write`, `noNetwork` false, `foregroundMinutes` 5,
  `disabledAgents` [], agents e seats `alpha`/`beta` como no spec) — o contrato que as
  cinco frentes usam.

- [ ] **Step 1: Apagar os caminhos listados** com `git rm -r` e mover a fixture com
  `git mv`.
- [ ] **Step 2: Criar os manifestos.** `plugin.json`:
  `{ "name": "pantheon", "version": "0.1.0", "description": "Orchestrator with Codex and Claude specialists, inspired by oh-my-opencode-slim", "types": "./types/index.d.ts" }`.
  `marketplace.json` com uma entrada `pantheon` de `source` `./`. `hooks.json`:
  `{ "modules": ["./register.tsx"] }`.
- [ ] **Step 3: Escrever `hooks/types.ts`:**

```ts
export type Sandbox = 'read-only' | 'workspace-write'
export type CodexRole = 'explorer' | 'librarian' | 'fixer'
export type NativeRole = 'oracle' | 'designer'
export interface RoleOverride { model?: string; effort?: string; prompt?: string; sandbox?: Sandbox }
export interface Seat { engine: 'codex' | 'claude'; model?: string; effort?: string; prompt?: string }
export interface PantheonConfig {
  sandboxCap: Sandbox
  noNetwork: boolean
  foregroundMinutes: number
  disabledAgents: string[]
  agents: Record<CodexRole | NativeRole, RoleOverride>
  council: { seats: Record<string, Seat> }
}
export type Origin = 'default' | 'user' | 'project'
export type ConfigResult =
  | { ok: true; config: PantheonConfig; origins: Record<string, Origin> }
  | { ok: false; error: string; config: PantheonConfig }
export interface DelegateArgs {
  agent: string; prompt: string; description?: string; cwd?: string
  model?: string; effort?: string; background?: boolean; resume?: string
}
export interface CodexCall {
  agent: string; model?: string; effort?: string; sandbox: Sandbox; noNetwork: boolean
  prompt: string; cwd: string; skipGitRepoCheck: boolean; resumeSessionId?: string
}
export type JobStatus = 'running' | 'background' | 'done' | 'error' | 'cancelled' | 'lost'
export interface Tokens { input: number; cached: number; output: number }
export interface Job {
  id: string; agent: string; description?: string; model?: string; status: JobStatus
  startedAt: number; endedAt?: number; cwd: string; sessionId?: string
  lastActivity?: string; tokens?: Tokens; result?: string; error?: string
}
export type CodexEvent =
  | { kind: 'session'; sessionId: string }
  | { kind: 'activity'; text: string }
  | { kind: 'message'; text: string }
  | { kind: 'usage'; tokens: Tokens }
  | { kind: 'failed'; error: string }
export type SpawnChunk = { stream: 'stdout' | 'stderr'; text: string }
export type SpawnEnd = { code: number | null; signal?: string | null }
export type Spawn = (req: { argv: string[]; cwd: string; input: string }) =>
  AsyncIterable<SpawnChunk> & { result: Promise<SpawnEnd>; return?: () => unknown }
export type ReadFile = (path: string) => Promise<string | undefined>
export interface Clock {
  now: () => Promise<number>
  after: (ms: number, fn: () => void) => { cancel: () => void }
}
export interface Codec {
  buildArgv: (call: CodexCall) => string[]
  createJsonlReader: () => { push(text: string): CodexEvent[]; end(): CodexEvent[] }
}
export type PromptKey = CodexRole | NativeRole | 'councillor'
export type RolePrompts = (key: PromptKey) => string
export type StatReal = (path: string) => Promise<string | undefined> // realPath ou undefined
```

- [ ] **Step 4: Escrever `types/index.d.ts`** declarando em `interface PluginState` a
  chave `pantheon` com `{ jobs: Job[] }` (importando `Job` de `../hooks/types`), e o
  stub `register.tsx` exportando `register: Register` vazio.
- [ ] **Step 5: Escrever `hooks/smoke.test.ts`:** `test('types load', () => { expect(1).toBe(1) })`
  importando `../hooks/types` sem erro.
- [ ] **Step 6: Vendorizar os tipos.** Carregar o mod uma vez nesta sessão (hot reload)
  para o engine gerar `.claude-plugin/types/`; copiar `claude-code/index.d.ts` e
  `claude-code-tools/index.d.ts` de lá para `vendor/claude-code/` e anotar a versão do
  Claude Code (2.1.295) num `vendor/claude-code/VERSION`. `tsconfig.json` próprio
  (`strict`, `noEmit`, `jsx` conforme o `tsconfig.json` gerado, `paths` mapeando
  `claude-code` e `claude-code/testing` para `vendor/claude-code/`), sem depender de
  arquivo gerado. Assim `tsc -p .` funciona em qualquer worktree e na CI.
- [ ] **Step 7: Verificar.** Run: `claude plugin validate . && claude plugin test . && tsc -p .`
  Expected: validate sem erros; 1 teste passando; tsc sem erros.
- [ ] **Step 8: Commit:** `chore: replace runner with pantheon mod skeleton`

---

## Fase 2 — Frentes Codex em paralelo (herdr)

Cada frente roda num pane herdr, Codex padrão com `-s workspace-write -a never`, num
worktree próprio criado a partir do commit da Task 1:
`git worktree add ../pantheon-task<N> -b andersonsilva/pantheon-task<N>` (N = 2…6).
As cinco frentes começam juntas. O prompt
de cada frente contém: o caminho do plano e do spec, a task inteira, a lista de
arquivos permitidos, o comando de teste (`claude plugin test .`, que roda todos os
`*.test.ts` da pasta; não há filtro por arquivo) e o formato de relatório
`<summary>/<changes>/<verification>`. Executor (decidido na Task 0): Codex no herdr
(não commita; o orchestrator revisa e commita no worktree da frente) ou subagente
Claude com `isolation: worktree` (commita sozinho; o orchestrator revisa). Em ambos os
casos o orchestrator leva o commit para a `andersonsilva/pantheon-mod` com
`git cherry-pick <sha>`, um por tarefa, na ordem 2, 3, 4, 5, 6, e roda
`claude plugin test .` depois de cada um.

### Task 2 (frente 1): config

**Files:** Create `hooks/config.ts`, Test `hooks/config.test.ts`. Spec: "Configuração".

**Interfaces:**
- Consumes: `PantheonConfig`, `ConfigResult`, `ReadFile` de `hooks/types.ts`.
- Consumes também: `DEFAULT_CONFIG` de `hooks/defaults.ts`.
- Produces:
  - `loadConfig(read: ReadFile, paths: { user: string; project?: string }, lastValid?: PantheonConfig): Promise<ConfigResult>`

- [ ] **Step 1: Testes que falham:**

```ts
test('defaults when no files', async () => {
  const r = await loadConfig(async () => undefined, { user: 'u' })
  expect(r.ok).toBe(true); expect(r.config.sandboxCap).toBe('workspace-write')
  expect(r.config.agents.fixer.model).toBe('gpt-6-luna')
})
test('project cannot loosen user cap', async () => {
  const files = { u: '{"sandboxCap":"read-only","noNetwork":true}', p: '{"sandboxCap":"workspace-write","noNetwork":false}' }
  const r = await loadConfig(async f => files[f], { user: 'u', project: 'p' })
  expect(r.config.sandboxCap).toBe('read-only'); expect(r.config.noNetwork).toBe(true)
})
test('project overrides functional fields; disabledAgents is a union', ...)  // foregroundMinutes do projeto vence; ['oracle'] ∪ ['council']
test('danger-full-access is rejected', ...)  // ok:false, error cita danger-full-access
test('invalid JSON keeps lastValid', ...)    // ok:false, config === lastValid
test('unknown field is an error', ...)       // {"agents":{"fixer":{"modle":"x"}}} → ok:false
test('origins report where each field came from', ...) // origins['foregroundMinutes'] === 'project'
```

- [ ] **Step 2:** Run `claude plugin test .` → FAIL em `config.test.ts` (módulo inexistente).
- [ ] **Step 3: Implementar `loadConfig`.** Merge em três camadas (padrão, usuário,
  projeto); `sandboxCap` pela ordem `read-only` < `workspace-write` (vence o mais
  restritivo); `noNetwork` por OR; `disabledAgents` por união; demais campos por
  sobrescrita profunda. Validação manual (sem biblioteca): chaves conhecidas, tipos,
  domínios; seats com `engine` obrigatório. Em erro, `config` é `lastValid` ou, sem
  ela, `DEFAULT_CONFIG`; isso só alimenta prompt e agentes nativos, porque `delegate`
  recusa enquanto `ok:false` (Task 7).
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Relatório; o orchestrator commita `feat(config): load and merge pantheon config`.

### Task 3 (frente 2): roles e workspace

**Files:** Create `hooks/roles.ts`, `hooks/workspace.ts`; Test `hooks/roles.test.ts`,
`hooks/workspace.test.ts`, `hooks/offer.test.ts`. Spec: "Papéis", "Workspace",
"Ferramenta delegate".

**Interfaces:**
- Consumes: `PantheonConfig`, `DelegateArgs`, `CodexCall`, `Sandbox`, `StatReal`,
  `RolePrompts`.
- Produces:
  - `CODEX_ROLES: CodexRole[]`, `NATIVE_ROLES: NativeRole[]`
  - `resolveCodexCall(config: PantheonConfig, args: DelegateArgs, ctx: { cwd: string; skipGitRepoCheck: boolean; resumeSessionId?: string }, prompts: RolePrompts): CodexCall | { error: string }`
    (`councillor:<seat>` usa `prompts('councillor')`)
  - `nativeAgentSpecs(config: PantheonConfig, prompts: RolePrompts): Array<{ name: string; description: string; prompt: string; model?: string; effort?: string; tools?: string[] }>`
    — `name` é o nome curto (`oracle`, `designer`, `councillor-<seat>`); o engine
    forma `pantheon:<name>`
  - `isOffered(config: PantheonConfig, agentType: string): boolean`
  - `authorizedRoot(sessionCwd: string, gitTopLevel: string | undefined): string`
  - `checkCwd(statReal: StatReal, root: string, cwd: string): Promise<string | { error: string }>`

- [ ] **Step 1: Testes que falham** (porta dos casos de sandbox de
  `runner/test/offline.js`, consultados no histórico com `git show HEAD~1:runner/test/offline.js`):

```ts
test('role sandbox capped by sandboxCap', () => {
  const c = { ...DEFAULT_CONFIG, sandboxCap: 'read-only' }
  const r = resolveCodexCall(c, { agent: 'fixer', prompt: 'x' }, ctx)
  expect(r.sandbox).toBe('read-only')
})
test('call model/effort win over role', ...)          // model 'gpt-x' → call.model === 'gpt-x'
test('native role in delegate is refused with instruction', ...) // error contém 'pantheon:oracle' e 'Agent'
test('disabled or unknown agent lists valid ones', ...)
test('codex seat resolves; claude seat is refused', ...) // 'councillor:alpha' ok, 'councillor:beta' erro → 'pantheon:councillor-beta'
test('codex seat is always read-only', ...)
test('role prompt + config prompt + task prompt order', ...)
// workspace.test.ts
test('cwd inside root is accepted', ...)
test('symlink resolving outside root is refused', async () => {
  const stat = async (p: string) => p === '/repo/link' ? '/etc' : p
  expect(await checkCwd(stat, '/repo', '/repo/link')).toEqual({ error: expect.stringContaining('fora') })
})
test('prefix trick /repo2 is not inside /repo', ...)
// offer.test.ts
test('disabled native, removed seat or disabled council is not offered', ...)
test('non-pantheon agents are always offered', ...)
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implementar.** `resolveCodexCall` monta `prompt` como
  `prompts(key) + (override.prompt ? '\n\n' + override.prompt : '') + '\n\n---\n\n' + args.prompt`;
  nos testes `prompts` é um fake (`k => '<' + k + '>'`); a integração passa
  `rolePrompt` da Task 6. `checkCwd` compara por segmento
  (`root + '/'`), nunca por prefixo de string.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Relatório; commit `feat(roles): resolve codex calls, native specs and workspace`.

### Task 4 (frente 3): codex argv e parser

**Files:** Create `hooks/codex.ts`; Test `hooks/codex.test.ts`. Spec: "Fluxo de uma
delegação" (passos 3–4), "Workspace".

**Interfaces:**
- Consumes: `CodexCall`, `CodexEvent`, `Tokens`.
- Produces:
  - `buildArgv(call: CodexCall): string[]`
  - `createJsonlReader(): { push(text: string): CodexEvent[]; end(): CodexEvent[] }`
  - `parseEvent(obj: unknown): CodexEvent[]`

- [ ] **Step 1: Testes que falham:**

```ts
test('new run argv', () => {
  expect(buildArgv({ ...base, model: 'm', effort: 'high', noNetwork: true })).toEqual([
    'codex','exec','--json','-s','workspace-write','-m','m',
    '-c','model_reasoning_effort=high',
    '-c','sandbox_workspace_write.writable_roots=[]',
    '-c','sandbox_workspace_write.network_access=false',
    '--ignore-rules','-'])
})
test('resume puts exec options before the subcommand', ...) // termina com ['resume','sess-1','-'] e '-s' aparece antes de 'resume'
test('skip-git-repo-check only when asked', ...)
test('writable_roots and ignore-rules always present', ...)
test('fixture yields session, activity, message and usage', () => {
  const r = createJsonlReader(); const ev = r.push(CODEX_EXEC_SAMPLE)
  expect(ev[0]).toEqual({ kind: 'session', sessionId: '01a11cfa-fdc8-7b61-a3ff-779df92a9d86' })
  expect(ev.filter(e => e.kind === 'message').at(-1)).toEqual({ kind: 'message', text: '3' })
  expect(ev.at(-1)).toEqual({ kind: 'usage', tokens: { input: 52107, cached: 25344, output: 68 } })
})
test('line split across chunks is read once', ...)        // Review Focus 4
test('unknown item type becomes generic activity', ...)
test('turn.failed and error become failed', ...)
test('non-JSON line is ignored', ...)
```

  A fixture vem de `import { CODEX_EXEC_SAMPLE } from './fixtures/codex-exec-sample'`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implementar.** Atividade de `command_execution`: `"$ <command>"`
  (com ` → <exit_code>` no `item.completed`); `agent_message` gera `message`; outros
  itens geram `activity` com o `type`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Relatório; commit `feat(codex): build exec argv and parse json events`.

### Task 5 (frente 4): jobs

**Files:** Create `hooks/jobs.ts`; Test `hooks/jobs.test.ts`. Spec: "Fluxo de uma
delegação" (passos 2, 5–7), "Ferramenta delegate".

**Interfaces:**
- Consumes: `Spawn`, `Clock`, `CodexCall`, `Job`, `Codec` de `hooks/types.ts` (não
  importa `hooks/codex.ts`: a Task 4 roda em paralelo).
- Produces:
  - `createJobs(deps: { spawn: Spawn; clock: Clock; codec: Codec; newId: () => string; onChange: (jobs: Job[]) => void; notify: (text: string) => void; initial?: Job[] })`
    — os testes usam um `Codec` falso (argv fixo, reader que converte linhas `ev:<json de CodexEvent>`)
    retornando
    `{ run(call: CodexCall, opts: { foregroundMs: number; background: boolean; signal?: AbortSignal; description?: string }): Promise<{ job: Job; outcome: 'done' | 'error' | 'background' | 'cancelled' }>; get(id: string): Job | undefined; cancel(id: string): Job | { error: string }; resumeTarget(id: string): { sessionId: string; cwd: string; agent: string } | { error: string }; list(): Job[] }`
  - `markLost(jobs: Job[]): Job[]`

- [ ] **Step 1: Testes que falham** (spawn falso controlado pelo teste; `Clock` falso
  em memória com `advance(ms)` que dispara os `after` vencidos):

```ts
test('finishes in foreground with final message and sessionId', ...)
test('exceeds foregroundMs -> background, then notify on finish', ...) // notify chamado 1x com texto contendo job.id e 'delegate_result'
test('background:true returns immediately', ...)
test('non-zero exit with no message -> error with code', ...)          // Review Focus 3: error contém 'código 2'
test('non-zero exit after a message -> error, message kept in result', ...)
test('turn.failed then exit 0 -> error', ...)
test('exit 0 without agent_message -> error', ...)
test('error includes the last stderr lines', ...)
test('resumeTarget: unknown, still active, without sessionId -> error', ...)
test('resumeTarget: done/cancelled/lost with sessionId -> sessionId, cwd, agent', ...)
test('cancel kills process and marks cancelled', ...)                  // return() do iterável chamado
test('abort signal in foreground kills process', ...)
test('markLost turns running and background into lost, keeps sessionId', ...)
test('onChange receives every status transition', ...)
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implementar.** Corrida entre o fim do loop e `clock.after(foregroundMs)`
  (cancelado se o loop terminar antes). Em produção `Clock` é `$.clock` adaptado
  (Task 7). Mensagem de `notify`:
  `"pantheon: job <id> (<agent>) terminou com <status>; use delegate_result({ jobId: '<id>' })."`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Relatório; commit `feat(jobs): run codex jobs with foreground and background`.

### Task 6 (frente 5): prompts

**Files:** Create `hooks/prompts/roles.ts`, `hooks/prompts/orchestrator.ts`,
`hooks/prompts/council.ts`, `hooks/prompts/superpowers.ts`; Test
`hooks/prompts/orchestrator.test.ts`, `hooks/prompts/council.test.ts`,
`hooks/prompts/superpowers.test.ts`. Spec: "System prompt do orchestrator", "Prompts
dos papéis", "Council", "Integração com superpowers". Fontes:
`~/dev/tools/oh-my-opencode-slim/src/agents/{orchestrator,role-routing,role-prompts,council}.ts`,
`src/hooks/council-inject/index.ts`.

**Interfaces:**
- Consumes: `PantheonConfig`.
- Produces:
  - `rolePrompt: RolePrompts` (de `hooks/types.ts`)
  - `buildOrchestratorSection(config: PantheonConfig): string`
  - `matchesCouncilTrigger(text: string): boolean`
  - `isCouncilOrigin(kind: string | undefined): boolean`
  - `buildCouncilBlock(config: PantheonConfig): string`
  - `buildSuperpowersBlock(config: PantheonConfig): string` (incluído por
    `buildOrchestratorSection`)

- [ ] **Step 1: Testes que falham:**

```ts
test('section lists active roles with how to call them', () => {
  const s = buildOrchestratorSection(DEFAULT_CONFIG)
  expect(s).toContain('delegate'); expect(s).toContain('pantheon:oracle')
  expect(s).toContain('@explorer'); expect(s).toContain('@fixer')
})
test('disabled role disappears from blocks and parallel examples', ...)
test('same config -> same bytes', () => {
  expect(buildOrchestratorSection(DEFAULT_CONFIG)).toBe(buildOrchestratorSection(DEFAULT_CONFIG))
})
test('no opencode-only vocabulary', ...) // not.toContain task_revive, wait_for_user, `question` tool, marketplace, task_message
test('every role prompt ends with the report-format override line', ...)
// council.test.ts
test('triggers EN and PT', ...)          // 'run a council', 'second opinion', 'quero consenso', 'segunda opinião', 'conselho'
test('ignores code fences, inline code and slash commands', ...) // Review Focus 5
test('origin allowlist', () => {
  expect(isCouncilOrigin('composer')).toBe(true); expect(isCouncilOrigin('bridge')).toBe(true)
  expect(isCouncilOrigin('sdk')).toBe(false); expect(isCouncilOrigin(undefined)).toBe(false)
})
test('block dispatches each seat by engine and keeps synthesis format', ...) // 'councillor:alpha' com background:true; 'pantheon:councillor-beta' com run_in_background; '## Council Response', '## Per-Councillor Details', '## Council Summary'
test('disabled council -> empty block and no seat line', ...)
// superpowers.test.ts
test('maps implementer to fixer and one task reviewer per gate to oracle', ...)
test('executing-plans is an explicit exception', ...)
test('implementer dispatch says commits are the orchestrator job', ...)
test('disabled role line disappears', ...)
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implementar** adaptando os textos do slim conforme a tabela da seção
  "System prompt do orchestrator" do spec (manter / adaptar / remover). Regex de
  gatilho: a do `council-inject` + `conselho|consenso|segunda opini[aã]o`. Linha final
  dos prompts de papel: `"Se a tarefa definir um formato de relatório, ele substitui o formato acima."`.
  Seção alvo ~100 linhas.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Relatório; commit `feat(prompts): orchestrator, roles, council and superpowers`.

---

## Fase 3 — Integração (orchestrator)

### Task 7: register.tsx

**Files:** Modify `hooks/register.tsx`; Test `hooks/register.test.ts`. Spec:
"Ferramenta delegate", "Papéis", "Council", "Configuração".

**Interfaces:**
- Consumes: todas as Produces das Tasks 2–6.

- [ ] **Step 1: Conferir os cherry-picks** das Tasks 2–6 na `andersonsilva/pantheon-mod`
  (`git log --oneline` mostra os cinco commits); rodar `claude plugin test . && tsc -p .` → PASS.
- [ ] **Step 2: Testes que falham:**

```ts
test('session.start registers tools and native agents', ...)   // 3 ferramentas; agent.register recebeu name 'oracle', 'designer', 'councillor-beta'
test('delegate refuses while config is invalid', ...)
test('delegate runs codex through process.spawn hook and returns final message', ...)
test('prompt.compose appends the orchestrator section last', ...)
test('prompt.submit injects council block only for composer/bridge with trigger', ...)
test('agent.offer hides disabled pantheon agents and fails closed', ...) // hook que lança → isOffered false
test('agent.offer guard over budget -> pantheon:* hidden, others offered', { timeoutMs: 20000 }, ...) // guarda presa > 10 s
test('resume: unknown job, active job, no sessionId -> error', ...)
test('resume ignores a new cwd and reuses the stored one', ...)
test('resume recomputes sandbox with a stricter current policy', ...)
test('resume revalidates the stored cwd before spawning', ...)
test('session.start marks leftover running/background jobs as lost', ...)
test('valid config change re-registers native agents; invalid change does not', ...)
test('skipGitRepoCheck is true only when git rev-parse fails', ...)
```

- [ ] **Step 3: Implementar** ligando (o `Codec` de produção é
  `{ buildArgv, createJsonlReader }` de `hooks/codex.ts`): `session.start` (carrega config, `markLost`,
  registra ferramentas com `isDeferred: false` e agentes nativos), `tool.call` das três
  ferramentas (raiz por `git rev-parse --show-toplevel` via `$.process.run`; `checkCwd`
  via `$.fs.stat(p, { resolve: true })`; spawn via `$.process.spawn`; notify via
  `$.prompt.submit`; estado via `$.state`), `prompt.compose`, `prompt.submit`,
  `agent.offer` com `.catch(() => ({ isOffered: false }))` para `pantheon:*`.
  `delegate` com `resume`: `jobs.resumeTarget(jobId)` → recusa `cwd` do argumento →
  `checkCwd` no `cwd` gravado → `resolveCodexCall` com a config atual e
  `resumeSessionId`. `Clock` de produção: `{ now: () => $.clock.now(), after: (ms, fn) => $.clock.after(ms, fn) }`
  (ajustar à assinatura de `TimerCall`). No
  `prompt.compose`, se a config mudou e é válida, re-registrar os agentes nativos.
- [ ] **Step 4:** Run `claude plugin test . && claude plugin validate . && tsc -p .` → PASS.
- [ ] **Step 5:** Commit `feat: wire pantheon hooks`.

### Task 8: painel e comandos

**Files:** Create `hooks/pane.tsx`; Modify `hooks/register.tsx`; Test
`hooks/pane.test.ts`. Spec: "Painel e comandos".

> Nota (2026-10-08): o plano abaixo é histórico. Desde a 0.2.0 o painel `/pantheon` mostra
> só as ações sobre os jobs Codex (uma linha curta por job, com Cancelar e Copiar
> resposta) e não lista os agentes nativos `pantheon:*`; modelo, tempo, tokens e
> atividade passaram para o flightdeck, que lê `pantheon.jobs` de `$.state`. A status
> line segue igual.

- [ ] **Step 1: Testes que falham** (loop em `['terminal', 'desktop'] as const`):

```ts
test('pane lists codex jobs with status, model and resumable flag', ...)
test('cancel button cancels a running job', ...)
test('native pantheon agents appear without buttons', ...)
test('status line counts running and background, clears when none', ...)
test('/pantheon config shows origins and current error', ...)
test('/pantheon doctor reports codex, login and config', ...)
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implementar** com `$.ui.open`/`ui.render` `Pane`, `$.ui.status`,
  `$.command.register` (`pantheon`, com subcomandos por argumento), `$.ui.copy`,
  `$.agent.list` filtrado por `pantheon:`. Base: o exemplo `examples/pane.tsx` da skill
  plugin-authoring.
- [ ] **Step 4:** Run `claude plugin test . && tsc -p .` → PASS.
- [ ] **Step 5:** Commit `feat: add /pantheon pane and commands`.

### Task 9: docs, CI e validação manual

**Files:** Rewrite `README.md`, `CONTRIBUTING.md`, `.github/workflows/ci.yml`.

- [ ] **Step 1: README** em português: o que é, instalação
  (`/plugin install pantheon --marketplace anderson-spider/<repo>`), papéis, config
  com o exemplo do spec, council, superpowers, segurança (teto, `--ignore-rules` e seu
  custo, `writable_roots`), crédito MIT ao oh-my-opencode-slim.
- [ ] **Step 2: CI:** `tsc -p .`, `claude plugin validate .` e `claude plugin test .`
  quando o `claude` rodar sem login no runner; senão só os dois primeiros e o
  CONTRIBUTING exige `claude plugin test .` local. Testar no próprio PR.
- [ ] **Step 3: Validação manual nesta sessão** (hot reload): explorer read-only com
  Codex real; fixer que edita um arquivo de rascunho; `foregroundMinutes: 0.1` força
  background e o aviso chega; `delegate_cancel`; council com um seat de cada engine;
  `pantheon:oracle` pelo Agent tool; `/pantheon` e `/pantheon doctor`.
- [ ] **Step 4:** Commit `docs: rewrite readme and ci for pantheon`.

---

## Fase 4 — Revisão final

### Task 10: revisão do branch por Codex read-only (herdr)

- [ ] **Step 1:** Pane herdr com Codex padrão `-s read-only -a never`; prompt: revisar
  `git diff main...andersonsilva/pantheon-mod` contra o spec e este plano, com achados
  numerados (severidade, arquivo:linha, correção).
- [ ] **Step 2:** Aplicar só os achados com que o orchestrator concorda; registrar os
  demais com o motivo no relatório ao usuário.
- [ ] **Step 3:** `claude plugin test . && claude plugin validate . && tsc -p .` → PASS;
  commit `fix: address final review`.

## Ordem e paralelismo

```
Task 0 → Task 1 → [Task 2] [Task 3] [Task 4] [Task 5] [Task 6]   (paralelo, worktrees)
                → cherry-pick 2, 3, 4, 5, 6 na pantheon-mod
                → Task 7 → Task 8 → Task 9 → Task 10
```

As cinco frentes não compartilham arquivos; só leem `hooks/types.ts` e
`hooks/defaults.ts` (congelados depois da Task 1 — mudança neles passa pelo
orchestrator e é propagada a todas as frentes ainda abertas).
