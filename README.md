# Spider Marketplace

Marketplace de plugins do [Claude Code](https://claude.com/claude-code) feitos por anderson-spider. Cada plugin fica em uma pasta de `plugins/` e é listado em `.claude-plugin/marketplace.json`.

## Plugins

| Plugin | O que faz |
| --- | --- |
| [blast-radius](plugins/blast-radius) | Segura um comando arriscado do Bash e mostra o que ele mudaria antes de rodar. |
| [branch-guard](plugins/branch-guard) | Segura um `git commit` ou `git push` na branch protegida e mostra o que entraria. |
| [tailscale](plugins/tailscale) | Deixa o Claude consultar e modificar a sua tailnet pela API da Tailscale. |

## Instalar

Dentro do Claude Code, adicione o marketplace e instale o plugin:

```
/plugin marketplace add anderson-spider/spider-marketplace
/plugin install blast-radius@spider-marketplace
/plugin install branch-guard@spider-marketplace
/plugin install tailscale@spider-marketplace
```

Para usar uma cópia local em vez do GitHub, passe o caminho da pasta:

```
/plugin marketplace add ~/dev/personal/spider-marketplace
```

Os plugins daqui são mods de function hooks, uma API do Claude Code ainda em acesso antecipado, que pode mudar entre versões.

## blast-radius

Quando o Claude chama o Bash com um comando destrutivo, o Blast Radius segura a chamada, mede o que ela mudaria com os dry runs das próprias ferramentas e mostra o relatório em uma faixa acima do prompt, com `1: Prosseguir` e `2: Cancelar`. Ao cancelar, o Claude recebe a recusa com o resumo do que o comando faria.

| Comando | Como é medido |
| --- | --- |
| `rm -r`, `rm -rf` | `find` e `du` nos alvos: "apagar 9 arquivos (1.1 MB)" |
| `git reset --hard` | `git status --porcelain`, `git diff --shortstat` e `git log <ref>..HEAD` |
| `git clean -f` | `git clean -n` com as mesmas flags |
| force push (`-f`, `--force`, `--force-with-lease`, `+ref`) | `git log HEAD..<remoto>/<branch>`, sem fetch |
| migração de banco (Django, Rails, Prisma, Laravel) | o comando de status de cada ferramenta |

Passam sem perguntar o `rm -rf`, o `git reset --hard` e o `git clean` que só tocam um diretório temporário do sistema (`/tmp`, `/private/tmp`, `/var/folders`), inclusive quando o caminho vem de uma variável atribuída na mesma linha (`S=/tmp/x; rm -rf $S`). A raiz do temporário, alvos mistos, alvos que só o shell sabe resolver e worktrees ligados a um repositório de fora continuam segurados.

É uma rede de segurança, não um sistema de permissões: o plugin lê o texto do comando, então `$(…)`, aliases e scripts que chamam `rm` por dentro passam por ele. Para um bloqueio de verdade, use as regras de permissão do Claude Code.

## branch-guard

Quando o Claude chama o Bash com `git commit` ou `git push` e a branch alvo é `main`, `master`, `develop`, `release` ou `release/*` (também `release-*` e `release_*`), o Branch Guard segura a chamada e mostra na faixa acima do prompt o que entraria: os arquivos do commit ou os commits que subiriam, com `1: Prosseguir` e `2: Cancelar`. Ao cancelar, o Claude recebe a recusa com a orientação de abrir uma branch de trabalho (`git switch -c`) e refazer o comando nela, ou de abrir um PR quando o push é `HEAD:<protegida>` a partir de outra branch.

Passam sem perguntar: commits e pushes em outras branches, em HEAD solto, em repositório dentro de `/tmp`, `git commit --dry-run`, `git push --dry-run`, push só de tags e commit sem nada staged. O force push não é daqui: é do blast-radius. Para desligar o aviso, desabilite só este plugin.

Limitações: o plugin lê o texto do comando, então `merge`, `cherry-pick`, `rebase`, `pull`, aliases e `bash -c "git commit"` não passam por ele; um `"` ou `'` solto no corpo de um `-m "$(cat <<EOF …)"` pode confundir a leitura; só vê o que o Claude digita, não o seu terminal.

## tailscale

Registra duas tools para o Claude falar com a API da Tailscale (`https://api.tailscale.com/api/v2`), autenticadas pela variável de ambiente `TS_API_KEY`, que precisa estar exportada quando o Claude Code abre:

| Tool | O que faz |
| --- | --- |
| `mcp__tailscale__tailscale_get` | Só leitura (`GET`): dispositivos, ACL, DNS, chaves, usuários, convites, configurações, webhooks, logs, device posture, services, OAuth apps e contatos. Ex.: `/tailnet/-/devices`. Aceita `fields` para trazer só as chaves pedidas (a API não pagina, então a lista vem inteira). Tira `machineKey`, `nodeKey`, `tailnetLockKey`, `secret`, `s3SecretAccessKey` e `token` da resposta e mostra o `ETag` quando há. |
| `mcp__tailscale__tailscale_write` | Modifica a tailnet (`POST`, `PUT`, `PATCH`, `DELETE`): tags, rotas, ACL, DNS, apagar dispositivos, chaves, webhooks. Aceita `ifMatch`. A resposta vem completa, porque a API mostra o segredo de uma chave nova uma vez só. |

As duas são separadas para você liberar só a leitura sem prompt e manter a escrita pedindo confirmação. O `path` precisa ser relativo à API e começar com `/`; `//host`, `..`, `%2e`, `%2f`, `%5c` e URLs completas são recusados. O `-` no lugar da tailnet vale para a padrão.

Para atualizar a ACL sem sobrescrever uma edição de outra pessoa: faça um `GET /tailnet/-/acl`, guarde o `ETag` da resposta e passe-o em `ifMatch` no `POST /tailnet/-/acl` (a API responde 412 se a ACL mudou). Um `body` em string que não seja JSON válido vai como HuJSON, então a política com comentários passa. `DELETE /tailnet/{tailnet}`, que apaga a tailnet inteira, é recusado pela tool.

`TS_API_KEY` precisa ser uma chave `tskey-api-...`. Um segredo OAuth `tskey-client-...` não vale como Bearer sem uma troca por token, que o plugin não faz.

## Desenvolver

Para editar um plugin com recarga automática, aponte o Claude Code direto para a pasta dele, com `claude --plugin-dir` ou no `env` do `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/caminho/para/spider-marketplace/plugins/blast-radius"
  }
}
```

Para validar e testar:

```
claude plugin validate .
claude plugin validate plugins/blast-radius
claude plugin test plugins/blast-radius
claude plugin validate plugins/branch-guard
claude plugin test plugins/branch-guard
claude plugin validate plugins/tailscale
claude plugin test plugins/tailscale
```
