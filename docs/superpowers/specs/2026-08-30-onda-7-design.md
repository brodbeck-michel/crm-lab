# Spec — Onda 7: Convênios/TUSS no catálogo, conexão WhatsApp por QR e fechamento de pendências

**Data:** 2026-08-30
**Status:** Aprovado pelo lead técnico (design em chat, 2026-08-30). Aguardando plano de execução.
**Coordenador:** sessão principal (Claude) · Execução multiagente com validadores independentes.

---

## 1. Contexto e objetivo

A Onda 6 fechou paciente e operação. O negócio pede agora (solicitação formal da integração
Bitlab, Fase 1 — Trilha A da proposta em `docs/STATUS.md`) que o catálogo de exames deixe de
ter um único `price_insurance` e passe a modelar **convênio como entidade**, **preço por
convênio com código TUSS/AMB**, **sinônimos** e **material/recipiente** — preparando o terreno
para o espelhamento do LIS sem depender da resposta do Bitlab. Em paralelo, o produto quer que
o laboratório conecte o WhatsApp do próprio número **sem a API oficial da Meta**: um botão na
tela, um QR code, e o CRM passa a receber e enviar mensagens daquele número. A onda também
fecha as pendências mecânicas herdadas das ondas anteriores.

Três blocos: **A** (catálogo), **B** (WhatsApp QR), **C** (pendências).

## 2. Decisões aprovadas pelo lead (2026-08-30)

| # | Decisão | Escolha |
|---|---------|---------|
| 1 | Caminho técnico do WhatsApp sem API oficial | **Evolution API** (gateway self-hosted, Docker) — não Baileys embutido, não WAHA |
| 2 | Tratamento do risco de ToS/banimento | **Com salvaguardas**: termo de aceite explícito e auditado na UI, rate-limit de envio, sem disparo em massa, risco registrado em DECISIONS e SECURITY |
| 3 | Recorte do catálogo | Convênios + TUSS/AMB + sinônimos + **material/recipiente**. **Painéis/composição ficam FORA** — registrados como pendência por comportamento ("exame composto não expande no orçamento") para a Onda 8 |
| 4 | Orçamento sem preço para o convênio escolhido | **Cai no particular** (`price_private`) com marcação visível no item (`priceSource`) |

## 3. Bloco A — Catálogo: convênios, TUSS/AMB, sinônimos e material

### 3.1 Schema (migração `005_insurances_and_catalog.sql` + `006_rls_onda7.sql`)

Três tabelas novas, todas com `tenant_id NOT NULL`, FK para `tenants(id) ON DELETE CASCADE`,
trigger de `updated_at` e **RLS fail-closed na mesma leva** (lição da Onda 6: tabela sem
policy não trava, vaza).

**`insurances`** — convênio do laboratório:

```sql
CREATE TABLE insurances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  name VARCHAR(255) NOT NULL,            -- nome usual: "Unimed Tubarão"
  official_name VARCHAR(255),            -- razão social, opcional
  ans_code VARCHAR(20),                  -- registro ANS, opcional (SC Saúde não tem)
  type VARCHAR(30) NOT NULL,             -- CHECK: cooperativa|medicina_grupo|seguradora|autogestao|especial
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  UNIQUE (tenant_id, name)
);
```

- **"Particular" NÃO é linha** de `insurances`. Particular = ausência de convênio
  (`insurance_id NULL` na proposta). Um convênio fantasma exigiria espelhar `price_private`
  em `exam_prices` — segunda origem para o mesmo número (BUSINESS_RULES §5).
- Sem `DELETE` — desativação por `PATCH { isActive: false }` (mesmo padrão do catálogo, D-004).

**`exam_prices`** — preço por (exame, convênio). É a tabela que o Bitlab espelhará na Fase 1:

```sql
CREATE TABLE exam_prices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  exam_id UUID NOT NULL,
  insurance_id UUID NOT NULL,
  price NUMERIC(12,2) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (exam_id) REFERENCES exam_catalog(id) ON DELETE CASCADE,
  FOREIGN KEY (insurance_id) REFERENCES insurances(id) ON DELETE CASCADE,
  UNIQUE (tenant_id, exam_id, insurance_id)
);
```

**`exam_synonyms`** — nomes alternativos para busca:

```sql
CREATE TABLE exam_synonyms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  exam_id UUID NOT NULL,
  synonym VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (exam_id) REFERENCES exam_catalog(id) ON DELETE CASCADE,
  UNIQUE (tenant_id, exam_id, synonym)
);
```

