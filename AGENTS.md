# AGENTS.md

Marketplace de plugins do Claude Code (`anderson-spider/spider-marketplace`). Hoje tem um plugin, `blast-radius`. O README e o código estão em português do Brasil; comentários e mensagens seguem no mesmo idioma.

## Estrutura

- `.claude-plugin/marketplace.json` lista os plugins; cada plugin vive em `plugins/<nome>/`.
- Os plugins são **mods de function hooks**, uma API do Claude Code em acesso antecipado que pode mudar entre versões. O módulo `claude-code` (`atom`, `read`, `Register`, `claude-code/testing`) não vem de npm: as tipagens são gravadas pelo Claude Code em `plugins/*/.claude-plugin/types/` ao carregar o plugin (ignorado no git). Não há `package.json`, build nem lint; `tsconfig.json` estende essas tipagens.
- Antes de escrever ou depurar um módulo de hooks, carregue a skill `plugin-authoring`.

## Comandos

```
claude plugin validate .                       # valida o marketplace
claude plugin validate plugins/blast-radius    # valida o plugin
claude plugin test plugins/blast-radius        # roda tests/blast-radius.test.ts
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

## Testes

`tests/blast-radius.test.ts` usa `claude-code/testing` e um host falso (`answer`) que responde por executável e subcomando. Um novo tipo de risco precisa de resposta nesse host.

## Versão

Ao mudar o comportamento do plugin, atualize `version` em `plugins/blast-radius/.claude-plugin/plugin.json`.
