# CRMLAB-65 — Atendimento com comportamento de WhatsApp Web

Épico: https://brodbeckmichelatlassian.atlassian.net/browse/CRMLAB-65
Início: 2026-09-28. Coordenação: uma sessão do Claude (orquestrador) + 1 agente por card.

> **ESTE ARQUIVO É O PONTO DE RETOMADA.** Se a sessão cair, leia a seção
> "Estado atual" e siga "Como retomar". Todo agente e o orquestrador atualizam a tabela
> ao mudar de fase (commit + push na branch `integ/epic-65`).

## Branch de integração

- `integ/epic-65` no worktree `../CRM Lab-epic-65`, criada de `origin/main` @ `7650fe5` (v1.23.0).
- Cada onda sai da integração da onda anterior. Ao fim da onda, as branches dos cards são
  mergeadas aqui, a suíte completa roda **uma vez** aqui (`--maxWorkers=3`), e é desta branch
  que a hml sobe para validação.
- Os PRs para a `main` saem por card depois da aprovação do Michel (merge sempre confirmado).

## Ondas (sequência A→H, agrupadas para não brigarem pelos mesmos arquivos)

| Onda | Cards | Por que juntos |
|---|---|---|
| 1 | CRMLAB-66 [A], CRMLAB-71 [F], CRMLAB-72 [G] | A = webhook/tipos/bolha; F = lista/paginação; G = hook isolado. Pouca sobreposição. |
| 2 | CRMLAB-67 [B], CRMLAB-68 [C], CRMLAB-69 [D] | B reaproveita a reconfiguração de webhook do A; C reaproveita o cursor do F; D mexe no Composer/envio. |
| 3 | CRMLAB-70 [E], CRMLAB-73 [H], CRMLAB-64 | E depois do D (vídeo); H e 64 só frontend. |

## Faixas reservadas (evita colisão entre worktrees paralelos)

Outras branches em andamento já usam até **D-214** e a migração **032** (`integ/onda-53-62`).
O migrador aplica por ordem de nome o que ainda não foi aplicado, então buraco na numeração é ok.

| Card | Decisões | Migrações |
|---|---|---|
| CRMLAB-66 [A] | D-220 … D-224 | 040, 041 |
| CRMLAB-67 [B] | D-225 … D-227 | 042 |
| CRMLAB-68 [C] | D-228 … D-230 | 043 |
| CRMLAB-69 [D] | D-231 … D-233 | 044 |
| CRMLAB-70 [E] | D-234 … D-236 | 045 |
| CRMLAB-71 [F] | D-237 … D-239 | 046 |
| CRMLAB-72 [G] | D-240 … D-241 | — |
| CRMLAB-73 [H] | D-242 … D-243 | — |
| CRMLAB-64     | D-244 … D-245 | — |

Não usar número fora da própria faixa. Sobrou número? Deixa o buraco.

## Worktrees e branches

| Card | Worktree | Branch |
|---|---|---|
| 66 | `../CRM Lab-66` | `feature/CRMLAB-66-responder-reagir-apagada` |
| 71 | `../CRM Lab-71` | `feature/CRMLAB-71-leitura-conversa` |
| 72 | `../CRM Lab-72` | `feature/CRMLAB-72-aviso-mensagem-nova` |
| 67 | `../CRM Lab-67` | `feature/CRMLAB-67-tiques-presenca` |
| 68 | `../CRM Lab-68` | `feature/CRMLAB-68-busca-nao-lidas` |
| 69 | `../CRM Lab-69` | `feature/CRMLAB-69-anexos-previa` |
| 70 | `../CRM Lab-70` | `feature/CRMLAB-70-tipos-mensagem` |
| 73 | `../CRM Lab-73` | `feature/CRMLAB-73-texto-rascunho` |
| 64 | `../CRM Lab-64` | `feature/CRMLAB-64-setas-lightbox` |

node_modules são symlinks para a pasta principal; `*.wt.*` (vitest/tsconfig com alias do
`shared/` do próprio worktree) copiados do `../CRM Lab-62`.

## Regras para os agentes (resumo; o prompt completo repete)

1. Ler `CLAUDE.md`, `docs/AGENTS.md` e o card no Jira antes de codar. Docs primeiro (Regra Zero).
2. **Commit WIP cedo e sempre** (a cada etapa: docs, migração, backend, frontend, testes) e
   `git push -u origin <branch>`. Trabalho não commitado some quando a sessão cai.
3. Escrever o diário do card em `docs/superpowers/plans/crmlab-65/CRMLAB-<n>.md` (um arquivo
   por card, para não conflitar na integração), a cada etapa, no mesmo commit da etapa.
   **Não mexer em `docs/STATUS.md` nem neste arquivo**: quem atualiza é o orquestrador.