**Colunas novas em tabelas existentes:**

| Tabela | Coluna | Tipo | Notas |
|--------|--------|------|-------|
| `exam_catalog` | `tuss_code` | `VARCHAR(10) NULL` | Código TUSS (tabela 22), 8 dígitos. NULL = não informado, nunca inventado |
| `exam_catalog` | `amb_code` | `VARCHAR(20) NULL` | Código AMB legado, para o de-para do faturamento |
| `exam_catalog` | `material` | `VARCHAR(255) NULL` | Ex.: "Sangue — tubo tampa roxa (EDTA)" |
| `exam_catalog` | `source` | `VARCHAR(20) NOT NULL DEFAULT 'manual'` | CHECK `manual\|lis`. Nesta onda só existe e é exibida; a sincronização LIS decide por ela quem vence numa edição concorrente (onda futura, pós-resposta Bitlab) |
| `proposals` | `insurance_id` | `UUID NULL` | FK `insurances(id)`. NULL = particular |
| `proposal_items` | `price_source` | `VARCHAR(20) NOT NULL DEFAULT 'private'` | CHECK `insurance\|private`. Snapshot: com que origem o `unit_price` foi resolvido (D-004) |
| `tenant_channels` | `connection_mode` | `VARCHAR(20) NOT NULL DEFAULT 'cloud_api'` | CHECK `cloud_api\|qr` (Bloco B) |
| `tenant_channels` | `accepted_terms_at` | `TIMESTAMP NULL` | Aceite do termo de risco (Bloco B) |
| `tenant_channels` | `accepted_terms_by` | `UUID NULL` | FK `users(id)`; quem aceitou (Bloco B) |

**`exam_catalog.price_insurance` (coluna única atual):** entra no passo 1 da regra dos 3
passos de AGENTS.md — **permanece nesta onda**, deixa de ser exibida/editável na UI, e a
remoção (passo 3) fica para onda futura, registrada como pendência com dono. Nenhum contrato
de leitura existente quebra.

### 3.2 Busca com sinônimos (comportamento, não tela)

`?search=` de `GET /exams` passa a casar **nome, código E sinônimo**, com a mesma dobra de
caixa/acento já existente (`folded()` em `exam.repository.ts` — `translate + lower`, porque
`unaccent` não existe no PGlite). Implementação: `EXISTS (SELECT 1 FROM exam_synonyms s WHERE
s.tenant_id = e.tenant_id AND s.exam_id = e.id AND folded(s.synonym) LIKE ...)` como terceiro
ramo do `OR`. Por ser comportamento do endpoint, vale automaticamente para `/catalog`,
`/budget/new` e qualquer consumidor futuro — a lição da D7/D-080 (pendência se nomeia pelo
comportamento) aplicada na origem.

### 3.3 Resolução de preço no orçamento

- `POST /proposals` ganha `insuranceId?: string | null` (NULL/ausente = particular).
- Preço unitário do item: `exam_prices(exam_id, insurance_id)` quando a proposta tem convênio
  e a linha existe; senão `price_private`. A origem usada vira snapshot em
  `proposal_items.price_source`.
- O fallback **nunca bloqueia** o orçamento (decisão 4). A UI marca o item com badge
  "particular" quando `priceSource === 'private'` numa proposta com convênio.
- Continuam intactos: total 100% calculado no backend (`calculateTotal` de shared), snapshot
  de `exam_name`/`unit_price` (D-004), alçada e transições. `resolveActiveByIds` ganha a
  variante com convênio (ou parâmetro opcional `insuranceId`) e **continua sem ler cache**
  (preço nunca sai obsoleto).
- `PATCH` de proposta **não permite trocar `insuranceId`** após a criação nesta onda (troca
  de convênio re-precificaria itens com snapshot — comportamento novo que exigiria decisão
  própria; registrar como limitação em API_CONTRACTS).

### 3.4 API (contratos a escrever na Fase 0, shapes em `shared/types/`)

**Módulo novo `/insurances`** (`insurance.routes.ts`, mesmo padrão de `/exams`):

| Endpoint | Papéis | Resposta |
|----------|--------|----------|
| `GET /insurances` (`?active`, `?search`, paginação padrão) | todos do tenant | `{ insurances, pagination }` (D-009) |
| `POST /insurances` | manager/admin | `Insurance` cru (D-070) |
| `PATCH /insurances/:id` | manager/admin | `Insurance` cru |

