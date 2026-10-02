# AGENTS.md

Marketplace de plugins do Claude Code (`anderson-spider/spider-marketplace`). Hoje tem três plugins, `blast-radius` (segura comandos destrutivos), `branch-guard` (segura commit e push na branch protegida) e `tailscale` (tools para consultar e modificar a tailnet). O README e o código estão em português do Brasil; comentários e mensagens seguem no mesmo idioma.

## Estrutura

- `.claude-plugin/marketplace.json` lista os plugins; cada plugin vive em `plugins/<nome>/`.
- Os plugins são **mods de function hooks**, uma API do Claude Code em acesso antecipado que pode mudar entre versões. O módulo `claude-code` (`atom`, `read`, `Register`, `claude-code/testing`) não vem de npm: as tipagens são gravadas pelo Claude Code em `plugins/*/.claude-plugin/types/` ao carregar o plugin (ignorado no git). Não há `package.json`, build nem lint; `tsconfig.json` estende essas tipagens.
- Antes de escrever ou depurar um módulo de hooks, carregue a skill `plugin-authoring`.

## Comandos

```
claude plugin validate .                       # valida o marketplace
claude plugin validate plugins/blast-radius    # valida o plugin
claude plugin test plugins/blast-radius        # roda tests/blast-radius.test.ts
claude plugin test plugins/branch-guard        # idem, para o branch-guard
claude plugin test plugins/tailscale           # idem, para o tailscale
claude --plugin-dir plugins/blast-radius       # carrega o plugin com recarga automática
```

Dentro de uma sessão, `/reload-plugins` recarrega os hooks.

## Arquitetura do blast-radius

`hooks/hooks.json` só aponta para `./register.tsx`. O fluxo atravessa três arquivos:

- `hooks/risk.ts`: lógica pura, sem `$`. `classify(command)` lê o texto do Bash (`split`, `cd`, `git -C`, variáveis atribuídas na linha) e devolve `Risk[]` (`rm`, `reset`, `clean`, `push`, `migrate`). `isDisposable` libera alvos só em temporários do sistema. `measure` roda os dry runs das próprias ferramentas e devolve um `BlastRadiusReport`. Tudo que toca o host passa pelo `Probe` injetado, o que permite testar sem processo real.
- `hooks/register.tsx`: liga ao host. `tool.call` (Bash) classifica, mede e **segura** a chamada em `hold()` até a pessoa decidir (`proceed` libera, senão retorna `deny` com o resumo); `ui.render` em `AbovePrompt` desenha a faixa; `session.start` zera um estado preso por reload.
- `types/index.d.ts`: formato do relatório e do estado do plugin (`BlastRadiusHeld`), declarado em `PluginState`.

Detalhes que só se entendem lendo os dois lados:

- A decisão trafega pela variável de módulo `waiting`, não pelo estado: leituras de `$.state` em um dispatch veem um só momento. O estado guarda só o que a faixa desenha.
- A espera usa `$.process.run(['sleep', '0.25'])` e não `$.clock.sleep`, para não gastar o tempo do hook. Só uma chamada fica segurada por vez.
- `hold()` nunca rejeita: erro vira `'aborted'` e nega o comando.
- `CHROME_ROWS` em `register.tsx` precisa acompanhar as linhas fixas da faixa ao mudar o layout.
- É uma rede de segurança que lê texto, não um sistema de permissões (`$(…)`, aliases e scripts passam).

## branch-guard

Mesmo desenho do blast-radius (`hooks/guard.ts` puro com `Probe` injetado, `hooks/register.tsx` com `hold`/`draw`), com estado próprio (`branch-guard`/`held`). `classify` levanta `commit` e `publish`; `isProtectedTarget` decide, de forma assíncrona, se a branch alvo é protegida. O parser (`parse`, `resolve`, `locate`, `isTempRepo`) é **cópia** do de `blast-radius/hooks/risk.ts`, porque um plugin não importa código de outro: uma correção em um lado precisa ser levada ao outro. O force push fica fora de propósito, por ser do blast-radius.

## tailscale

Não segura nada: registra duas tools com `$.tool.register` no `session.start` (`tailscale_get` e `tailscale_write`, listadas como `mcp__tailscale__<nome>`) e as atende em hooks `tool.call`. `hooks/api.ts` é puro: `buildUrl` só aceita caminho relativo à API (sem `..`, `//`, `%2e`, `%2f`, `%5c`), `forbidden` recusa `DELETE /tailnet/{tailnet}`, e `call(fetch, key, req)` recebe o `fetch` injetado. `transform` aplica, só no `tailscale_get`, `redact` (tira `REDACTED_FIELDS`: `machineKey`, `nodeKey`, `tailnetLockKey`, `secret`, `s3SecretAccessKey`, `token`) e `fields` (projeta as chaves pedidas); o `write` não filtra, porque a resposta de uma chave nova traz o segredo uma única vez. O `call` também devolve o `ETag` da resposta, manda `If-Match` quando há `ifMatch` e escolhe `application/hujson` quando o `body` é uma string que não é JSON. A spec da API é a OpenAPI de `https://api.tailscale.com/api/v2?outputOpenapiSchema=true` (a página `/api-docs` é renderizada por JS e o `WebFetch` não a lê); ela se declara instável. Detalhes que só se entendem lendo a API do host:

- A chave vem de `$.env.get('TS_API_KEY')` a cada chamada, nunca de `options` nem do código.
- O `validate` recusa `$.http.fetch` passado como valor; por isso o `register.tsx` o envolve em `(url, init) => $.http.fetch(url, init)`.
- `result` do `tool.call` de uma tool própria é string ou array, não objeto, e `isError` só aceita `true` (omita em vez de `false`).
- O teste usa só as funções de `hooks/api.ts` com um `fetch` falso; não há host falso.

## Testes

`tests/blast-radius.test.ts` usa `claude-code/testing` e um host falso (`answer`) que responde por executável e subcomando. Um novo tipo de risco precisa de resposta nesse host.

## Versão

Ao mudar o comportamento de um plugin, atualize `version` no `plugin.json` dele.