4. Comando pesado (typecheck, vitest) sempre atrás de
   `flock /tmp/claude-1000/crmlab-heavy.lock`, com `--maxWorkers=3 --minWorkers=1` no vitest.
   Rodar só os specs afetados; a suíte completa roda na integração.
5. Nunca `git commit -a`, nunca `git stash` sem tag, nunca mexer em outro worktree, nunca deploy.
6. Dúvida de regra de negócio: parar e reportar ao orquestrador (não adivinhar).

## Estado atual

> ⏸️ **PAUSADO em 28/09/2026 17:20** a pedido do Michel (computador desligado). Onda 1 (66/71/72) integrada,
> verde e em "Pronto p/ Validação". Onda 2 (67/68/69) interrompida no meio: cada agente foi
> instruído a commitar WIP + push e escrever "⏸️ PAUSADO" no diário do card. **Para retomar:**
> em cada `../CRM Lab-67|68|69`, `git status --short` (se houver arquivo solto, o WIP não entrou)
> e `git log --oneline -3`; ler o diário do card; disparar um agente novo por card apontando
> para o mesmo worktree/branch, com o prompt da onda 2 + "continue do diário". hml ainda não
> subiu em 28/09 20:15 (`hml-3f52c86`, com a main v1.23.0+62/53 dentro). 4 perguntas de regra em aberto (ver comentários nos cards 66 e 72).

| Card | Fase | Último commit | Observação |
|---|---|---|---|
| 66 [A] | ✔️ aprovado na hml (28/09) · aguarda PR | 6dd7c9e | D-220..D-223 (D-224 e migração 041 sem uso). Migração 040. `EVOLUTION_WEBHOOK_EVENTS` + `syncEvolutionWebhooks` no boot: o 67 só acrescenta eventos. 829 back + 716 front verdes no card. |
| 71 [F] | ✔️ aprovado na hml (28/09) · aguarda PR | e35cbfc | D-237..D-239. Cursor `before=<messageId>`, `cursors.after` reservado p/ 68. 37 back + 656 front verdes. Migração 046 não usada. |
| 72 [G] | ✔️ aprovado na hml (28/09) · aguarda PR | d356ac6 | D-240, D-241. 645 testes front verdes. Dúvida p/ Michel: gestor/admin avisados só da própria fila. |
| 67 [B] | 🧪 hml (`hml-deb5132`) · Pronto p/ Validação | 08d161c | D-225..D-227, 042 sem uso. Tiques/pending/retry, presença efêmera, composing. |
| 68 [C] | 🧪 hml (`hml-deb5132`) · Pronto p/ Validação | 8931970 | D-228..D-230, migração 043. Busca, Não lidas, around/after. Isolamento 81 rotas. |
| 69 [D] | 🧪 hml (`hml-deb5132`) · Pronto p/ Validação | a59817c | D-231..D-233, 044 sem uso. Prévia, vários, Ctrl+V, drop, caption. |
| 70 [E] | 🔄 docs (onda 3, 29/09) | — | Vídeo toca no balão (fora do lightbox); `sticker` vira tipo próprio. |
| 73 [H] | ✅ pronto no card (29/09) | f294454 | D-242, D-243. Parser em árvore (`WhatsAppText`), rascunho `userId:conversationId` em localStorage (7 dias; logout apaga), 549 emojis estáticos. 925 specs afetados verdes. 2 perguntas p/ Michel (logout apaga? 7 dias?). |
| 64    | ✅ pronto no card (29/09) | a815f0d | D-244, D-245. Lightbox único no painel (`ConversationImageViewer`, `useConversationImages`); cache por URL com refcount em `useAuthenticatedMedia`. 860 specs afetados verdes. Sticker sai da navegação quando o 70 entrar. |

Fases: ⬜ não iniciado → 🔄 docs → 🔄 backend → 🔄 frontend → 🔄 testes → ✅ pronto no card
→ 🔗 integrado em `integ/epic-65` → 🧪 hml → ✔️ aprovado → PR.

## Como retomar (se a sessão cair)

1. `git worktree list` e, em cada worktree de card: `git status --short` (trabalho solto aparece
   aqui, não no `git log`) e `git log --oneline origin/main..HEAD`.
2. Ler o diário `docs/superpowers/plans/crmlab-65/CRMLAB-<n>.md` **dentro do worktree do card**
   (é lá que o agente escreve; também no GitHub, na branch do card) e a tabela "Estado atual"
   na `integ/epic-65`.
3. Conferir o status no Jira (o card diz a fase oficial).
4. Retomar o card do ponto do diário com um agente novo apontado para o mesmo worktree/branch.
5. Não recriar worktree que já existe; não renumerar D-NNN/migração fora da faixa.