`requireAuth()` + `denyPlatformOperator()` em todas; rota entra no inventário de isolamento
(`route-tenant-isolation.spec.ts`, meta-teste exige declaração). Nome duplicado → `CONFLICT`
(corrida coberta por `isUniqueViolation`, como no catálogo).

**Extensões em `/exams`:**

- Shape `Exam` ganha `tussCode`, `ambCode`, `material`, `source`, `synonyms: string[]`
  (sinônimos gravados/regravados na tabela filha na mesma transação do POST/PATCH; enviar
  `synonyms` no PATCH substitui o conjunto — semântica de PUT sobre a coleção filha).
- `GET /exams?insuranceId=<uuid>` acrescenta a cada item `effectivePrice: number` e
  `priceSource: 'insurance' | 'private'` — é o que o seletor do orçamento consome. Sem o
  parâmetro, os dois campos não aparecem (aditivo, backward compatible).
- A chave de cache da listagem incorpora `insuranceId` (`exam-catalog.service.ts`,
  `listCacheKey`); mutação de `exam_prices` e de `insurances` invalida o prefixo
  `exams:<tenantId>:` existente.

**Preços do exame:**

| Endpoint | Papéis | Semântica |
|----------|--------|-----------|
| `GET /exams/:id/prices` | todos do tenant | `{ prices: ExamPrice[] }` — uma linha por convênio cadastrado |
| `PUT /exams/:id/prices` | manager/admin | Upsert em lote: `{ prices: [{ insuranceId, price }] }`. Linha ausente do corpo é removida (PUT = estado completo). Auditado |

**Regras herdadas que se aplicam sem exceção:** dinheiro como número decimal no fio;
`BusinessError` tipada; recurso de outro tenant → `NOT_FOUND`; auditoria em criação/edição de
convênio e preço; `MAX_PAGE` (o módulo novo já nasce com teto — ver Bloco C).

### 3.5 UI

| Tela | Mudança |
|------|---------|
| **Convênios** (`/settings/insurances`, NOVA) | Tabela + modal CRUD (nome, oficial, ANS, tipo, ativo). Manager/admin. Segue `route-config.ts` + `routes/index.tsx` |
| **Catálogo** (`/catalog`) | Colunas TUSS e material na tabela; no `ExamModal`: campos TUSS/AMB/material, chips de sinônimos (adicionar/remover), aba "Preços por convênio" (grid convênio × preço sobre `GET/PUT /exams/:id/prices`); badge de `source` (Manual/LIS) somente leitura |
| **Novo Orçamento** (`/budget/new`) | Seletor de convênio no topo (default Particular); lista de exames passa a pedir `?insuranceId=` e exibe `effectivePrice`; item com `priceSource: 'private'` em proposta com convênio ganha badge "particular"; convênio escolhido viaja no `POST /proposals` |
| **Pipeline/Modal de proposta** | Exibe o convênio da proposta (ou "Particular") no cabeçalho e o badge de origem por item |

Zero token cru (o spec `no-hardcoded-tokens.spec.ts` varre `pages/` e `components/`); dado de
servidor só via TanStack Query com chaves novas em `query-keys.ts`.

### 3.6 Seed genérico (dev + e2e)

- **Convênios** (Apêndice A): ~17 nacionais + 4 regionais SC ativos, com nome usual, razão
  social, tipo e ANS quando confirmado. Agemed **não entra** (liquidação extrajudicial ANS,
  out/2020). SC Saúde entra como `especial` (plano estadual fora da regulação ANS). Cada
  Unimed é convênio próprio (sistema de ~340 cooperativas independentes).
- **TUSS/sinônimos** (Apêndices B e C): os 106 exames do seed atual são enriquecidos com os
  códigos TUSS confirmados (~60) e sinônimos. Hormônios **sempre** no subgrupo `40316xxx`
  (nunca os `40712xxx` de radioimunoensaio das tabelas antigas). Código não confirmado na
  pesquisa fica `NULL` com nota no seed — **nunca inventado**.
- **Preços por convênio**: NÃO são semeados no dev (dado contratual de cada laboratório).
  Exceção: o seed **e2e** grava 2-3 linhas de `exam_prices` em `lab-vida` (constantes em
  `e2e-fixtures.ts`) para os testes de resolução de preço e fallback.
- Seeds continuam idempotentes e recusando `NODE_ENV=production`.

## 4. Bloco B — Conexão WhatsApp por QR (Evolution API)

### 4.1 Arquitetura

