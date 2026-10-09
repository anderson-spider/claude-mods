# Pantheon: mod do Claude Code no estilo oh-my-opencode-slim

> 2026-10-08: flightdeck was absorbed into the Pantheon panel and removed from the marketplace. `/pantheon` now opens automatically with Agents and Jobs tabs; `/pantheon close` closes it. The original design below is preserved as history.

> Design record from the original repository (`anderson-spider/claude-workflow-codex`, PR #4). Paths cited here moved: tests are in `tests/`, not `hooks/*.test.ts`, and the API types come from `.claude-plugin/types/` instead of `vendor/`.

Data: 2026-10-08 · Branch: `andersonsilva/pantheon-mod` · Revisão 4 (após três revisões
independentes do spec)

## Objetivo

Transformar este repositório num mod do Claude Code (plugin de function hooks) chamado
`pantheon`, que reproduz o modelo do oh-my-opencode-slim: a sessão do Claude é o
orchestrator e delega para especialistas. Especialistas Codex rodam via `codex exec` pela
ferramenta `delegate`; especialistas Claude são agentes nativos do plugin, chamados pelo
Agent tool. Sem CLI, sem DSL de workflow, sem viewers.

Critérios de sucesso:

- Com o mod instalado, o Claude decide sozinho quando delegar, guiado por uma seção de
  system prompt adaptada do `orchestrator.ts` do slim.
- Delegações Codex curtas voltam na própria chamada; longas (ou pedidas com
  `background: true`) viram job em background e acordam a sessão ao terminar.
- `/pantheon` mostra as ações sobre os jobs Codex (cancelar, copiar resposta); o detalhe
  dos jobs fica no Flightdeck.
- Uma mensagem do usuário com gatilho de council dispara a consulta em paralelo aos
  conselheiros e a síntese no formato do slim.
- Teto de sandbox preservado e nunca afrouxado por configuração de projeto.

Fora de escopo: fallback de modelo, Observer, limite de concorrência, persistência de jobs
entre sessões, viewers HTML/ASCII, `--frontier`, steer de agente em execução, troca de um
papel entre os grupos Codex e nativo.

## Referências

- oh-my-opencode-slim (MIT), clonado em `~/dev/tools/oh-my-opencode-slim` @ `73739208`:
  `src/agents/orchestrator.ts`, `role-routing.ts`, `role-prompts.ts`, `council.ts`,
  `src/hooks/council-inject/index.ts`, `docs/council.md`. Crédito no README.
- API de mods: tipos do engine (`claude-code.d.ts`) e `reference.md` da skill
  plugin-authoring.
- Amostra real de `codex exec --json` (codex-cli 0.161.0).
- Skills do superpowers 6.4.2 (subagent-driven-development, requesting-code-review,
  dispatching-parallel-agents, executing-plans).

## O que sai do repositório

`runner/`, `bin/`, `examples/`, `references/`, `SKILL.md`, `scripts/sync-skill.js`,
`docs/` (screenshots dos viewers), `.claude/agents/`
(papéis migram para o mod), `package.json` atual (scripts do runner) e o conteúdo atual
de `.claude-plugin/`. `README.md`, `CONTRIBUTING.md` e `.github/workflows/ci.yml` são
reescritos.

Do runner, só a lógica é portada (não o código): teto de sandbox (`roles.js`),
merge de papéis (`agentTypes.js`), precedência de modelo (`modelMap.js`, sem frontier e
sem família→modelo).

## Estrutura

```
.claude-plugin/plugin.json        name "pantheon", types ./types/index.d.ts
.claude-plugin/marketplace.json   o próprio repo como marketplace
hooks/hooks.json                  { "modules": ["./register.tsx"] }
hooks/register.tsx                liga eventos: session.start, tool.call, prompt.compose,
                                  prompt.submit, agent.offer, command.run, ui.render
hooks/config.ts                   padrões + ~/.claude/pantheon.json +
                                  <repo>/.claude/pantheon.json; validação; política de
                                  segurança
hooks/roles.ts                    papéis Codex e nativos; resolução de sandbox/modelo/effort
hooks/workspace.ts                raiz autorizada e validação de cwd
hooks/prompts/orchestrator.ts     seção de system prompt (função pura da config)
hooks/prompts/roles.ts            prompts de cada papel (de role-prompts.ts)
hooks/prompts/council.ts          gatilho + bloco Council Mode
hooks/prompts/superpowers.ts      bloco de integração com superpowers
hooks/codex.ts                    argv do codex exec; parser de JSONL → eventos de job
hooks/jobs.ts                     estado dos jobs Codex, foreground→background, cancelamento
hooks/pane.tsx                    painel /pantheon (só ações) e linha de status
types/index.d.ts                  contrato do $.state (pantheon.jobs)
hooks/fixtures/                   amostras JSONL do codex exec
hooks/*.test.ts                   testes (claude plugin test)
```

## Papéis

Dois grupos fixos. O grupo de um papel não muda por configuração.

**Codex** (via `delegate`):

| Papel | Modelo padrão | Sandbox padrão |
|---|---|---|
| explorer | `gpt-6-luna` | `read-only` |
| librarian | `gpt-6-luna` | `read-only` |
| fixer | `gpt-6-luna` | `workspace-write` |
| councillor:\<seat\> (seats `engine: "codex"`) | do seat | `read-only` (fixo) |

**Nativos Claude** (via Agent tool, registrados com `$.agent.register` no
`session.start` e re-registrados quando a config muda):

| Agente | Modelo padrão | Ferramentas |
|---|---|---|
| `pantheon:oracle` | `opus` | Read, Grep, Glob |
| `pantheon:designer` | `inherit` | todas |
| `pantheon:councillor-<seat>` (seats `engine: "claude"`) | do seat | Read, Grep, Glob |

`model` e `effort` dos nativos vão no registro do agente (o spawn não aceita `effort`);
o Agent tool continua aceitando `model` por chamada. O teto de sandbox e o `noNetwork`
não se aplicam aos nativos: o limite deles é a lista de ferramentas e o modo de
permissão da sessão. O designer, único nativo que escreve, roda sob as permissões
normais da sessão.

Um registro não pode ser desfeito durante a sessão. Por isso um hook `agent.offer` lê a
config vigente e esconde do modelo todo `pantheon:*` que esteja em `disabledAgents`, que
pertença a um seat removido ou com o council desligado. Agentes já em execução não são
afetados. A decisão é tomada antes de chamar `next`, e o hook tem um `.catch` que
devolve `{ isOffered: false }` para `pantheon:*`: se a guarda falhar ou estourar o
orçamento, o agente fica escondido em vez de passar (a API deixa passar por padrão).

## Configuração

Arquivo `~/.claude/pantheon.json`, sobrescrito por `<repo>/.claude/pantheon.json`.
Valores abaixo são os padrões; o arquivo só precisa do que muda.

```json
{
  "sandboxCap": "workspace-write",
  "noNetwork": false,
  "foregroundMinutes": 5,
  "disabledAgents": [],
  "agents": {
    "explorer":  { "model": "gpt-6-luna", "sandbox": "read-only" },
    "librarian": { "model": "gpt-6-luna", "sandbox": "read-only" },
    "fixer":     { "model": "gpt-6-luna", "sandbox": "workspace-write" },
    "oracle":    { "model": "opus" },
    "designer":  { "model": "inherit" }
  },
  "council": {
    "seats": {
      "alpha": { "engine": "codex",  "model": "gpt-6-astra", "effort": "high" },
      "beta":  { "engine": "claude", "model": "opus" }
    }
  }
}
```

Merge:

- **Campos de segurança** (`sandboxCap`, `noNetwork`) combinam pelo mais restritivo
  entre padrão, usuário e projeto: `read-only` < `workspace-write`; `noNetwork: true`
  vence. Um projeto nunca afrouxa o usuário.
- **Demais campos**: projeto sobrescreve usuário campo a campo; `disabledAgents` é a
  união.
- Cada papel/seat aceita `model`, `effort` e `prompt` (acrescentado ao fim do prompt do
  papel, como o `customAppendPrompt` do slim). Papéis Codex aceitam `sandbox`.
- `noNetwork` vale só para a rede dentro do sandbox do Codex
  (`sandbox_workspace_write.network_access`); não restringe agentes nativos.
- `danger-full-access` é recusado em qualquer campo.
- `disabledAgents` aceita nomes de papel e `"council"` (desliga gatilho, seats e menção
  no system prompt).

Config inválida (JSON ruim, campo desconhecido, valor fora do domínio): toast com o
erro; **`delegate` recusa toda delegação** com a mensagem de erro até a config ser
corrigida; os nativos não são re-registrados (ficam os da última config válida, ou os
padrões se nunca houve uma). Nunca se cai num padrão mais permissivo do que a última
política válida.

Leitura: no `session.start`, a cada `delegate` e a cada `prompt.compose` (via `$.fs`;
mudanças valem sem reload).

## Ferramenta `delegate` e companheiras

Registradas com `$.tool.register`, `isDeferred: false`. Atendem só papéis Codex.

- `delegate({ agent, prompt, description?, cwd?, model?, effort?, background?, resume? })`
  - `agent`: `explorer`, `librarian`, `fixer` ou `councillor:<seat>` de seat Codex.
    Nativo, desconhecido ou desligado → erro dizendo o que usar (o agente nativo pelo
    Agent tool, ou a lista válida).
  - `model` / `effort`: sobrescrevem os do papel nesta chamada (precedência: chamada >
    papel > padrão do Codex). Permite o escalonamento de modelo que o SDD pede.
  - `cwd`: ver Workspace. Padrão: diretório da sessão.
  - `background: true`: devolve `{ jobId, status: "background" }` imediatamente.
  - `resume`: `jobId` de um job Codex desta sessão já terminado, `cancelled` ou `lost`.
    Exige que o job tenha `sessionId` (gravado no `thread.started`); sem ele, erro
    dizendo que o job morreu antes de o Codex abrir a sessão e que é preciso delegar de
    novo. Reusa o `sessionId` e o `cwd` gravados; o sandbox é recalculado com a política
    atual.
  - Retorno no foreground: mensagem final, `jobId`, uso (tokens, tempo).
  - Ao passar de `foregroundMinutes`: `{ jobId, status: "background" }`.
- `delegate_result({ jobId })`: estado e, se terminado, resultado.
- `delegate_cancel({ jobId })`: encerra o processo Codex e marca `cancelled`. Mudanças
  parciais ficam no disco; o retorno lista isso.

## Workspace

- Raiz autorizada: `git rev-parse --show-toplevel` do diretório da sessão; fora de um
  repositório, o próprio diretório da sessão.
- `cwd` é resolvido com `$.fs.stat(path, { resolve: true })` e precisa ter `realPath`
  dentro da raiz (também resolvida). Fora disso → erro.
- `resume` sempre usa o `cwd` gravado no job; não aceita `cwd` novo.
- `--skip-git-repo-check` só é passado quando a raiz não é um repositório.
- Toda execução passa `-c sandbox_workspace_write.writable_roots=[]`, no `exec` e no
  `resume`, para que raízes graváveis extras herdadas do `config.toml` do usuário não
  ampliem a escrita além do `cwd`. `/tmp` e `$TMPDIR` continuam graváveis (padrão do
  Codex), porque testes e builds dependem deles.
- Toda execução passa `--ignore-rules`, no `exec` e no `resume`: uma regra
  `decision = "allow"` em `.rules` do usuário ou do projeto roda comandos fora do
  sandbox e furaria o teto e o `noNetwork`. Custo aceito: regras `forbidden` do usuário
  também deixam de valer dentro do Pantheon; o sandbox continua valendo.
- `workspace-write` deixa `.git` somente leitura, então papéis Codex não fazem commit.
  Commits são do orchestrator.

## Fluxo de uma delegação

1. Valida config, papel e `cwd`; resolve modelo, effort, sandbox efetivo
   (mais restritivo entre papel, chamada não pode ampliar, e `sandboxCap`) e prompt
   (prompt do papel + `prompt` da config + prompt da tarefa).
2. Cria job em `pantheon.jobs` (`running` ou `background`) e atualiza a status line.
3. `$.process.spawn({ argv, cwd, input })`:
   - novo: `codex exec --json -s <sandbox> [-m <model>] [-c model_reasoning_effort=<e>]
     -c sandbox_workspace_write.writable_roots=[]
     [-c sandbox_workspace_write.network_access=false] --ignore-rules
     [--skip-git-repo-check] -`
   - resume: as mesmas opções de `exec` **antes** do subcomando, depois
     `resume <sessionId> -` (o subcomando `resume` não aceita `-s`).
4. Eventos (amostra real):
   - `thread.started.thread_id` → `sessionId` do job
   - `item.started` / `item.completed`: `command_execution` (`command`, `exit_code`),
     `agent_message` (`text`), demais tipos → última atividade
   - última `agent_message` → resposta final
   - `turn.completed.usage` → tokens
   - saída ≠ 0, `turn.failed`/`error`, ou sem `agent_message` → `error`, com as últimas
     linhas de stderr
5. Foreground: aguarda até `foregroundMinutes` (a espera em `$.process.spawn` não consome
   o orçamento de 10 s do hook). Terminou → retorna. Passou → retorna `background`; o
   loop continua desacoplado da chamada e, ao terminar, `$.prompt.submit` avisa a sessão
   ("job X do fixer terminou; use delegate_result").
6. Esc no foreground: `next.signal` aborta, o loop sai e o processo morre.
7. Reload do mod: o processo morre com o módulo; no `session.start` seguinte, jobs
   `running` **e** `background` viram `lost`. São retomáveis por `resume` só os que já
   têm `sessionId`; o painel mostra quais.

Sem retry automático: repetir é decisão do orchestrator.

## System prompt do orchestrator (`prompt.compose`)

Seção de sessão adicionada por último, função pura da config efetiva (mesmos bytes para
a mesma config, por causa do prompt cache). Adaptada de `orchestrator.ts`:

- **Mantido**: `<Role>` (gerente de workflow; faz direto só ação isolada, clara e de
  baixo risco); `<Agents>` com os blocos de `role-routing.ts` filtrados pelos papéis
  ativos, sem "Permissions"/"Stats", cada um dizendo como chamar (`delegate` para Codex,
  Agent tool com `pantheon:<nome>` para nativos); Workflow 1–5; Design Handoff
  Discipline; exemplos de paralelo filtrados por papel ativo.
- **Adaptado**: Background Task Discipline, Active Task Amendments e Session Reuse para
  `delegate` / `delegate_result` / `delegate_cancel` / `resume` e para o
  `run_in_background` do Agent tool. "Lance em background, dê um status curto e encerre
  o turno" vale para os dois. Sem `task_message`/steer. Regras de arquivo reescritas
  para as ferramentas reais.
- **Removido**: Todo Continuity, Marketplace, `wait_for_user`, `question`,
  `<Communication>` (coberto pelo output style e pelo CLAUDE.md do usuário).

Tamanho alvo: ~100 linhas, incluindo o bloco de superpowers.

## Prompts dos papéis

De `role-prompts.ts`, quase literais, com formatos de saída (`<results>` do explorer;
`<summary>/<changes>/<verification>` do fixer). Regras de arquivo por grupo: Codex
(`rg`, shell para diagnóstico, `apply_patch` para edição; read-only proíbe escrita);
nativos (Read/Grep/Glob/Edit). Librarian: "busca na web e MCPs de documentação
disponíveis" no lugar de `context7`/`gh_grep`. Todo prompt de papel termina com: "Se a
tarefa definir um formato de relatório, ele substitui o formato acima."

## Council

- Gatilho (`prompt.submit`): só quando `e.origin.kind` é `composer` (o usuário no
  terminal) ou `bridge` (o usuário remoto); `sdk` e qualquer outra origem nunca
  disparam. Regex
  do `council-inject` mais `conselho`, `consenso`, `segunda opinião`; ignora blocos e
  inline code; mensagem que começa com `/` não dispara. Avisos do Pantheon nunca
  disparam.
- Com gatilho, anexa ao prompt o bloco Council Mode: (1) buscar contexto externo
  primeiro e embutir resumo, porque conselheiros são read-only; (2) despachar todos os
  seats em background no mesmo turno: Codex com
  `delegate({ agent: "councillor:<seat>", background: true })`, Claude com o Agent tool
  `pantheon:councillor-<seat>` e `run_in_background`; (3) coletar conforme cada seat
  termina (cada conclusão acorda a sessão); uma nova tentativa para resposta vazia;
  sintetizar quando todos tiverem terminado ou falhado; seat com falha aparece como tal,
  sem omitir; um seat travado é visível no painel e pode ser cancelado com
  `delegate_cancel` (Codex) ou parando o agente (nativo), e então conta como falha;
  (4) sintetizar. Sem prazo fixo: o pior caso é a síntese atrasar, nunca se perder.
- Síntese pelo próprio orchestrator, no formato de `council.ts`: `## Council Response`,
  `## Per-Councillor Details` (pelo nome do seat), `## Council Summary` (Consensus Level
  unanimous|majority|split, Agreed Points, Disagreements, Remaining Uncertainty,
  Recommended Action).
- Sem gatilho, o custo é uma linha no system prompt citando os seats.

## Integração com superpowers

As skills que despacham subagentes os criariam pelo Agent tool com tipos genéricos, fora
dos papéis do Pantheon. A seção do orchestrator ganha um bloco estático (sem gatilho,
nunca se aplica): quando uma skill mandar despachar um subagente, use o papel abaixo,
mantendo o processo da skill (etapas, gates, escolha de modelo, formato de prompt e de
retorno).

| Despacho da skill | Pantheon |
|---|---|
| implementer (subagent-driven-development) | `delegate` com `fixer`; Agent `pantheon:designer` se a tarefa for UI |
| task reviewer e re-reviewer do subagent-driven-development (um despacho por gate, com o pacote de `scripts/review-package`) | Agent `pantheon:oracle` |
| code reviewer final da branch (subagent-driven-development, requesting-code-review) | Agent `pantheon:oracle`, despacho separado |
| agentes em paralelo (dispatching-parallel-agents) | vários `delegate`/Agent na mesma mensagem, papel conforme a tarefa |

Regras do bloco:

- **executing-plans** roda no próprio agente principal: o bloco declara que essa
  modalidade é uma exceção à regra geral de delegar e não deve ser convertida em
  despachos.
- O modelo escolhido pela skill vai em `model` do `delegate` ou do Agent tool.
- O formato de relatório definido pela skill substitui o formato padrão do papel.
- Revisões: o reviewer recebe o pacote de revisão em arquivo (no SDD, o gerado por
  `scripts/review-package`; no requesting-code-review, um gerado pelo orchestrator com
  diff e SHAs), porque o oracle não tem Bash.
- O implementer Codex continua uma tarefa por `resume` (jobId); sem isso, segue o
  fallback da skill (novo implementer com brief, relatório e achados).
- Commits: o sandbox do Codex não deixa o fixer commitar (`.git` é somente leitura).
  O fixer implementa, testa e entrega o relatório sem commit; o orchestrator faz o
  commit, registra o SHA e então gera o pacote de revisão (BASE gravado antes do
  despacho, HEAD = esse commit). O prompt do fixer nesse despacho diz que a ausência de
  commit é esperada e não é motivo para reportar BLOCKED.
- Papel desligado sai da tabela; a skill usa o Agent tool padrão naquele caso.

## Painel e comandos

- Status line (`$.ui.status`): `pantheon: N rodando · M em background`; some sem jobs
  ativos.
- `/pantheon`: abre painel (`$.ui.open` + `ui.render` `Pane`) só com as ações sobre os
  jobs Codex. Uma linha curta por job: id, estado (running, background, done, error,
  cancelled, lost), papel, descrição e `↻` se é retomável; botões Cancelar (job ativo) e
  Copiar resposta (`$.ui.copy`, job com resposta). Ativos primeiro, depois os mais
  recentes, limitado pela altura do viewport. Sem jobs: "Nenhum job do Pantheon nesta
  sessão." O painel não lista os agentes nativos `pantheon:*`.
- Detalhe dos jobs (modelo, tempo, tokens, última atividade): fica no plugin flightdeck,
  que lê `pantheon.jobs` de `$.state` sem tipos e desenha cartões/raias marcados
  codex / codex bg / codex lost. O pantheon não os desenha.
  Não abre sozinho.
- `/pantheon cancel <jobId>`, `/pantheon config` (config efetiva, origem de cada campo e
  erro atual, se houver), `/pantheon doctor` (`codex` no PATH, versão,
  `codex login status`, config válida, raiz autorizada).
- Estado em `$.state` (`pantheon.jobs`), declarado em `types/index.d.ts`.

## Testes

Padrão do slim (funções puras testadas com `toContain`/`not.toContain`, determinismo
por igualdade de duas chamadas, regex de gatilho com casos positivos e negativos),
rodando com `claude plugin test` (`claude-code/testing`):

- `config.test.ts`: merge funcional; merge restritivo de `sandboxCap`/`noNetwork`
  (projeto não afrouxa usuário); `danger-full-access` recusado; config inválida bloqueia
  `delegate` e mantém a última política válida.
- `offer.test.ts`: `pantheon:*` desligado, seat removido ou council desligado não é
  oferecido; os demais são; se a guarda lançar exceção ou estourar o orçamento, o
  `pantheon:*` não é oferecido.
- `roles.test.ts`: sandbox efetivo (porta dos casos de `runner/test/offline.js`),
  precedência chamada > papel > padrão para modelo e effort; nativo em `delegate` recusado
  com instrução; registros nativos refletem model/effort da config.
- `workspace.test.ts`: `cwd` dentro e fora da raiz; symlink apontando para fora; resume
  ignora `cwd` novo.
- `superpowers.test.ts` também cobre: o despacho do implementer diz que commit é do
  orchestrator.
- `codex.test.ts`: argv por combinação (sandbox, modelo, effort, `noNetwork`,
  `--skip-git-repo-check`), `writable_roots=[]` e `--ignore-rules` sempre presentes, resume com opções antes
  do subcomando; parser sobre
  `hooks/fixtures/codex-exec-sample.jsonl` e casos de erro.
- `orchestrator.test.ts`: seção reflete papéis ativos; papel desligado some dos blocos e
  exemplos; mesma config → mesmos bytes; nenhuma menção a `task_revive`,
  `wait_for_user`, `question`, marketplace.
- `council.test.ts`: gatilhos (EN, PT), code fences, inline code, slash command;
  `composer` e `bridge` disparam, `sdk` e demais origens não; bloco lista todos os seats com a chamada certa por engine;
  formato de síntese presente.
- `superpowers.test.ts`: bloco presente; exceção de executing-plans; um único task
  reviewer por gate; linha de papel desligado some.
- `jobs.test.ts`: termina no foreground; passa do limite → `background` e
  `prompt.submit` ao terminar; `background: true` volta na hora; `delegate_cancel` encerra
  o processo; `session.start` marca `running` e `background` como `lost`; `resume` de
  job sem `sessionId` (reload antes do `thread.started`) dá erro claro.
- `pane.test.ts`: `mount` em `['terminal', 'desktop']`, linha curta por job e botão Cancelar.
- Validação manual em sessão real: explorer e fixer com Codex real; background forçado
  com `foregroundMinutes: 0.1`; council com um seat de cada engine; oracle nativo.

CI: `tsc -p .` e `claude plugin validate .`; `claude plugin test .` se o `claude` rodar
sem login no runner do GitHub, senão passo local obrigatório no CONTRIBUTING (a
confirmar na implementação).

## Riscos e pontos a confirmar na implementação

- Eventos do `codex exec --json` além da amostra (`file_change`, `turn.failed`): o
  parser trata tipos desconhecidos como atividade genérica.
- Se o `claude plugin test` consegue mockar `$.process.spawn`; senão `codex.ts` e
  `jobs.ts` recebem um spawn injetável e os testes usam um fake.
- Re-registro de agentes nativos durante a sessão vale a partir do turno seguinte.
- O processamento de cada evento do Codex consome o orçamento do hook; o parser deve
  ser leve.