## Diário do orquestrador

Diário de cada card: `docs/superpowers/plans/crmlab-65/CRMLAB-<n>.md`.

- 2026-09-28: criada `integ/epic-65`, plano e faixas. Onda 1 (66, 71, 72) disparada.
- 2026-09-28: 72 e 71 mergeados na `integ/epic-65`. Conflitos: fim de `DECISIONS.md` (mantidos os
  dois blocos) e imports de `Attendance/index.tsx`. **Conflito semântico achado na junção:** o hook
  de aviso (72) lia o detalhe no formato antigo; o 71 trocou para páginas do `useInfiniteQuery`.
  Corrigido na integração (`detailOf` no hook + specs com o cache real). Specs afetados: 203 verdes.
  Falta: 66 terminar → merge → suíte completa.
- 2026-09-28: 66 mergeado na `integ/epic-65` sem conflito (o agente já tinha trazido a integ). Suíte
  completa rodando (logs em scratchpad `onda1/`). Se a sessão cair aqui: rodar de novo o typecheck
  (`*.wt.*`), `eslint .` e os dois vitest com `--maxWorkers=3 --minWorkers=1` na `integ/epic-65`.
- 2026-09-28: **suíte completa da onda 1 verde na `integ/epic-65`**: tsc shared/back/front, eslint,
  backend 1637/1637 (109 arquivos), frontend 1374/1374 (99 arquivos). E2E Playwright não rodado
  (precisa da stack Docker). 66/71/72 → Pronto p/ Validação. Onda 2 (67, 68, 69) disparada a
  partir desta integração. hml: aguardando autorização do Michel.
- 2026-09-28 20:15: **onda 1 na hml** (`hml-3f52c86`). Antes, merge da `origin/main` (62/53) na
  `integ/epic-65`, porque a hml rodava a `integ/onda-53-62` e subir sem ela tiraria o 031/032 do
  código. Conflitos: `main.ts`, `message.repository.ts` (autor "Mensagem automática" entrou no
  `senderNameSql`; INSERT grava citação + `automation`), `DECISIONS.md`, `SCHEMA.md`. Conflito
  semântico: spec do reengajamento com `listByConversation` antigo. E2E do CI achou
  `getByLabel('Mensagem')` casando "Ações da mensagem" do 66 → rótulo exato. Suíte local e CI verdes.
- 2026-09-28: **onda 1 aprovada pelo Michel na hml** (massa em `/home/deploy/simula-onda1.sh`:
  `base` | `ao-vivo` | `limpar`, telefone 5548900000001). Fora do épico, pedidos dele na validação,
  cada um com card próprio, branch saindo da `integ/epic-65` e mergeado nela:
  **CRMLAB-63** (cursor no campo após enviar; `MESSAGE_SEND_FAILED` não devolve o texto) e
  **CRMLAB-74** (contexto começa fechado; E2E `flow-8` abre pelo botão). Ambos aprovados.
  hml em `hml-082cbac`. Falta decidir a forma dos PRs para a main.
- 2026-09-29: PR #79 (onda 1 + 63 + 74) mergeado por squash (`c5b16fc`); `merge -s ours origin/main`
  na integ (3d0ef03). **Onda 2 retomada** por 3 agentes, cada um trouxe a integ antes. Integração:
  67 sem conflito; 69 × 67 (ConversationPanel/index/DECISIONS + spec com `onAttach`); 68 × 67/69
  (6 arquivos; área de mensagens reconstruída sobre a drop area do 69 + 3 mudanças do 68; spec
  `onAttach` e `useRef`). Suíte completa verde (back 1795, front 1486), CI verde, hml `hml-deb5132`.
  Massa: `simula-onda1.sh base|ao-vivo|tiques|presenca|limpar`.
- 2026-09-29 ~15h: **onda 3 iniciada** a pedido do Michel. Antes, merge da `origin/main` (#81 do
  CRMLAB-75 + bump v1.24.0) na `integ/epic-65`, sem conflito (25b2eee). Worktrees `../CRM Lab-70|73|64`
  saindo de 25b2eee, com `node_modules/` real (`@crm-lab/*` → pacotes do próprio worktree) e `*.wt.*`.
  Cards 70/73/64 → Em Desenvolvimento; 3 agentes disparados. Para evitar conflito no `MessageBubble`:
  70 = componentes novos por tipo + despacho; 64 = só o trecho da imagem (lightbox sobe p/ ConversationPanel);
  73 = só o trecho do texto (parser). Conflito provável na junção: `MessageBubble.tsx`, `DECISIONS.md`,
  `COMPONENTS.md`. **Se a sessão cair:** seguir "Como retomar" com o prompt da onda 3 + "continue do diário".