- **Gateway separado do backend**, nunca lib embutida: serviço `evolution` no
  `docker-compose.yml` (dev) e `docker-compose.prod.yml`, usando o Postgres e o Redis já
  existentes. Sessões WhatsApp são stateful e de vida longa; o backend Express continua
  stateless e reiniciável. Patch de protocolo da Meta = trocar a tag da imagem, sem redeploy
  do CRM.
- **Versão fixada** da imagem. Escolha: última **2.4.x** estável, com a ativação gratuita de
  licença da Evolution Foundation documentada em DECISIONS como dependência operacional
  (heartbeat a cada 30 min contra o servidor deles); a **v2.3.7** (última sem ativação) fica
  registrada como fallback se essa dependência virar problema.
- **Cada tenant = uma instância** nomeada no gateway (`tenant-<uuid>`), com apikey e webhook
  próprios. A apikey da instância é gravada **cifrada** em `tenant_channels.api_token`
  (AES-256-GCM via `secret-box.ts`, chave em `CHANNEL_SECRET_KEY` — infra da Onda 6 reusada;
  write-only, máscara no SQL, `''` sentinela de revogação).
- `tenant_channels` ganha `connection_mode VARCHAR(20) NOT NULL DEFAULT 'cloud_api'`
  (CHECK `cloud_api|qr`) e `accepted_terms_at TIMESTAMP NULL` + `accepted_terms_by UUID NULL`
  (o aceite é dado do canal, não só do audit log — a UI precisa saber se já foi aceito).
- Env vars novas (validadas em `env.ts`, documentadas em `.env.example`):
  `EVOLUTION_API_URL`, `EVOLUTION_API_KEY` (chave global de administração do gateway),
  `EVOLUTION_WEBHOOK_TOKEN` (segredo que o gateway envia nos webhooks para o CRM). Ausentes
  ⇒ funcionalidade desligada com erro claro (`CHANNEL_QR_UNAVAILABLE`), nunca crash.

### 4.2 Fluxo de conexão (UX)

1. Admin abre **Canais & Equipe** → card WhatsApp → botão **"Conectar WhatsApp"**.
2. Modal com o **termo de aceite** (obrigatório, checkbox): risco de banimento permanente do
   número, violação dos ToS do WhatsApp, recomendação de número dedicado (não o pessoal),
   necessidade de abrir o app no celular a cada ~14 dias, e que mensagens transitam pelo
   gateway do CRM (a cifra fim-a-fim termina no dispositivo vinculado). Aceite grava
   `accepted_terms_at/by` + audit log `accept_whatsapp_qr_terms`.
3. Backend: `POST /settings/channels/whatsapp/connect` → cria/reaproveita a instância no
   Evolution (`POST /instance/create` + `GET /instance/connect`) → devolve o QR
   (`{ qrcode: string /* base64 PNG */, expiresInSeconds }`).
4. Modal exibe o QR; o QR expira em ~20s e o gateway emite renovações via webhook
   `QRCODE_UPDATED` → o frontend faz **polling de ~2s** em `GET /settings/channels/whatsapp/qr`
   até `status: connected` ou timeout (~90s), com botão "Gerar novamente".
5. A pessoa abre WhatsApp no celular → Dispositivos conectados → escaneia. Conectado:
   webhook `CONNECTION_UPDATE` → CRM grava `connected_at`, `phone_number` informado pelo
   gateway, `connection_mode = 'qr'`, `is_active = true`.
6. **Desconexão**: botão "Desconectar" → `POST /settings/channels/whatsapp/disconnect`
   (logout da instância + limpa estado); ou a pessoa remove o dispositivo no celular →
   gateway emite `loggedOut` → CRM marca desconectado e a UI mostra "Reconectar". Banimento
   aparece pelo mesmo caminho (`loggedOut`) — a UI não distingue, o termo de aceite avisa.

**Endpoints novos** (todos admin, auditados, `denyPlatformOperator()`, no inventário de
isolamento):

| Endpoint | Semântica |
|----------|-----------|
| `POST /settings/channels/whatsapp/connect` | Exige aceite prévio (ou `acceptTerms: true` no corpo). Cria instância, devolve QR. Idempotente: reconectar reaproveita a instância |
| `GET /settings/channels/whatsapp/qr` | QR vigente + status (`pairing \| connected \| disconnected`). Alimenta o polling |
| `GET /settings/channels/whatsapp/status` | Status do canal (para o card, sem QR) |
| `POST /settings/channels/whatsapp/disconnect` | Logout da instância no gateway + atualiza canal |

