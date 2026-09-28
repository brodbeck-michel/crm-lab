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

| Card | Fase | Último commit | Observação |
|---|---|---|---|
| 66 [A] | 🔄 disparado (onda 1) | — | |
| 71 [F] | 🔄 disparado (onda 1) | — | |
| 72 [G] | 🔄 disparado (onda 1) | — | |
| 67 [B] | ⬜ aguarda onda 2 | — | |
| 68 [C] | ⬜ aguarda onda 2 | — | |
| 69 [D] | ⬜ aguarda onda 2 | — | |
| 70 [E] | ⬜ aguarda onda 3 | — | |
| 73 [H] | ⬜ aguarda onda 3 | — | |
| 64    | ⬜ aguarda onda 3 | — | |

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
