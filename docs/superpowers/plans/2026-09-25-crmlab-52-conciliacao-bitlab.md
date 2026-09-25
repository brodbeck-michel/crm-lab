# CRMLAB-52 — Conciliação com o LIS pela API do Bitlab

Card: https://brodbeckmichelatlassian.atlassian.net/browse/CRMLAB-52
Decisões: D-119, D-185, D-186, D-187 (`docs/DECISIONS.md`).
Branch/worktree: `feature/CRMLAB-52-conciliacao-bitlab` em `../CRM Lab-52`.

## Fase 0 — contratos (este commit)

- `DECISIONS.md`: D-119 (escrita pela primeira vez; estava só no spec da fusão) e D-185..D-187.
- `SCHEMA.md` §25 (`kind: 'sync'`), §31 (`lis_sync_settings`), RLS e exceção do agendador.
- `API_CONTRACTS.md` §3 (`PATCH /proposals/:id/lis-reference`, campos `lis*`), §5
  (`realized`), §10.1 (purge bloqueado, `proposalsWon`), §10.3 (Integração LIS).
- `API_ERRORS.md` (motivos de `CONFLICT`), `SERVICES.md` §4/§19/§24/§24.1/§25,
  `BUSINESS_RULES.md` §3/§11.10, `WORKFLOWS.md` §4, `PAGES.md` §6/§8/§20, `SECURITY.md`,
  `DEPLOYMENT.md`, `ENVIRONMENTS.md`.
- `shared/types/lis.types.ts`: só tipos **novos** (§10.3). Os campos novos em `Proposal`,
  `ProposalDetail` e `FunnelReport` entram no commit do PR 2, junto com o código que os
  preenche, para o typecheck não quebrar no meio (mesmo cuidado da Fase 0 da Onda 7).

## PR 1 — sincronização pela API (não depende da chave)

1. `backend/migrations/026_lis_sync.sql` + teste de RLS com 2 tenants.
2. `lib/bitlab-client.ts`: zod do envelope, tolerâncias de §24.1, `bitlabDateToIsoDate` (D-187),
   mapeamento §11.10, erros → `LisSyncErrorKind`. Testes com respostas gravadas do manual
   (LISTA, SEM_RESULTADOS, 400 ×2, 403 texto, array, número como string, `avisos[]`).
3. `LisImportService.ingestRows` extraído de `import` (sem mudar comportamento: a suíte atual
   da planilha tem que continuar verde sem alteração).
4. `lis-sync-settings.repository.ts` (projeção explícita, `resolveApiKey`,
   `listEnabledTenantIds` via `withoutTenant`) e `lis-sync.service.ts`.
5. Rotas `/settings/lis-integration` + inventário de isolamento + `env.ts`
   (`BITLAB_API_BASE_URL`, `LIS_SYNC_INTERVAL_MS`, `LIS_SYNC_INITIAL_DAYS`) + agendador no
   `main.ts`.
6. `scripts/homolog-sincroniza-dados.sh`: `UPDATE lis_sync_settings SET enabled = FALSE,
   api_key = NULL` junto do `tenant_channels`. `.env` de hml com `LIS_SYNC_INTERVAL_MS=0`.
7. Frontend `/settings/lis-integration` (PAGES §20) + item na sidebar + `route-config.spec`.
   Rótulo "API" para `kind: 'sync'` no histórico de importações.

## PR 2 — conciliação nas propostas

1. Tipos: `Proposal.lisBudgetNumber/lisReconciledAt`, `ProposalDetail.lisRequisitionNumber/
   lisPaidValue/lisPaidOn`, `FunnelReport.realized`.
2. `ProposalService.transitionInTx` extraído de `updateStatus`, e `markWonFromLis`.
3. `lis-reconcile.service.ts` + hook por chunk em `ingestRows` + `setLisReference` + rota.
4. Purge bloqueado com vínculo.
5. `analytics.repository.ts` → `realized`.
6. Frontend: campo no `ProposalModal`, selo no modal e no `ProposalCard`, cartão em `Analytics`.
7. Testes (spec da fusão, Onda 13): PATCH (conflito, closed, perdido aceito, normalização);
   import/sync → ganho com histórico/audit/WS; `novo_contato` → ganho; `perdido` não reabre e
   audita uma vez; pagamento sem requisição não muda status; idempotência (rodar 2x);
   isolamento entre tenants; PATCH depois do orçamento já importado concilia na hora.

## Quando o Bitlab reativar a chave

1. **Primeiro teste fora do CRM**, só leitura, janela pequena, com saída mascarada (CPF,
   nascimento e nome nunca no terminal):
   `tamanhoPagina: 3`, `tipoData: "alteracao"`, últimos 3 dias.
2. Conferir contra §24.1, linha por linha: envelope objeto (não array), tipos de `ORCAMENTO`,
   `VL_TOTAL*`, `Valor_Pago` e `REQUISICAO`, formato de `marcaDagua`, se `dataInicio` aceita a
   marca convertida, se a comparação é `>=` ou `>`, e os headers `X-API-*`. Emendar §24.1 e
   BUSINESS_RULES §11.10 no que divergir.
3. Resposta sobre o fuso → emendar D-187 (e `bitlabDateToIsoDate`, se for UTC real).
4. Bitlab confirmou a restrição ao IP `2.25.227.155`? Só então colar a chave em **produção**:
   Configurações → Integração LIS → Salvar chave → ligar → [Sincronizar agora].
5. Comparar o resultado com a última planilha importada (mesmo período): totais de
   Orçado/Recebido em `/results` devem bater.