### 4.3 Recebimento e envio

- **Webhook novo público** `POST /webhooks/evolution/:tenant` (+ variante de status), no
  `webhook.routes.ts` existente: autentica por `EVOLUTION_WEBHOOK_TOKEN` (comparação em tempo
  constante) + kill switch `is_active` antes de tudo (D-074); traduz `MESSAGES_UPSERT` /
  `CONNECTION_UPDATE` / `QRCODE_UPDATED` para os DTOs internos existentes e **reusa o caminho
  inteiro**: `findOrCreateByPhone` → `createFromPatient` (dedupe por `externalId`, unread,
  `last_message_at`, WS). Resposta sempre `200 { received: true }`; try/catch por mensagem.
  A tela de Atendimento não muda.
- **Envio**: novo `EvolutionWhatsAppDriver` ao lado do mock e do HTTP/Meta, falando
  `POST {EVOLUTION_API_URL}/message/sendText/{instance}` com a apikey da instância
  (via `resolveCredentials`). A escolha do driver por tenant vem de
  `tenant_channels.connection_mode` (resolvida no `WhatsAppCredentialsResolver`, que já
  existe para isso — D-024/D-032). Retry 3× da fila continua.
- **Salvaguarda anti-ban no envio**: espaçamento mínimo configurável entre envios por tenant
  (default ~1.5s, jitter) aplicado na fila; **nenhum endpoint de disparo em massa** existe ou
  entra. Registrado em DECISIONS.
- **Teste**: driver e webhook cobertos por um **gateway fake** (servidor HTTP de teste que
  responde como o Evolution) — mesmo padrão do driver mock atual. O pareamento QR real só é
  verificável manualmente com um número de verdade; isso fica documentado como verificação
  manual no plano, não como teste automatizado.

### 4.4 Segurança e LGPD

- Nota em `docs/architecture/SECURITY.md`: risco de ToS/ban, dado de saúde transitando pelo
  gateway self-hosted (cifra fim-a-fim termina no dispositivo vinculado = nosso gateway),
  apikey por instância cifrada em repouso, webhook autenticado, aceite auditado.
- O HMAC com `rawBody` (Bloco C, item 1) é pré-requisito desta onda: o webhook Evolution já
  nasce verificando token sobre os bytes reais.

## 5. Bloco C — Pendências fechadas nesta onda

Todas com teste que falharia antes da correção (exceto as puramente documentais):

| # | Pendência | Correção |
|---|-----------|----------|
| 1 | HMAC sobre JSON reserializado (aberta desde a Onda 3) | `express.json({ limit: '1mb', verify: (req,_res,buf) => { req.rawBody = buf } })` em `app.ts`; `rawBodyOf` já prefere `req.rawBody`. Teste: corpo com ordem de chaves/escape que diverge da reserialização passa a validar |
| 2 | `page` sem teto | `MAX_PAGE = 10_000` em `conversation`, `exam-catalog`, `platform` **e `internal-chat`** (mesmo comportamento, não estava na lista — pendência nomeada pelo comportamento) |
| 3 | `MetricTile` percent fora do pt-BR | `Intl.NumberFormat('pt-BR', { style: 'percent' })`; spec atualizado (hoje fixa o defeito à vista) |
| 4 | Comentário obsoleto em `flow-7` | Remover a afirmação falsa ("carrega só a 1ª página") |
| 5 | `oldestWaitSeconds`: ordenação é contrato | Escrever em `SERVICES.md` §14 que `ORDER BY espera DESC NULLS FIRST` é contrato |
| 6 | `user.came_online` sem emissor | **Remover** de `websocket.types.ts` e o `case` de `ws.ts` — contrato mentiroso sai; se presença virar feature, volta com service junto. Registrar em DECISIONS |
| 7 | `message` pt-BR em `POST /proposals` | Remover do tipo compartilhado, do service e do doc no mesmo commit; texto vai para a tela (i18n é do frontend, D-070) |

**Ficam fora, re-registradas com dono e motivo:** rotação de `CHANNEL_SECRET_KEY` (produto +
infra: exige versionamento de chave e re-cifra); reescrita do texto de mensagens na
anonimização LGPD (jurídico: destruiria histórico de terceiros); normalização E.164 de
telefone (mudaria a chave de dedupe — exige migração de dados própria); exames inativos do
`flow-12` (é o desenho, D-004). **Nova pendência registrada:** painéis/composição de exames
("exame composto não expande no orçamento — orçamento pode nascer incompleto ou com item
duplicado") — Onda 8; e remoção de `exam_catalog.price_insurance` (passo 3 da regra dos 3
passos).

