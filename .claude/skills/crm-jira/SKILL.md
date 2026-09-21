---
name: crm-jira
description: Automação do fluxo de dev do CRM Lab integrado ao Jira (projeto CRMLAB) — cria, discute, move e acompanha cards do backlog até o merge e o encerramento em produção. Use quando o usuário pedir para criar card de melhoria/manutenção, mover item de fase, tirar dúvida de regra de negócio, validar ou abrir PR/merge ligado a uma issue CRMLAB.
---

# CRM Jira — fluxo automatizado

Skill que EU (Claude Code) opero via comandos Jira (MCP Atlassian) para tocar o ciclo de vida de uma
melhoria/manutenção do projeto CRM Lab, do backlog até produção. O usuário não mexe no Jira manualmente —
eu crio os cards e movo os status conforme o combinado abaixo.

## Constantes

- `cloudId`: `18534185-6f51-4d22-88aa-ad4cd6f3ac6a` (site brodbeckmichelatlassian.atlassian.net)
- `projectKey`: `CRMLAB`
- Tipo de issue padrão: `Tarefa` (usar `Bug` se for correção de defeito, `História` se for feature maior)

## Mapa de status → transitionId

| Fase | Status Jira | transition id (a partir de qualquer status, são globais) |
|---|---|---|
| 1. Ideia registrada | Backlog | 11 |
| 2. Discutindo escopo/regras | Discussão | 21 |
| 3. Escopo fechado, pode implementar | Aprovado p/ Dev | 31 |
| 4. Codando | Em Desenvolvimento | 2 |
| 5. Código pronto, aguardando o usuário testar | Pronto p/ Validação | 4 |
| 6. Usuário validou | Aprovado | 5 |
| 7. PR aberto / mergeado | PR aberto / Merge | 6 |
| 8. No ar, ciclo encerrado | **Finalizado / em produção** | **3** |

Use `transitionJiraIssue` com `cloudId`, `issueIdOrKey` e `transition: {"id": "<id>"}`.
Antes de mover, adicione um comentário curto (`addCommentToJiraIssue`) explicando a mudança — isso vira o
histórico de decisão do card, já que não há board físico sendo olhado em tempo real.

### Cuidado: o NOME da transição 3 mente

No Jira, a transição **3 ainda se chama "Dúvida/Revisão de Regras"**, mas o status de destino foi
renomeado para **"Finalizado / em produção"** (status id `10009`). Quem confiar no nome marca o card
como concluído achando que o está travando para tirar uma dúvida — e faz isso em silêncio, porque a
API aceita numa boa. Corrigido aqui em 2026-09-19, depois de conferir com `getTransitionsForJiraIssue`.

**Não existe mais status de "dúvida"** neste workflow: nenhuma das 8 transições leva a um. Dúvida de
regra de negócio agora volta o card para **Discussão (21)**, que é o status que de fato significa
"escopo em aberto".

Os nomes das transições 11/21/31 também são genéricos de template (`A fazer`/`Fazendo`/`Feito`) e não
descrevem o destino. **Confie no id e no status de destino, nunca no nome da transição.** Em dúvida,
rode `getTransitionsForJiraIssue` antes de mover — ele mostra o `to.name` real.

## Comandos (subcomandos do skill)

Args esperados após `/crm-jira`: `<subcomando> [CHAVE] [texto livre]`.

### `backlog "<ideia>"`
1. Cria issue em `CRMLAB` com `createJiraIssue` (fica automaticamente em Backlog).
2. Resumo (`summary`) curto e objetivo; descrição com o contexto que o usuário deu.
3. Responda ao usuário com a chave (ex: CRMLAB-7) e o link, e pergunte se quer discutir escopo agora.

### `discutir <CHAVE>`
1. Transição 21 (Discussão).
2. NÃO mova sozinho para "Aprovado p/ Dev" — só o usuário decide isso explicitamente
   ("pode implementar", "aprovado", "manda pra dev").

### `aprovar-dev <CHAVE>`
1. Transição 31 (Aprovado p/ Dev).
2. Confirme resumo do escopo acordado no comentário antes de mover.

### `iniciar-dev <CHAVE>`
1. Transição 2 (Em Desenvolvimento).
2. Crie branch git a partir de main/master: `feature/CRMLAB-<n>-slug-curto`.
3. Comece a implementação normalmente (seguindo as práticas de código do projeto).
4. **Se durante a implementação surgir qualquer dúvida de regra de negócio ou ambiguidade de escopo**:
   pare, rode o subcomando `duvida` (abaixo) e aguarde resposta do usuário antes de continuar codando.
   Não adivinhe regra de negócio.

### `duvida <CHAVE> "<pergunta>"`
1. Comenta a pergunta específica na issue.
2. Transição **21 (Discussão)** — NÃO a 3, que apesar do nome leva a "Finalizado / em produção" e
   encerraria o card em vez de travá-lo (ver o aviso no mapa acima).
3. Avise o usuário na conversa que o card está travado aguardando resposta.
4. Quando o usuário responder, comente a resposta na issue e volte para transição 2 (Em Desenvolvimento)
   automaticamente para continuar o trabalho.

### `pronto-validacao <CHAVE>`
1. Rode a suíte de testes/lint do projeto se existir; só prossiga se passar (ou avise se não passou).
2. Comente um resumo do que foi feito (arquivos alterados, o que testar).
3. Transição 4 (Pronto p/ Validação).
4. Avise o usuário que está pronto para ele validar.

### `aprovar <CHAVE>`
Só executar quando o usuário disser explicitamente que validou/aprovou.
1. Transição 5 (Aprovado).

### `abrir-pr <CHAVE>`
1. Confirme que o card está em "Aprovado" — se não estiver, pergunte antes de prosseguir.
2. Push da branch e `gh pr create` com título referenciando a chave (`CRMLAB-<n>: <resumo>`) e corpo
   linkando a issue.
3. Comente o link do PR na issue e transição 6 (PR aberto / Merge).
4. **NUNCA faça merge para a branch de produção automaticamente.** Depois do PR aberto, pergunte
   explicitamente ao usuário "posso fazer o merge agora?" e só rode `gh pr merge` após confirmação
   explícita nesta conversa — mesmo que o card já esteja "Aprovado". Merge em prod é sempre manual/confirmado.

### `finalizar <CHAVE>`
Encerra o ciclo do card: o código está mergeado, deployado e **confirmado no ar**.
1. Confirme que o deploy de produção realmente aconteceu — versão/tag no ar, não só o merge.
2. Comente o que foi para produção: commit, tag e a verificação feita depois do deploy.
3. Transição **3** (Finalizado / em produção). Sim, o id 3 — o nome dela no Jira é enganoso, ver o
   aviso no mapa de status.
4. Só execute quando o usuário pedir explicitamente para finalizar, ou depois de ele confirmar que
   validou em produção.

## Regras gerais

- Nunca pule etapas silenciosamente (ex: ir direto de Backlog para Em Desenvolvimento) — sempre siga a
  sequência, a menos que o usuário peça explicitamente para pular uma fase.
- Toda transição de status vem acompanhada de um comentário explicando o porquê.
- Se o usuário pedir para "criar um card", assuma `backlog` por padrão, a não ser que ele já diga que quer
  pular direto para dev.
- Merge para produção é a única ação que exige confirmação explícita a cada vez, independente do status do card.