## 6. Fora de escopo desta onda

- Qualquer integração real com o Bitlab (sem resposta deles, não há contrato — Regra Zero).
  A coluna `source` e a estrutura de preços apenas **preparam** o espelhamento.
- Sincronização agendada/scheduler (não existe infraestrutura de job recorrente; entra com a
  integração LIS).
- Painéis/composição, troca de convênio em proposta existente, disparo em massa, presença
  (`user.came_online`), merge de pacientes.

## 7. Execução multiagente

Formato da Onda 6: fases sequenciais; dentro da fase, agentes em paralelo que **nunca
escrevem no mesmo arquivo** (exceções conhecidas: `src/http/modules.ts` e
`frontend/src/routes/index.tsx`, uma linha por agente, conflito resolvido pelo coordenador).

| Fase | Agentes | Entrega |
|------|---------|---------|
| **0 — Contrato (bloqueante)** | `Agent-Docs-Onda7` | API_CONTRACTS (§4 estendido, §6 conexão QR, §8 novo /insurances), SCHEMA §18+, SERVICES §15-§16, `shared/types/{insurance,exam,channel}`, DECISIONS D-081+. Nenhuma implementação antes (Regra Zero) |
| **1 — Banco (bloqueante)** | `Agent-DB-Onda7` | Migrações 005/006, colunas novas, RLS fail-closed provada com 2 tenants, seeds enriquecidos (Apêndices A-C), fixtures e2e. Teste de migração sobre banco montado só com 001-004 |
| **2 — Implementação (paralela)** | `Agent-API-Insurances` (módulo /insurances + preços + sinônimos na busca + extensões /exams) · `Agent-API-Proposals7` (insuranceId + resolução/fallback + snapshot) · `Agent-API-Channel-QR` (driver Evolution + endpoints connect/qr/status/disconnect + webhook) · `Agent-Kernel-RawBody` (C1) · `Agent-Fix-Pendencias` (C2-C7) · `Agent-UI-Catalog7` (Convênios + Catálogo) · `Agent-UI-Budget7` (seletor + badges) · `Agent-UI-Connect` (modal QR + termo) · `Agent-Infra7` (compose + env + CI) |
| **3 — Verificação (paralela)** | `Agent-QA-Onda7` | E2E: convênio no orçamento com fallback, sinônimo na busca, CRUD convênio, conexão simulada (gateway fake), inventário de isolamento 39 → ~44 rotas |
| **4 — Validação independente** | `Validador-Contratos` · `Validador-Segurança` · `Validador-Verificação` | Sem participação na implementação; achados classificados viram tarefas `Agent-Fix-*` |
| **5 — Correções e fechamento** | Coordenador + `Agent-Fix-*` | Coordenador roda a **suíte inteira** (typecheck, lint, backend, frontend, E2E completo com banco resemeado) antes de declarar fechado |

**Critério de pronto da onda:** suíte completa verde rodada pelo coordenador; docs
atualizados; zero mock ativo; pendências fechadas ou re-registradas com dono; STATUS.md
atualizado.

## 8. Riscos aceitos e registrados

| Risco | Mitigação/registro |
|-------|--------------------|
| Banimento do número WhatsApp (ToS) | Termo de aceite auditado, número dedicado recomendado, rate-limit de envio, sem disparo em massa. Decisão de produto consciente (lead, 2026-08-30) |
| Dependência do servidor de licenças da Evolution (≥2.4.0) | Versão fixada; fallback documentado para v2.3.7; gateway é substituível (WAHA fala protocolo análogo) por trás do driver |
| Protocolo da Meta muda e o gateway quebra | Atualização = trocar tag da imagem; nada no código do CRM |
| Pareamento QR real não é testável em CI | Gateway fake nos testes; verificação manual documentada no plano |
| Dado de saúde transita pelo gateway | Nota em SECURITY.md; gateway self-hosted (nada sai para terceiros); segredos cifrados |

---

## Apêndice A — Seed de convênios

Fontes: dados ANS (competência mar/2026) via pesquisa de 2026-08-30 (URLs no fim). `ans_code`
NULL onde não confirmado.

**Nacionais** (`type` entre parênteses):

| name | official_name | type | ans_code |
|------|---------------|------|----------|
| Hapvida | Hapvida Assistência Médica Ltda. | medicina_grupo | 368253 |
| NotreDame Intermédica | Notre Dame Intermédica Saúde S.A. | medicina_grupo | 359017 |
| Bradesco Saúde | Bradesco Saúde S.A. | seguradora | 005711 |
| Amil | Amil Assistência Médica Internacional S.A. | medicina_grupo | 326305 |
| SulAmérica | Sul América Companhia de Seguro Saúde | seguradora | 006246 |
| Seguros Unimed | Unimed Seguros Saúde S.A. | seguradora | — |
| Porto Seguro Saúde | Porto Seguro – Seguro Saúde S.A. | seguradora | — |
| Cassi | Caixa de Assistência dos Funcionários do Banco do Brasil | autogestao | — |
| Prevent Senior | Prevent Senior Private Operadora de Saúde Ltda. | medicina_grupo | — |
| Assim Saúde | Assim Saúde | medicina_grupo | — |
| GEAP | GEAP Autogestão em Saúde | autogestao | — |
| Saúde Caixa | Plano dos empregados da Caixa Econômica Federal | autogestao | — |
| Postal Saúde | Caixa de Assistência dos Empregados dos Correios | autogestao | — |
| Saúde Petrobras | Associação Petrobras de Saúde – APS | autogestao | — |
| Care Plus | Care Plus Medicina Assistencial Ltda. | medicina_grupo | 379956 |
| Omint | Omint Serviços de Saúde Ltda. | medicina_grupo | 359661 |

**Regionais SC** (relevantes para a região do laboratório):

| name | official_name | type | ans_code | Nota |
|------|---------------|------|----------|------|
| Unimed Tubarão | Unimed de Tubarão Cooperativa de Trabalho Médico | cooperativa | 364860 | ~56 mil beneficiários (região AMUREL) |
| Unimed Grande Florianópolis | Unimed Grande Florianópolis Coop. de Trabalho Médico | cooperativa | — | |
| SC Saúde | Sistema de Assistência à Saúde dos Servidores de SC | especial | — | Plano estadual FORA da regulação ANS (~200 mil vidas) |
| Celos Saúde | Fundação Celesc de Seguridade Social | autogestao | 315044 | |

**Não incluir:** Agemed (liquidação extrajudicial ANS, out/2020). Cada Unimed é convênio
próprio (sistema de ~340 cooperativas com registro ANS individual). "Particular" não é linha.

## Apêndice B — Códigos TUSS confirmados (seed do catálogo)

TUSS = Terminologia Unificada da Saúde Suplementar (padrão TISS/ANS, tabela 22) — código
obrigatório na guia SP/SADT ao faturar convênio. AMB/CBHPM = tabelas de nomenclatura e
valoração usadas como referência de preço nos contratos; a TUSS deriva da CBHPM (grupo 4.03 =
Medicina Laboratorial). **Regra do seed: hormônios pelos códigos `40316xxx` (vigentes), nunca
`40712xxx` (radioimunoensaio legado). Código não confirmado fica NULL.**

| Exame | TUSS |
|-------|------|
| Hemograma completo | 40304361 |
| VHS | 40304370 |
| Tempo de protrombina (TP) | 40304590 |
| TTPA | 40304639 |
| Coagulograma | 40304922 |
| Grupo sanguíneo ABO+Rh | 40304299 |
| Coombs direto / indireto | 40304108 / 40304884 |
| Dímero D | 40304906 |
| Glicose | 40302040 |
| Hemoglobina glicada | 40302733 |
| Curva glicêmica (TOTG) | 40301680 |
| Colesterol total / HDL / LDL / VLDL | 40301605 / 40301583 / 40301591 / 40302695 |
| Triglicerídeos | 40302547 |
| Creatinina / clearance | 40301630 / 40301508 |
| Ureia | 40302580 |
| Ácido úrico | 40301150 |
| TGO (AST) / TGP (ALT) | 40302504 / 40302512 |
| Gama-GT | 40301990 |
| Fosfatase alcalina | 40301885 |
| Bilirrubinas | 40301397 |
| Sódio / Potássio | 40302423 / 40302318 |
| Cálcio (iônico) | 40301400 (40301419) |
| Magnésio | 40302237 |
| Ferro sérico | 40301842 |
| Vitamina D 25-OH | 40302830 |
| Eletroforese de proteínas | 40301761 |
| TSH | 40316521 |
| T4 livre / T4 / T3 / T3 livre | 40316491 / 40316548 / 40316556 / 40316467 |
| Cortisol | 40316190 |
| Insulina | 40316360 |
| Prolactina | 40316416 |
| Testosterona total / livre | 40316513 / 40316505 |
| Estradiol | 40316246 |
| FSH / LH | 40316289 / 40316335 |
| Progesterona | 40316408 |
| Beta-HCG | 40316327 |
| Ferritina | 40316270 |
| Vitamina B12 | 40316572 |
| PSA total / livre | 40316149 / 40316130 |
| Urina tipo I (EAS) | 40311210 |
| Urocultura | 40310213 |
| Antibiograma | 40310027 |
| Parasitológico de fezes (col. múltipla) | 40303110 (40303128) |
| Sangue oculto nas fezes | 40303136 |
| HIV 1+2 | 40307182 |
| VDRL | 40307760 |
| FTA-ABS IgG / IgM | 40307735 / 40307743 |
| HBsAg / Anti-HBs | 40307018 / 40306992 |
| Anti-HCV | 40307026 |
| Toxoplasmose IgG / IgM | 40307824 / 40307832 |
| Rubéola IgG / IgM | 40307697 / 40307700 |
| Citomegalovírus IgG / IgM | 40306666 / 40306674 |
| Dengue IgG/IgM | 40306798 |
| COVID-19 RT-PCR | 40314618 |
| PCR (proteína C reativa) | 40307646 |
| Espermograma | 40309312 |

## Apêndice C — Sinônimos (seed de `exam_synonyms`)

Seleção principal (lista completa no seed; variações regionais marcadas):

| Exame | Sinônimos |
|-------|-----------|
| Hemograma completo | sangue completo, exame de sangue, hemograma com plaquetas, HMG, CBC |
| Glicose | glicemia, glicemia de jejum, açúcar no sangue, dextro |
| Hemoglobina glicada | glicada, HbA1c, A1c, hemoglobina glicosilada |
| Triglicerídeos | triglicérides, triglicerídios, TG |
| Perfil lipídico | lipidograma, colesterol completo, colesterol fracionado |
| TSH | tireoide, exame da tireoide, TSH ultrassensível |
| TGO / TGP | AST, ALT, transaminases, exame do fígado |
| Urina tipo I | EAS (RJ), urina 1, urina tipo 1, EQU (RS), sumário de urina (NE), parcial de urina (PR/SC), urina rotina |
| Urocultura | cultura de urina, urina com antibiograma |
| Parasitológico de fezes | exame de fezes, EPF, protoparasitológico, exame de verme |
| PSA | exame da próstata |
| Beta-HCG | teste de gravidez, BHCG, HCG, exame de gravidez de sangue |
| TP/TTPA | coagulograma, exame de coagulação, TAP, KTTP |
| INR | RNI, controle do Marevan |
| Eletroforese de proteínas | proteinograma |
| HIV | teste de HIV, anti-HIV |
| VDRL | exame de sífilis, sorologia para sífilis |
| Toxoplasmose | toxo, doença do gato |
| Citomegalovírus | CMV, citomegalo |
| COVID RT-PCR | PCR de COVID, teste de COVID, swab |
| Grupo sanguíneo | tipagem sanguínea, tipo de sangue, fator Rh |
| Espermograma | exame de esperma, contagem de espermatozoides |
| Curva glicêmica | TOTG, TTGO, teste de tolerância à glicose, dextrosol |
| Ferritina | estoque de ferro |
| Vitamina B12 | B12, cianocobalamina |
| VHS | hemossedimentação |

Atenção registrada no seed: "coprocultura" (cultura de fezes) NÃO é sinônimo de
parasitológico — exame distinto; "PCR" ambíguo entre proteína C reativa e RT-PCR.

---

**Fontes da pesquisa (2026-08-30):** ANS/dados.gov.br (operadoras ativas), rankings de
beneficiários competência mar/2026, tabela TUSS de laboratório SINDLAB/PR,
tuss.iclinic.com.br, codigotuss.com.br, Manual AMB×TUSS (Unimed Araraquara), ANS (inclusão
COVID RT-PCR no rol), scsaude.sea.sc.gov.br, celos.com.br, registros da liquidação da Agemed.
Pesquisa técnica WhatsApp: repositórios GitHub de Baileys, whatsapp-web.js, Evolution API
(incl. FAQ de licenciamento e issue #2534), WAHA (anúncio 2026.6), docs de engines WAHA.
