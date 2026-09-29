# 📝 Registro de Decisões Técnicas (ADR leve)

Toda decisão que afeta mais de um domínio é registrada aqui. Formato: data, decisão, motivo, impacto.

---

## 2026-08-23 — Decisões iniciais de arquitetura

### D-001: Stack — React + Node.js + PostgreSQL
**Decisão:** Frontend React 18 + TypeScript + Vite; Backend Node.js (NestJS preferido) + TypeScript; PostgreSQL 14+ com RLS; Redis para cache/filas.
**Motivo:** Ecossistema maduro, tipagem compartilhável entre front e back, RLS nativo para multitenant.
**Impacto:** Todos os domínios.

### D-002: Multitenant por linha (shared database, shared schema)
**Decisão:** Todos os tenants na mesma base, isolados por coluna `tenant_id` + Row-Level Security.
**Motivo:** Simplicidade operacional no MVP; particionamento por tenant fica para quando houver escala.
**Impacto:** db, api. Toda tabela de dados de laboratório tem `tenant_id`.

### D-003: Total da proposta é calculado, mas persistido como cache
**Decisão:** `proposals.total_price` existe como coluna, porém é SEMPRE recalculado pelo backend a partir de items + desconto a cada escrita. Nunca aceito do cliente.
**Motivo:** Performance de listagens (evita JOIN + SUM em toda listagem de pipeline), mantendo a regra "um número, uma origem" — a origem é o cálculo no service.
**Impacto:** api. Frontend nunca envia `totalPrice`.

### D-004: Snapshot de exames em proposal_items
**Decisão:** `proposal_items` guarda `exam_name` e `unit_price` no momento da criação.
**Motivo:** Preço do catálogo pode mudar; propostas históricas devem preservar os valores da época.
**Impacto:** db, api.

### D-005: Derivação de cores no frontend
**Decisão:** Backend armazena só as 5 cores base + radiusId + fontId; as 27 variações são derivadas no frontend via `color-mix(in oklab)`.
**Motivo:** Conforme design system; garante contraste automático e reduz dados por tenant a uma linha.
**Impacto:** ui, api (ThemeService retorna só as bases).

### D-006: WebSocket para real-time, REST para o restante
**Decisão:** Mensagens de conversa, mudanças de status e aprovações emitem eventos WebSocket; todas as mutações continuam via REST.
**Motivo:** REST auditável e simples; WS apenas como notificação (o cliente refaz fetch ao receber evento).
**Impacto:** api, ui.

---

## 2026-08-23 — Decisões de implementação (rodada multi-agente)

### D-007: Backend em Express 4 + TypeScript (revisa D-001)
**Decisão:** O backend usa Express 4 com TypeScript ESM e camadas explícitas
(controller → service → repository), em vez de NestJS.
**Motivo:** ARCHITECTURE.md já admitia "Express.js ou NestJS". Com múltiplos agentes escrevendo em
paralelo, a ausência de DI por decorators reduz a superfície de divergência e mantém o ciclo de
teste em segundos. As camadas exigidas por CONVENTIONS.md são preservadas integralmente.
**Impacto:** api. `TenantContext` é passado explicitamente como primeiro parâmetro dos services
(como já exigia SERVICES.md), em vez de injetado por escopo de request.

### D-008: PGlite como banco dos testes; Docker para dev e produção
**Decisão:** `docker-compose.yml` (Postgres 16 + Redis) permanece o ambiente de dev/prod
documentado. As suítes de integração e de isolamento multitenant rodam contra **PGlite**
(PostgreSQL 16.4 compilado para WASM, embutido no processo Node).
**Motivo:** É Postgres real — as mesmas migrações, os mesmos tipos, e RLS de verdade
(verificado: `SET ROLE` + `current_setting('app.tenant_id')` filtra linhas). Isso torna os testes
de isolamento executáveis em qualquer máquina e no CI sem daemon Docker, que é justamente a
suíte que TESTING.md marca como bloqueante de release.
**Impacto:** api, db, qa. As migrações são as mesmas nos dois caminhos — divergência é impossível.

### D-009: Envelope de listagem usa chave nomeada
**Decisão:** Endpoints de listagem retornam a chave nomeada de API_CONTRACTS.md
(`{ conversations, pagination }`, `{ proposals, pagination }`, `{ exams, pagination }`), e não
`{ data, pagination }`. `Paginated<T>` continua definido em `shared/types` como envelope genérico
para uso interno dos repositórios.
**Motivo:** API_CONTRACTS.md mostra JSON concreto por endpoint; FRONTEND_BACKEND.md descreve o
padrão em abstrato. Conflito resolvido pela fonte mais específica, conforme AGENTS.md
("interpretação mais restritiva"). `pagination` é idêntico em todas as listagens.
**Impacto:** api, ui.

### D-010: Componentes próprios em vez de shadcn/ui
**Decisão:** Os primitivos de `docs/frontend/COMPONENTS.md` são implementados diretamente sobre os
tokens CSS, sem trazer shadcn/ui como dependência.
**Motivo:** COMPONENTS.md já especifica a anatomia completa de cada primitivo, com variantes e
estados próprios (Chip com 3 tons, Button com `confirmation` reservado a positivo, bolhas com
canto apontado). Trazer shadcn criaria duas fontes de verdade para a mesma peça e um caminho fácil
para valores hardcoded entrarem. Tailwind permanece, com o tema mapeado para as CSS vars.
**Impacto:** ui.

### D-011: Cache e fila com adaptador in-memory por padrão
**Decisão:** `CacheService` e `QueueService` expõem interface única com duas implementações:
Redis (quando `REDIS_URL` está setado) e in-memory (dev sem Docker e testes).
**Motivo:** Os TTLs exigidos por SERVICES.md (catálogo 1h, analytics 5min) e o retry exponencial do
envio WhatsApp precisam ser testáveis sem infraestrutura externa. A troca é uma env var.
**Impacto:** api, infra.

### D-012: Correções no SCHEMA.md
**Decisão:** Três correções em relação ao SQL publicado em `docs/database/SCHEMA.md`:
(a) `ON SET NULL` → `ON DELETE SET NULL` (a sintaxe original não é SQL válido);
(b) a FK circular `tenants.theme_id → themes.id` é removida — `themes.tenant_id` já é UNIQUE e
    modela o 1:1 sem exigir criação em duas fases;
(c) acrescentada a tabela `proposal_status_history`, sem a qual o campo `history` de
    `GET /proposals/:id` (documentado em API_CONTRACTS.md) não teria origem.
**Motivo:** O doc é a intenção, mas o SQL precisa executar. Regra de AGENTS.md: contrato
incompleto → parar, atualizar doc, registrar aqui, continuar.
**Impacto:** db, api. `docs/database/SCHEMA.md` atualizado no mesmo commit.

---

## 2026-08-23 — Decisões do domínio Auth / Users / Theme / Audit (Agent-API-Auth)

### D-013: Ninguém altera o próprio papel, a própria alçada nem o próprio status
**Decisão:** `PATCH /users/:id` recusa (`FORBIDDEN`, `details.reason:
"self_privilege_change"`) qualquer mudança de `role`, `discountLimit` ou `isActive` em
que o alvo seja o próprio autor da requisição — **inclusive quando ele é admin**.
Renomear-se continua permitido.
**Motivo:** Não está escrito em nenhum doc, mas decorre direto de BUSINESS_RULES §2
(a alçada é concedida, não escolhida) e §8/§9 (mudança de permissão é ação auditada de
terceiro sobre terceiro). Sem a regra, a alçada deixa de ser um controle: qualquer
sessão sequestrada de um usuário com acesso à tela vira 100% de desconto com um PATCH.
O caso do admin é o mais importante, não a exceção — é justamente a conta cujo
sequestro tem o maior alcance, e "auto-aprovação" não deixa rastro útil no audit log
(autor e alvo são a mesma pessoa). Bloquear `isActive` no próprio usuário evita, de
quebra, que o último admin se tranque para fora.
**Impacto:** api, ui. O frontend deve desabilitar os campos papel/alçada/status na
linha do próprio usuário; o servidor recusa de qualquer forma ("a UI esconde, o
servidor recusa"). `platform_operator` também não é atribuível por admin de
laboratório: pertence ao console da plataforma.

### D-014: `POST /auth/refresh` devolve também o novo refresh token
**Decisão:** A resposta de `/auth/refresh` ganha o campo `refreshToken` além de
`accessToken` e `expiresIn`.
**Motivo:** SECURITY.md exige rotação a cada uso — usar um refresh o revoga. Sem
devolver o substituto, o cliente perderia a sessão na primeira renovação. Campo
aditivo, portanto compatível com `RefreshResponse` de `@crm-lab/shared` (AGENTS.md:
"campos novos são sempre opcionais").
**Impacto:** api, ui. O frontend DEVE substituir o refresh guardado a cada renovação.
`API_CONTRACTS.md` §1 atualizado no mesmo commit.

### D-015: A "família" de refresh tokens é a cadeia de rotação do usuário
**Decisão:** Reuso de um refresh já revogado é tratado como roubo: devolve
`REFRESH_TOKEN_INVALID`, revoga **todos** os refresh tokens vivos daquele usuário e
grava `refresh_token_reuse_detected` no audit log.
**Motivo:** `refresh_tokens` (migração 001) não tem coluna de família, e schema é
domínio do Agent-DB. Como cada usuário só tem a cadeia que nasceu dos seus logins, o
conjunto "todos os tokens do usuário" é um superconjunto seguro da família: derruba o
ladrão e o legítimo, que é exatamente o comportamento desejado (o legítimo refaz login).
**Impacto:** api. Se um dia o schema ganhar `family_id`, o escopo pode ser estreitado
sem mudar o contrato externo.

### D-016: `themes.radius_id` legado é normalizado na leitura
**Decisão:** A migração 001 traz `radius_id DEFAULT 'md'` (herdado dos nomes de
`--radius-*`), mas o contrato de `@crm-lab/shared` é `reto | suave | redondo`. A
leitura normaliza: `sm→reto`, `lg→redondo`, qualquer outro valor desconhecido →
`suave`. A escrita só aceita os três valores do contrato.
**Motivo:** O doc é a intenção e o tipo compartilhado é o contrato; normalizar na
borda evita uma migração de dados e impede que valor legado vaze para o frontend.
Tenant sem linha em `themes` recebe o preset `terracota` + `figtree` + `suave`.
**Impacto:** api, ui. Nenhuma mudança de schema.

### D-017: Refresh token carrega `role` e um nonce `jti`
**Decisão:** As claims do refresh token incluem `role` e `jti` (UUID), além de
`userId`/`tenantId`.
**Motivo:** duas razões mecânicas, ambas verificadas por teste. (a) `verifyRefreshToken`
do kernel valida o payload contra `JwtPayload`, onde `role` é obrigatório — sem a claim,
o token recém-assinado não passa na própria verificação. (b) Dois `jwt.sign` com as
mesmas claims dentro do mesmo segundo produzem a MESMA string (`iat` tem resolução de
1s); sem o nonce, rotacionar logo após o login colidiria com
`refresh_tokens.token_hash UNIQUE`. A `role` do token nunca é usada para autorizar:
na rotação, papel e alçada são relidos do banco, então um refresh antigo não ressuscita
privilégio revogado.
**Impacto:** api. Pedido registrado em STATUS.md para o Agent-Kernel avaliar ajustar
`signRefreshToken`/`verifyWith` em `src/lib/tokens.ts`.

---

## 2026-08-23 — Decisões de Analytics e Console da Plataforma (Agent-API-Analytics)

### D-018: Dinheiro em analytics é número, não string formatada
**Decisão:** `revenue`, `averageTicket`, `totalValue`, `value` e `topPerformers[].revenue`
trafegam como número decimal (`15000`, `2666.67`). `API_CONTRACTS.md` §5 foi corrigido: os
exemplos mostravam `"R$ 15.000,00"` e `"totalValue": "R$ 45.000,00"`.
**Motivo:** o exemplo do doc contraria três fontes ao mesmo tempo — `FRONTEND_BACKEND.md`
("Datas e Dinheiro: número decimal no fio; formatação é do frontend; backend NUNCA envia
string formatada"), a regra 9 de `CLAUDE.md`, e os próprios tipos de `@crm-lab/shared`
(`FunnelReport.revenue: number`, `PipelineSnapshot.totalValue: number`), que são a fonte
única do contrato. Seguir o exemplo formatado obrigaria o frontend a fazer parsing de
string localizada para poder somar ou ordenar, e quebraria `MoneyDisplay`. Vale a regra de
AGENTS.md: contrato errado → parar, corrigir o doc, registrar aqui.
**Impacto:** api, ui. `API_CONTRACTS.md` §5 corrigido no mesmo commit. Nenhuma mudança nos
tipos compartilhados — eles já estavam certos. Há teste de rota afirmando
`typeof revenue === 'number'`.

### D-019: Tabela de planos e preço de excedente vivem no PlatformService (provisórios)
**Decisão:** `PLAN_CATALOG` (starter R$ 299 / 1.000 msgs; pro R$ 799 / 5.000; enterprise
R$ 1.999 / 20.000) e `EXTRA_MESSAGE_PRICE` (R$ 0,10 por mensagem excedente) são constantes
exportadas de `src/services/platform.service.ts`. `extraMessages` é **derivado**
(`max(0, messagesUsed - messagesIncluded)`), e a coluna `tenants.extra_messages` da migração
001 **não é lida**.
**Motivo:** nenhum documento define preço, franquia ou valor do excedente — `SCHEMA.md` só
lista os três nomes de plano e `PAGES.md` §11 pede a tela "Assinaturas & Uso: planos,
faturas, excedente de mensagens". Sem os valores não há como responder `monthlyPrice` nem
`mrr`. Ficam num único lugar, tipados e testados por `billingFor()`, para que trocá-los (ou
movê-los para o banco quando o produto definir) seja uma edição só. Ignorar
`tenants.extra_messages` é aplicação direta de BUSINESS_RULES §5: um contador materializado
seria uma segunda origem para um número que o uso já determina.
**Impacto:** api, ui. **Valores a confirmar com o produto** antes de faturar de verdade.

### D-020: Analytics usa duas janelas de tempo, explicitamente
**Decisão:** num relatório de período, `funnel.*`, `conversionRate` e `lossReasons` contam
propostas **criadas** no período (`created_at`); `revenue`, `averageTicket` e `topPerformers`
contam propostas **ganhas** no período (`closed_at`, com `COALESCE(closed_at, created_at)`
como defesa contra dado terminal sem data).
**Motivo:** os dois docs pedem coisas diferentes e ambos estão certos — WORKFLOWS.md §10
define o funil como "contagem por estágio no período" e a conversão como "ganhos / total
criadas", enquanto BUSINESS_RULES.md §5 calcula receita com `closedAt BETWEEN period`. São
perguntas distintas: uma proposta criada em julho e ganha em agosto é receita de agosto e
funil de julho. Deixar isso implícito produziria o pior resultado possível — números que
parecem inconsistentes sem que ninguém saiba por quê. Documentado no cabeçalho do
repositório, em API_CONTRACTS.md §5 e coberto por teste (a mesma proposta aparece numa
janela e não na outra).
**Impacto:** api, ui. A tela de Conversão deve rotular "receita do período" como receita
**fechada** no período.

### D-021: Timestamps de `proposals` são formatados como UTC no SQL, não no driver
**Decisão:** onde uma data de `proposals` vira valor de resposta (hoje
`PipelineSnapshot.oldestProposal.daysOpen`), o SELECT usa
`to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` em vez de devolver a coluna crua.
**Motivo:** as colunas são `TIMESTAMP` **sem** timezone guardando UTC. Devolvidas como
`Date`, o driver as interpreta no fuso da máquina — numa máquina em UTC-3, `daysOpen` saía
com um dia a menos (detectado por teste, não por revisão). Comparações de período não têm
esse problema porque acontecem dentro do banco; só a travessia para o JavaScript tem.
**Impacto:** api. Vale para qualquer service que derive número a partir de timestamp:
comparar no banco, e formatar como UTC quando a data precisar sair.

### D-022: `TeamReport` acrescentado a `shared/types/analytics.types.ts`
**Decisão:** `TeamReport` e `TeamMemberPerformance` foram adicionados aos tipos
compartilhados, junto com o endpoint `GET /analytics/team` em API_CONTRACTS.md §5.
**Motivo:** `SERVICES.md` §9 declara `getTeamPerformance(ctx, period): Promise<TeamReport>`,
mas `TeamReport` não existia em `@crm-lab/shared` — e CLAUDE.md proíbe redeclarar shape de
API localmente. O tipo foi criado onde os outros do domínio já moram, no mesmo commit do
doc.
**Impacto:** api, ui. A tabela "desempenho por atendente" de PAGES.md §8 tem contrato.

---

## 2026-08-23 — Decisões do domínio Propostas / Aprovações / Chat interno (Agent-API-Proposals)

### D-041: `rejectionReason` deriva do audit log, não de uma coluna nova
**Decisão:** `ProposalDetail.rejectionReason` (contrato de `@crm-lab/shared`) é lido do
`audit_logs`: a entrada mais recente com `action = 'reject_proposal_discount'` sobre a
proposta, campo `new_values.rejectionReason`.
**Motivo:** a migração 001 não tem coluna para o motivo da rejeição, e schema é domínio do
Agent-DB. A decisão de rejeitar já é obrigatoriamente auditada (BUSINESS_RULES §9), então o
audit log **é** a origem única do dado (§5: um número, uma origem) — copiá-lo para uma coluna
criaria a segunda fonte que a regra proíbe. A leitura ocorre dentro de `withTenant`, portanto
sob RLS.
**Impacto:** api. Pedido registrado em STATUS.md caso o Agent-DB queira uma coluna dedicada;
o contrato externo não muda se ela existir um dia.

### D-042: Visibilidade de proposta por papel — atendente vê as próprias
**Decisão:** `GET /proposals`, `GET /proposals/:id` e todos os `PATCH` aplicam: atendente
enxerga apenas as propostas que **criou**; gestor e admin, todas do tenant. Proposta fora da
visibilidade responde `NOT_FOUND` (404), nunca `FORBIDDEN`.
**Motivo:** SERVICES.md §2 define exatamente isso para conversas ("atendente só lista as
próprias"), e proposta nasce de uma conversa — visibilidades divergentes deixariam o atendente
ver pelo pipeline o que não vê pela caixa de entrada. Regra de AGENTS.md para contrato
ambíguo: interpretação mais restritiva. 404 em vez de 403 porque 403 confirmaria a existência
(CLAUDE.md regra 8).
**Impacto:** api, ui. `?createdBy=` de outro usuário, pedido por atendente, devolve lista
vazia em vez de erro (não é oráculo de existência).

### D-043: Canais internos padrão são criados sob demanda, de forma idempotente
**Decisão:** `#geral` e `#aprovacoes` são criados na primeira listagem de canais do tenant
(e `createSystemPost` cria o canal alvo se faltar), com `UNIQUE (tenant_id, key)` garantindo
que não dupliquem.
**Motivo:** WORKFLOWS §7 manda criá-los no onboarding do tenant, que ainda não existe como
serviço. Sem isso, o primeiro pedido de aprovação de um tenant novo não teria onde ser
postado — a alçada ficaria sem caixa de entrada. Quando o onboarding existir, ele passa a
criar os canais e este caminho vira um no-op.
**Impacto:** api. Nenhuma mudança de schema nem de contrato.

### D-044: `Channel.unreadCount` nasce 0 até haver estado de leitura
**Decisão:** o campo é servido como `0` para todos os canais.
**Motivo:** não há tabela de leitura por usuário no schema (as 13 tabelas da migração 001 não
incluem marcação de leitura de canal interno), e o campo é obrigatório em `Channel`. Devolver
0 é honesto e estável; inventar um contador derivado de "mensagens desde o login" seria um
número sem origem (BUSINESS_RULES §5).
**Impacto:** api, ui. Pedido registrado em STATUS.md para o Agent-DB.
**SUPERADA por D-068** (Onda 6): a tabela `channel_reads` existe, `unreadCount` passou a ser
derivado de verdade e `POST /internal-chat/channels/:id/read` zera o contador.

### D-045: `DISCOUNT_EXCEEDS_LIMIT` é o bloqueio de `updateDiscount` sobre proposta de terceiro
**Decisão:** criar proposta com desconto acima da alçada **não** é erro — vai para `pending`
(BUSINESS_RULES §2, WORKFLOWS §2). O código `DISCOUNT_EXCEEDS_LIMIT` (403) é emitido quando
alguém tenta elevar, acima da própria alçada, o desconto de uma proposta que **não criou**.
**Motivo:** API_CONTRACTS.md §3 mostra um 403 na criação, enquanto BUSINESS_RULES §2,
WORKFLOWS §2/§3 e SERVICES.md §4 mandam cair em aprovação — três documentos contra um. O
parêntese de API_ERRORS.md ("OU bloqueio em updateDiscount de terceiro") descreve exatamente
o caso que sobra, e é onde o código foi implementado. Sem essa leitura, o pedido de aprovação
de A poderia ser aumentado por B sem passar por alçada nenhuma.
**Impacto:** api, ui. O exemplo de 403 em `POST /proposals` de API_CONTRACTS.md foi corrigido
no mesmo commit.

### D-046: Ninguém aprova a própria proposta — nem admin
**Decisão:** `PATCH /proposals/:id/approve` recusa (`FORBIDDEN`, `details.reason:
"self_approval"`) quando o aprovador é o criador da proposta.
**Motivo:** o doc não cobre o caso; interpretação mais restritiva (AGENTS.md). A alçada é um
controle de terceiro sobre terceiro, como em D-013: auto-aprovação não deixa rastro útil no
audit log (autor e aprovador são a mesma pessoa) e transformaria "acima da alçada" em um
clique a mais. O cenário existe na prática: quem cria dentro da alçada e depois tem a alçada
reduzida acabaria decidindo sobre si mesmo. Rejeitar a própria proposta continua permitido —
rejeitar não concede privilégio.
**Impacto:** api, ui. A UI deve esconder o botão Aprovar na própria proposta; o servidor
recusa de qualquer forma.

### D-047: Proposta `rejected` também não vai ao paciente
**Decisão:** a transição para `orcamento_enviado` é recusada com `PROPOSAL_PENDING_APPROVAL`
(409) tanto para `approvalStatus: "pending"` quanto para `"rejected"`; o erro passa a levar
`details.approvalStatus` para o frontend distinguir os dois.
**Motivo:** WORKFLOWS §3 escreve a regra só para `pending`, mas o mesmo fluxo diz que uma
proposta rejeitada segue para "ajusta desconto e re-submete". Deixar sair uma proposta cujo
desconto foi explicitamente negado anularia a decisão do gestor — o caminho de volta é
`PATCH /discount`, que reavalia a alçada e reaprova sozinho quando cabe.
**Impacto:** api, ui. `details` é aditivo; quem trata só o `code` não muda.

### D-048: Proposta dentro da alçada nasce `approved`, não `none`
**Decisão:** `approvalStatus` é `approved` (com `approvedBy` = o próprio criador e
`approvedAt` preenchido) quando `discount <= user.discountLimit`; `pending` acima disso.
`none` não é escrito pela API — permanece apenas em dados legados/semeados.
**Motivo:** é o pseudocódigo literal de BUSINESS_RULES §2 ("Aprovado automaticamente /
`proposal.approvedBy = user.id` — aprovado por si mesmo") e o que §10 usa como teste de
verdade (`approvalStatus === 'approved'`). Um único valor para "pode enviar" evita que o
frontend precise tratar `none` e `approved` como sinônimos.
**Impacto:** api, ui. O seed usa `none` em propostas históricas; ambos os valores significam
"sem pendência de aprovação" para o frontend.

---

## 2026-08-23 — Decisões do domínio Conversas / Mensagens / WhatsApp (Agent-API-Conversations)

### D-031: A corrida de atribuição é resolvida pela escrita, não por lock otimista
**Decisão:** `assign` usa `UPDATE conversations SET assigned_to = $1 WHERE id = $2 AND
assigned_to IS NULL`. Quem afeta 0 linhas perdeu e recebe
`CONVERSATION_ALREADY_ASSIGNED` (409) com `details: { assignedTo, assignedToName }`.
SERVICES.md §2 sugeria lock otimista por `updated_at`.
**Motivo:** o lock otimista precisa de uma leitura prévia cujo valor pode envelhecer
entre o SELECT e o UPDATE — e `updated_at` é mexido por trigger em qualquer escrita
(tag, status, contador), então versionaria coisas que não são a atribuição. Com a
condição dentro da própria escrita, o banco decide e não existe janela. Coberto por
teste com duas chamadas concorrentes de verdade.
**Impacto:** api. Nenhuma mudança de schema.

### D-032: A identidade do tenant no webhook vem do slug na URL
**Decisão:** o webhook do canal externo é `POST /webhooks/whatsapp/:tenant` (slug ou
uuid), e as credenciais por tenant são servidas por um `WhatsAppCredentialsResolver`
cuja implementação default deriva URL/token/segredo das env vars.
**Motivo:** o webhook chega sem sessão e o schema ainda não tem tabela de canal por
tenant (não existe onde guardar "este número pertence a este laboratório"). Inventar a
tabela violaria a Regra Zero; usar um segredo global sem identificar o tenant seria
pior. O slug na URL identifica o laboratório sem depender de schema novo, e o resolver
isola o ponto que muda quando a tabela existir. A leitura de `tenants` por slug usa
`withoutTenant()` — o mesmo caso do login ("o tenant ainda não é conhecido"); toda
ESCRITA acontece depois, dentro de `withTenant()`.
**Impacto:** api, db (pedido de tabela de canal registrado em STATUS.md), infra
(a URL do webhook configurada na Meta passa a incluir o slug).

### D-033: `handleWebhook` e `handleStatusCallback` devolvem lista
**Decisão:** as duas devolvem array em vez do objeto único de SERVICES.md §11.
**Motivo:** a API da Meta entrega lote — um POST carrega `entry[].changes[].value.
messages[]` com N mensagens. Devolver só a primeira perderia mensagem de paciente,
que é dado que não se recupera. Nenhuma das duas lança: payload malformado devolve
lista vazia, porque o handler responde 200 de qualquer forma (SECURITY.md).
**Impacto:** api. SERVICES.md §11 atualizado no mesmo commit.

### D-034: HMAC calculado sobre o corpo reserializado
**Decisão:** a verificação da assinatura usa `req.rawBody` quando existir e, na falta
dele, `JSON.stringify(req.body)`.
**Motivo:** o kernel aplica `express.json()` globalmente em `createApp`, então o stream
já foi consumido quando a requisição chega ao router do webhook — os bytes originais
não existem mais. `app.ts` é do Agent-Kernel, não deste domínio. Pedido registrado em
STATUS.md para o kernel guardar os bytes via `express.json({ verify })`; quando isso
existir, o código já prefere `rawBody` sem outra mudança. A comparação é
`crypto.timingSafeEqual`, nunca `===`.
**Impacto:** api, kernel. Em produção com a Meta, a reserialização pode divergir do
corpo original — por isso o pedido ao kernel é pré-requisito para ligar o canal real.

### D-035: `GET /conversations/:id` marca a conversa como lida
**Decisão:** abrir o detalhe zera `unreadCount` e passa as mensagens do paciente para
`read`. Existe também `POST /conversations/:id/read` (204), idempotente.
**Motivo:** PAGES.md §2 diz "Ao abrir: markAsRead" e o exemplo de API_CONTRACTS.md §2
mostra o detalhe com `unreadCount: 0` e `status: "read"` enquanto a listagem traz
`unreadCount: 3` — o contrato já descrevia esse efeito. O frontend (Agent-UI-Attendance)
implementou contra essa leitura. O endpoint dedicado cobre quem precisa do efeito sem
carregar 50 mensagens.
**Impacto:** api, ui. `GET` com efeito colateral é deliberado e está documentado.

---

## 2026-08-24 — Decisões de CI/CD e imagens de produção (Agent-Infra-CI)

### D-049: Contexto de build das imagens é a raiz do monorepo
**Decisão:** `backend/Dockerfile` e `frontend/Dockerfile` são construídos com
`context: .` (raiz), nunca com o contexto da própria pasta:
`docker build -f backend/Dockerfile .`.
**Motivo:** os dois workspaces importam `@crm-lab/shared`, e o `package-lock.json` é único
(npm workspaces). Um contexto por pasta não enxergaria `shared/` nem o lock — só restaria
copiar `node_modules` pronto de fora, que é exatamente o que uma imagem reprodutível não pode
fazer. Os `COPY` de `package.json` de todos os workspaces vêm antes do código para que a
camada de `npm ci` só invalide quando o lock mudar.
**Impacto:** infra. `.dockerignore` na raiz mantém `e2e/package.json` no contexto — `npm ci`
falha se um workspace declarado estiver ausente.

### D-050: A imagem do backend empacota um shim de `@crm-lab/shared`
**Decisão:** no estágio de runtime, `node_modules/@crm-lab/shared` deixa de ser o link do
workspace e passa a ser um diretório real apontando para o JS já compilado em
`dist/shared/types/`. O `CMD` é `node dist/backend/src/main.js`.
**Motivo:** dois fatos verificados executando a imagem, não por leitura. (a)
`tsconfig.build.json` usa `rootDir: ".."`, então a saída é `dist/backend/src/**` +
`dist/shared/types/**` — o script `start` de `backend/package.json` (`node dist/main.js`)
aponta para um caminho que não existe. (b) O JS emitido mantém o import bare
`@crm-lab/shared`, que resolve para `shared/types/index.ts`; o Node tenta carregar
TypeScript e morre com `ERR_MODULE_NOT_FOUND .../shared/types/api.types.js`. Sem o shim, a
API compilada simplesmente não sobe. O shim é empacotamento puro — nenhuma linha de
`backend/src`, `shared/` ou `backend/package.json` foi tocada (ownership).
**Impacto:** infra, api. Pedido ao Agent-API/Agent-Kernel: corrigir o script `start` para o
caminho real, ou fazer o build emitir `@crm-lab/shared` como JS resolvível. Enquanto isso,
`npm start` no backend não funciona e a única forma suportada de rodar a API compilada é a
imagem Docker.

### D-051: Mesmo origin em produção — o nginx do frontend faz proxy de `/api` e `/ws`
**Decisão:** a imagem do frontend serve o bundle **e** encaminha `/api/` e `/ws` para
`API_UPSTREAM` (default `http://backend:3000`). Os `ARG` de build default para
`VITE_API_URL=/api/v1` e `VITE_WS_URL=/ws`. No `docker-compose.prod.yml`, backend, Postgres
e Redis não publicam porta nenhuma.
**Motivo:** as variáveis `VITE_*` são inlinadas no bundle em tempo de build — apontá-las para
um host externo fixa a URL da API dentro de um artefato público e obriga a rebuildar a imagem
a cada mudança de domínio, além de exigir CORS e preflight em toda requisição. Caminho
relativo elimina os três problemas de uma vez e reduz a superfície exposta a uma única porta.
**Impacto:** infra. `CORS_ORIGIN` continua obrigatória (o backend valida), mas em operação
normal o browser nunca faz requisição cross-origin.

### D-052: O job de E2E falha de verdade — nada de `continue-on-error`
**Decisão:** o job `e2e` do CI é bloqueante. Se a suíte não passar, o run fica vermelho.
Em caso de falha, publica `playwright-report` (`e2e/playwright-report/` + `e2e/test-results/`)
e o log dos servidores.
**Motivo:** `continue-on-error` num job de E2E produz o pior resultado possível — um check
verde que não afirma nada, e que ninguém percebe estar quebrado até o dia em que importa.
TESTING.md trata a suíte de isolamento como bloqueante de release; o mesmo critério vale para
os fluxos críticos. Se a suíte estiver instável, o caminho é consertá-la ou desabilitá-la
explicitamente — não mascarar o resultado.
**Impacto:** infra, qa. O job usa `NODE_ENV=development` (não `test`: `test` força PGlite em
memória por D-008 e o seed iria para um banco descartável) e sobe API e UI com `npm run dev`,
como `e2e/playwright.config.ts` documenta (`webServer: undefined`).

### D-053: `RefreshResponse` declara `refreshToken` — obrigatório, não opcional
**Decisão:** `shared/types/auth.types.ts` ganha `refreshToken: string` em
`RefreshResponse`. O tipo local `RefreshResult` do `auth.service.ts` foi removido.
**Motivo:** D-014 chamou o campo de "aditivo, portanto opcional" e por isso ele ficou fora
do tipo compartilhado, com o backend contornando por um `interface RefreshResult extends
RefreshResponse` — exatamente o "redeclarar shape de API localmente" que CLAUDE.md proíbe.
A premissa estava errada: a rotação a cada uso é **incondicional**, então `/auth/refresh`
devolve `refreshToken` em 100% das respostas de sucesso. Um campo opcional descreveria uma
resposta que o servidor nunca produz, e deixaria o frontend achar que pode ignorá-lo — e
perder a sessão. A regra "campos novos são opcionais até os dois lados suportarem" vale
durante a transição; os dois lados já suportam desde a Onda 2.
**Impacto:** api, ui. Nenhuma mudança de runtime — o campo já vinha no fio e o frontend já
o consumia (`frontend/src/api/client.ts`). `API_CONTRACTS.md` §1 perdeu a nota de
divergência. D-014 continua válido no mérito; só a nota sobre opcionalidade é superada aqui.

### D-054: A chave do rate limit deriva do Bearer token, não de `req.ctx`
**Decisão:** `rateLimitKey` (em `http/middleware/rate-limit.ts`) verifica a assinatura do
access token da própria requisição e limita por `user:<userId>`; sem token válido, cai em
`ip:<clientIp>`. O middleware continua montado no kernel, antes dos routers.
**Motivo:** a chave anterior lia `req.ctx`, que só existe **depois** de `requireAuth()` — e
`requireAuth` é por rota, montado depois do limitador. O ramo `user:<id>` era código morto:
todo o tráfego autenticado, de todos os tenants, dividia um único balde de 100/min por IP.
Atrás de load balancer ou NAT isso é um laboratório inteiro se autobloqueando; foi o que
derrubou a suíte E2E com 429 em cascata. Aumentar o limite trataria o sintoma e deixaria o
acoplamento IP↔tenant de pé.
Duas alternativas foram descartadas: (a) mover o limitador para depois da autenticação exige
repeti-lo em cada módulo, e a primeira rota que esquecesse ficaria sem limite nenhum;
(b) um `optionalAuth()` que preenchesse `req.ctx` antes do limitador daria contexto válido
de brinde a qualquer rota que esquecesse `requireAuth` — trocaria um bug de disponibilidade
por um de autorização. Por isso `rateLimitKey` lê o token e **não escreve em `req`**.
Token ausente, expirado ou adulterado cai no balde por IP de propósito: se ganhasse balde
próprio, trocar o token a cada requisição seria um bypass trivial do limite.
**Impacto:** api. Rotas públicas (login, refresh, webhook do WhatsApp) seguem por IP, que é
o comportamento desejado para força bruta. `SECURITY.md` "OWASP" continua satisfeito.

### D-055: Mutação de proposta invalida o cache de analytics do tenant inteiro
**Decisão:** `ProposalService.create`, `updateStatus` e `updateDiscount` chamam
`cache.delByPrefix('analytics:<tenantId>:')` depois de gravar. O `ProposalServiceDeps`
ganhou `cache`. O TTL de 5 min (SERVICES.md §9) continua valendo para leitura pura.
**Motivo:** a chave de analytics é `analytics:<tenant>:<escopo>:<relatório>:<período>`, e o
escopo multiplica as entradas. Rodando a aplicação na Onda 5 apareceu o efeito: a visão do
gestor mostrava 622 e a "parcial" do atendente 722 — a parcial de UMA pessoa maior que o
total do laboratório, por até 5 minutos. Não é "dado um pouco atrasado": é um estado que não
existe, e que faz desconfiar do relatório inteiro. Invalidar só a entrada do autor deixaria
a do gestor velha, que é precisamente o bug; por isso o prefixo inteiro — todos os escopos,
relatórios e períodos.
A inconsistência de até 5 min NÃO foi aceita como contrato: o número é o argumento de venda
da tela de conversão, e o custo da invalidação é recalcular na próxima leitura, num caminho
que já é dominado por leitura.
**Impacto:** api. O prefixo carrega o `tenantId`, então `delByPrefix` nunca alcança outro
laboratório (regra 1) — há teste para isso em
`backend/tests/analytics/cache-invalidation.spec.ts`. Falha do cache é registrada no logger e
engolida: a proposta já está gravada e auditada, e o pior caso é voltar ao TTL de 5 min.

### D-056: `npm start` do backend aponta para `dist/backend/src/main.js` e o build emite o shim
**Decisão:** `backend/package.json` passa a ter `"start": "node dist/backend/src/main.js"`, e
`build` roda `tsc -p tsconfig.build.json && npm run build:shared-link`, que escreve
`dist/node_modules/@crm-lab/shared/{package.json,index.js}` reexportando
`../../../shared/types/index.js` (o JS já compilado, dentro do próprio `dist`).
**Motivo:** fecha o pedido registrado em D-050. Com `rootDir: ".."` a saída é
`dist/backend/src/**` + `dist/shared/types/**`, então `node dist/main.js` aponta para um
caminho inexistente; e o JS emitido mantém o import bare `@crm-lab/shared`, que pelo link do
workspace resolve para `shared/types/index.ts` e mata o processo com
`ERR_MODULE_NOT_FOUND .../shared/types/api.types.js`. `tsc` não reescreve especificador bare —
é o Node que precisa achar um JS ali. O shim dentro de `dist/` resolve mais perto que
`node_modules/` da raiz e é auto-contido: o `dist` inteiro pode ser copiado sozinho.
Verificado executando: `npm run build && PORT=3987 npm start` sobe e `GET /health` responde
`{"status":"ok","driver":"pg"}`.
**Impacto:** api, infra. Não conflita com D-050 — o shim da imagem e este apontam para os
mesmos arquivos emitidos; o do `dist` só vence por proximidade. A estratégia de build não
mudou (`rootDir`/`outDir` intactos). O arranjo mais limpo a longo prazo — `shared/` com build
próprio e `exports` condicional, dispensando shim dos dois lados — continua sendo do
Agent-Infra: mexe em `shared/package.json` e no Dockerfile, fora do domínio da API.

### D-057: O IP do cliente vem da cadeia de proxies configurada, nunca do header cru
**Decisão:** `clientIp()` passa a devolver apenas `req.ip` (com fallback para o endereço do
socket) e **não lê mais `X-Forwarded-For`**. Quem decide se o header vale é o Express, via
`app.set('trust proxy', env.trustProxy)`, agora configurado por duas env vars novas
(documentadas em `backend/.env.example`):
- `TRUST_PROXY_HOPS` — quantos proxies reversos nossos ficam na frente. **Default `0` = não
  confia em `X-Forwarded-For` nenhum.**
- `TRUSTED_PROXIES` — lista de IPs/CIDRs confiáveis; se preenchida, vence a contagem.

`app.ts` deixou de fazer `app.set('trust proxy', true)`. A configuração ficou em
`applyTrustProxy()`, exportada para que os testes montem um app com a MESMA regra do real.

**Motivo:** `trust proxy: true` confia em qualquer proxy — na prática, confia no cliente. E
`clientIp()` lia o header cru, então nem isso importava. O IP alimenta **três** controles de
segurança e os três estavam anulados:
1. **Rate limit** — o balde por IP é o que protege as rotas públicas (`/auth/login`,
   `/auth/refresh`, `/webhooks/*`), justamente as que a D-054 deixa fora do ramo por token.
   Com limite 3, 50 requisições variando `X-Forwarded-For: 10.0.0.<i>` passavam todas.
2. **Lockout de login** (o pior) — a chave é `login-failures:<email>:<ip>`. Variando o header,
   cada tentativa ganhava um contador zerado: força bruta ilimitada contra qualquer e-mail,
   contra a política de 5 tentativas / 15 min de `SECURITY.md`.
3. **Audit log** — `ip_address` de `login` gravava o endereço que o atacante escolhesse.

Contar hops a MAIS é o erro perigoso (cada hop excedente é uma posição do header que o
cliente controla), por isso o default é `0` e subir esse número é ato deliberado de deploy.

**Impacto:** api, infra. **PENDÊNCIA PARA O AGENT-INFRA:** `docker-compose.prod.yml` põe
exatamente um nginx na frente do backend (`API_UPSTREAM: http://backend:3000`), então o serviço
`backend` precisa de `TRUST_PROXY_HOPS: 1` no `environment` — arquivo fora do domínio da API.
Sem isso todo o tráfego colapsa no IP do proxy e um laboratório inteiro passa
a dividir um balde — é o cenário da D-050, e a correção é configuração, não voltar a confiar
no header. (Enquanto não for setado o comportamento é seguro, só pessimista.) Regressões em `tests/kernel/client-ip.spec.ts` (header ignorado sem proxy
confiável; com 1 hop vale o último da cadeia), `tests/kernel/rate-limit.spec.ts` (50 requests
variando o header ainda batem no limite de 3) e `tests/auth/login.spec.ts` (lockout dispara
mesmo variando o header; audit log grava o IP da conexão).

### D-058: `RedisCache` de verdade (ioredis) e boot fail-closed quando o Redis não responde
**Decisão:** duas coisas, na ordem:
(a) `RedisCache` deixou de ser stub. Fala Redis de verdade via `ioredis` (dependência nova em
`backend/package.json`): `GET`, `SET ... EX`, `DEL` e `SCAN MATCH <prefixo>* COUNT 100` para
`delByPrefix`. Valores trafegam como JSON; TTL `<= 0` apaga a chave, para casar com a semântica
do `MemoryCache`. A conexão é injetável (`RedisClientLike`), então o comportamento é testado
com um duplo que guarda strings, expira por TTL e responde SCAN por glob — sem subir servidor.
(b) `CacheService` ganhou `ping()`, e `main.ts` chama `verifyCacheReady(cache)` no boot: com
`REDIS_URL` definido e o Redis fora do ar, o processo **morre** com `CacheUnavailableError`
explicando o que fazer. `MemoryCache.ping()` é no-op — dev/CI sem Redis continuam subindo.

**Motivo:** o stub delegava tudo para um `MemoryCache` in-process e emitia **um** `warn`.
`docker-compose.prod.yml` define `REDIS_URL`, então produção rodava no stub. Isso deixa **por
processo** as três coisas que dependem deste cache: o balde do rate limit (com N instâncias o
limite efetivo vira N × 100/min), o contador de lockout de login (N × 5 tentativas) e a
invalidação de analytics da D-055 (o relatório obsoleto sobrevive na instância que não recebeu
a mutação — exatamente o bug que a D-055 existe para matar). Um `warn` que ninguém lê não é
controle de segurança.

A opção "só falhar o boot, sem cliente Redis" foi descartada porque tornaria impossível rodar
mais de uma instância — e o precedente de fail-fast do `env.ts` (recusar segredo fraco em
produção) resolve o silêncio, não o problema de estado compartilhado. Fazer as duas coisas
custa uma dependência e fecha os dois buracos: o cache funciona de verdade, e se não funcionar
ninguém descobre pelo relatório errado três semanas depois.

**Impacto:** api, infra. `REDIS_URL` virou compromisso: definida = Redis tem que estar de pé.
Quem rodava dev com `REDIS_URL` apontando para um Redis inexistente precisa apagar a variável
(o `.env.example` explica). O ambiente de teste ignora `REDIS_URL` como antes (`env.isTest`).
Testes em `tests/kernel/cache.spec.ts`, incluindo o de `delByPrefix` que prova que o SCAN não
encosta em chave de outro tenant (regra 1).

---

## 2026-08-24 — Contrato da Onda 6 (Agent-Docs-Onda6)

Fase 0 do plano `docs/superpowers/plans/2026-08-24-onda-6.md`: paciente como entidade, canais
e operação, e as pendências de doc da Onda 5. Nada de implementação — só contrato.

### D-059: Paciente vira entidade própria; as colunas denormalizadas ficam
**Decisão:** nasce a tabela `patients` (`UNIQUE (tenant_id, phone)`, SCHEMA.md §14) e a coluna
`conversations.patient_id UUID NULL`. As colunas `conversations.patient_name/patient_phone/
patient_email` **permanecem** nesta onda, e **nenhum contrato de `/conversations` muda**.
**Motivo:** a ficha `/patients/:id` (PAGES.md §3) pede cadastro completo editável — e um
cadastro que mora denormalizado em N conversas não tem onde ser editado uma vez só: editar o
nome numa conversa deixaria as outras N-1 com o valor velho, e não existiria linha para
`birth_date`, `document`, `notes` ou o marcador de LGPD. Manter as colunas antigas é o passo 1
da regra dos 3 passos de AGENTS.md (criar novo → migrar dados → remover antigo): remover na
mesma onda em que se cria obrigaria backend, frontend e E2E a mudarem juntos, e qualquer
caminho esquecido viraria erro em produção.
**Impacto:** db, api, ui. `patient_id` é nullable de propósito (linha anterior ao backfill é
legítima). `findOrCreateByPhone` passa a resolver o paciente pelo telefone no mesmo caminho do
webhook, com `ON CONFLICT (tenant_id, phone)` — duas mensagens simultâneas não podem criar dois
pacientes. A remoção das colunas denormalizadas é trabalho de uma onda futura.

### D-060: A ficha do paciente são três chamadas, e as propostas dele saem de `/proposals`
**Decisão:** `GET /patients/:id` devolve **cadastro + contadores** e nada mais. A timeline tem
rota própria (`GET /patients/:id/timeline`, paginada) e as propostas do paciente saem de
`GET /proposals?patientId=<uuid>` — não existe `GET /patients/:id/proposals`. Os três blocos
aplicam o mesmo recorte por papel: atendente enxerga apenas pacientes com ao menos uma conversa
visível a ele (dele ou não atribuída); gestor/admin veem tudo; fora disso, `404`.
**Motivo:** embutir timeline e propostas faria a abertura da ficha carregar centenas de linhas
para mostrar as dez primeiras, e os três blocos têm ciclos de atualização diferentes. Para as
propostas, o filtro reusa de graça o que `/proposals` já tem: visibilidade de D-042, paginação,
ordenação e o shape do item — um endpoint próprio duplicaria as quatro coisas e faria o
`PatientService` ler a tabela `proposals`, de outro domínio (SERVICES.md "Convenções
Transversais"). O recorte por papel na timeline não é detalhe: sem ele, a ficha seria um caminho
lateral para o atendente ler a conversa de outro atendente, contrariando SERVICES.md §2.
**Impacto:** api, ui. Contadores (`conversationCount`, `proposalCount`, `lastInteractionAt`)
são derivados no recorte de quem pergunta — dois usuários podem ver números diferentes na mesma
ficha, e a tela não deve rotulá-los como "total do laboratório". `?patientId=` de paciente
invisível devolve **lista vazia**, não 404 (filtro não é oráculo de existência, como em D-042).

### D-061: Não existe `POST /patients` nem edição de telefone
**Decisão:** o paciente é criado exclusivamente por `findOrCreateByPhone`, no caminho do canal.
`PATCH /patients/:id` recusa `phone` (`VALIDATION_ERROR`), e não há `DELETE`.
**Motivo:** `phone` é a chave de deduplicação `(tenant_id, phone)`; deixá-lo editável permitiria
fundir ou órfãos dois cadastros por digitação, sem nenhum fluxo de merge para consertar. E não
há tela que cadastre paciente fora de uma conversa — um `POST` criaria uma segunda origem para
a mesma entidade, com o risco de dois cadastros do mesmo telefone competindo pela unicidade.
**Impacto:** api, ui. Corrigir um telefone errado é assunto de uma onda futura (exigiria fusão
de cadastros); a UI não oferece o campo.

### D-062: Exportação LGPD é admin e NÃO aplica o recorte por papel
**Decisão:** `GET /patients/:id/export` exige `admin` e devolve o dado completo do titular no
tenant — conversas e propostas que o solicitante não veria pela UI inclusive. Formato JSON com
`Content-Disposition: attachment`; gera audit log `export_patient_data`.
**Motivo:** atender pedido de titular é ato de controlador de dados, não tarefa de atendimento.
Uma exportação filtrada pela visibilidade de quem clicou seria uma resposta **incompleta** a um
pedido legal — pior que negar. A defesa correta é restringir o papel e auditar, não entregar
meia verdade. JSON, e não CSV, porque o dado é aninhado (conversas → mensagens, propostas →
itens) e achatar perderia estrutura.
**Impacto:** api, ui, segurança. Gestor e atendente recebem `403` com
`details.requiredRoles: ["admin"]`. Entram cadastro (inclusive `notes`, que é interno mas é
dado pessoal), conversas, mensagens — inclusive as de sistema — e propostas com itens e total.
Não entram `approvalStatus`, alçadas, quem aprovou/rejeitou, chat interno e audit log: são dados
do laboratório (BUSINESS_RULES §7).

### D-063: Apagamento LGPD é anonimização, não `DELETE`
**Decisão:** `POST /patients/:id/anonymize` (admin, `reason` obrigatório) limpa o cadastro,
troca `phone` por `'anon-' || substring(id::text, 1, 8)`, grava `anonymized_at` e limpa as
cópias denormalizadas em `conversations` — tudo em uma transação. Propostas, itens, mensagens e
audit logs ficam intactos. Idempotente (repetir devolve 200). Depois disso, `PATCH` responde
`409 CONFLICT` com `details.reason: "patient_anonymized"`.
**Motivo:** apagar a linha quebraria o histórico — propostas apontam para conversas que apontam
para o paciente, e o funil e a receita passariam a mentir. Por outro lado, deixar as colunas
denormalizadas de `conversations` intactas tornaria a anonimização decorativa: o nome
continuaria aparecendo na lista do inbox. Por isso o efeito atravessa as duas tabelas enquanto
as denormalizadas existirem (D-059) — é a única escrita do `PatientService` fora da sua tabela,
e está registrada como exceção em SERVICES.md §12. O audit log grava só o `reason`: gravar os
valores antigos seria desfazer a anonimização em outra tabela.
**Impacto:** api, db, ui, segurança. **Limitação conhecida e documentada:** o conteúdo das
mensagens não é reescrito — o texto é registro da conversa, e expurgo de mensagem é a política
de retenção que SECURITY.md "LGPD" deixa como config futura. `patientName` já é anulável em
`Proposal`, então propostas históricas passam a aparecer sem nome, sem quebrar.

> **Emenda (Onda 6, ver D-075).** Duas frases desta decisão estavam erradas por omissão:
> 1. **"audit logs ficam intactos" não vale mais.** `PATCH /patients/:id` grava
>    `oldValues`/`newValues` com nome, e-mail, `birthDate`, CPF e `notes`, e
>    `GET /audit?entityType=patient&entityId=<id>` devolvia tudo em claro **depois** do
>    apagamento — o direito ao esquecimento era reversível por uma rota suportada. Agora a
>    anonimização substitui o **valor** desses campos por `"[ERASED]"` na mesma transação,
>    preservando linha, ação, autor, timestamp e as **chaves**. Detalhe em D-075.
> 2. **`messages.attachment_url` é limpo.** "O conteúdo das mensagens não é reescrito" cobre o
>    TEXTO. A URL do anexo aponta para um arquivo do titular (foto, PDF de exame) e não é
>    conteúdo de conversa em nenhum sentido útil — ela vira `NULL`. O texto continua intacto, e
>    essa continua sendo a limitação declarada.

### D-064: `tenant_channels`, com segredo write-only
**Decisão:** nasce `tenant_channels (tenant_id, channel, phone_number_id, phone_number,
api_token, webhook_secret, is_active, ...)` com `UNIQUE (tenant_id, channel)`. A API **nunca**
devolve `api_token` nem `webhook_secret`: a leitura expressa `apiTokenMasked`
(`'••••••••' + 4 últimos`) e `webhookSecretSet: boolean`. Escrita em três estados: campo ausente
preserva, `null` apaga, string grava; `""` é `VALIDATION_ERROR`.
**Motivo:** fecha o pedido do Agent-API-Conversations (D-024), que hoje deriva credenciais de
env var e identidade de tenant do slug da URL — arranjo que impede dois laboratórios com números
diferentes na mesma instalação. Sobre o mascaramento: um token que volta na resposta vaza por
onde a resposta passar (log de proxy, devtools, cache de query, print de tela em suporte), e
"só para o admin" não resolve nenhum desses. O `webhookSecret` não tem nem prévia de 4
caracteres: ele é curto e assina HMAC, então qualquer pedaço reduz o espaço de busca.
**Impacto:** db, api, ui, segurança. O repositório projeta colunas explicitamente — `SELECT *`
devolvendo a linha ao controller é bug de segurança, não estilo. `update_channel_settings` grava
`"[REDACTED]"` no audit log. `ChannelSettingsService.resolveCredentials` é o único método que lê
o valor em claro, e cai nas env vars quando o laboratório não configurou o canal (dev e CI
continuam subindo sem nenhuma linha na tabela).

### D-065: Distribuição, mensagens automáticas e horário moram em `tenant_settings`
**Decisão:** tabela nova `tenant_settings` (1:1 com `tenants`, `tenant_id` como PK), com
`distribution_mode`, as duas mensagens automáticas e `business_hours JSONB`. **Linha ausente =
defaults**: o `GET` responde `manual`, mensagens desligadas e `America/Sao_Paulo` sem gravar
nada; o primeiro `PATCH` faz `INSERT ... ON CONFLICT`.
**Motivo:** as três alternativas foram pesadas. Em `tenants`: é a tabela raiz, escrita pelo
console da plataforma (identidade, plano, assinatura) e sob RLS por `id` — o `PATCH` de uma tela
de admin de laboratório passaria a escrever na mesma linha que o billing edita, e a policy teria
forma diferente de todas as outras. Em `tenant_channels`: a configuração é do laboratório, não
do canal; duplicaria por canal um valor que é único. Tabela própria com `tenant_id` como PK
**e** chave da policy padrão mantém o mesmo formato das demais 16 tabelas. Não criar a linha no
onboarding evita que o `POST /platform/tenants` ganhe mais um passo transacional para gravar
exatamente os defaults.
**Impacto:** db, api, ui. `business_hours` é JSONB por ser lido inteiro e nunca filtrado por
parte, e é **substituído**, não mesclado por dia — merge por dia tornaria impossível fechar um
dia sem inventar um sentinela.

### D-066: A equipe vem embutida em `GET /settings/channels`, não de `GET /users`
**Decisão:** a resposta traz `team[]` com id, nome, papel e status — **sem e-mail e sem
alçada**, incluindo inativos, ordenado por nome. `GET /users` continua admin-only, inalterado.
**Motivo:** a tela é lida pelo gestor (PAGES.md §10) e `GET /users` é admin. As saídas eram:
alargar `/users` para gestor, o que entregaria e-mail e alçada de todo mundo por causa de uma
lista de nomes; ou servir o recorte mínimo aqui. A segunda é a interpretação mais restritiva
que AGENTS.md manda escolher, e mantém a tela de Usuários & Permissões como o único lugar que
governa papel e alçada.
**Impacto:** api, ui. Se a tela um dia precisar de qualquer campo além destes quatro, o caminho
é `GET /users` (e a discussão de papel volta), não engordar `team`.

### D-067: `/operations/overview` é UM endpoint, não três
**Decisão:** fila, carga por atendente e decisões pendentes vêm de uma única rota
(`GET /operations/overview`, gestor+), com `generatedAt` e sem cache.
**Motivo:** os três blocos são o retrato do mesmo instante e saem das mesmas duas tabelas.
Três rotas triplicariam o polling e permitiriam a tela mostrar uma fila de 14:03 ao lado de uma
carga de 14:05 — a incoerência que BUSINESS_RULES §5 existe para evitar, e que aqui seria
visível ao gestor (a soma da carga não bateria com a fila). Sem cache porque é um painel de
"agora": 5 minutos de TTL mostrariam uma fila que já não existe.
**Impacto:** api, ui. Tudo é derivado de `conversations` e `proposals` — nenhuma tabela nova.
"Em espera" é definido como `unread_count > 0`, deliberadamente o mesmo número do badge do
inbox: derivá-lo de "a última mensagem é do paciente" criaria uma segunda definição de
"esperando resposta" no mesmo produto. Os tempos saem em **segundos**, calculados no SQL em UTC
(`EXTRACT(EPOCH FROM (NOW() - COALESCE(last_message_at, created_at)))::int`) — subtrair datas em
JavaScript reintroduziria o defeito de fuso de D-021.

### D-068: `channel_reads` e `POST /internal-chat/channels/:id/read` (supera D-044)
**Decisão:** nasce `channel_reads (tenant_id, channel_id, user_id, last_read_at)`, PK
`(channel_id, user_id)`. `Channel.unreadCount` passa a ser derivado dela — mensagens com
`created_at > last_read_at` cujo `sender_id` não é o do usuário — e `Channel` ganha
`lastReadAt`. `POST /internal-chat/channels/:id/read` devolve `204` e é idempotente.
**Motivo:** D-044 servia `0` fixo por não haver tabela de leitura, o que produziu o defeito D5
da Onda 5: o badge subia e nunca descia. Contar "mensagens desde o login" seria número sem
origem (BUSINESS_RULES §5); a origem correta é o estado de leitura por usuário. O `unreadCount`
continua **derivado**, nunca materializado — contador incrementado é a segunda origem que a
regra proíbe. Mensagem de sistema conta de propósito: o pedido de aprovação em `#aprovacoes` é
o que mais precisa piscar. Mensagem do próprio autor nunca conta.
**Impacto:** db, api, ui. `listMessages` **não** marca como lido — ler página antiga do
histórico não é ter visto a mensagem nova. É a diferença deliberada para `GET /conversations/:id`
(D-035), onde a página 1 é literalmente o fim da conversa. A leitura não gera audit log.

### D-069: No chat interno, `page=1` é a página das mensagens mais recentes
**Decisão:** `GET /internal-chat/channels/:id/messages` pagina **do fim**: `page=1` cobre as
mensagens mais recentes, com os itens em ordem cronológica crescente dentro da página; `page=2`
é o bloco anterior. O `OFFSET` é `max(0, total - page * limit)`.
**Motivo:** a implementação da Onda 5 fatiava do começo (`created_at ASC` + `OFFSET` a partir da
primeira mensagem), então abrir um canal no estado útil custava **dois** requests: um só para
descobrir `totalPages` e outro para buscar a última página. Um chat abre no fim. A alternativa
seria cursor (`before=<id>`), mais correto sob escrita concorrente, mas mudaria o shape de
`pagination` só nesta rota e exigiria uma segunda convenção de paginação no projeto — e
`GET /conversations/:id` já documenta exatamente esta ("`page=1` é a página mais recente"). A
consistência interna venceu.
**Impacto:** api, ui. A última página (a mais antiga) pode vir com menos itens que `limit`;
a página 1 vem cheia sempre que houver mensagens suficientes. `totalPages` continua
`ceil(total / limit)`. Quem implementa segue esta regra — o `fetchTail` de dois requests some.

### D-070: Regra de envelope — listagem tem chave nomeada, recurso único viaja cru
**Decisão:** três formas, sem quarta. Listagem: chave nomeada no plural + `pagination` (D-009).
Recurso único (GET, POST ou PATCH): o objeto **cru**. Resposta composta (mais de um recurso, ou
recurso + meta): uma chave por parte. Sem corpo: `204`.
**Motivo:** a Onda 5 terminou com duas convenções convivendo (defeito D8): `POST
/platform/tenants` devolvia `{ tenant }` enquanto `POST /users` e
`POST /internal-chat/.../messages` devolviam o objeto cru. Duas formas para o mesmo caso obrigam
quem escreve cliente a consultar o doc endpoint a endpoint. A maioria esmagadora dos endpoints
já era crua, então essa é a regra que muda menos código; e envelopar um recurso único só
acrescenta um nível para desembrulhar, sem carregar informação nenhuma.
**Impacto:** api, ui. **Muda exatamente um endpoint:** `POST /platform/tenants` passa a
devolver `TenantSummary` cru, e `CreateTenantResponse` (`shared/types/platform.types.ts`) virou
alias de `TenantSummary`. Dono da correção: **Agent-API-Fixes** (controller) + o cliente
`frontend/src/api/platform.ts`. **Exceção explícita registrada:** `GET`/`PATCH
/themes/current` continuam em `{ theme }`, porque o mesmo objeto viaja aninhado em
`tenant.theme` no login e desembrulhar aqui criaria duas formas do mesmo dado no bootstrap, sem
ganho.
**Varredura completa (Onda 6):** as demais formas fora das tres regras estao registradas na
tabela de excecoes de `API_CONTRACTS.md` §"Excecao explicita, registrada" — as projecoes
parciais de `PATCH /proposals/:id/{status,discount,approve,reject}` (devolvem so o que a
operacao mudou; o recurso inteiro sai em `GET /proposals/:id`) e o ACK `{ received: true }` do
webhook da Meta (nao e recurso). Na mesma varredura o campo `message` em pt-BR saiu de
`/approve` e `/reject`: texto de interface e do frontend (i18n), e `approvalStatus` ja carrega
a informacao. Fora dessas linhas, qualquer envelope de recurso unico e bug de contrato.

### D-071: `proposal_items.position INT NOT NULL DEFAULT 0`
**Decisão:** a coluna entra na migração 003; o `INSERT` grava o índice do item no array do
request, e toda leitura ordena por `position ASC, created_at ASC`.
**Motivo:** fecha o pedido do Agent-API-Proposals em STATUS.md. Hoje a ordem em que o atendente
montou o orçamento é preservada deslocando `created_at` em 1 microssegundo por item, porque o
desempate por `id` (UUID aleatório) embaralhava a lista. Isso é uma coluna de tempo sendo usada
como coluna de ordem: qualquer reprocessamento, importação ou migração que normalize timestamps
embaralha o orçamento, e o defeito só aparece na tela do paciente.
**Impacto:** db, api. `DEFAULT 0` torna a migração compatível com o dado existente — nenhum
backfill é obrigatório, e o segundo critério (`created_at`) mantém as propostas antigas na ordem
atual. Sem mudança de contrato externo: `ProposalItem` já é um array ordenado.

### D-072: Paciente nasce junto da conversa; nome do canal preenche, nunca sobrescreve
**Decisão:** `ConversationRepository.findOrCreateByPhone` passa a criar/reaproveitar a linha de
`patients` e a gravar `conversations.patient_id` na **mesma transação** (funcao de repositorio sobre
a `DbTx` ja aberta, nao chamada de service — transacao nao aninha, D-008). Tres regras sobre o nome
que vem do perfil do canal: (1) **nunca sobrescreve** nome ja cadastrado; (2) **preenche** quando o
cadastro esta sem nome (`COALESCE(p.name, EXCLUDED.name)`); (3) **paciente anonimizado nao volta a
existir** — a anonimizacao (D-063) troca o telefone por `anon-<id>`, entao o `ON CONFLICT
(tenant_id, phone)` de um numero real nunca alcanca a linha morta e o contato seguinte cria cadastro
novo.
**Motivo:** ate aqui **so o backfill da migracao 003** preenchia `conversations.patient_id`. Todo
paciente que chegasse pelo webhook depois da Onda 6 nasceria com `patient_id NULL` e ficaria
invisivel na Ficha do Paciente — um defeito que funciona na demo e morre em producao. Quanto ao
nome: o cadastro e editado pelo atendente, enquanto o nome do perfil do WhatsApp e apelido escolhido
por terceiro ("Jhow 🔥") e nao pode vencer o dado de negocio.
**Impacto:** api, db. Consequencia aceita e desejada: o historico anterior ao pedido de apagamento
**nao** e reanexado ao cadastro novo — e exatamente o que "direito ao esquecimento" significa. O
`CASE WHEN p.anonymized_at IS NOT NULL` no upsert e cinto de seguranca caso alguem, no futuro,
anonimize sem embaralhar o telefone. Bug pre-existente corrigido no caminho: o upsert usava CTE com
`JOIN` de volta e a parte principal da query enxerga o snapshot anterior ao statement, entao
**nenhum paciente novo era retornado** — so o caminho `DO UPDATE` funcionava. O metodo ainda nao
tinha consumidor, por isso ninguem tinha visto.

### D-073: Credenciais de canal saem da tabela, com fallback campo a campo para env var
**Decisão:** `WhatsAppCredentialsResolver` le `tenant_channels` via
`ChannelSettingsService.resolveCredentials`, caindo nas env vars **campo a campo** (linha ausente ou
coluna nula). `apiUrl` continua so em env var. Segredo de webhook vazio continua recusando tudo.
**Motivo:** fecha o D-024, que registrava a ausencia de tabela de canal por tenant como divida. O
fallback e campo a campo, e nao "linha existe ⇒ ignora env", porque um laboratorio pode ter
conectado o numero sem ainda ter girado o segredo do webhook — e um ambiente ja configurado nao pode
quebrar no deploy desta onda.
**Impacto:** api, infra. `apiUrl` fica fora porque e endereco da API do canal (e decide driver mock
x real), nao credencial do laboratorio.

> **Emenda (Onda 6): o fallback distingue "nunca configurou" de "revogou".** Como escrito, o
> fallback campo a campo tornava **inócuo** o `null` do contrato: `{"webhookSecret": null}` apaga a
> coluna e a resposta volta `webhookSecretSet: false` — mas o resolver então devolvia
> `WHATSAPP_WEBHOOK_SECRET`, que é **um valor para a instalação inteira**. Quem conhecesse esse
> segredo (operador de infra, um `.env` vazado, outro laboratório da mesma instalação) assinaria
> webhook válido para **todo** tenant que ainda não tivesse girado o próprio — e o slug vai na
> URL, que é pública. Isso é escrita cross-tenant em `messages`/`conversations`/`patients`. O
> mesmo valia para `apiToken: null`, que devolvia o envio ao número global.
>
> A coluna passa a ter **três** estados, e o fallback só vale para o primeiro:
>
> | coluna | significado | resolver |
> |--------|-------------|----------|
> | `NULL` | o laboratório nunca configurou | **cai na env var** (dev, CI e o ambiente que já rodava só com env var continuam funcionando) |
> | `''`   | o laboratório **revogou** (`null` no PATCH) | **sem fallback**: o webhook recusa tudo e o envio recusa sair |
> | texto  | o valor (cifrado em repouso, D-076) | usa o valor do laboratório |
>
> A sentinela é string vazia — e não uma coluna nova — porque `''` já era o valor que a leitura
> da tela tratava como "não configurado" (`webhook_secret <> ''`): o contrato de §6 não muda, a
> tela não vê diferença entre os dois primeiros estados e nenhuma migração é necessária. `''`
> nunca é cifrado: é estado, não segredo.

### D-079: `patientId` entra no contrato de conversa (campo opcional, não reabre a D-059)
**Decisão:** `Conversation` (e portanto `ConversationDetail`) ganha `patientId: string | null`,
mapeado de `conversations.patient_id` em `toConversation`. A Ficha do Paciente passa a ter porta de
entrada no produto: coluna 3 do Atendimento (PAGES.md §2), fila da Gestão da Operação (§10, via
`QueueItem.patientId`, que já existia na resposta e era descartado) e a busca de pacientes do inbox,
que passa a consumir `GET /patients` (PAGES.md §2/§3). Onde `patientId` é `null` o link **não é
renderizado** — não é link quebrado nem botão desabilitado sem explicação.
**Motivo:** a D-059 congelou `/conversations` para não quebrar cliente existente, e a leitura estrita
disso deixou `/patients/:id` sem nenhum caminho de navegação: as únicas ocorrências da rota eram a
declaração e o registro de permissão, e `patientsApi.list` não tinha chamador nenhum. Um atendente
logado não conseguia abrir a ficha de ninguém — o E2E não pegava porque entrava por URL direta.
Acrescentar campo **opcional** é backward compatible e é o padrão do projeto (AGENTS.md: "campos
novos são sempre opcionais até ambos os lados suportarem"): quem não conhece `patientId` ignora, e
nada do que já existia mudou de forma ou de significado. Os denormalizados `patientName`/
`patientPhone` continuam sendo o que a lista exibe — `patientId` serve para navegar, não para
mostrar.
**Impacto:** api, ui, docs. `GET /conversations` e `GET /conversations/:id` passam a devolver mais um
campo (API_CONTRACTS.md §2). Multitenant e recorte por papel valem para o link: `patientId` só chega
em conversa que o solicitante já enxerga, e `GET /patients/:id` reaplica o recorte de D-060 (404,
nunca 403) — o link nunca revela paciente que o usuário não poderia ver por outro caminho.

### D-077: `/operations/overview` não pagina as decisões pendentes — `pagination` é só o "quantas ficaram de fora"
**Decisão:** o contrato deixa de prometer paginação incremental em `pendingDecisions`.
`OperationOverviewQuery` continua com `queueLimit`/`decisionsLimit` e **nada mais**;
`pendingDecisions.pagination` continua sendo o `PaginationMeta` padrão, mas descrevendo sempre
`page: 1`. Quem precisa da lista completa e paginável vai para `GET /proposals` filtrado por
aprovação pendente.
**Motivo:** o shape e a implementação já diziam isso (`operation.service.ts` fixa `page: 1`; não
existe `decisionsPage` para receber). O texto de API_CONTRACTS §7 justificava o campo com "para
a tela paginar a lista de decisões sem recarregar a fila" — algo que este endpoint **não pode**
entregar: a resposta é um retrato único do mesmo instante (D-067), então pedir a página 2 das
decisões refaz fila e carga junto. Acrescentar o parâmetro seria implementar uma paginação que
recarrega tudo a cada página para uma lista que, por definição de fila de decisão, é curta —
custo real por um ganho imaginário. Corrigir o texto é a opção honesta.
**Impacto:** docs (API_CONTRACTS §7). Nenhuma mudança de código nem de shape: `pagination`
segue no `OperationPendingDecisions` porque `total`/`totalPages` são o que a tela usa para
oferecer o "ver todas". Endpoint novo que recortar lista sem paginar de verdade documenta isso
explicitamente, como aqui.

### D-078: `TimeZone=UTC` fixado na conexão, e aritmética de tempo explícita em UTC
**Decisão:** duas travas, de propósito. (1) `PgDriver` abre o pool com
`options: '-c timezone=UTC'`, fixando o `TimeZone` da sessão do banco. (2) toda aritmética entre
`NOW()` e coluna `TIMESTAMP` sem fuso usa **`NOW() AT TIME ZONE 'UTC'`**, não `NOW()` cru —
hoje as duas ocorrências em `operation.repository.ts` (espera da fila e espera da decisão).
**Motivo:** defeito **provado**, não suspeitado. `last_message_at`, `created_at` e afins são
`TIMESTAMP` **sem** fuso, gravados em UTC; `NOW()` é `timestamptz`. Subtrair um do outro faz o
Postgres converter a coluna pelo `TimeZone` da **sessão**, e nada fixava esse fuso: nem o
`docker-compose.yml`, nem o driver. Sondagem em PGlite (Postgres 16), mesma linha, mesmo
instante:
```
TimeZone=UTC                -> EXTRACT(EPOCH FROM (NOW() - ts))::int =      0
TimeZone=America/Sao_Paulo  -> EXTRACT(EPOCH FROM (NOW() - ts))::int = -10800
```
E com o cenário real da tela, sob `America/Sao_Paulo`, a espera de 3 h da fila voltava como
`0` s. Hoje passa despercebido só porque a imagem oficial do Postgres roda em UTC — num servidor
em `America/Sao_Paulo` a Gestão da Operação mentiria em horas. É o mesmo defeito que D-021
registrou, reaparecendo por outro caminho.
**Impacto:** api, infra. Fixar o fuso na conexão elimina a classe inteira de bug e custa uma
linha; a aritmética explícita é o cinto que continua segurando se alguém trocar o driver ou
apontar para um pool externo que não passe `options`. `generatedAt` já era imune
(`to_char(NOW() AT TIME ZONE 'UTC', ...)`) e segue igual. Regressão coberta por
`tests/operation/operation-overview.spec.ts` → "esperas nao mudam com o TimeZone da sessao do
banco", que faz `SET TimeZone='America/Sao_Paulo'` antes de ler o retrato. Query nova que
subtrai `NOW()` de coluna `TIMESTAMP` escreve `AT TIME ZONE 'UTC'` — não é estilo.

### D-074: `isActive: false` desliga o canal nos DOIS sentidos
**Decisão:** `tenant_channels.is_active` passa a valer para valer. `false` significa: (1) o
webhook do tenant é **recusado** — antes do HMAC, sem tocar no banco, com a mesma resposta
`200 {received:true}` de todos os outros caminhos; (2) `WhatsAppService.send` **lança antes de
enfileirar**, e o `MessageService` reflete isso como `status: failed` + `MESSAGE_SEND_FAILED`
(502). Linha ausente na tabela = canal ligado (o ambiente só-env-var não muda).
**Motivo:** `isActive: false` é o **único** desligamento que o contrato oferece —
API_CONTRACTS.md §6 diz literalmente "não existe remoção de canal nesta rota; desligar é
`isActive: false`". Ele não fazia nada: a tela mostrava o canal inativo e o webhook com HMAC
válido continuava criando paciente + conversa + mensagem, enquanto o envio continuava saindo
pelo token guardado. É o gesto que um admin faz **justamente quando descobre que o token
vazou** — o momento em que um controle decorativo é pior que controle nenhum, porque ele
acredita ter contido o incidente. Recusar antes do HMAC (e não depois) é de propósito: canal
desligado não chega nem a usar o segredo.
**Impacto:** api, segurança. A resposta do webhook continua invariável — desligado, ligado,
tenant inexistente e assinatura errada respondem a mesma coisa, senão a rota vira oráculo de
enumeração. O envio falha **rápido**: a fila não tenta 3 vezes o que não é falha transitória.
Religar é `isActive: true` — o kill switch não é via de mão única.

### D-075: o apagamento LGPD alcança o audit log e o anexo
**Decisão:** `PatientRepository.anonymize` passa a fazer, na **mesma transação**, mais duas
coisas além do cadastro e das cópias denormalizadas: (3) `messages.attachment_url = NULL` nas
mensagens das conversas do titular; (4) em `audit_logs` com
`entity_type = 'patient' AND entity_id = <id>`, o **valor** de cada chave de
`old_values`/`new_values` vira `"[ERASED]"`. Linha, `action`, `user_id`, `timestamp`,
`ip_address` e as **chaves** dos objetos permanecem. É a **única** escrita não-append de
`audit_logs` no projeto, vive em `auditRepo.eraseEntityValues` e **nenhum controller a
alcança** — só a transação de anonimização.
**Motivo:** `PATCH /patients/:id` grava o valor anterior e o novo de cada campo alterado, o que
inclui `document` (CPF), `name`, `email`, `birthDate` e `notes`. Com o audit log intacto,
`GET /api/v1/audit?entityType=patient&entityId=<id>` — rota suportada, admin — devolvia a
ficha "apagada" inteira em claro. O produto prometia apagamento e não apagava, e a promessa é
jurídica. A saída **não** é apagar a linha de auditoria: auditoria existe para provar **que** a
edição aconteceu, e isso continua provado (quem, quando, de onde, qual campo). O que ela não
precisa guardar depois do pedido do titular é o **valor** do dado pessoal. Manter as chaves é o
que separa "auditoria com o dado redigido" de "auditoria destruída".
**Impacto:** api, db, segurança, LGPD. Emenda D-063 (ver lá). O escopo é **por entidade**:
apagar o titular X não toca na auditoria do titular Y nem em `entity_type` diferente de
`patient`. Idempotente (`"[ERASED]"` reescrito continua `"[ERASED]"`). SECURITY.md "Auditoria"
passa a dizer "append-only, com uma exceção nomeada" em vez de "nunca editável" — a regra que
não admite exceção é a de **não haver DELETE**, e essa continua valendo.

### D-076: credencial de canal é cifrada em repouso, com chave em env var
**Decisão:** `tenant_channels.api_token` e `tenant_channels.webhook_secret` são gravados
cifrados com **AES-256-GCM** (`backend/src/lib/secret-box.ts`), com chave derivada de
`CHANNEL_SECRET_KEY`. A env var é **obrigatória em `NODE_ENV=production`** (mínimo 32
caracteres, validada em `env.ts`: sem ela o processo não sobe) e **opcional em dev/CI**, onde o
valor é gravado em claro. A leitura aceita os dois formatos, então a migração do dado existente
é preguiçosa — acontece na próxima escrita. Nenhuma coluna nova.
**Motivo:** SECURITY.md dizia "segredos só em env vars" e o precedente do projeto é
`refresh_tokens`, guardado **hasheado** (SCHEMA.md §14) — mas estes dois valores precisam
voltar em claro (o token vai no `Authorization` da API do canal; o segredo assina o HMAC), então
hash não serve. Aceitar o risco foi considerado e recusado: o ativo em jogo não é só leitura. O
`webhook_secret` é **permissão de escrita** — quem o tem injeta mensagem de paciente em nome do
laboratório —, o dump é multitenant (um backup entrega **todos** os laboratórios de uma vez) e
backup é justamente o artefato que mais circula fora do perímetro do banco. Cifrar com uma chave
que **não mora no banco** faz o dump sozinho não bastar, e essa é a diferença que importa.
**Impacto:** api, infra, segurança. **Exige do ambiente:** `CHANNEL_SECRET_KEY` no `.env` de
produção (já em `.env.example` e em `docker-compose.prod.yml`, que também recusa subir sem
ela); **trocar a chave invalida as credenciais gravadas** — os laboratórios precisam reconectar
o canal, e não há rotação automática (dívida assumida). Consequência de projeto:
`apiTokenMasked` não sai mais de `RIGHT(api_token, 4)` no SQL — `RIGHT` sobre ciphertext seria
mentira — e é montado no repositório, depois de decifrar; a fronteira de D-064 continua sendo o
repositório, mudou de camada e não de lugar. **Risco residual aceito e declarado:** quem tem o
dump **e** a env var lê tudo; a chave é única para a instalação (não por tenant); e a cifra não
protege contra um backend comprometido em execução — ele precisa dos valores em claro para
operar.

### D-080: o catálogo do orçamento é seletor — busca server-side + carga incremental, não `Pagination`
**Decisão:** a coluna de catálogo de `/budget/new` (`CatalogSegments`) alcança o catálogo inteiro por
**busca server-side + carga incremental** (`useInfiniteQuery` via `useExamListInfinite`, botão
`Carregar mais`, rodapé `N de M exames`), e **não** pelo componente `Pagination` numerado que
`/proposals` e `/catalog` usam. A página **não** vai para a URL nesta tela. Chave de cache própria,
`queryKeys.examsInfinite` (`['exams','infinite',filtros]`), dentro do escopo `['exams']`.
**Motivo:** a tela renderizava `useExamList(...).exams` com `limit: 50` — uma página só. Laboratório
com mais de 50 exames ativos **não conseguia montar orçamento** com os demais: eles não eram
alcançáveis por gesto nenhum da tela. É a D7 da Onda 5, fechada nas duas telas listadas e não aqui,
porque ninguém olhou para o seletor; o E2E não pegava porque o seed tem 14 exames.
A forma é diferente das outras duas porque o problema é diferente. `/proposals` e `/catalog` são
**tabelas**, onde trocar de página é o gesto esperado e "a página" é estado compartilhável (por isso
mora na URL). Isto é um **seletor**: o usuário monta um carrinho na coluna da direita enquanto
procura na esquerda, e substituir o conteúdo da lista sob ele tiraria da tela o que ele acabou de
ver sem devolver nada em troca — ninguém quer "voltar à linha 47" de um seletor, quer achar um
exame. Acumular páginas preserva o que já foi lido; a busca, que o backend já implementa
(`GET /exams?search=`, API_CONTRACTS §4, dobra de caixa e acento no repositório), recorta o catálogo
inteiro no banco, não as linhas carregadas. As duas juntas cobrem os dois modos de procurar: sei o
nome (busco) e não sei (rolo).
Chave separada porque `useInfiniteQuery` guarda `{ pages, pageParams }`, shape incompatível com o
`ListExamsResponse` de `useExamList`; mantida sob `['exams']` para que `queryScopes.exams` continue
invalidando as duas de uma vez quando o catálogo muda.
**Impacto:** ui, docs. Nenhuma mudança de contrato: `page`/`limit`/`search` de `GET /exams` já
existiam e o backend não muda. `PAGES.md §4` passa a fixar a forma. `Pagination` continua sendo o
padrão de **tabela** — esta decisão não o enfraquece, delimita onde ele se aplica. E2E:
`flow-12-pagination.spec.ts` prova o alcance com um recorte de 55 exames (maior que o `limit: 50`
antigo de propósito — um lote menor passaria com o defeito).

---

## 2026-08-30 — Contrato da Onda 7 (Agent-Docs-Onda7)

Fase 0 do plano `docs/superpowers/plans/2026-08-30-onda-7.md`: convênios/TUSS no catálogo,
conexão WhatsApp por QR (Evolution API) e fechamento de pendências. Nada de implementação — só
contrato. Fonte: `docs/superpowers/specs/2026-08-30-onda-7-design.md` (aprovado pelo lead
técnico em 2026-08-30).

### D-081: Código TUSS/AMB nulo nunca é inventado
**Decisão:** `exam_catalog.tuss_code` e `exam_catalog.amb_code` (SCHEMA.md §7) são `NULL` para
todo exame cujo código não foi confirmado pela pesquisa registrada no spec da Onda 7 (Apêndice
B). Nenhum código é adivinhado por padrão de nomenclatura, proximidade textual ou "parece
certo". O mesmo vale para `insurances.ans_code`: convênio sem registro ANS confirmado (a
maioria dos regionais) fica `NULL`, nunca um código de outro convênio ou um placeholder.
**Motivo:** TUSS é código regulatório usado na guia SP/SADT de faturamento de convênio — um
código errado não é um dado incompleto, é uma **guia rejeitada ou uma cobrança sobre o
procedimento errado**. A tentação de inferir por proximidade (ex.: preencher hormônios pelos
`40712xxx` de radioimunoensaio legado, que aparecem em tabelas antigas, em vez dos `40316xxx`
vigentes) produziria dado com aparência de certo e consequência financeira real. `NULL` é
honesto; um código plausível e errado não é.
**Impacto:** db, api, ui. `POST/PATCH /exams` aceita `tussCode`/`ambCode` como `string | null`
explícito — a tela não pré-preenche esses campos com sugestão nenhuma. O seed do catálogo (~60
dos 106 exames com TUSS confirmado, Onda 7 — Fase 1) documenta caso a caso a fonte da pesquisa;
o restante entra `NULL` com nota, não é lacuna a "resolver depois" por adivinhação.

### D-082: "Particular" é ausência de convênio, não linha de `insurances`
**Decisão:** não existe convênio "Particular" cadastrado em `insurances`. Uma proposta
particular é `proposals.insurance_id = NULL` (SCHEMA.md §5); um exame sem preço de convênio
cadastrado usa `exam_catalog.price_private` via fallback do `ExamCatalogService.resolveActiveByIds`/
`list` (SERVICES.md §5, quarto parâmetro `insuranceId` opcional), nunca uma linha de
`exam_prices` apontando para um convênio fantasma.
**Motivo:** modelar "Particular" como convênio exigiria espelhar `price_private` dentro de
`exam_prices` para manter os dois caminhos consistentes — criando uma **segunda origem** para o
mesmo número (BUSINESS_RULES.md §5, "um número, uma origem"). Toda vez que `price_private`
mudasse, a linha espelhada teria que mudar junto, e um esquecimento divergiria os dois preços
sem nenhum erro visível. `NULL` como sentinela de "sem convênio" já é o padrão do projeto
(BUSINESS_RULES.md §10) e não custa uma tabela.
**Impacto:** db, api, ui. `CreateProposalRequest.insuranceId` é opcional; `null`/ausente = 
particular. O seletor de convênio em `/budget/new` (Onda 7 — Fase 2) tem "Particular" como
opção da UI, não como item vindo de `GET /insurances` — a tela sintetiza a opção, o backend
nunca a serve.

### D-083: Gateway Evolution separado do monolito; versão fixada com fallback documentado
**Decisão:** WhatsApp sem API oficial da Meta usa **Evolution API** como gateway self-hosted,
um serviço próprio no `docker-compose.yml`/`.prod.yml` (nunca lib embutida no backend Express).
A imagem roda com versão **fixada na v2.3.7** — a **última versão sem exigência de ativação de
licença** — e a linha **2.4.x** (que exige ativação gratuita de licença da Evolution Foundation,
com heartbeat a cada ~30 min contra o servidor deles) fica registrada como **fallback**: subir
para 2.4.x é o caminho se v2.3.7 se mostrar insuficiente (bug corrigido só na linha nova,
recurso necessário ausente), aceitando nesse momento a dependência operacional externa que a
v2.3.7 evita hoje. Baileys embutido e WAHA foram avaliados e descartados para este papel.
**Motivo:** entre exigir uma dependência de disponibilidade de terceiro (o servidor de licenças
da Evolution Foundation) de saída e adotá-la só se e quando for necessário, a segunda é mais
conservadora — começar sem essa dependência e subi-la sob demanda documentada é reversível na
direção certa; o inverso (já operar dependente de um serviço externo de terceiro para o WhatsApp
do laboratório continuar funcionando) não seria uma escolha revisitável sem esforço.
Adicionalmente: sessões de WhatsApp são **stateful e de vida longa** (o pareamento sobrevive
entre deploys); o backend Express é stateless e reiniciável por design (D-007) — embutir a
sessão no processo do backend acoplaria o ciclo de vida de dois recursos com requisitos opostos,
e um redeploy de rotina derrubaria conexões pareadas. Gateway separado também isola o efeito de
mudança de protocolo da Meta: quando ela muda, o conserto é trocar a tag da imagem, sem tocar em
uma linha do código do CRM. A versão fixada (em vez de `latest`) evita que uma atualização
automática do gateway mude comportamento sem aviso; o fallback documentado antes de precisar
dele é o que torna a migração de versão uma decisão de infra rápida, não uma investigação sob
pressão no dia em que a v2.3.7 se mostrar insuficiente.
**Impacto:** infra, api, segurança. `EVOLUTION_API_URL`, `EVOLUTION_API_KEY` e
`EVOLUTION_WEBHOOK_TOKEN` são env vars novas, validadas em `env.ts`; ausentes ⇒
`CHANNEL_QR_UNAVAILABLE` (nunca crash no boot). Cada tenant é uma instância nomeada
(`tenant-<tenantId>`) isolada por apikey própria, cifrada com a infra de D-076. Ver a nota de
risco em `docs/architecture/SECURITY.md` (ToS/banimento, dado de saúde no gateway self-hosted).

### D-084: `user.came_online` sai do contrato de WebSocket — execução registrada, não feita nesta onda
**Decisão:** `websocket.types.ts` (`WsEventName`/`WsEventPayloads` de `@crm-lab/shared`) e o
`case` correspondente em `ws.ts` do backend **devem** perder a entrada `user.came_online`. Esta
tarefa (Fase 0, só contrato) **não executa** a remoção — o tipo compartilhado continua com o
campo por enquanto. A remoção de tipo e de código acontece **atomicamente, no mesmo commit**,
numa task de implementação da Fase 2 desta mesma onda (pendência C6 do spec).
**Motivo:** o evento nunca teve emissor — nenhum caminho do backend publica
`user.came_online`, então o contrato descrevia uma notificação que o frontend podia assinar e
nunca receberia (contrato mentiroso). A ordem de execução muda em relação ao texto original do
plano por decisão do coordenador: as 11 tasks da Fase 2 rodam com
`npm run typecheck --workspace backend`/`--workspace frontend` como critério de pronto, e
remover o campo do tipo compartilhado **antes** de remover o `case` que o lê quebraria o
typecheck de toda tarefa que tocar nesses workspaces até a remoção de código acontecer — um
custo desnecessário espalhado por várias tasks paralelas, por uma limpeza que uma tarefa só
resolve num commit. Documentar a decisão agora (Fase 0) e adiar a execução (Fase 2) mantém a
Regra Zero (o contrato final está registrado desde já) sem quebrar o critério de pronto das
tasks intermediárias.
**Impacto:** api, ui, docs. Se presença de usuário voltar a ser feature, o evento retorna junto
com o service que o emite — não como campo solto no tipo. `API_CONTRACTS.md` "WebSocket Events"
(exemplo `socket.on('user.came_online', ...)`) também será atualizado no commit que executa a
remoção, fora do escopo desta Fase 0.

### D-085: `message` de `POST /proposals` sai do contrato — execução registrada, não feita nesta onda
**Decisão:** `CreateProposalResponse.message` (`shared/types/proposal.types.ts`) e a linha
correspondente em `proposal.service.ts`/`proposal.routes.ts` **devem** ser removidas — é a
pendência C7 do spec da Onda 7. Esta tarefa (Fase 0, só contrato) **não executa** a remoção — o
tipo compartilhado continua com o campo opcional por enquanto, como API_CONTRACTS.md §"Envelope
de resposta" já documentava ("é o último texto de UI em pt-BR que sai do backend"). A remoção de
tipo e de código acontece **atomicamente, no mesmo commit**, numa task de implementação da Fase
2 desta mesma onda (`Agent-Fix-Pendencias`).
**Motivo:** o mesmo da D-084, aplicado ao mesmo padrão de campo — texto de interface em pt-BR
vindo do backend é i18n do frontend (D-070), e `approvalStatus` já carrega toda a informação que
`message` descreve em prosa. A ordem de execução muda pela mesma razão da D-084: remover o
campo do tipo compartilhado antes de remover o código que o produz quebraria
`npm run typecheck --workspace backend` de qualquer task da Fase 2 que toque
`proposal.service.ts` antes da limpeza — custo espalhado por tarefas paralelas para uma limpeza
que uma tarefa só resolve num commit.
**Impacto:** api, ui, docs. `API_CONTRACTS.md` §3 (`POST /proposals`) e a nota na seção
"Envelope de resposta" também serão atualizados no commit que executa a remoção, fora do escopo
desta Fase 0.

### D-101: Mensagens diretas (DM) no Chat Interno — get-or-create idempotente, chave canônica e visibilidade por participante
**Decisão:** `internal_channels` ganha `dm_user_a_id`/`dm_user_b_id` (migração
`010_internal_chat_dm.sql`) para registrar os dois participantes de uma DM, com
`CHECK (dm_user_a_id < dm_user_b_id)` — par ordenado canônico, sem depender de parsear a `key`.
A chave da DM segue o padrão `dm:{menorId}:{maiorId}`. `POST /internal-chat/dms {userId}` é
**get-or-create idempotente** (mesmo par sempre devolve o mesmo canal) e responde **200**, não
201 — mesmo precedente de `POST /settings/channels/whatsapp/connect` ("cria ou reaproveita").
O `name` gravado na linha de uma DM **não é exibido**: o nome mostrado é `Channel.otherUserName`,
resolvido por quem pergunta (o outro participante, nunca o próprio). `GET /internal-chat/users`
(diretório de usuários elegíveis a DM) fica sob `/internal-chat`, não sob `/users` — `/users` é
admin-only (tela de gestão), e o diretório de chat precisa ser visível a qualquer membro do
laboratório (attendant/manager/admin).
**Motivo:** uma DM não pode aparecer, nem ser lida/escrita, por quem não é um dos dois
participantes — o filtro de visibilidade (`ch.kind = 'channel' OR ctx.userId IN
(dm_user_a_id, dm_user_b_id)`) estende a regra já existente "recurso de outro tenant →
`NOT_FOUND`, nunca `FORBIDDEN`" (SECURITY.md camada 2) para "recurso do MESMO tenant do qual não
participo → `NOT_FOUND`" — sem essa correção, `findChannelById` (compartilhado por
`listChannels`, `GET/POST .../messages` e `.../read`) devolveria qualquer canal do tenant,
inclusive DM alheia, para quem adivinhasse o id. Reaproveitar `/users` para o diretório
misturaria dois contratos diferentes (gestão administrativa vs. "com quem posso conversar") e
exigiria relaxar `requireRoles('admin')` numa rota já documentada — mais simples e mais seguro
um endpoint novo com escopo próprio.
**Impacto:** api (`GET /internal-chat/users`, `POST /internal-chat/dms` novos;
`Channel.otherUserId`/`otherUserName` novos), db (migração 010 — ver nota de numeração abaixo),
ui (seção "Usuários" na barra lateral do Chat Interno). Migração `010` foi reivindicada por esta
feature; `docs/superpowers/specs/2026-09-08-fusao-crm-fluxolab-design.md` citava
`010_plans_basic_plus.sql` para a Onda 9 (planos basic/plus), mas essa onda ainda não começou a
ser implementada (só existe como spec) — quando começar, sua migração é renumerada para `011`.
Sem WebSocket novo: criar uma DM sem enviar mensagem não notifica o outro lado em tempo real — só
a primeira mensagem, via `internal_chat.new_message` já existente, faz a DM aparecer para ele.

### D-102: Console da plataforma ganha detalhe por tenant — status de canal, admin mínimo e ações administrativas
**Decisão:** `GET /platform/tenants/:id` (novo) devolve `TenantDetail`: o `TenantSummary` de
sempre, mais `channels[]` (projeção de `tenant_channels` limitada a `channel`, `isActive`,
`connectionMode`, `connectedAt` — nunca `phoneNumber`/`apiToken`/`webhookSecret`), `admins[]`
(projeção de `users` limitada a `id`+`email`, **só** `role = 'admin'`, nunca `name` nem
`manager`/`attendant`) e `usage` (agregados: usuários ativos/total, `MAX(last_login_at)`,
propostas e mensagens do mês corrente — mesmo molde de `COUNT(*)` já usado em `billingUsage`).
Duas ações novas: `PATCH /platform/tenants/:id` (troca `isActive` e/ou `subscriptionPlan`, um ou
outro, nunca corpo vazio) e `POST /platform/tenants/:id/users/:userId/reset-password` (gera senha
temporária aleatória, devolvida em texto plano **uma única vez** na resposta, nunca logada; só
aceita `userId` cujo `role` seja `admin` do próprio tenant — `NOT_FOUND` em qualquer outro caso,
mesma regra de "recurso de outro tenant/fora de escopo → 404, nunca 403"). As duas ações são
auditadas (`update_tenant`, `reset_admin_password`) com o mesmo padrão diff-then-audit de
`user.service.ts#update` — `reset_admin_password` nunca grava a senha em `oldValues`/`newValues`.
**Motivo:** o produto vai ser vendido a múltiplos laboratórios no mercado, e quem opera a
plataforma comercialmente precisa saber, por cliente, se a integração de WhatsApp está de pé e
conseguir agir (suspender inadimplente, reativar, trocar plano, resetar acesso de um admin que
perdeu a senha) sem depender de acesso direto ao banco. Isso amplia deliberadamente o invariante
de `platform.service.ts` ("o operador não vê canal nem nome de usuário do laboratório") em dois
pontos mínimos e nomeados — status de canal (sem conteúdo, sem segredo, sem número de telefone) e
e-mail do admin (nunca nome, nunca papel operacional) — porque sem esse mínimo a ação de suporte
(saber qual conta resetar) não é executável. A dúvida se resolve para o lado conservador em tudo
que não está nesta lista: continua proibido projetar `phoneNumber`, qualquer segredo, `name` de
usuário, ou dado de `manager`/`attendant`.
**Impacto:** api (3 rotas novas em `/platform`, todas atrás de `requireRoles('platform_operator')`
já aplicado no router), db (nenhuma migração — só leitura/escrita de colunas existentes em
`tenant_channels`/`users`/`tenants`), ui (nova página de drill-down `platform/tenants/:id`, linha
clicável na listagem existente), docs (`SECURITY.md` "Console de Plataforma",
`API_CONTRACTS.md` §5b, `PAGES.md` §11, comentário de cabeçalho de `platform.service.ts`
atualizados no mesmo commit).

---

### D-103: Numeração sequencial de proposta, POR TENANT — não global
**Decisão:** `proposals` ganha `proposal_number` (`INTEGER NOT NULL`, migração
`011_proposal_number.sql`), único por `(tenant_id, proposal_number)`, gerado em
`ProposalRepository.insertProposal` via `pg_advisory_xact_lock(hashtext(tenant_id))` seguido de
`MAX(proposal_number) + 1`, na MESMA transação do `INSERT` — sem tabela de contador dedicada.
Exposto em `Proposal.proposalNumber` (`API_CONTRACTS.md` §3), formatado na UI como `#000123`
(`formatProposalNumber`, `@crm-lab/shared`).
**Motivo:** o UUID de `id` não é citável por telefone/WhatsApp — o atendente precisa de um
número curto para "orçamento tal" ser rastreável numa ligação ou mensagem. A numeração é POR
TENANT (não uma sequence global) para seguir a mesma convenção do resto do schema (RLS por
`tenant_id`, CLAUDE.md regra 1: nenhum dado de laboratório é compartilhado ou comparável entre
tenants) — o primeiro orçamento de cada laboratório novo começa em 1, e dois laboratórios nunca
competem pelo mesmo contador. A trava é advisory (não uma tabela de contador) porque o volume de
um laboratório não justifica a complexidade extra, e a trava soma no `COMMIT`/`ROLLBACK` da
própria transação sem estado residual.
**Impacto:** db (migração 011: coluna + backfill via `ROW_NUMBER() OVER (PARTITION BY tenant_id
ORDER BY created_at, id)` + índice único), api (`proposalNumber` em `Proposal`/`ProposalDetail`,
somado nos 3 shapes de resposta de `API_CONTRACTS.md` §3), ui (`ProposalCard`, `ProposalModal`
mostram `#000123` em vez do UUID truncado), seeds (`dev.ts`, `e2e.ts`, factory de teste
`createProposal` numeram por tenant também).

### D-104: "Enviar orçamento" avança estágio E entrega mensagem pronta na conversa
**Decisão:** Botão "Enviar orçamento" em `ProposalModal`/`ActionsRow`, visível só quando
`status === 'novo_contato'` (única transição de saída além de `perdido`, `ALLOWED_TRANSITIONS`).
Um clique faz DUAS coisas: `PATCH /proposals/:id/status` para `orcamento_enviado`, e navega para
`/attendance?conversationId=…&draft=…` com o `Composer` já preenchido com
`"Olá! Segue o orçamento nº #000123, no valor de R$ 179,80."` — a pessoa ainda revisa e aperta
"Enviar" no composer; nada sai sozinho.
**Motivo:** o fluxo anterior exigia dois passos manuais desconectados (mudar o estágio pelo
seletor, depois ir até o atendimento e escrever a mensagem do zero) — fácil de esquecer um dos
dois, e sem garantia de que o valor citado na mensagem bate com o total real da proposta. Um
clique que já entrega o texto certo elimina as duas fontes de erro; o composer continua exigindo
confirmação humana antes de qualquer coisa realmente sair pelo WhatsApp.
**Impacto:** ui (`ActionsRow.onSendProposal` novo prop opcional, `Composer.initialValue` novo
prop — seeded no mount, o Composer continua não-controlado depois disso;
`Attendance/index.tsx` lê `conversationId`/`draft` da query string só no mount, via
`useSearchParams`). Nenhuma mudança de contrato de API (a rota `PATCH .../status` já existia).

### D-105: Pipeline aceita voltar UM estágio, e ganha botão "Avançar para X"
**Decisão:** `ALLOWED_TRANSITIONS` (`shared/types/proposal.types.ts`) ganha 3 arestas de volta:
`orcamento_enviado → novo_contato`, `follow_up → orcamento_enviado`,
`negociacao → follow_up`. `ganho`/`perdido` continuam terminais — `ProposalService.updateStatus`
recusa qualquer transição a partir deles (`isTerminal`) ANTES de consultar a matriz, voltar não
reabre proposta fechada. Nova constante `NEXT_STAGE` (`orcamento_enviado → follow_up`,
`follow_up → negociacao`) alimenta um botão "Avançar para X" em `ActionsRow.tsx`, que soma-se
(não substitui) ao seletor "Mudar estágio" já existente — que agora também lista as novas
transições de volta, de graça, por já ler de `ALLOWED_TRANSITIONS`.
**Motivo:** pedido do usuário — o atendente precisa desfazer um "Enviar orçamento" clicado por
engano, ou voltar uma negociação que esfriou para follow-up, sem sair da tela normal do pipeline
(reabrir `ganho`/`perdido` fechados foi discutido e explicitamente descartado — maior escopo,
mexeria em histórico/auditoria/analytics de proposta encerrada). "Avançar para X" existe à parte
de "voltar": um clique cobre o caminho comum sem o atendente precisar abrir o seletor toda vez.
**Impacto:** shared (`ALLOWED_TRANSITIONS`, `NEXT_STAGE` novos em `proposal.types.ts` — backend e
frontend leem da mesma constante, nenhuma mudança de código em `ProposalService.updateStatus`),
ui (`ActionsRow.tsx`: botão novo "Avançar para X"; o Kanban de `Proposals.tsx` também passa a
aceitar arrastar um card pra trás nessas 3 transições, de graça, mesmo mecanismo de
`isTransitionAllowed`), docs (`BUSINESS_RULES.md` §3, `WORKFLOWS.md` §4).

### D-106: `phone` passa a ser editável na Ficha do Paciente (reverte D-061)
**Decisão:** `PATCH /patients/:id` aceita `phone` (string, **nunca** `null` — apagar deixaria o
paciente sem chave de dedupe). O valor é normalizado para o mesmo formato E.164 que o webhook
grava (`+5548999991234`, mesma lógica de `toE164` de `conversation.service.ts`) antes de gravar
e antes de comparar para auditoria. O índice único `(tenant_id, phone)` continua sendo a única
defesa contra duas linhas com o mesmo telefone: tentar salvar um número que já pertence a OUTRO
paciente do tenant devolve `409 CONFLICT` (`details.reason: "phone_already_in_use"`) — a escrita
é recusada, **nunca funde os dois cadastros**.
**Motivo:** pedido do usuário — corrigir um telefone digitado errado no cadastro (ou atualizado
pelo paciente por outro canal) hoje exige recriar o cadastro inteiro, o que D-061 não previa
como fluxo aceitável no dia a dia. A fusão de dois cadastros que hoje têm o MESMO número
continua fora de escopo (seria um fluxo de merge separado); esta mudança só resolve o caso
comum, "consertar um número errado", bloqueando o caso ambíguo com um erro explícito em vez de
implementar merge automático.
**Impacto:** shared (`UpdatePatientRequest.phone` novo em `patient.types.ts`), api
(`updatePatientSchema` aceita `phone`; `PatientService.update` normaliza e traduz violação de
unicidade em `CONFLICT`; `PatientRepository` ganha `isUniqueViolation`, mesmo padrão de
`exam.repository.ts`/`insurance.repository.ts`), ui (`PatientProfileForm.tsx`: campo deixa de
ser `readOnly`, trata `CONFLICT`/`phone_already_in_use` com mensagem própria), docs
(`API_CONTRACTS.md` §2c, `PAGES.md` §3).

### D-107: Botão "Enviar mensagem" na Ficha do Paciente abre o Atendimento
**Decisão:** a Ficha do Paciente (`/patients/:id`) ganha um botão "Enviar mensagem" no cabeçalho.
Ao clicar, chama `POST /conversations` com `{ patientPhone: patient.phone, patientName:
patient.name ?? 'Paciente', patientEmail: patient.email, channel: 'direct' }` — o MESMO
`findOrCreateByPhone` de D-059/D-089 (nenhum endpoint novo): devolve a conversa existente daquele
telefone ou cria uma atribuída a quem clicou. Em seguida navega para
`/attendance?conversationId=<id>`, o mesmo deep-link que "Enviar orçamento" já usa. Erro
`409 CONVERSATION_ALREADY_ASSIGNED` (telefone já tem conversa de OUTRO atendente) vira toast com
o nome de quem está atendendo — não navega, porque abrir uma conversa fora da visibilidade do
usuário devolveria `404` do outro lado.
**Motivo:** pedido do usuário — a ficha era só leitura/edição de cadastro; não havia caminho de
volta para o chat. Reusar `POST /conversations` (em vez de um endpoint novo) evita uma segunda
forma de achar-ou-criar conversa por telefone divergindo da primeira.
**Impacto:** ui (`Patients/Profile.tsx`: botão + mutation; nenhuma mudança de api/schema/backend
— consome contrato já existente), docs (`PAGES.md` §3).

### D-108: Produto único, sem planos na v1 — entitlement por plano fica aditivo, para depois
**Decisão:** a fusão CRM Lab + FluxoLab (Onda 9) não cria `requirePlan`, `PLAN_FEATURES`,
`PLAN_REQUIRED` nem `JwtPayload.plan`. `tenants.subscription_plan` (VARCHAR sem CHECK, default
`starter`) permanece exatamente como está, lido só por `PlatformService` para listar/faturar.
Todo tenant enxerga todas as funcionalidades — o acesso continua governado só por `role`
(`admin`/`manager`/`attendant`), como já era.
**Motivo:** a revisão 2 do spec da fusão (2026-09-12) reverte a divisão `basic`/`plus` desenhada
na revisão 1: entitlement por plano é aditivo por natureza (entra depois como um middleware ao
lado de `requireRoles` + um campo opcional em `route-config`, sem tocar tabela/serviço/tela já
construídos), então adiar não cria dívida técnica — e adiar apaga uma onda inteira (~2-3
agent-days) que não tinha comprador implementado ainda. O texto de §5b de `API_CONTRACTS.md`
sobre entitlement `basic`/`plus` (migração `010_plans_basic_plus.sql`) descreve um desenho que
não foi implementado e não será nesta v1 — a migração `010` real é `010_internal_chat_dm.sql`
(D-101); quando entitlement por plano voltar a ser priorizado, aquele texto precisa ser revisto
por quem o retomar.
**Impacto:** api (nenhuma rota desta onda checa plano), db (nenhuma coluna de plano nova), docs
(esta decisão é a autorização para o restante da Onda 9 não mencionar plano em nenhum contrato).

### D-109: Import de planilha do LIS é síncrono, em chunks, com histórico imutável
**Decisão:** `POST /lis-imports` recebe a planilha em base64 (mesma disciplina de anexos de
mídia, Onda 8), parseia com `lis-spreadsheet.ts` (exceljs), consolida por número
(`consolidateByNumber`, maior `total_value` vence — BUSINESS_RULES.md §11.1), resolve
atendente/convênio por linha e grava em `lis_budgets` via `upsert ON CONFLICT (tenant_id,
number)` **em chunks**, cada chunk numa transação própria. Todo import (e todo purge) grava uma
linha em `lis_imports`, nunca apagada pela API.
**Motivo:** planilha real do Santé é ~500KB (~667KB em base64) — folgada dentro de qualquer teto
razoável, mas o import processa centenas de linhas com resolução de atendente/convênio por
linha, e uma transação única para o arquivo inteiro arrisca estourar o timeout do request numa
planilha maior no futuro. Chunks tornam a falha parcial rastreável (`rowsAccepted` reflete o que
de fato commitou) em vez de um 500 sem diagnóstico. Histórico imutável (sem `DELETE` na API) é o
que torna "quando e o que mudou na base" auditável sem depender de log de aplicação.
**Impacto:** db (`lis_imports`, `lis_budgets`, SCHEMA.md §25/§26), api (`POST /lis-imports`,
`GET /lis-imports[/latest]`, `POST /lis-imports/purge`), backend (`lis-spreadsheet.ts` como lib
pura, sem tenant nem I/O de banco — `LisImportService` é quem fala com o banco).

### D-110: Datas do domínio LIS são `DATE`, nunca `TIMESTAMP`
**Decisão:** `lis_budgets.issued_on`/`paid_on` são `DATE`. O serial de data do Excel é convertido
por componentes (ano/mês/dia, com a correção do bug do ano bissexto de 1900 do próprio Excel),
nunca por aritmética de milissegundos.
**Motivo:** o serial do Excel não carrega fuso horário — não existe "hora" nesse dado, só dia.
Guardar como `TIMESTAMP` reintroduziria exatamente a classe de bug de UTC-3 que D-021 e D-078 já
corrigiram para dado que sempre teve hora de verdade; aqui, nem isso: seria inventar uma hora
que a fonte nunca teve, só para descartá-la de novo em todo agrupamento por dia/mês. A divergência
de fronteira de mês entre a data local do Santé e a data gravada é listada explicitamente no
checklist de paridade da Onda 11, não escondida por uma falsa precisão de timestamp.
**Impacto:** db (`lis_budgets.issued_on`/`paid_on`, `proposals.lis_paid_on` — todas `DATE`),
backend (parser converte serial → `DATE` por componentes, nunca via `new Date(serial)`).

### D-111: `principal_insurance_name` e `total_value` são colunas `GENERATED … STORED`
**Decisão:** `lis_budgets.principal_insurance_name` (regra do convênio principal,
BUSINESS_RULES.md §11.3) e `lis_budgets.total_value` (valor do convênio principal — mesma
seleção; **não** a soma de `value_1..3`, correção de D-124) são colunas
`GENERATED ALWAYS AS (...) STORED` (SCHEMA.md §26), não calculadas em código a cada leitura nem
gravadas por um `INSERT` que replica a regra em TypeScript.
**Motivo:** as duas são regra de negócio pura sobre outras colunas da mesma linha — o tipo de
cálculo que diverge silenciosamente no dia em que um segundo caminho de escrita aparece (seed,
script de correção, importação futura por outra rota). Uma coluna gerada é a única forma de a
regra valer para **todo** `INSERT`/`UPDATE`, inclusive um que ninguém previu. **Risco aceito e
registrado no spec:** `GENERATED ... STORED` precisa ser validado no PGlite (D-008, testes)
**na primeira hora** da Onda 9 — se o suporte for incompleto, o fallback é calcular as duas
colunas como colunas normais, escritas num único ponto do `LisImportRepository`, preservando a
mesma regra de prioridade.
**Impacto:** db (SCHEMA.md §26, migração 012), backend (`LisImportService`/repositório não
recalculam essas duas colunas — leem o que o banco gerou), qa (teste dedicado a provar que a
coluna gerada bate com a regra de BUSINESS_RULES.md §11.3, incluindo o empate "nenhum convênio
com valor > 0").

### D-112: Atendente do LIS é entidade própria, não obrigatoriamente ligada a um `user`
**Decisão:** `attendants` (SCHEMA.md §24) é uma tabela nova, independente de `users`. O `USUÁRIO`
da planilha do LIS vira `attendant_id`; ligar um `attendants.user_id` a um login do CRM é
**opcional e manual** (feito por manager/admin em `PATCH /attendants/:id`). O escopo de `/sales`
para quem tem papel `attendant` é resolvido por esse vínculo (`attendants.user_id = ctx.userId`),
não pelo papel em si.
**Motivo:** no FluxoLab, atendente nunca teve login — era só um nome de planilha
(`atendentes.nome`). Exigir que todo atendente do LIS seja um `users` ativo do CRM quebraria a
migração do Santé (nem toda pessoa que aparece como `USUÁRIO` numa planilha antiga ainda
trabalha lá, ou tem e-mail cadastrado) e acoplaria dois conceitos que nascem em momentos
diferentes: o atendente existe desde a primeira planilha importada; o login, só quando (e se)
essa pessoa passar a usar o CRM.
**Impacto:** db (`attendants`, SCHEMA.md §24), api (`/attendants`, `/sales` com recorte por
vínculo — API_CONTRACTS.md §11/§12), backend (`AttendantService`, `SalesService`,
SERVICES.md §21/§22).

### D-113: Percentuais de comissão migram de `localStorage` por navegador para `tenant_settings` por tenant
**Decisão:** `tenant_settings` ganha `commission_budget_pct` (default 2,00),
`commission_exams_pct` (1,50) e `commission_checkup_pct` (1,50) — os mesmos valores validados em
produção pelo FluxoLab, onde viviam em `localStorage` do navegador de quem configurava.
`GET/PATCH /settings/commissions` (manager lê, admin edita) substitui a tela que só existia no
FluxoLab.
**Motivo:** comissão por navegador significa que o valor não é o mesmo em duas máquinas do
mesmo laboratório, e desaparece ao limpar o cache — um defeito de arquitetura que o FluxoLab
carregava desde sempre e que a fusão corrige de graça, movendo a configuração para onde toda
outra configuração operacional do tenant já mora (`tenant_settings`, D-065). Confirmar 2/1,5/1,5
com o Santé continua uma pendência de produto (registrada no spec §6), não bloqueante para a
Onda 9 — os defaults são os valores conhecidos e corrigíveis por `PATCH` a qualquer momento.
**Impacto:** db (ALTER em `tenant_settings`, SCHEMA.md), api (`/settings/commissions`), backend
(`CommissionSettingsService`, SERVICES.md §18, consumido por `SalesService.getSummary`).

### D-114: Convênio da planilha do LIS é resolvido por nome dobrado; inexistente é criado como `outro`
**Decisão:** `lis_budgets.principal_insurance_name` é casado contra `insurances.name` dobrado
(`lower`+trim, sem remoção de acento). Convênio que não existe no cadastro do tenant é **criado
automaticamente** com `type: 'outro'` (valor novo no CHECK de `insurances.type`) e
`source: 'lis'` (coluna nova, espelhando `exam_catalog.source`, D-081). `PARTICULAR` e variantes
de grafia resolvem para `insurance_id: NULL` — nunca criam uma linha "Particular"
(reafirma D-082 para o domínio do LIS).
**Motivo:** o cadastro de convênios de um laboratório que nunca usou o módulo de Orçamentos do
CRM está vazio; exigir cadastro manual de cada convênio antes da primeira importação inverteria
a ordem natural (o laboratório já usa esses convênios há anos, só nunca precisou cadastrá-los no
CRM). Diferente da resolução de atendente (D-112/BUSINESS_RULES §11.6), aqui a criação automática
é segura: o nome do convênio na planilha do LIS é confiável (não é um campo de digitação livre
por atendente), e a alternativa — bloquear o import até alguém cadastrar manualmente — quebraria
justamente o fluxo de "importar e ver os KPIs" que é o valor central da Onda 9.
**Impacto:** db (`insurances.type` CHECK ganha `'outro'`, `insurances.source` nova coluna,
SCHEMA.md §18/§26), backend (`LisImportService`, SERVICES.md §19), domain (BUSINESS_RULES.md
§11.4, decisão 3 em aberto do spec — "convênios `outro` aparecem direto ou exigem
classificação" — fica para decisão de produto futura, não bloqueia esta onda).

### D-115: Exames importados do LIS entram no catálogo com preço `0`
**Decisão:** exames que só existiam no FluxoLab (nunca precificados no CRM) entram em
`exam_catalog` com `price_private = 0`, `price_insurance = 0`, `source: 'lis'` (mesma coluna
`source` de D-081); sinônimos alimentam `exam_synonyms`. A UI do Catálogo marca esses exames
como "sem preço" (Onda 10).
**Motivo:** o domínio do LIS não tem preço de exame — o FluxoLab nunca precificou, só registrou
o resultado do orçamento já fechado. Recusar a entrada do exame por falta de preço quebraria a
migração do Santé (o catálogo do LIS precisa existir para o import de `lis_budgets` fazer
sentido); inventar um preço seria pior — um número sem origem, exatamente o que
BUSINESS_RULES.md §5 proíbe. **Risco registrado no spec:** um tenant que passa a montar
orçamentos pelo CRM (`Budget/New`) precisa que a tela **bloqueie** item sem preço
(`EXAM_WITHOUT_PRICE`) — comportamento de tela, pendência para quem tocar `Budget/New` a seguir,
não resolvido nesta onda de backend.
**Impacto:** db (nenhuma coluna nova — reaproveita `exam_catalog.source` de D-081), backend
(seed/import do catálogo do LIS grava preço `0` explicitamente, nunca `NULL` — `price_private`/
`price_insurance` continuam `NOT NULL`), ui (pendência registrada, fora do escopo desta onda).

### D-118: Colunas `lis_*` em `proposals` nascem na migração 012, comportamento só na Onda 13
**Decisão:** `proposals` ganha `lis_budget_number`, `lis_requisition_number`, `lis_paid_value`,
`lis_paid_on` e `lis_reconciled_at` já na migração `012_lis_domain.sql` (Onda 9). Nenhuma rota
desta onda lê ou escreve essas colunas — `POST /proposals` e `PATCH /proposals/:id/*` continuam
exatamente como estavam. O comportamento (gravar o número do orçamento do LIS a partir da tela,
casar por número no import, avançar `ganho` automaticamente) é construído inteiro na Onda 13
(D-119, fora do escopo deste documento).
**Motivo:** a revisão 2 do spec elimina a divisão de planos (D-108) que antes justificava
separar "criar a coluna" (Onda 9) de "usar a coluna" (Onda 14) em dois momentos de produto
diferentes. Sem planos, não há razão para duas migrações e dois passes pelo `ProposalService`
sobre a mesma tabela — a coluna nasce junto com o resto do domínio LIS que a Onda 9 já está
migrando, e o índice único parcial (`idx_proposals_tenant_lis_budget_number`, `WHERE
lis_budget_number IS NOT NULL`) já impede a colisão de dois orçamentos do LIS na mesma proposta
desde já, mesmo sem nenhum caminho de escrita ligado ainda.
**Impacto:** db (ALTER em `proposals`, SCHEMA.md §5 — nasce na 012), api (nenhuma mudança de
contrato nesta onda; `API_CONTRACTS.md` §3 só muda na Onda 13), backend (`ProposalService`
inalterado nesta onda — `markWonFromLis`/`transitionInTx` são construídos na Onda 13).

### D-116: PDFs do LIS (Executivo e Busca Ativa) são gerados no cliente, nunca no servidor
**Decisão:** os dois PDFs da Onda 10 (Relatório Executivo e Busca Ativa) são montados no
navegador com `jspdf` + `jspdf-autotable` (lazy import), a partir do MESMO JSON que já preencheu
a tela (`GET /reports/executive`, `GET /lis-budgets/pending*` — API_CONTRACTS.md §5c/§10.2). O
backend nunca gera, assina nem armazena PDF. A marca do documento (nome, logo) vem de
`theme.brandName`/`theme.logoUrl` do próprio tenant — nada de "Santé" fixo em nenhum template.
**Motivo:** gerar PDF no servidor exigiria uma dependência de renderização (headless browser ou
lib de layout) só para dois relatórios, além de um segundo caminho de dado que precisaria ficar
sincronizado com o que a tela mostra — dois fetches do mesmo período podem retornar números
diferentes se algo mudar entre eles (nova importação, por exemplo). Gerar a partir do JSON já
carregado elimina essa divergência por construção: o PDF é sempre um retrato exato do que a
pessoa está vendo na tela no momento do clique.
**Impacto:** frontend (`jspdf`/`jspdf-autotable` como dependência nova, só carregada sob demanda
— `document.title` e branding por tema, PAGES.md §14); backend/api (nenhuma mudança — os
endpoints já existentes de §5c/§10.2 bastam, nenhuma rota de PDF é criada).

### D-117: Filtros de período/atendente/convênio das telas de leitura do LIS são estado global
**Decisão:** `/results`, `/reconciliation` e `/active-search` (PAGES.md, Telas do LIS) compartilham
o mesmo filtro de período + atendente + convênio através de `useUIStore.lisFilters`, persistido
em `sessionStorage` — não na URL de cada rota e não em três estados locais independentes.
**Motivo:** as três telas respondem à mesma pergunta operacional ("como estão os orçamentos
deste período, deste atendente, deste convênio") sob ângulos diferentes (visão executiva,
listagem crua, fila de cobrança). Sem estado compartilhado, trocar o período em `/results` e
abrir `/reconciliation` reapresentaria os últimos 30 dias por padrão, obrigando a pessoa a
reconfigurar o mesmo filtro três vezes na mesma sessão de trabalho — o padrão de UX que o
FluxoLab já resolvia (filtro persistente entre as abas do Dashboard). `sessionStorage` (não
`localStorage`) porque o filtro é conveniência de sessão, não preferência duradoura: outra
pessoa no mesmo computador não deve herdar o recorte de quem usou antes.
**Impacto:** frontend (`useUIStore` ganha `lisFilters`, PAGES.md `## Estado Global`; `PeriodFilter`
component, COMPONENTS.md); nenhuma mudança de contrato de API — os três endpoints já aceitam
`startDate`/`endDate`/`attendantId`/`insuranceId` como query params independentes desde a Onda 9.

### D-122: Detalhe por atendente em `/results` é relatório de comissão, não ranking — sem corte de `MIN_ORC_RANKING`, com vendas por atendente
**Decisão:** validação da Onda 10 trouxe a tela real equivalente do FluxoLab/Santé como referência
(screenshots) — ela tem uma tabela "Detalhe por atendente" (orçado, recebido, conversão, comissão
sobre orçamento + vendas de exames + vendas de check-up, comissão total) que a Fase 0 original não
previa. Dois campos aditivos entram no contrato:
- `LisAttendantAgg` ganha `paidCount` (requisições pagas do atendente no período) — base de
  `conversionQty` por linha.
- `LisBudgetsSummary` ganha `byAttendantDetail: LisAttendantAgg[]` — TODOS os atendentes do
  período, **sem** o corte de `MIN_ORC_RANKING` e **sem** o top-6 que `byAttendant` já tinha
  (BUSINESS_RULES.md §11.5). `byAttendant` continua existindo, inalterado, para quem já consome o
  ranking qualitativo (gráfico "Faturamento por atendente" e `/reports/executive`).
- `SalesSummary` ganha `byAttendant?: SalesAttendantSummary[]` — só presente quando manager/admin
  consulta sem `attendantId` (visão do tenant inteiro); `attendant` nunca recebe o campo (D-112,
  ele só vê a própria comissão).
**Motivo:** um relatório de comissão é documento contábil — esconder um atendente porque o
laboratório importou poucos orçamentos no mês (`MIN_ORC_RANKING = 20`) pagaria menos comissão do
que o devido sem ninguém perceber. `MIN_ORC_RANKING` existe para **rankings qualitativos**
("top atendente do mês" não é significativo com amostra pequena) — não se aplica a "quanto essa
pessoa tem a receber". As duas perguntas são diferentes; um único campo gated não serve às duas.
**Impacto:** shared (`LisAttendantAgg.paidCount`, `LisBudgetsSummary.byAttendantDetail`,
`SalesAttendantSummary` novo, `SalesSummary.byAttendant?`); backend (`lis-analytics.repository.ts`
soma `paid_count` na mesma query já existente — sem nova tabela/coluna; `sales.repository.ts` ganha
`summarizeByAttendantAndKind`; nenhuma migração de banco — tudo é agregação sobre colunas já
existentes); api (`API_CONTRACTS.md` §10.2/§11 atualizados); frontend (`/results`, PAGES.md §14,
combina os dois no CLIENTE por `attendantId` — nenhum endpoint novo, nenhum join no servidor entre
`lis_budgets` e `sales`, que vivem em domínios de leitura separados por design D-108/D-112).

### D-123: Exportação de comissão (PDF e Excel) — mesmo princípio de D-116, cliente escolhe o formato
**Decisão:** o botão "Relatório de comissão" de `/results` gera o arquivo no CLIENTE, a partir da
MESMA tabela "Detalhe por atendente" já montada na tela (mesmo princípio de D-116: nunca um
segundo fetch que possa divergir do que a pessoa está vendo). Dois formatos, escolhidos num menu
do próprio botão: PDF (`jspdf`/`jspdf-autotable`, já usado pelos outros dois relatórios) e Excel
(`xlsx`/SheetJS, dependência nova — só para este relatório, os outros dois continuam PDF apenas).
**Motivo:** a referência real (FluxoLab/Santé) oferece os dois formatos porque comissão costuma
alimentar a folha de pagamento — algumas pessoas colam a planilha direto numa ferramenta externa,
outras quatro só precisam do PDF pra arquivar. Gerar no servidor exigiria uma segunda dependência
de lib de planilha no backend e um segundo caminho de dado (mesmo risco de divergência que D-116
já rejeitou para os PDFs).
**Impacto:** frontend (`xlsx` como dependência nova; `lib/excel/commission-report.ts` +
`lib/pdf/commission-report.ts`, PAGES.md §14); backend/api (nenhuma mudança — usa os mesmos dados
de D-122, já expostos por `/lis-budgets/summary` e `/sales/summary`).

### D-124: `lis_budgets.total_value` corrigido — valor do convênio principal, não a soma de value_1..3
**Decisão:** a migração `012_lis_domain.sql` (Onda 9) implementou `total_value` como
`value_1 + value_2 + value_3`. Está errado. A migração `014_fix_lis_budgets_total_value.sql`
corrige: `total_value` passa a ser o valor do **mesmo par (nome, valor) que
`principal_insurance_name` já escolhe** (BUSINESS_RULES.md §11.3) — nunca a soma dos três.
`backend/src/lib/lis-spreadsheet.ts#totalValue()` (usado na consolidação por número dentro do
mesmo lote de import, §11.1) corrigido do mesmo jeito, com um terceiro fallback (valor > 0 sem
nenhum nome de convênio) que replica o app de referência à risca.
**Motivo:** achado comparando com o app de referência do FluxoLab
(`orcamentos-sante-main/src/lib/orcamento.ts`) depois do usuário reportar que os números de
`/results` não batiam com a produção real. `insurance_2`/`insurance_3` + `value_2`/`value_3` são
**cotações alternativas** do mesmo orçamento — o mesmo exame precificado por um convênio
diferente — nunca valores adicionais. Somar os três infla "Total Orçado" (e tudo que deriva
dele: `byInsurance`, `monthlySeries.issuedValue`, o próprio `total_value` gravado) em qualquer
orçamento com mais de uma cotação preenchida — o que é comum na planilha real do Santé.
**Impacto:** db (migração 014 — `DROP`+`ADD` da coluna gerada, recalcula os valores já gravados
automaticamente); backend (`lis-spreadsheet.ts#totalValue()`); docs (`SCHEMA.md` §26,
`BUSINESS_RULES.md` §11.1, ambos com o SQL/pseudocódigo atualizado); nenhuma mudança de
contrato de API (o *shape* de `total_value` não muda, só o valor fica correto).

### D-125: "Em Requisição" é orçamentos convertidos em requisição, não Busca Ativa
**Decisão:** o card "Em Requisição" de `/results` (e o KPI homônimo do PDF Executivo) soma
`requisition_value` de TODA requisição emitida no período (dedupe por requisição, mesmo critério
de `paid`) — **paga ou pendente**. Não é a mesma pergunta de Busca Ativa (§16, que é só a fatia
sem pagamento). Campo novo `requisition: { count, totalValue }` em `LisBudgetsSummary`
(`GET /lis-budgets/summary`, §10.2) e `ExecutiveReport` (`GET /reports/executive`, §5c) —
`lis-analytics.repository.ts#getRequisitionTotals`, janela de EMISSÃO (`issued_on`, igual a
`getIssuedTotals`).
**Motivo:** a Onda 10 original implementou "Em Requisição" reaproveitando o resumo de Busca
Ativa (`/lis-budgets/pending/summary`) — errado, achado comparando com o app de referência do
FluxoLab (`orcamentos-sante-main/src/hooks` `useOrcamentos`/`Dashboard.tsx`, `kpis.reqValue`):
lá, "Em requisição" é "quanto já virou requisição no sistema" (convertido em venda), um retrato
de VOLUME convertido — não "quanto ainda falta receber", que é uma pergunta de cobrança
(Busca Ativa). As duas coexistem na tela por perguntarem coisas diferentes, igual a
`issued`/`paid` (D-020).
**Impacto:** shared (`LisRequisitionTotals` novo; `LisBudgetsSummary.requisition`,
`ExecutiveReport.requisition`); backend (`getRequisitionTotals` nova, chamada por
`LisAnalyticsService.getSummary` e `ExecutiveReportService.getExecutiveReport`); api
(`API_CONTRACTS.md` §5c/§10.2); frontend (`/results`, PAGES.md §14, troca a fonte do card "Em
Requisição" de `/lis-budgets/pending/summary` para `summary.requisition`).

### D-126: Dedupe de linhas duplicadas do mesmo orçamento MESCLA requisição/pagamento, nunca descarta
**Decisão:** `consolidateLisRows` (`backend/src/lib/lis-spreadsheet.ts`) passa a mesclar campos
entre as duas linhas quando há duplicata do mesmo `ORCAMENTO` dentro de uma importação, em vez de
substituir a linha inteira pela de maior `total_value`. `total_value`/convênio/paciente/atendente
continuam vindo da linha de maior total (regra original, §11.1) — mas `requisition_number` cai
para a outra linha quando a vencedora não tem, e `paid_value`/`paid_on`/`requisition_value` vêm da
linha com **maior `paid_value` entre as duas**, seja ela a vencedora do total ou não. Port exato
de `consolidateOrcamentos` (app de referência do FluxoLab).
**Motivo:** achado comparando "Recebido" com o app de referência usando a MESMA planilha real, no
mesmo período: nosso sistema contava 167 pagos, a referência 169 — uma diferença real de
R$ 3.516,76. A causa: a mesma REQUISIÇÃO pode gerar mais de uma linha na planilha (um exame por
linha) sob o mesmo número de ORÇAMENTO; quando só uma das linhas tem requisição/pagamento
preenchidos e ela não é a de maior `total_value`, a versão anterior jogava esse pagamento fora ao
descartar a linha inteira. Um pagamento de verdade desaparecendo silenciosamente é o pior tipo de
bug num sistema que alimenta comissão/folha de pagamento.
**Impacto:** backend (`lis-spreadsheet.ts#consolidateLisRows`, único ponto de mudança — o
`upsertBudget`/SQL de conflito entre IMPORTAÇÕES diferentes, ao longo do tempo, não muda: mesmo
comportamento da referência, que também substitui por completo num reimport); nenhuma mudança de
schema ou de contrato de API. **Dado já importado antes desta correção continua com o pagamento
perdido** — precisa reimportar a mesma planilha para recuperar (o reimport é idempotente e
upserta por número, então corrige as linhas afetadas sem duplicar as demais).

## 2026-09-12 — Agrupamento do menu em categorias (CRMLAB-4)

### D-127: Sidebar em accordion — itens soltos + 4 grupos, ordem fixa, abertos por padrão
**Decisão:** `route-config.ts` ganha `group?: NavGroupId` por rota e `NAV_GROUPS` (ordem fixa:
Comunicação → Comercial → LIS / Operação Laboratorial → Configurações). `sidebarSectionsFor(role)`
organiza os itens já filtrados por papel (`sidebarRoutesFor`) em soltos (sem `group`, sempre no
topo) + grupos (na ordem de `NAV_GROUPS`, omitindo grupo sem nenhum item visível para o papel).
Accordion aberto por padrão; estado por grupo persiste em localStorage por usuário
(`sidebar-groups.store.ts`, chave `crm-lab.sidebar-groups`), decisão distinta do recolher/expandir
do trilho inteiro (`ui.store`, não persistido). Console da plataforma (`platform_operator`)
continua sem grupo, inalterado.
**Motivo:** menu tinha 21 itens soltos, difícil de navegar. Decisões de UX (ordem dos grupos,
estado inicial, grupo vazio) fechadas com o usuário no card CRMLAB-4 antes da implementação.
**Impacto:** só frontend (`route-config.ts`, `Sidebar.tsx`, nova store `sidebar-groups.store.ts`).
Nenhuma mudança de rota, papel ou contrato de API — `sidebarRoutesFor` (usado pelo guard de rota)
não muda.

**Superseded parcialmente por D-128** — o agrupamento (grupos/ordem/persistência) descrito acima
continua valendo; só o tratamento visual do cabeçalho de grupo mudou (era `font-heading
text-section`, maior que o item — usuário não aprovou na validação).

### D-128: Sidebar variante "Trilho de grupo" — cabeçalho de grupo do mesmo tamanho do item, trilho de filhos, destaque único
**Decisão:** revisão visual do trilho após o usuário rejeitar o resultado de D-127 na validação.
Mudanças (`Sidebar.tsx`, tokens existentes de `DESIGN_TOKENS.md` — nenhum hex/valor literal novo):
- Largura: **272px expandido / 64px recolhido** (era 244/72).
- Cabeçalho de grupo passa a `font-body text-label font-bold` — MESMO tamanho do item, só o peso
  diferencia (bold × medium/semibold). Fundo `accent-100` quando aberto; `hover:bg-neutral-100`
  quando fechado (nunca a cor do item ativo — só um destaque preenchido por vez no trilho).
  Chevron `▶` único, com `rotate(90deg)` animado ao abrir (substitui o swap `⌄`/`›`).
- Um único divisor (`<hr>` neutral-300) entre o bloco de itens soltos e o bloco de grupos — cada
  grupo não tem mais `border-t` próprio.
- Filhos de grupo indentados atrás de um trilho vertical (`border-l-2 border-neutral-300`,
  `margin-left`/`padding-left`), raio menor (`rounded-md`) que o item de nível 1 (`rounded-lg`).
- Item ativo (solto ou filho): fundo `accent-500` sólido + texto `text-bg` + `font-semibold` —
  substitui `accent-200` + `shadow-sm`. Grupo fechado com filho ativo dentro: ponto 6px
  `bg-accent-500` ao lado do chevron, avisando sem abrir o grupo.
- Foco de teclado: `outline-2 outline-accent-500 outline-offset-2` (`focus-visible`) em item e
  cabeçalho de grupo.
- Lista (`<nav>`) com scrollbar fina via `scrollbar-width`/`scrollbar-color` (tokens CSS,
  `--color-neutral-400`), header e footer continuam fixos fora do scroll.
**Motivo:** usuário validou visualmente D-127 e não aprovou — cabeçalho maior competia com o item
ativo e a largura/raio pareciam desproporcionais. Especificação ("Trilho de grupo") fornecida pelo
usuário via Claude Design; paleta e fonte (DM Sans) do documento original eram hex fixos — **não
adotados literalmente** para não quebrar o tema por tenant (D-005, 5 temas via CSS vars) nem a
regra "zero hex/zero nome de fonte em componente"; a estrutura/comportamento foi traduzida para os
tokens já existentes (`accent-*`, `neutral-*`, `text`, `bg`, `font-body`).
**Escopo não implementado (registrado, não esquecido):** flyout dos grupos ao passar o mouse no
trilho recolhido (64px) e o marcador quadrado/circular alternado por seção do documento original —
o recolhido continua mostrando só ícone, sem flyout; os itens continuam usando `NavGlyph` em vez de
um marcador de ponto, já que o ícone já cumpre esse papel.
**Impacto:** só `Sidebar.tsx` (visual) + `Sidebar.spec.tsx` (larguras/classes atualizadas). Nenhuma
mudança de rota, papel, store ou contrato de API.

### D-129: Grupos "Comercial" e "LIS / Operação Laboratorial" fundidos em "Gestão"; Catálogo vira "Cadastro de Exames" e muda para Configurações
**Decisão:** `route-config.ts` perde os `NavGroupId` `'comercial'` e `'lis'`, ganha `'gestao'`.
`NAV_GROUPS` passa a `Comunicação → Gestão → Configurações`. O grupo "Gestão" reúne, nessa ordem:
Conversão, Decisões, Resultados, Conferência, Busca Ativa, Gestão da Operação (união dos itens dos
dois grupos antigos, mesma ordem relativa que já tinham). A rota `/catalog` sai do grupo (antes
"LIS / Operação Laboratorial") e passa para "Configurações"; seu rótulo no trilho muda de
"Catálogo" para **"Cadastro de Exames"** (o `<h1>` da própria página já usava esse nome —
`Catalog.tsx`, "Catálogo de Exames" — o rótulo do menu só ficou consistente com a página).
**Motivo:** pedido do usuário após validar D-128 — os dois grupos "Comercial" e "LIS / Operação
Laboratorial" pareciam redundantes/pequenos demais para justificar dois cabeçalhos separados;
"Catálogo" fazia mais sentido como um cadastro em Configurações do que como item de operação do
LIS.
**Impacto:** só frontend — `route-config.ts` (grupos + `group` de 7 rotas + rótulo de `/catalog`),
`Sidebar.spec.tsx` e `route-config.spec.ts` (asserts de grupo/rótulo atualizados). Nenhuma mudança
de rota, papel, contrato de API ou do componente `Sidebar.tsx` em si (D-128 continua valendo).

### D-132: Badge de não lidas do Chat Interno propaga para o grupo "Comunicação" quando recolhido

**Decisão:** `Sidebar.tsx` passa a somar `Channel.unreadCount` de `GET /internal-chat/channels`
(mesma query, cache compartilhado via `queryKeys.internalChannels()` com a tela de chat — sem
endpoint novo) e exibe um `Badge` no item "Chat Interno", igual ao já existente para "Decisões"
(`pendingDecisions.total`). Quando o grupo "Comunicação" está fechado e esse total é maior que
zero, o mesmo `Badge` aparece no cabeçalho do grupo, substituindo o ponto 6px de "item ativo
dentro" (D-128) enquanto houver não lida — o ponto volta a valer sozinho se o total zerar mas
ainda houver item ativo dentro do grupo. Sem som, sem notificação push do navegador: só o
indicador visual dentro do CRM.
**Motivo:** CRMLAB-8 — usuário reportou que mensagem em conversa/grupo recolhido passava
despercebida. Investigação mostrou que o chat interno não tem hierarquia de grupos de conversa
(só listas fixas "Canais"/"Mensagens diretas"); o único "grupo recolhível" do produto é o grupo
de menu "Comunicação" (D-127/D-128). Ambiguidade resolvida com o usuário durante o dev: "grupo"
é o grupo de menu, não um agrupamento novo dentro do chat.
**Impacto:** só frontend (`Sidebar.tsx`). Nenhum endpoint novo, nenhuma mudança de schema —
`Channel.unreadCount` já existe (D-068).

### D-130: Cadastro de pacotes de exames (combos) — nova aba em Cadastro de Exames
**Decisão:** nova aba "Pacotes" em `/catalog`, ao lado da lista de exames (`SegmentedControl`,
mesmo padrão da aba "Dados"/"Preços por convênio" do `ExamModal`). Cadastro: `exam_packages` +
`exam_package_items` (M:N com `exam_catalog`) + `exam_package_prices` (preço por convênio,
SCHEMA.md §28-30). `pricePrivate` do pacote **nunca** é gravado — é sempre
`calculatePackagePrivatePrice(items, discountPercent)`: soma dos `pricePrivate` CORRENTES dos
exames incluídos, menos `discountPercent`%, calculada em `@crm-lab/shared` (mesma função no
backend e no frontend). Preço por convênio do pacote segue o mesmo mecanismo de fallback de
`exam_prices` (§19/D-081): sem override, `effectivePrice` cai no `pricePrivate` calculado.
Permissões: mesma alçada do catálogo — atendente só leitura, gestor/admin cria/edita/desativa
(sem `DELETE`, D-004).
**Ao adicionar um pacote em `/budget/new`:** expande em N linhas no resumo, uma por exame
incluído, usando o `pricePrivate` de cada `ExamPackageItem` — não o `effectivePrice` do pacote
(que é só o preço agregado mostrado no seletor, ver SCHEMA.md §30 para o motivo dessa escolha).
O atendente vê a soma resultante e pode ajustar o desconto geral do orçamento normalmente
(`DiscountSection` já existente em `SummaryColumn`) — não há um "desconto do pacote" que se
propague automaticamente para o orçamento; ele só influencia o `pricePrivate` MOSTRADO do
pacote no seletor.
**Motivo:** pedido do usuário — hoje só existe cadastro de exames individuais; pacotes/combos
(ex.: check-ups) precisam de cadastro próprio. Escopo fechado com o usuário: sem preço próprio
digitado (sempre derivado), mesma alçada e convenção ativo/inativo do catálogo de exames.
**Impacto:** backend (`exam-package.{routes,service,repository}.ts`, migrações `015`/`016`),
`shared/types/exam-package.types.ts`, frontend (`PackageTable.tsx`, `PackageModal.tsx`,
`PackagePricesTab.tsx`, aba nova em `Catalog.tsx`; segmento "Pacotes" de `CatalogSegments.tsx`
em `/budget/new` passa a listar pacotes de verdade — consome, não resolve por completo, o bug
CRMLAB-13 das abas "Pedido Médico"/"IA" que continuam vazias).

### D-131: Campo "Médico solicitante" na proposta — texto livre, opcional, imutável após criação
**Decisão:** `POST /proposals` ganha `requestingDoctor` (opcional, texto livre até 255
caracteres, aparado pelo backend — vazio/só espaço vira `NULL`, nunca `""`). Sem
cadastro/autocomplete de médicos — é só um campo de texto na proposta. Aparece em
`ProposalDetail`/`GET /proposals/:id` e é imutável depois de criado (mesma convenção de
`insuranceId`: sem `PATCH` que o altere nesta onda). Propostas existentes ficam `NULL`, sem
migração de dados retroativa.
**Motivo:** pedido do usuário para rastrear qual médico solicitou o exame/procedimento
diretamente na proposta/orçamento (CRMLAB-9). Escopo fechado com o usuário: campo simples,
sem bloquear a criação, sem novo cadastro.
**Impacto:** `shared/types/proposal.types.ts` (campo novo), `proposal.repository.ts` (coluna
nova, `017_proposal_requesting_doctor.sql`), `proposal.service.ts` (normaliza vazio → `null`),
`proposal.routes.ts` (aceita no `POST`). Frontend: `SummaryColumn.tsx` (`Input` em
`/budget/new`), `ProposalModal.tsx` (exibe só quando preenchido). Sobre "aparecer no PDF": não
existe hoje geração de PDF de proposta individual (só Relatório Executivo/Comissão/Busca Ativa,
client-side); quando existir, lê `requestingDoctor` do detalhe como qualquer outro campo —
não é pendência aberta, ver API_CONTRACTS.md §3.

### D-133: Inativar/reativar paciente — qualquer papel, motivo obrigatório nas duas pontas
**Decisão:** `patients` ganha `inactivated_at`/`inactivation_reason` (migração 018, mesmo
desenho de `anonymized_at`/D-063 — sem tabela de histórico, sem `DELETE`).
`POST /patients/:id/inactivate` e `.../reactivate` (`InactivatePatientRequest`/
`ReactivatePatientRequest` em `shared/types/patient.types.ts`) exigem `reason` (1..500
caracteres) nas DUAS direções; o motivo vai só para o audit log
(`inactivate_patient`/`reactivate_patient`) — reativar zera os dois campos na linha, não
preserva o motivo da inativação anterior. Ao contrário do bloco LGPD (D-062/D-063), a ação é de
**qualquer papel de laboratório** que enxergue o paciente (mesma alçada do `PATCH /:id`, sem
`requireRoles`) — não é admin-only. `GET /patients` esconde paciente inativo por padrão;
`?includeInactive=true` (checkbox "Mostrar inativos" na tela) traz os dois. Nenhum outro dado é
tocado: conversas, mensagens e propostas do paciente continuam intactos, só passam a se referir
a um cadastro marcado como inativo. Paciente anonimizado não pode ser inativado/reativado (409
`patient_anonymized`, mesmo princípio do `PATCH`).
**Motivo:** pedido do usuário (CRMLAB-11) — hoje não existe como marcar paciente como inativo no
CRM. Escopo fechado em discussão: sem alçada especial, motivo obrigatório nas duas pontas, dado
histórico preservado (referenciado, não apagado), some da listagem com filtro para voltar a
aparecer.
**Impacto:** `shared/types/patient.types.ts` (campos novos em `Patient`, dois request types),
`backend/migrations/018_patient_inactivation.sql`, `patient.repository.ts` (`inactivate`/
`reactivate`, filtro `includeInactive` no `list`), `patient.service.ts`, `patient.routes.ts`
(duas rotas novas, sem `requireRoles`). Frontend: `patients.ts` (dois métodos),
`PatientInactivationSection.tsx` (novo, visível a qualquer papel — ao contrário de
`PatientLgpdSection`), `Profile.tsx` (chip "Inativo" no header), `List.tsx` (checkbox "Mostrar
inativos" + coluna de status).

### D-134: Editar itens/desconto/médico solicitante de uma proposta já criada (CRMLAB-12)
**Decisão:** novo `PATCH /proposals/:id/items` substitui a lista de itens inteira e,
opcionalmente, `discountPercent` e `requestingDoctor` na mesma chamada — reaproveita a resolução
de preço pelo catálogo (mesmo convênio já gravado) e o recálculo de total de `create`/
`updateDiscount` (D-003). Só aceito com a proposta em `novo_contato`/`orcamento_enviado`
(`EDITABLE_STATUSES` em `shared/types/proposal.types.ts`) — fora disso,
`PROPOSAL_EDIT_NOT_ALLOWED` (409). `insuranceId` **continua fora do escopo**: permanece
imutável após a criação (D-082) — mudar de convênio re-precificaria itens com snapshot já
gravado e abriria discussão própria. A alçada de `discountPercent` segue exatamente a regra de
`PATCH /discount` (D-045): dentro do limite do autor aprova por si mesma; acima, a proposta
volta para `approvalStatus: pending` e reabre o fluxo de aprovação existente (WORKFLOWS §3) em
vez de bloquear a edição.
**Motivo:** pedido do usuário (CRMLAB-12) — atendente precisava corrigir itens/desconto/médico
solicitante depois de criar a proposta, e a única edição que já existia no backend (desconto)
nem estava ligada a nenhuma UI. `requestingDoctor` deixa de ser imutável (supera parcialmente
D-131 — só ele passou a ser editável; `insuranceId` segue imutável).
**Impacto:** `shared/types/proposal.types.ts` (`UpdateProposalItemsRequest/Response`,
`EDITABLE_STATUSES`/`isProposalEditable`), `shared/types/api.types.ts`
(`PROPOSAL_EDIT_NOT_ALLOWED`), `shared/types/websocket.types.ts` (evento `proposal.updated`),
`proposal.repository.ts` (`deleteItems`, `requestingDoctor` em `ProposalPatch`),
`proposal.service.ts` (`updateItems`), `proposal.routes.ts` (`PATCH /proposals/:id/items`).
Frontend: `ProposalModal.tsx` ganha modo de edição (itens + desconto + médico solicitante),
`DiscountSection.tsx` deixa de ficar `readOnly` hardcoded.

### D-135: `exceljs` mantido — troca por `xlsx` (SheetJS) fica como recomendação, não executada (CRMLAB-37)
**Decisão:** `exceljs` (`^4.4.0`, backend) continua em uso. Não foi trocado por `xlsx` (já
instalado no frontend via tarball da SheetJS, `frontend/package.json`) nem por parsing manual
do `.xlsx`, apesar de `exceljs` trazer `unzipper@0.10.14` (antigo) como transitiva.
**Motivo:** o único uso de `exceljs` no repo é `backend/src/lib/lis-spreadsheet.ts`
(`parseLisSpreadsheet`) — leitura de planilha do LIS para importar orçamentos, ~25 linhas de
API do ExcelJS (`new Workbook()`, `workbook.xlsx.load(buffer)`, `sheet.getRow`,
`row.getCell(...).value`, `eachCell`). Migrar para `xlsx` é tecnicamente possível
(`XLSX.read(buffer)` + `sheet_to_json`/acesso célula a célula cobrem o mesmo uso), mas o valor
de célula que cada biblioteca devolve para datas/número não é garantidamente idêntico
(`cellToDate`/`cellToNumber` em `lis-spreadsheet.ts` já tiveram dois bugs de fuso/soma
documentados em D-110/D-078/D-124) — e a soma de dinheiro do LIS é dado real de laboratório, não
tolera regressão silenciosa. `npm audit --omit=dev` de hoje mostra o `uuid`/`exceljs` como
**moderate**, não high/critical (ver D-136): não há urgência de segurança que justifique o
risco de reescrever um parser financeiro sem um card próprio e sem re-passar as ~20 planilhas
de referência do FluxoLab pelo novo caminho.
**Recomendação para card futuro (não deste):** abrir um card dedicado (fora da Onda A) para
migrar `parseLisSpreadsheet` para `xlsx`. Estimativa: 0,5–1 dia — reescrever a função (pequena),
mas rodar TODA a suíte de `backend/tests/lis/*.spec.ts` (260+122 linhas, cobre aliases de
cabeçalho, datas por componente, PDF disfarçado, planilha vazia) mais o E2E
`flow-17-lis-import-results.spec.ts` contra o novo parser, e idealmente confirmar contra uma
planilha real do LIS antes de trocar em produção. Alternativa mais barata: manter `exceljs` e
apenas monitorar advisories futuros do `unzipper` via o job `security` do CI — hoje ele não
aparece porque a vulnerabilidade transitiva reportada é do `uuid`, não do `unzipper`.
**Impacto:** nenhum arquivo de código mudou por esta decisão. Registrado aqui para não ser
reaberto como "esquecido" — é escolha deliberada, não pendência técnica.

### D-136: `npm audit` funciona neste repo — a suposição de erro 400 não se confirmou (CRMLAB-37)
**Decisão:** o job `security` do CI (`.github/workflows/ci.yml`) usa `npm audit --omit=dev
--audit-level=high` direto, em vez de `google/osv-scanner-action` como o escopo original do
card previa.
**Motivo:** o card partia da premissa de que `npm audit` quebra com `400 Invalid package tree`
porque o `xlsx` do frontend é instalado por URL/tarball da SheetJS (fora do registry do npm), e
por isso pedia `osv-scanner` (lê o `package-lock.json` direto, sem depender do registry).
Testado antes de escrever o job (19/09/2026, `npm --version` 10.9.8, Node 22): `npm audit`,
`npm audit --omit=dev` e `npm audit --omit=dev --audit-level=high` rodaram normalmente, sem
erro 400, contra o `package-lock.json` atual (que já tem o `xlsx@0.20.3` resolvido por URL desde
antes deste card). Resultado real: 7 moderate em produção (`qs`, `react-router`, `uuid` via
`exceljs`), 0 high/critical — `--audit-level=high` sai com `exit=0`, como o job precisa.
Não dá para descartar que o erro apareça em outro ambiente (proxy corporativo, mudança futura
do registry, ou uma versão de npm diferente da testada aqui) — é exatamente o tipo de falha que
`osv-scanner` evitaria por não depender do registry do npm para resolver a árvore. Optou-se por
`npm audit` agora por ser mais simples (nenhuma Action de terceiro nova, sintaxe já
comprovadamente correta neste ambiente) e por já resolver o critério de aceite do card (falhar
o PR em high/critical). Se o `security` job passar a falhar com `400`/erro de registry em
produção do CI (não reproduzido aqui), trocar para `osv-scanner` é a correção recomendada — não
precisa de novo card, é o mesmo job.
**Impacto:** `.github/workflows/ci.yml` (job `security`, novo). Nenhuma dependência nova.

### D-137: Pool do `pg` com listener de `error`, timeouts de sessão e timeout de `fetch` para os gateways (CRMLAB-30)
**Decisão:** `PgDriver` ganha `pool.on('error', ...)` (loga e não derruba o processo — o `pg`
já descarta a conexão quebrada sozinho) e um listener equivalente por conexão dentro de
`transaction()`, porque o `pg-pool` remove o listener do pool exatamente durante o checkout
(o intervalo em que uma transação fica aberta). O pool passa a fixar
`idleTimeoutMillis=30s`, `connectionTimeoutMillis=5s` e, no pacote de startup,
`statement_timeout=30s` + `idle_in_transaction_session_timeout=60s` (ambos em 0/sem limite
antes, confirmado na VPS em 19/09). As migrações usam `SET LOCAL statement_timeout=0`
(`db/statement-timeout.ts`) para se isentar do limite de 30 s: um `CREATE INDEX`/`ALTER TABLE`
longo é legítimo e cortá-lo no meio de um deploy é pior que esperar. Import LIS e export
Excel/PDF foram revisados e **não** precisam de isenção: o import faz um upsert por statement
dentro de um loop de chunks (nenhum statement individual passa de 30 s, mesmo que o total
passe) e não existe export que leia/escreva no banco (o `exceljs` só lê planilha de entrada,
fora do banco). `evolution-client.ts` e `whatsapp.service.ts` passam a chamar `fetch` com
`signal: AbortSignal.timeout(...)` via o wrapper `lib/fetch-timeout.ts`, que cobre tanto a
resposta não chegar quanto o corpo nunca fechar (`fetch` resolve só nos headers). Timeout vira
`GatewayTimeoutError` (`retryable = true`), tratado pela fila (`lib/queue.ts`) como qualquer
outra falha — 10 s para Evolution (controle/texto) e Meta, 15 s para mídia do Evolution
(corpo maior, ~20 MB em base64); orçamento de `3 tentativas × timeout + backoff` fica sempre
abaixo dos 60 s do `proxy_read_timeout` do nginx.
**Motivo:** incidente de 17/09 — o Postgres piscou (ou o gateway Evolution ficou "vivo mas
mudo") e o processo caiu inteiro: sem listener de `error` no pool, um `EventEmitter` que emite
`error` sem ouvinte vira exceção não capturada; sem timeout no `fetch`, o handler ficava preso
segurando uma transação e, com ela, uma das 10 conexões do pool, até esgotar o pool inteiro.
Os dois defeitos derrubam TODOS os tenants de uma vez — não é isolado por request.
**Impacto:** `backend/src/db/pg-driver.ts`, `backend/src/db/statement-timeout.ts` (novo),
`backend/src/db/migrator.ts`, `backend/src/db/index.ts`, `backend/src/lib/fetch-timeout.ts`
(novo), `backend/src/lib/evolution-client.ts`, `backend/src/services/whatsapp.service.ts`.
Testes novos: `backend/tests/db/pg-pool-resilience.spec.ts`,
`backend/tests/whatsapp/gateway-timeout.spec.ts`. Os testes de caos reais (`docker restart`
do Postgres, `docker pause` do Evolution) ficam para a validação em homologação — não rodam
neste ambiente. **Circuit breaker no cliente Evolution foi avaliado e descartado nesta rodada**:
o `AbortSignal.timeout` + retry exponencial da fila já limitam o dano de uma falha isolada a
uma tentativa de ~10-15 s, e o volume de envio por tenant é baixo o bastante para que um estado
compartilhado de "pausa de 30 s" ganhe pouco sobre o que os timeouts já resolvem, ao custo de
mais um componente com estado para depurar. Reavaliar se o padrão de falha em homologação/
produção mostrar rajadas de timeout que o retry sozinho não absorve bem.

### D-138: `unhandledRejection`/`uncaughtException` derrubam o processo pelo MESMO shutdown do SIGTERM (CRMLAB-30)
**Decisão:** `main.ts` ganha `process.on('unhandledRejection', ...)` e
`process.on('uncaughtException', ...)`, ambos logando `event: 'process.fatal'` (com a origem
em `source`) e chamando a mesma função `shutdown()` já usada por SIGTERM/SIGINT — que fecha
WebSocket, cache e pool antes de sair — com `exitCode = 1` para diferenciar, no
`docker inspect`, queda de parada pedida.
**Motivo:** hoje as duas situações derrubam o processo sem log nenhum (Node 22) ou de forma
descoordenada; um processo que abandonou uma promise/exceção no meio não está mais confiável
(pode ter deixado transação aberta, lock preso), e servir novas requisições nesse estado é
pior que sair de forma controlada. Pedido explícito do card: mesmo tratamento para as duas,
sem meio-termo de "loga e continua" para `unhandledRejection`.
**Impacto:** `backend/src/main.ts` (função `onFatal`, reaproveitando `shutdown`).

### D-139: Rate limit e lockout de login por `INCR` atômico; fail-open/fail-closed quando o Redis cai em runtime (CRMLAB-34)
**Decisão:** `CacheService` ganha `incr(key, ttlSeconds)` — incremento atômico com TTL aplicado
só na primeira chamada (janela fixa: `INCR` + `EXPIRE` condicional). Em `RedisCache` isso roda
como um script Lua (`INCR_EX_SCRIPT`) num único round-trip ao servidor — de verdade atômico,
sem janela entre leitura e escrita para outra requisição furar. Em `MemoryCache` o corpo do
método não tem nenhum `await`, então não há ponto de interleaving possível nem sob
`Promise.all` concorrente.

`rate-limit.ts` passa a usar janela FIXA: a chave carrega o índice da janela
(`Math.floor(at / windowMs)`), então todas as requisições da mesma janela caem no mesmo `INCR`
e o limite é decidido por um único comando atômico, em vez do `get` → filtra array de
timestamps → `set` anterior (TOCTOU: duas requisições concorrentes liam o mesmo estado e as
duas passavam). `auth.service.ts` troca o contador de falha de login pelo mesmo `incr` (mantendo
a chave existente `login-failures:{email}:{ip}`, não a sugerida no card — evita quebrar o
contrato já coberto por `cache.spec.ts`) e passa a dar `DEL` no sucesso (não existia antes).

**Comportamento com Redis indisponível em RUNTIME** (distinto do fail-closed do BOOT em D-058,
que continua intocado — `verifyCacheReady`/`main.ts` seguem parando o processo se o Redis não
responder ao subir):
- **Rotas autenticadas:** fail-OPEN. Loga `event: 'cache.unavailable'` (throttle de 30s por
  processo, `logCacheUnavailable` em `lib/cache.ts`) e deixa a requisição passar sem contar
  cota. Motivo: o JWT já é a defesa primária dessas rotas; recusar TODO o tráfego autenticado
  por causa do cache trocaria uma degradação de cota por uma indisponibilidade total — pior
  para o negócio que uma janela sem rate limit.
- **Rotas públicas** (`/auth/login`, `/auth/refresh`, `/webhooks/*`): fail-CLOSED — 503
  `SERVICE_UNAVAILABLE` (novo `ApiErrorCode`, `shared/types/api.types.ts` +
  `docs/api/API_ERRORS.md`). Motivo: rate limit e lockout de login SÃO a defesa dessas rotas
  (não há JWT prévio); deixar passar sem eles é convite a força bruta. `/auth/logout` fica de
  fora de propósito — não há o que proteger e travar logout com o cache fora do ar pioraria um
  incidente sem necessidade.
- A decisão é tomada duas vezes de forma independente e redundante: no middleware
  `rate-limit.ts` (que já barra `/auth/login`/`/auth/refresh` ANTES do controller, pela ordem em
  `app.ts`) e dentro do próprio `AuthService` (`assertNotThrottled`/`registerFailure`), para que
  o serviço não dependa de estar sempre atrás do middleware para se comportar corretamente —
  é o que os testes de `auth.service` cobrem isoladamente.

Headers de cota passam a sair em dois formatos simultâneos: os `X-RateLimit-*` existentes
(mantidos — contrato já consumido) e os do draft IETF `draft-ietf-httpapi-ratelimit-headers`
(`RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, sem prefixo `X-`). Divergência
proposital: `X-RateLimit-Reset` continua epoch absoluto (segundos desde 1970, como já era);
`RateLimit-Reset` é DELTA (segundos até o reset a partir de agora), porque é assim que o draft
define o campo — não dá para reaproveitar o mesmo valor para os dois.

**Motivo:** auditoria de 2026-09 apontou o padrão `get`+`set` como TOCTOU clássico tanto no
rate limit quanto no lockout de login (20 senhas erradas em paralelo perdiam 19 incrementos,
nunca disparando o bloqueio de 5), e o `next(err)` genérico do cache indisponível em runtime
derrubando TODAS as rotas com `INTERNAL_ERROR` — inclusive as autenticadas, que não precisavam
cair.

**Impacto:** `backend/src/lib/cache.ts` (`incr`, `RedisClientLike.incrEx`, `INCR_EX_SCRIPT`,
`logCacheUnavailable`/`resetCacheUnavailableThrottleForTest`), `backend/src/http/middleware/
rate-limit.ts` (janela fixa, `isPublicRoute`, headers duplos), `backend/src/services/
auth.service.ts` (lockout atômico + `DEL` no sucesso), `backend/src/app.ts` (`exposedHeaders`
do CORS), `shared/types/api.types.ts` (+`SERVICE_UNAVAILABLE`), `backend/src/http/errors.ts`
(catálogo), `docs/api/API_ERRORS.md`. Testes novos: `backend/tests/kernel/rate-limit.spec.ts`
(concorrência 50×`Promise.all` contra limite 10, fail-open/fail-closed com cache falhando),
`backend/tests/kernel/cache.spec.ts` (`incr`/`incrEx`), `backend/tests/auth/login.spec.ts`
(20 falhas em paralelo não furam o lockout de 5, 503 com Redis fora do ar). Não mexe em infra
(`REDIS_URL`/`maxmemory` — isso é CRMLAB-36).

### D-140: `evolution: user: "1000:1000"` avaliado e NÃO aplicado nesta rodada (CRMLAB-36)
**Decisão:** Não adicionar `user: "1000:1000"` ao serviço `evolution` em `docker-compose.prod.yml`
por enquanto. `mem_limit: 768m` e os demais itens do card foram aplicados normalmente.
**Motivo:** `evoapicloud/evolution-api:v2.3.7` é imagem de terceiro; não há como validar, a
partir deste repositório/CI, se o processo aceita rodar como uid 1000 com o volume de sessão
Baileys que já está em produção (permissões do volume, escrita de arquivo de sessão, etc.).
Aplicar às cegas e descobrir em produção que o container não sobe mais é pior do que manter o
risco documentado (o card já registra: hoje roda como root, é o único serviço nessa condição).
**Impacto:** Nenhum no código. Pendência de validação manual: testar `user: "1000:1000"` em
homologação primeiro (subir a stack, parear um número de teste, confirmar que a sessão
persiste depois de um restart do container) antes de replicar em produção. Ver
`docs/STATUS.md` (entrada CRMLAB-36) para o registro da pendência.

### D-141: Backend com UMA imagem para os dois ambientes; frontend com DUAS (CRMLAB-36)
**Decisão:** O job `docker` do CI publica `crm-lab-backend` no GHCR com três tags apontando pro
MESMO digest (`:<sha>`, `:hml-<sha>`, `:latest`) mas builda e publica o `crm-lab-frontend`
**duas vezes** — uma com os build-args default (produção, tag `:<sha>`) e outra com
`VITE_APP_ENV=homologacao` (tag `:hml-<sha>`). `IMAGE_TAG` em `deploy.sh` continua com o
mesmo prefixo `hml-` de sempre (`ENVIRONMENTS.md`), então `docker-compose.prod.yml` não muda a
lógica de tag por ambiente — só ganha o prefixo `${IMAGE_REGISTRY:-}`.
**Motivo:** o backend não tem NENHUMA diferença de build-time entre os dois ambientes — tudo
que muda (URL, segredo, `APP_ENV`) é variável de runtime injetada pelo compose. Publicar uma
imagem só e apontar duas tags pra ela evita build duplicado e mantém as duas stacks rodando o
mesmo binário verificado pelo CI. O frontend é diferente: `VITE_APP_ENV` (e as demais `VITE_*`)
são build-time — o Vite inlina no bundle (`frontend/Dockerfile`, `DEPLOYMENT.md` §2) — então
produção e homologação são, de fato, dois artefatos distintos; publicar só um dos dois faria a
outra stack rodar com o selo de ambiente errado na tela.
**Impacto:** `.github/workflows/ci.yml` (job `docker`, três steps novos de publicação),
`docker-compose.prod.yml` (`image:` com `${IMAGE_REGISTRY:-}` nos três serviços que usam
imagem própria — `migrate`, `backend`, `frontend`), `scripts/deploy.sh` (`pull` no lugar de
`build`, com fallback). Nada muda no cálculo de `IMAGE_TAG`/`PREFIXO_TAG` existente.

### D-142: Refresh token em cookie httpOnly, access token só em memória, CSP em Report-Only (CRMLAB-32)
**Decisão:** `POST /auth/login` e `POST /auth/refresh` gravam o refresh token em
`Set-Cookie: crm_refresh=<token>; HttpOnly; Secure (só produção/homologação); SameSite=Strict;
Path=/api/v1/auth`, e o corpo JSON deixa de trazer `refreshToken` (`LoginResponse`/
`RefreshResponse` em `shared/types/auth.types.ts`). `POST /auth/refresh` lê o cookie primeiro,
com fallback depreciado para `refreshToken` no corpo (remoção prevista 2026-10-04) e exige o
header `X-Requested-With: crm-lab` como camada extra de CSRF. `POST /auth/logout` limpa o
cookie (`Max-Age=0`) além de revogar a família. No frontend, `auth.store.ts` para de persistir
`tokens` no `localStorage` — só `user`/`tenant`/`theme` — e o access token vive só em memória;
toda carga de página chama `POST /auth/refresh` (cookie vai sozinho, mesmo origin) antes de
renderizar o router (`useSessionBootstrap`, `App.tsx`), trocando o cookie por um access token
novo. `nginx/frontend.conf` ganha `Content-Security-Policy-Report-Only` (não enforce ainda) e
`Permissions-Policy`.
**Motivo:** achado de severidade Alta da auditoria de segurança — a sessão inteira (access de
15min E refresh de 7 dias, rotativo) ficava legível por qualquer JavaScript no origin via
`localStorage`, e a SPA não tinha CSP nenhuma. Não há `dangerouslySetInnerHTML`/`innerHTML`
hoje, mas o vetor é dependência de terceiros (jspdf, recharts, xlsx) ou descuido futuro — com
dado de saúde de paciente em jogo, um XSS que rouba `localStorage` rouba a sessão inteira por
7 dias. `HttpOnly` fecha esse vetor para o refresh; o access token curto em memória reduz a
janela do que sobra. CSP entra em `Report-Only` (não `Content-Security-Policy` enforce) porque
a SPA nunca foi auditada contra uma política — enforce direto arriscaria quebrar produção sem
aviso; a promoção para enforce é decisão separada, após ~1 semana observando os relatórios de
violação em homologação.
**Impacto:** `backend/src/controllers/auth.routes.ts` (cookie-parser só neste router),
`backend/src/services/auth.service.ts` (`LoginResult`/`RefreshResult` internos, com
`refreshToken`, distintos do contrato público), `backend/package.json` (+`cookie-parser`),
`shared/types/auth.types.ts`, `frontend/src/stores/auth.store.ts`, `frontend/src/api/client.ts`,
`frontend/src/hooks/useSession.ts` (`useSessionBootstrap`), `frontend/src/App.tsx`,
`nginx/frontend.conf`. NÃO mexeu em `frontend/src/api/ws.ts` (WebSocket) — isso é CRMLAB-33,
que depende deste card. CORS geral (`app.ts`) continua com `credentials: false` — nginx já
serve SPA e API no mesmo origin, então o cookie não precisa de CORS com credenciais.

### D-143: Mesmo origin também em dev/E2E — proxy do Vite para `/api` e `/ws` (CRMLAB-32)
**Decisão:** `frontend/vite.config.ts` ganha `server.proxy` encaminhando `/api` e `/ws` para
`http://localhost:3000` (`ws: true` no segundo). `frontend/.env.example` e o job `e2e` de
`.github/workflows/ci.yml` passam a usar `VITE_API_URL=/api/v1` e `VITE_WS_URL=/ws`
(relativos) também em dev — antes só produção usava caminho relativo (D-051); dev apontava
direto para `http://localhost:3000`, uma origin diferente por porta.
**Motivo:** o refresh do D-142 vive num cookie `HttpOnly`, e cookie só volta em requisição
**same-origin** (porta inclusa). Com `VITE_API_URL` absoluto, todo `POST /auth/refresh` feito
pelo browser saía de `localhost:5173` para `localhost:3000` — origin diferente, cookie nunca
volta — e o `useSessionBootstrap` (D-142) via 401 a cada carga de página, jogando qualquer
sessão de volta para `/login`. Confirmado ao vivo: a suíte E2E inteira (76 de 123 specs)
falhava exatamente assim depois do merge do CRMLAB-32 — todo teste que fazia `page.goto` para
uma rota autenticada caía em `/login` porque o bootstrap nunca conseguia trocar o cookie por um
access token. O proxy do Vite resolve isso do MESMO jeito que o nginx resolve em produção
(D-051): dev, E2E e produção passam a compartilhar a mesma regra — "o browser nunca faz
requisição cross-origin para a API".
**Impacto:** `frontend/vite.config.ts`, `frontend/.env.example`, `.github/workflows/ci.yml`
(env do job `e2e`), `docs/guides/CONVENTIONS.md`, `docs/guides/DEVELOPMENT.md`,
`frontend/src/api/client.ts` (comentário de `resolveMediaUrl` atualizado — a distinção
dev-absoluto/prod-relativo que ele descrevia deixou de existir). Nenhuma mudança de código de
produção: `VITE_API_URL`/`VITE_WS_URL` do `frontend/Dockerfile` já eram relativos desde D-051.

### D-144: `add_header` repetido nas locations do nginx que também declaram `add_header` (CRMLAB-32, pós-deploy)
**Decisão:** `nginx/frontend.conf` passa a repetir os 5 headers de segurança do nível `server`
(`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`,
`Content-Security-Policy-Report-Only`, `Permissions-Policy`) dentro de `location = /index.html`
(todos os 5) e `location /assets/` (os 3 que não são específicos de documento — sem CSP/
Permissions-Policy, que só fazem sentido na resposta do documento).
**Motivo:** achado ao vivo no primeiro deploy do CRMLAB-32 em homologação — `curl -I` na raiz
não trazia NENHUM dos 5 headers, apesar de estarem corretos no `server {}`. Causa: pegadinha
documentada do próprio nginx — quando uma `location` declara seu PRÓPRIO `add_header`, ela para
de herdar QUALQUER `add_header` do nível acima, silenciosamente. `location = /index.html` e
`location /assets/` já tinham `add_header Cache-Control` antes do CRMLAB-32 existir (Onda 5), e
`/` sempre cai em `/index.html` via `try_files` — ou seja, a resposta que o navegador realmente
recebe como "o documento" nunca teve CSP nem X-Frame-Options desde que esses headers foram
escritos, e nada no CI pegou isso (testes de unidade não sobem o nginx de verdade; o E2E roda
contra o Vite dev server, que não usa este arquivo).
**Impacto:** só `nginx/frontend.conf`. Validado com `nginx -t` + um container real servindo
`index.html` e `curl -I` confirmando os 5 headers na resposta. Lição para o próximo header novo
neste arquivo: qualquer `add_header` adicionado ao `server {}` PRECISA ser copiado para as duas
locations que têm `add_header` próprio, ou vira letra morta — comentário no arquivo aponta para
esta decisão.

### D-145: Pool conecta com `crm_login` (sem superuser) em vez do dono do banco (CRMLAB-38)
> **Corrigida pela D-165:** o `NOBYPASSRLS` abaixo estava errado e quebrava login e webhook.
> Leia a D-165 antes de usar esta decisão.

**Decisão:** migração `020_crm_login_role.sql` cria a role `crm_login` (`LOGIN NOSUPERUSER
NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`), membro de `crm_app` — herda por `INHERIT`
os mesmos `GRANT`s de SELECT/INSERT/UPDATE/DELETE de D-002, sem ser dona de nada. A role NÃO
recebe senha na migração; apontar `DATABASE_URL` para ela e rodar `ALTER ROLE crm_login WITH
PASSWORD '...'` é **pendência manual na VPS** (`docs/guides/DEPLOYMENT.md`). O job `migrate` do
compose continua conectando como a role dona, que é quem precisa de DDL.
**Motivo:** a pool conecta hoje como o `POSTGRES_USER` do container, que a imagem oficial cria
como superuser. Dentro de transação com tenant a app troca para `crm_app` via `SET LOCAL ROLE`
(D-002), mas todo caminho `withoutTenant()` — login, `/platform/*`, lookup de tenant do webhook,
seeds — nunca troca: roda com DDL, `BYPASSRLS` e `DROP TABLE` na mão. Nenhuma SQLi foi
encontrada na auditoria (todo valor por bind, `ORDER BY` por allow-list); isto é defesa em
profundidade, não correção de falha explorada. Senha em migração versionada é senha vazada no
git — daí a role nascer sem senha e o resto ser passo manual.
**Impacto:** `backend/migrations/020_crm_login_role.sql`, `docs/guides/DEPLOYMENT.md`,
`docs/database/SCHEMA.md`.
### D-146: Índice nas 15 FKs sem índice, sem `CONCURRENTLY` (CRMLAB-38)
**Decisão:** `021_fk_indexes.sql` cria `idx_*` (`IF NOT EXISTS`) nas 15 foreign keys que não
tinham índice, com `CREATE INDEX` comum — não `CONCURRENTLY`.
**Motivo:** FK sem índice vira SEQ SCAN em `DELETE` na tabela pai e em qualquer JOIN pelo lado
filho. O banco tem 13 MB hoje, então o ganho é zero agora e o custo de esperar só cresce.
`CONCURRENTLY` foi descartado porque o migrator roda cada arquivo dentro de uma transação
própria e `CREATE INDEX CONCURRENTLY` não pode rodar em transação — suportá-lo exigiria um
modo "migração fora de transação" no runner, desproporcional para um índice que neste volume
sai instantâneo. Reavaliar se o volume crescer a ponto do lock incomodar em produção.
**Impacto:** `backend/migrations/021_fk_indexes.sql`, `docs/database/SCHEMA.md`.
### D-147: Lock de migração é `pg_advisory_xact_lock` pedido DENTRO da transação de cada migração (CRMLAB-38)
**Decisão:** cada migração pendente roda em sua própria transação, que começa pedindo
`pg_advisory_xact_lock(hashtext('crm_lab_migrate'))` e, **já com o lock na mão**, relê
`schema_migrations` para aquele arquivo antes de aplicá-lo. Não existe transação externa
envolvendo o loop.
**Motivo:** dois deploys disparados juntos aplicariam a mesma migração em paralelo. `deploy.sh`
já roda o job `migrate` sozinho — isto é segunda linha de defesa, não substituta da primeira.
Dois detalhes que a primeira versão desta decisão errou e o teste pegou:
1. **O lock NÃO pode ficar numa transação externa que envolva o loop.** O driver de PGlite
   (`pglite-driver.ts`, usado em todo teste e em dev sem `DATABASE_URL`) serializa cada
   `query`/`transaction` numa fila de uma conexão só: a transação externa esperaria o loop
   terminar e o loop esperaria a fila que a externa segura — deadlock, e a suíte inteira caiu
   em timeout de 60 s. O lock por migração não tem esse problema: nenhuma chamada aninha.
2. **Serializar não basta; é preciso reler.** O `SELECT` de `schema_migrations` feito antes do
   loop está obsoleto para o segundo runner, que fica bloqueado no lock justamente enquanto o
   primeiro aplica e commita. Sem o `SELECT ... WHERE name = $1` de dentro da transação, ele
   acordaria com a lista velha e aplicaria o arquivo de novo — o lock teria serializado a dupla
   aplicação em vez de impedi-la. Arquivo já aplicado por outro runner entra em `skipped`.
`pg_advisory_xact_lock` (transação) e não lock de sessão porque `db.query` fora de transação
usa o pool e cada chamada pode sair por uma conexão diferente; um lock de sessão pedido numa
conexão e liberado por engano noutra ficaria preso até a conexão fechar, e o pool reaproveita
conexões ociosas (D-030). O lock de transação nasce e morre preso à conexão da transação e
libera sozinho no COMMIT/ROLLBACK. Falha de uma migração continua não desfazendo as anteriores.
**Impacto:** `backend/src/db/migrator.ts`, `backend/tests/kernel/migrator.spec.ts`.
### D-148: Redact do logger ampliado preventivamente; corpo de erro do Evolution cortado em 200 chars (CRMLAB-38)
**Decisão:** `REDACT_PATHS` ganha `apikey`/`apiKey`/`secret`/`webhookSecret`/`contentBase64`/
`email`/`phone`, cada um também na forma `*.<campo>` (um nível de aninhamento), e passa a ser
`export` só para o teste conseguir afirmar a lista. O corpo de erro que o `evolution-client`
embute na mensagem do `Error` cai de 500 para 200 caracteres.
**Motivo:** nenhum dos campos novos tinha vazamento real no momento do card (grep vazio) — mas
o próximo `logger.info({ payload })` que incluir um deles vaza sem isto; o custo de listar é
nulo. `REDACT_PATHS` é exportado apenas para teste porque o pino fica `enabled: false` em
`NODE_ENV=test`, então não há saída renderizada para capturar: o teste verifica que o campo
está na lista, não o log final. Os 500 chars do corpo de erro do gateway vão para o log via
`queue.job_attempt_failed` e podem ecoar dado de sessão/número do terceiro; 200 ainda
identificam a causa para debug.
**Impacto:** `backend/src/lib/logger.ts`, `backend/src/lib/evolution-client.ts`,
`backend/tests/kernel/logger-redact.spec.ts`.
### D-149: Anti-replay nos webhooks por hash do corpo no Redis (10 min); janela de timestamp avaliada e DESCARTADA (CRMLAB-38)
**Decisão:** antes de aceitar um webhook autenticado, `authenticate()` calcula `sha256(rawBody)`
e guarda `webhook:replay:<tenantId>:<digest>` no Redis por 600 s; corpo já visto é recusado.
Essa é a **única** camada nova. Uma segunda camada — recusar payload da Meta cujo timestamp de
mensagem fosse mais velho que 5 min — foi implementada, testada e **removida antes do merge**.
**Motivo:** HMAC e token provam que o remetente é legítimo, não que a requisição é nova — um
corpo capturado é reenviável indefinidamente com assinatura válida.
`messages.external_id` (migração 019) já impede duplicar a *mensagem*; o que sobra são callbacks
de status/conexão repetidos, que não têm `external_id` para colidir. O TTL é curto porque o alvo
é o replay logo em seguida (janela realista de MITM ou proxy reentregando), não guardar hash
para sempre.

A janela de timestamp saiu porque **a Meta retenta webhook falho por até 7 dias**. Recusar por
idade significa descartar em silêncio toda reentrega legítima depois de qualquer indisponibilidade
maior que a janela — exatamente a situação em que essas mensagens mais importam. O ganho de
segurança adicional era quase nulo: dentro da janela quem barra é o hash acima, e fora dela a
UNIQUE de `external_id` impede a duplicata da mensagem. Trocar perda real de mensagem por defesa
em profundidade redundante é o negócio errado. O custo disso apareceu como 12 testes de webhook
quebrando: os fixtures usam um epoch fixo de 2024, e o teste estava certo — quem estava errado
era a regra. `tests/webhooks/replay-guard.spec.ts` guarda a regressão com um payload de 2024 que
**precisa** passar na primeira entrega e só ser barrado na segunda.
**Impacto:** `backend/src/controllers/webhook.routes.ts`,
`backend/tests/webhooks/replay-guard.spec.ts`.
### D-150: `deploy.sh` exige CI verde no commit, com `gh` autenticado na VPS (CRMLAB-38)
**Decisão:** antes de buildar, `scripts/deploy.sh` consulta `gh run list --commit <SHA> --branch
main --workflow CI` e aborta se a conclusão não for `success` — inclusive quando não há run
nenhum para o SHA, ou quando a consulta falha. `gh` ausente ou não autenticado também aborta,
com mensagem dizendo para rodar `gh auth login` (passo manual, uma vez, fora do script).
**Motivo:** o script já conferia árvore limpa e (em produção) tag igual à versão, mas nunca
perguntou ao GitHub se aquele commit passou no CI — buildava e subia com o workflow vermelho se
alguém rodasse o deploy sem olhar o PR. Abortar quando a checagem não pode ser feita, em vez de
pular em silêncio, é deliberado: uma verificação que se desliga sozinha é pior que não existir,
porque dá a impressão de cobertura.
**Impacto:** `scripts/deploy.sh`, `docs/guides/DEPLOYMENT.md`.

**Correção da revisão (2026-09-21):** o filtro `--branch main` saiu. O fluxo documentado de
homologação é `deploy.sh --ref <branch da onda>`, e o run de CI daquele commit fica atribuído à
branch dele, nunca a `main` — com o filtro fixo, TODO deploy de hml por `--ref` abortava com
`sem_run`. O filtro por commit já é exato; a branch só restringia sem ganho.

**Emenda (2026-09-22) — `--sem-ci`, com data de validade.** A trava abortava também quando o CI
**não podia** rodar: com a cota do GitHub Actions estourada desde 21/09/2026, os cinco jobs param
em 2 s e todo deploy trava — homologação inclusive, que é justamente onde se valida uma mudança
que o CI não validou. `--sem-ci` abre essa porta, e **só** essa: aborta em produção, exige
`SEM CI` digitado mais um motivo não vazio, e repete o motivo na última linha do deploy.

Isto é **dívida consciente, não um novo padrão.** A pergunta que a flag responde é "o CI não pode
rodar"; ela não deve responder "o CI ficou vermelho e eu tenho pressa" — para isso o lugar é o
código. Condição de saída e o que fazer está em `docs/STATUS.md` → "Dívida: `--sem-ci`". Se você
está lendo isto depois de 01/10/2026 e a flag ainda existe sem ninguém ter decidido mantê-la,
ela passou do prazo: leve para revisão em vez de usar.
### D-151: WebSocket autentica pelo cookie httpOnly do refresh; Path do cookie alarga para `/`; Origin verificado no upgrade (CRMLAB-33)
**Decisão:** `/ws` deixa de aceitar `?token=<accessToken>` na URL. O handshake de upgrade passa a
ser autenticado pelo cookie httpOnly `crm_refresh` (o mesmo do CRMLAB-32/D-142), lido e
verificado manualmente em `ws-hub.ts` (o upgrade de WebSocket não passa pelos middlewares do
Express, `cookie-parser` incluído — daí `backend/src/lib/cookies.ts`, parser mínimo só para isso).
Duas mudanças que essa escolha exigiu e não estavam no escopo original do card:
1. **`Path` do cookie alarga de `/api/v1/auth` para `/`.** Um cookie só aceita um `Path`; o
   handshake em `/ws` também precisa recebê-lo. `HttpOnly` + `SameSite=Strict` continuam sendo a
   defesa real contra roubo/CSRF do refresh — `Path` estreito só reduzia quais rotas o recebiam
   automaticamente, e o item 2 cobre o risco de CSRF específico do WS melhor do que `Path` cobria.
2. **Header `Origin` do upgrade é verificado contra `env.corsOrigins` e a conexão é recusada (sem
   completar o handshake) se não bater.** WebSocket NÃO respeita a Same-Origin Policy do jeito que
   `fetch`/XHR respeitam: o browser manda o cookie no handshake mesmo que a página que abriu a
   conexão esteja em outro domínio (classe conhecida: WebSocket CSRF). Autenticar só pelo cookie
   sem checar `Origin` abriria a porta pra qualquer site abrir `wss://.../ws` a partir do browser
   de uma vítima logada e ler o realtime dela — isso NÃO existia como risco antes porque o design
   anterior exigia o access token na URL, que um site de terceiro não tem como obter.
3. **Cookie ausente/inválido/expirado fecha com o código `WS_CLOSE_UNAUTHORIZED` (4401,
   `@crm-lab/shared`) DEPOIS de completar o handshake (101), não antes.** Um `4xx` cru na resposta
   HTTP do upgrade não é observável pelo `WebSocket` do browser (limitação da própria API —
   `onclose` chegaria com o código genérico `1006`), e o cliente PRECISA distinguir "sessão
   vencida, tento refresh antes de reconectar" de "rede caiu, só espero o backoff". Só o Origin
   errado (item 2) é recusado cru — não há cliente legítimo cujo UX dependa de ler esse motivo.
**Motivo:** o card pedia só tirar o token da URL (vazava no log de acesso do Caddy); a Opção C
citada no card ("se o cookie httpOnly vier antes, ele resolve sozinho") só resolve de fato depois
de tratar os dois pontos acima, que não estavam escritos no card original.
**Impacto:** `backend/src/lib/ws-hub.ts` (Origin + cookie + heartbeat + limite de 5 sockets/
usuário — ver STATUS.md para o resto do escopo do card), `backend/src/lib/cookies.ts` (novo,
fonte única do nome/path/parse do cookie — `auth.routes.ts` passa a importar de lá em vez de
declarar localmente), `backend/src/main.ts` (`createWsHub({ allowedOrigins })`),
`shared/types/websocket.types.ts` (+`WS_CLOSE_UNAUTHORIZED`), `frontend/src/api/ws.ts` (sem
`?token=`; `onclose` com esse código dispara `refreshAccessToken()` antes de reconectar),
`docs/api/API_CONTRACTS.md`, `docs/contracts/FRONTEND_BACKEND.md`, `docs/architecture/
SECURITY.md`, `docs/guides/ENVIRONMENTS.md`.
### D-152: `refresh-cookie.ts` (como o cookie é GRAVADO) separado de `lib/cookies.ts` (nome e Path) (CRMLAB-35)
**Decisão:** `cookieOptions`, `setRefreshCookie` e `clearRefreshCookie` saem de dentro de
`auth.routes.ts` (onde eram funções privadas do módulo) para `backend/src/http/refresh-cookie.ts`,
que importa `REFRESH_COOKIE_NAME`/`REFRESH_COOKIE_PATH` de `backend/src/lib/cookies.ts`
(CRMLAB-33/D-151) e os re-exporta. `auth.routes.ts` e `user.routes.ts` importam daí.
**Motivo:** `PATCH /users/me/password` precisa LER o mesmo cookie que `auth.routes.ts` escreve,
para identificar a sessão atual e poupá-la da revogação em massa — duplicar nome/path/flags em
dois controllers é como duas fontes de verdade divergem sem ninguém perceber (uma rota muda
`SameSite` e a outra não). A divisão em DOIS arquivos não é cerimônia: `lib/cookies.ts` precisa
ser importável pelo handshake de WebSocket, que não tem `Response` do Express nenhum; tudo que
depende do `Response` fica em `http/refresh-cookie.ts`, fora do alcance dele.

**Este card NÃO decide o `Path` do cookie.** A versão original desta decisão ampliava o `Path` de
`/api/v1/auth` para `/api/v1` por conta própria; o CRMLAB-33, desenvolvido em paralelo, já amplia
para `/` (D-151) porque o handshake de `/ws` também precisa do cookie. `/` contém `/api/v1`, logo
a necessidade deste card está atendida e uma segunda decisão sobre o mesmo atributo só criaria
duas fontes de verdade para um cookie que só aceita um `Path`.
**Impacto:** `backend/src/http/refresh-cookie.ts` (novo), `backend/src/lib/cookies.ts` (do
CRMLAB-33, reusado), `backend/src/controllers/auth.routes.ts` (imports trocados, comportamento
idêntico), `backend/src/controllers/user.routes.ts` (import novo).
### D-153: Política de senha nova — mínimo 10 chars + lista curta de senhas triviais, sem `zxcvbn` (CRMLAB-35)
**Decisão:** `PATCH /users/me/password` exige `newPassword` com pelo menos 10 caracteres E fora
de uma lista embutida de ~20 senhas triviais comuns (`senha123`, `12345678910`, etc. —
`backend/src/lib/password-policy.ts`). Não usa `zxcvbn` nem serviço externo de força de senha.
**Motivo:** o card sugeria `zxcvbn` (score ≥ 3) OU uma lista de senhas comuns. `zxcvbn` é uma
dependência de ~800 KB (dicionários embutidos) só para uma tela de troca de senha — peso
desproporcional ao ganho, quando `MIN_PASSWORD_LENGTH` já subiu de 8 (criação de usuário,
`user.service.ts`) para 10 aqui, e uma lista curta pega o caso mais comum (reusar a mesma senha
óbvia). YAGNI: se um dia a auditoria pedir scoring de verdade, troca-se a função interna por
`zxcvbn` sem mexer no contrato da API.
**Impacto:** `backend/src/lib/password-policy.ts` (novo), `backend/src/services/auth.service.ts`
(`changePassword`). `MIN_PASSWORD_LENGTH` (8, `user.service.ts`, criação de usuário por admin)
NÃO mudou — é uma tela diferente (admin criando conta de outra pessoa), fora do escopo deste
card.
### D-154: Expiração absoluta de 30 dias por família de refresh (`TIMESTAMPTZ` + `revoked_reason`); desativação aceita a janela de 15 min do access token (CRMLAB-35)
**Decisão:** `refresh_tokens` ganha `absolute_expires_at` (migração 022): gravado no LOGIN como
`now + JWT_REFRESH_ABSOLUTE_TTL` (env var, default 30 dias) e CARREGADO para a frente em cada
rotação — a família não ganha teto novo a cada refresh, senão "absoluto" não seria absoluto.
Passado o teto, o próximo refresh cai em `REFRESH_TOKEN_INVALID` mesmo com o token ainda dentro
dos 7 dias rotativos. Ao desativar usuário (`PATCH /users/:id`, `isActive: false`), todas as
famílias de refresh são revogadas na mesma transação; o access token de até 15 min já emitido
NÃO é invalidado por denylist — a janela é aceita (o card dava as duas opções).

Dois detalhes que só apareceram quando os testes do card foram escritos, ambos corrigidos aqui:

1. **A coluna é `TIMESTAMPTZ`, não `TIMESTAMP` como as vizinhas.** `absolute_expires_at` é a
   primeira coluna de data desta tabela que faz *round-trip*: é lida do banco e gravada de volta
   a cada rotação. Em `TIMESTAMP` naive o driver devolve um `Date` interpretando o valor como
   hora **local**, enquanto a escrita manda `toISOString()` em **UTC** — o teto andava para
   frente o equivalente ao fuso a cada rotação (3 h em UTC-3). Uma sessão ativa empurraria o
   próprio teto indefinidamente, que é exatamente o que este card existe para impedir.
   `expires_at` e `revoked_at` continuam `TIMESTAMP` porque nunca são regravados a partir do que
   foi lido; a comparação delas tem o mesmo desvio de fuso, com efeito de 3 h numa janela de
   7 dias — anotado como dívida, fora do escopo deste card.
2. **`revoked_reason` separa "rotacionado" de "derrubado por segurança".** A detecção de roubo
   (D-015) trata qualquer token revogado que reapareça como reuso e derruba a família inteira.
   Com a troca de senha revogando as outras sessões em massa, o próximo refresh de outro
   navegador — comportamento normal, não ataque — derrubava também a sessão que acabara de
   trocar a senha, tornando o "revoga todas MENOS a atual" inútil na prática. `revokeByHash`
   (rotação) marca `'rotated'` e continua disparando a detecção; as revogações em massa marcam
   `'security'` e apenas recusam aquele token. `NULL` (linhas anteriores à migração) é lido como
   `'rotated'`, preservando o comportamento anterior.
**Motivo:** sem teto absoluto, um refresh rotativo mantém a MESMA sessão viva para sempre —
dispositivo perdido continua logado enquanto alguém abrir o app nele, mesmo trocando de token a
cada 15 min. Denylist no Redis para o access token do usuário desativado foi descartada por
YAGNI: adiciona um `jti` + TTL por token gerado (custo em toda requisição autenticada) para
fechar uma janela de no máximo 15 minutos — desproporcional ao risco hoje.
**Impacto:** `backend/migrations/022_refresh_tokens_absolute_expiry.sql`,
`backend/src/repositories/refresh-token.repository.ts` (`absoluteExpiresAt` e `revokedReason` em
toda leitura/escrita, `revokeAllForUserExcept`), `backend/src/services/auth.service.ts`
(`issueRefreshToken` carrega o teto adiante, `refresh()` checa o teto e o motivo da revogação),
`backend/src/services/user.service.ts` (`update()` revoga ao desativar),
`backend/src/config/env.ts` (`JWT_REFRESH_ABSOLUTE_TTL`), `docs/database/SCHEMA.md`.
### D-155: Limpeza de `refresh_tokens` expirados via `setInterval` no boot, sem scheduler novo (CRMLAB-35)
**Decisão:** `main.ts` roda `deleteExpiredOrRevoked` uma vez no boot e depois a cada 24h via
`setInterval` (`.unref()` — não impede o processo de sair). Sem `pg_cron`, sem lib de jobs nova.
Best-effort: falha loga e não derruba o processo nem o boot.
**Motivo:** o projeto não tem scheduler (CLAUDE.md/AGENTS.md não listam um; introduzir um só
para isto seria dependência nova desproporcional). Volume é baixo (34 linhas hoje, crescimento
linear com uso) — não é uma tarefa que precise de garantia de execução distribuída, só não
deixar a tabela crescer para sempre. `withoutTenant` é usado aqui porque a limpeza é
manutenção cross-tenant por natureza (não serve requisição de tenant nenhum) — terceiro uso
legítimo, além dos dois já documentados em `db/types.ts` (login, console de plataforma); o
comentário de `withoutTenant` foi atualizado para listar os três.
**Impacto:** `backend/src/main.ts`, `backend/src/repositories/refresh-token.repository.ts`
(`deleteExpiredOrRevoked`), `backend/src/db/types.ts` (comentário de `withoutTenant`).
### D-156: Guard de anti-replay atômico (`incr`) e isento para `CONNECTION_UPDATE` (CRMLAB-38)
**Decisão:** `isReplay` passa a usar `cache.incr(key, ttl) > 1` em vez de `get` seguido de
`set`, e `CONNECTION_UPDATE` fica fora da guarda (`replayExempt`).
**Motivo:** dois problemas achados na revisão do card. (1) `get`-então-`set` não é atômico:
dois replays idênticos chegando juntos liam `null` os dois e passavam os dois — `incr` é atômico
nas duas implementações de `CacheService` (`INCR` no Redis, contador único no `MemoryCache`) e
já renova o TTL. (2) O corpo de um `CONNECTION_UPDATE` não tem id nem timestamp: um `state:
'open'` é byte a byte igual ao `open` anterior. Num flap open → close → open dentro dos 10 min
de TTL, o segundo `open` era descartado como replay e o canal ficava marcado como desconectado
no banco, na tela e no WS até o próximo flap — dano maior que o replay que a guarda evita, ainda
mais porque reaplicar estado de conexão é idempotente.
**Impacto:** `backend/src/controllers/webhook.routes.ts`,
`backend/tests/webhooks/replay-guard.spec.ts`. D-149 continua valendo para todo o resto.
### D-157: `SET LOCAL statement_timeout` vem ANTES do advisory lock da migração (CRMLAB-38)
**Decisão:** em `migrator.ts`, `setStatementTimeout(tx, NO_STATEMENT_TIMEOUT)` é a primeira
instrução da transação, antes de `pg_advisory_xact_lock`.
**Motivo:** a ESPERA pelo lock também é uma instrução e herdava o `statement_timeout=30s` que o
`PgDriver` fixa na sessão (D-030/CRMLAB-30). O segundo runner abortava com 57014 exatamente
quando a primeira migração demora mais de 30 s — que é o único caso em que o lock (D-147) tem
alguma função. A ordem invertida desarmava a proteção justamente no cenário para o qual foi
escrita.
**Impacto:** `backend/src/db/migrator.ts`. D-147 continua valendo.
### D-158: WebSocket confere a sessao no BANCO no handshake e revalida a cada 5 min (CRMLAB-33)
**Decisão:** `WsHubOptions.validateSession` (ligado em `main.ts` a
`refreshSessionIsLive`) repete no handshake as checagens que `/auth/refresh` faz — linha em
`refresh_tokens`, `revoked_at`, expiração, `user.is_active`, `tenant.is_active` — sem rotacionar
nada e sem derrubar família em caso de reuso. Sockets já abertos são reconferidos a cada 10
ciclos de heartbeat (~5 min). Handshake é fail-closed (erro na checagem recusa); socket já
aberto é fail-open (soluço do Postgres não derruba o realtime inteiro).
**Motivo:** achado HIGH da revisão do PR #47. `verifyRefreshToken` prova assinatura e validade,
nada mais — um refresh revogado no logout, já rotacionado, ou de usuário/tenant desativado
abria um WebSocket com realtime completo do tenant por até `JWT_REFRESH_TTL` (7 dias), enquanto
o MESMO token era recusado em `/auth/refresh`. O esquema antigo (`?token=` com access token)
expunha no máximo os 15 min do access: sem esta checagem, o card teria PIORADO a janela que veio
consertar. Não rotacionar aqui é deliberado — rotacionar brigaria com o refresh do próprio
cliente, e derrubar a família daria a quem capture um token velho um jeito barato de deslogar o
dono.
**Impacto:** `backend/src/lib/ws-hub.ts`, `backend/src/services/auth.service.ts`,
`backend/src/main.ts`. D-151 continua valendo.
### D-159: `Set-Cookie` de expiração no path antigo do refresh, por uma release (CRMLAB-33)
**Decisão:** toda resposta que grava ou limpa `crm_refresh` manda também um `Set-Cookie` de
expiração em `Path=/api/v1/auth` (`LEGACY_REFRESH_COOKIE_PATH`), depois do cookie válido. Sai
quando não houver mais sessão aberta de antes da v1.13.0 — `JWT_REFRESH_TTL` (7 dias) após o
deploy desta onda.
**Motivo:** achado HIGH da revisão dos PRs #47 e #49. Cookie é identificado por (nome, domínio,
PATH): gravar em `/` não substitui o que já está em `/api/v1/auth` (D-142, em produção desde a
v1.12.0) — o usuário fica com os dois, os dois são enviados em `/auth/refresh`, o de path mais
específico vem primeiro (RFC 6265 §5.4) e o `cookie-parser` fica com a primeira ocorrência. A
rota leria eternamente o token VELHO: a primeira renovação o consome e rotaciona, a segunda o
reapresenta já revogado, dispara a detecção de reuso (D-015) e derruba a família — logout
forçado, em loop, de todo mundo que estivesse logado no momento do deploy, por 7 dias. Ordem
(válido primeiro, expiração depois) importa para cliente ingênuo que só olha o nome do cookie.
**Impacto:** `backend/src/lib/cookies.ts`, `backend/src/controllers/auth.routes.ts`. Mesma
correção nos dois cards da onda, arquivo idêntico nos dois.
### D-160: eviction por teto de sockets usa código de close próprio (4409) (CRMLAB-33)
**Decisão:** o socket mais antigo derrubado pelo teto de 5 por usuário é fechado com
`WS_CLOSE_TOO_MANY_SOCKETS` (4409), não `terminate()`; o cliente não reconecta nesse código.
**Motivo:** achado MEDIUM da revisão do PR #47. `terminate()` chega no browser como 1006, que o
cliente lê como queda de rede e reconecta na hora — com 6 abas abertas, cada reconexão
estourava o teto de novo e evictava a próxima mais velha, para sempre, e cada reconexão dispara
`invalidateQueries()` naquela aba. O teto virava um gerador de carga.
**Impacto:** `shared/types/websocket.types.ts`, `backend/src/lib/ws-hub.ts`,
`frontend/src/api/ws.ts`.
### D-161: `Set-Cookie` de expiração no path antigo do refresh, por uma release (CRMLAB-35)
**Decisão:** toda resposta que grava ou limpa `crm_refresh` (login, refresh, logout, troca de
senha) manda também um `Set-Cookie` de expiração em `Path=/api/v1/auth`
(`LEGACY_REFRESH_COOKIE_PATH`), depois do cookie válido. Sai 7 dias
(`JWT_REFRESH_TTL`) após o deploy desta onda.
**Motivo:** achado HIGH da revisão — mesmo achado do PR #47, mesma correção (ver D-159; o
arquivo `lib/cookies.ts` é idêntico nos dois cards). Cookie é identificado por (nome, domínio,
PATH): gravar em `/` não substitui o de `/api/v1/auth` (D-142, em produção desde a v1.12.0). Os
dois chegam em `/auth/refresh`, o mais específico primeiro (RFC 6265 §5.4), o `cookie-parser`
fica com o primeiro, a rota lê o token velho, a segunda renovação o reapresenta revogado e a
detecção de reuso derruba a família — logout forçado de todo mundo, em loop, por 7 dias.
**Impacto:** `backend/src/lib/cookies.ts`, `backend/src/http/refresh-cookie.ts`.
### D-162: bcrypt da troca de senha roda FORA da transação, com compare-and-set (CRMLAB-35)
**Decisão:** `changePassword` lê o usuário, verifica a senha atual e calcula o hash novo fora de
qualquer transação; a transação seguinte só grava, e o `UPDATE` leva o hash antigo no `WHERE`
(compare-and-set). Nenhuma linha afetada = "senha atual incorreta".
**Motivo:** achado MEDIUM da revisão. `verifyPassword` + `hashPassword` (bcryptjs cost 12,
~300 ms cada) dentro da transação seguravam uma conexão do pool `idle in transaction` por
~600 ms; com `DEFAULT_POOL_MAX = 10`, dez trocas simultâneas travavam todas as outras queries do
sistema. `login` já fazia o bcrypt fora de transação por este mesmo motivo. O compare-and-set
fecha a janela entre verificar e gravar que essa mudança abre.
**Impacto:** `backend/src/services/auth.service.ts`,
`backend/src/repositories/user.repository.ts`.
### D-163: replay de token revogado por segurança é auditado, sem derrubar a família (CRMLAB-35)
**Decisão:** quando um refresh com `revoked_reason = 'security'` reaparece, a resposta continua
sendo um 401 comum e a família NÃO é derrubada (D-154), mas é gravada uma entrada de auditoria
`refresh_token_replay_after_security`. A API também recusa `newPassword === currentPassword`,
que antes só a tela barrava.
**Motivo:** achados MEDIUM e LOW da revisão. Não derrubar a família está certo — é o outro
navegador do próprio usuário, não um ataque. Mas ficar em silêncio apaga o sinal exatamente no
caso pós-comprometimento: o usuário troca a senha PORQUE perdeu o dispositivo, e o replay do
ladrão era a única evidência de que o token vazou. Sobre a senha repetida: a API respondia 200,
revogava as outras sessões e escrevia auditoria sem nada ter rotacionado.
**Impacto:** `backend/src/services/auth.service.ts`,
`backend/tests/auth/change-password.spec.ts`.
### D-164: `absolute_expires_at` ganha `DEFAULT` antes do `NOT NULL` (CRMLAB-35)
**Decisão:** a migração 022 define `DEFAULT NOW() + INTERVAL '30 days'` na coluna antes do
`SET NOT NULL`, e o índice `idx_refresh_tokens_absolute_expires_at` não é criado.
**Motivo:** achados MEDIUM e LOW da revisão. Sem `DEFAULT`, o processo ANTIGO ainda atendendo
durante a janela de deploy faz `INSERT` sem a coluna e viola o `NOT NULL` — todo login vira 500
até o container novo assumir. O índice, por outro lado, nunca seria lido: a checagem do teto é
leitura de uma linha por hash e a limpeza filtra `expires_at`/`revoked_at`; índice que ninguém
lê só custa escrita.
**Impacto:** `backend/migrations/022_refresh_tokens_absolute_expiry.sql`.

### D-165: `crm_login` com `BYPASSRLS` — a alternativa não existia (CRMLAB-38)
**Decisão:** `crm_login` é criada (020) e corrigida (023) com `LOGIN NOSUPERUSER BYPASSRLS
NOCREATEDB NOCREATEROLE NOREPLICATION`. A `DATABASE_URL` da pool passa a usá-la; o job `migrate`
segue como a role dona.
**Motivo:** a D-145 criou a role `NOBYPASSRLS`, o que parecia mais seguro e tornava o card
inútil na prática. Medido no banco de homologação, com dados reais: `SET ROLE crm_login` sem
`app.tenant_id` devolve **0 de 5 usuários e 0 de 3 tenants**. Todo caminho `withoutTenant()` —
login, `/platform/*`, `resolveWebhookTenant`, seeds — retornaria vazio, ou seja, login e webhook
mortos. O cabeçalho de `002_row_level_security.sql` já dizia em texto que esses caminhos só
funcionam porque rodam como a role dona, que burla RLS; o 020 foi escrito sem reler o 002. Com
`BYPASSRLS`, no mesmo banco: caminho sem tenant volta a 5 usuários e 3 tenants, e o caminho com
tenant continua sob RLS (3 de 5 usuários, 1 de 3 tenants), porque `withTenant()` faz
`SET LOCAL ROLE crm_app` (D-002) e `crm_app` não tem `BYPASSRLS`.
**Por que isso ainda vale a pena:** `BYPASSRLS` não muda nada nos caminhos sem tenant — eles já
burlam RLS hoje, por serem a role dona. O que sai é o `SUPERUSER`: DDL, `DROP TABLE`, `COPY`
lendo arquivo do host, leitura de qualquer tabela do cluster, alteração de outras roles. A
alternativa (policies explícitas para os caminhos sem tenant) foi descartada: mais superfície de
erro, e a falha seria silenciosa — uma policy errada devolve zero linha em vez de erro.
**Impacto:** `backend/migrations/020_crm_login_role.sql`,
`backend/migrations/023_crm_login_bypassrls.sql`, `docs/guides/DEPLOYMENT.md`,
`docs/database/SCHEMA.md`. Substitui a parte de `NOBYPASSRLS` da D-145; o resto da D-145 vale.

### D-166: janela de tolerância de 10 s no reuso de refresh token + lock entre abas (CRMLAB-40)
**Decisão:** no backend, um refresh token já rotacionado (`revoked_reason = 'rotated'`)
reapresentado até 10 s depois da rotação devolve `401 REFRESH_TOKEN_INVALID` comum — **sem**
derrubar a família e sem auditoria de roubo (`REFRESH_REUSE_GRACE_MS`). No frontend,
`refreshAccessToken()` roda dentro de `navigator.locks.request('crm-lab:auth-refresh')` quando
o Web Locks API existe, serializando o refresh entre abas do mesmo origin.
**Motivo:** achado das revisões dos PRs #44 e #47 (CRMLAB-40). Desde o CRMLAB-32 o refresh
roda em **toda** carga de página, e o cookie `crm_refresh` é um só para o navegador inteiro:
restaurar uma sessão com duas abas mandava o mesmo cookie duas vezes; a primeira rotacionava, a
segunda apresentava o token recém-revogado, a detecção de reuso (D-015) tratava como roubo,
derrubava a família e deslogava o usuário das duas abas — com um `refresh_token_reuse_detected`
falso na auditoria. `refreshInFlight` deduplicava só dentro de uma aba. O lock resolve a causa
(a segunda aba espera e, quando entra, o cookie já é o novo); a janela no servidor é a rede de
segurança para navegador sem Web Locks e para o 4401 do WebSocket. Um ladrão que reapresenta o
token dentro dos 10 s ganha nada — ele já está revogado.
**Impacto:** `backend/src/services/auth.service.ts`, `frontend/src/api/client.ts`,
`backend/tests/auth/refresh.spec.ts`. D-015 continua valendo fora da janela.

### D-167: `allkeys-lru` no Redis com duas chaves de segurança dentro — risco aceito e datado (CRMLAB-36)
**Decisão:** o Redis segue com `maxmemory-policy allkeys-lru`, agora com `maxmemory 128mb`
(era 200mb) dentro de `mem_limit 256m`. Reavaliar quando houver mais de ~10 tenants.
**Motivo:** a revisão do PR #46 apontou que o contador de lockout do login e o nonce de
anti-replay dos webhooks moram no mesmo Redis que o cache de analytics/catálogo, e a LRU pode
evictá-los sob pressão de memória — o comentário do compose ("nada aqui é fonte da verdade")
era falso para essas duas chaves. As alternativas são piores hoje: `noeviction` transforma
cache cheio em `503` em todo login (o incidente do CRMLAB-34 ao contrário); instância separada
é mais um container numa VPS de 2 vCPU para um cenário teórico com o volume atual. O que dá
para fazer barato é dar folga real: `maxmemory` limita só o dataset — fragmentação, buffers de
cliente e o fork do `BGREWRITEAOF` ficam por cima, e com 200mb num cgroup de 256m o Redis era
morto por OOM **antes** da evicção sequer entrar.
**Impacto:** `docker-compose.prod.yml`. Registrado como dívida técnica com gatilho explícito.

### D-168: rota pública é reconhecida pelo caminho normalizado; lockout de login conta a TENTATIVA antes da senha (CRMLAB-34)
**Decisão:** `isPublicRoute`/`isChannelWebhook` comparam o caminho **normalizado** como o
roteador do Express o vê (`pathOf`: minúsculo, sem barra final, sem barras duplicadas,
percent-decoding resolvido). O lockout de `/auth/login` passa a `INCR` primeiro e comparar
depois — a 6ª tentativa em 15 min é recusada **sem olhar a senha**; acertar zera o contador. A
janela é fixa a partir da 1ª tentativa.
**Motivo:** dois achados da revisão do PR #45. (1) O roteador do Express é case-insensitive e
não-estrito: `/API/V1/AUTH/REFRESH` e `/api/v1/auth/refresh/` caem no handler certo, mas a
comparação crua de `originalUrl` não os reconhecia como rota pública — com o Redis fora do ar
caíam no ramo fail-**open**, sem limite, em vez do fail-closed da D-139. (2) O lockout lia o
contador antes do bcrypt e incrementava depois, só na falha: check-then-act. Uma rajada de 100
tentativas paralelas passava toda pela leitura antes de qualquer incremento — o próprio teste
do PR exigia que 20 senhas erradas paralelas voltassem 401, ou seja, exigia o buraco. Contar a
tentativa não muda nada para quem acerta (o sucesso zera); para quem erra, é o mesmo limite de
5. Janela fixa em vez de renovar o TTL a cada erro é deliberado: renovar deixava um atacante
paciente segurar o lockout da vítima indefinidamente, um palpite a cada 14 min.
**Impacto:** `backend/src/http/middleware/rate-limit.ts`, `backend/src/services/auth.service.ts`,
`backend/src/lib/cache.ts` (throttle de log por escopo; `MemoryCache.incr` lança em chave
não-numérica como o Redis), `docs/api/API_CONTRACTS.md` §Rate Limiting (headers `RateLimit-*`
e janela fixa documentados — estavam fora do contrato, Regra Zero).

### D-169: MIME de mídia comparado normalizado e por categoria; saída rejeita, entrada rebaixa; allow-list vale na leitura (CRMLAB-31)
**Decisão:** `normalizeMediaMimeType` (minúsculo, sem parâmetros, sinônimos resolvidos) antes
de qualquer comparação com a allow-list; o sniff de magic bytes compara **categoria**
(imagem/áudio/PDF/outro), não string. `POST /conversations/:id/attachments` recusa MIME fora da
lista com `400 VALIDATION_ERROR`; webhooks continuam rebaixando para `octet-stream`.
`GET /media/:id` aplica a allow-list ao MIME **gravado**. Entram na lista `image/heic`,
`application/vnd.ms-excel`, `text/csv`. Uma única função `mediaCategoryOf` substitui os cinco
mapeamentos MIME→categoria que existiam.
**Motivo:** revisão do PR #43, dois achados HIGH. `audio/ogg; codecs=opus` é o mimetype
**padrão** do recado de voz do WhatsApp e falhava na comparação exata contra `audio/ogg` — todo
áudio recebido virava `application/octet-stream`, o player sumia e a bolha mostrava "Baixar
anexo (doc)". O `file-type` rotula Opus-em-Ogg com parâmetro e M4A como `audio/x-m4a`, então a
comparação de string do sniff derrubava anexo legítimo também. Na saída, rebaixar em silêncio
fazia o atendente ver 201 e o paciente receber um "documento" no lugar da foto. E a rota de
leitura nunca consultou a allow-list que `media.types.ts` dizia ser "fonte única" para ela —
uma linha gravada antes do CRMLAB-31 com `image/svg+xml` seguia servida `inline` com esse
Content-Type: o vetor de XSS do card, aberto para o dado legado.
**Impacto:** `shared/types/media.types.ts`, `backend/src/services/media.service.ts`,
`backend/src/controllers/media.routes.ts`, `frontend/src/components/conversation/MessageBubble.tsx`
(anexo externo vira link cru — passar `attachmentUrl` absoluto de outro host pelo fetch
autenticado mandava o Bearer para terceiro; PDF/doc baixado só no clique, não na montagem),
`docs/api/API_CONTRACTS.md` §Hardening de mídia.

### D-170: headers de segurança do nginx num `include` compartilhado; `connect-src 'self'` sem `wss:` (CRMLAB-42)
**Decisão:** os 5 headers ficam em `nginx/security-headers.conf`, incluído no `server {}` e em
**toda** location que declara `add_header` próprio (`= /healthz`, `/assets/`, `= /index.html`).
A CSP perde o `wss:` de `connect-src`.
**Motivo:** a D-144 optou por repetir os headers em duas locations e afirmou um invariante de
"3 cópias" que já estava errado no dia em que foi escrito — `location = /healthz` tinha
`add_header` e ficou sem nenhum (CRMLAB-42). Com o `include`, a próxima location que ganhar um
`add_header` precisa de uma linha, e não há invariante para esquecer. Sobre a CSP: `'self'` já
cobre o WebSocket do próprio origin (CSP3); `wss:` sozinho abria a política para **qualquer**
host wss:// — exatamente o canal que um script injetado usaria para exfiltrar, sem gerar
relatório (revisão do PR #44).
**Impacto:** `nginx/security-headers.conf` (novo), `nginx/frontend.conf`, `frontend/Dockerfile`.
Substitui a estratégia de repetição da D-144.

### D-171: nginx re-resolve o backend pelo DNS do Docker (`resolver` + variável no `proxy_pass`) (CRMLAB-43)
**Decisão:** `nginx/frontend.conf` ganha `resolver 127.0.0.11 valid=10s ipv6=off;` no `server`, e
as locations `/api/` e `/ws` passam a usar `set $upstream_x ${API_UPSTREAM}; proxy_pass
$upstream_x$request_uri;`. O `deploy.sh` reinicia o `frontend` quando o compose recriou o
`backend` e não o frontend, e, se o healthcheck falhar, compara o IP do backend com o que
aparece no log do nginx antes de abortar.
**Motivo:** incidente real em produção, 21/09/2026 — ~6 min de `502` em `/api/*`. A troca da
`DATABASE_URL` para `crm_login` (D-165) alterou o env só do `backend`; o compose recriou só ele,
o container novo nasceu em `172.18.0.7` e o nginx do `frontend`, intocado, seguiu batendo em
`172.18.0.5`. `proxy_pass` com **hostname literal** resolve o nome uma única vez, ao carregar a
configuração, e guarda o IP para sempre. Todo deploy anterior mascarou isso porque backend e
frontend sempre subiam juntos (imagem nova nos dois) — qualquer mudança de `.env` que afete só o
backend reproduz.
**Por que `$request_uri` explícito:** é o par obrigatório da variável. Com variável no
`proxy_pass`, o nginx **não** repassa a URI original sozinho — sem ele todo request chegaria no
backend como `/`. Verificado antes de subir, com upstream de teste que ecoa `$request_uri`:
`/api/v1/health`, `/api/v1/conversations?page=2&q=ab%20c` e `/ws` chegam íntegros, com query
string e percent-encoding preservados.
**Prova de que resolve:** upstream trocado de IP com o nginx NO AR, sem restart —
conf antiga: `502` com o IP velho no log (`upstream: "http://172.18.0.4:3000"`), reproduzindo o
incidente; conf nova: `200` em todas as sondagens de 5 em 5 s.
**Por que os dois (resolver E restart):** o `resolver` corrige sozinho, mas deixa uma janela de
até `valid=10s`; o restart do frontend mata a janela e custa ~2 s, só no caso específico. E a
"pista" no erro do healthcheck existe porque o `deploy.sh` **detectou** o problema (CRMLAB-29) e
mesmo assim mandou investigar o backend, que estava vivo — a mensagem escondia a causa.
**Impacto:** `nginx/frontend.conf`, `scripts/deploy.sh`.

### D-172: Recuperação de senha por e-mail — Resend, token SHA-256 de 30 min, sempre 200, revoga tudo (CRMLAB-39)
**Decisão:** `POST /auth/forgot-password` e `POST /auth/reset-password` (novos). Provedor de
e-mail: **Resend** (`RESEND_API_KEY`/`RESEND_FROM_EMAIL`, obrigatórias em produção — mesmo
padrão de `CHANNEL_SECRET_KEY`/`MEDIA_DIR`, D-076/Onda 8). Token de reset: 32 bytes aleatórios,
guardado só como hash SHA-256 (`password_reset_tokens`, migração 024, mesmo desenho de
`refresh_tokens`), validade de 30 min, uso único, um pedido novo invalida qualquer link anterior
ainda não usado. `forgot-password` responde SEMPRE `200` com a mesma mensagem — e-mail
existente ou não — e o envio do e-mail roda fire-and-forget (nunca `await`ado no caminho de
resposta). `reset-password` revoga **todas** as famílias de refresh do usuário (sem "exceto",
ao contrário do CRMLAB-35 — não há sessão atual a preservar). Rate limit de 5/15min por
e-mail+IP em `forgot-password`, mesma janela do lockout de login, fail-closed com Redis fora do
ar (D-139).
**Motivo:** Resend por não haver provedor nenhum configurado ainda e o card exigir uma escolha
para desbloquear — API simples, sem infraestrutura própria de SMTP. SHA-256 (não bcrypt) pelo
mesmo motivo do refresh token (D-refresh-tokens): o token nasce com 256 bits de entropia
gerados pelo servidor, não é senha escolhida por humano — o lookup precisa ser indexado, não
uma varredura. 30 min é o valor que o próprio card (CRMLAB-39, desmembrado do CRMLAB-35) já
pedia como critério de aceite. O "sempre 200" replica o anti-oráculo do `login` (mesmo arquivo,
mesmo comentário de topo) — sem ele, a resposta denunciaria quais e-mails têm conta. Fire-and-
forget no envio existe pelo mesmo motivo: se o `await` do Resend bloqueasse a resposta, o
TEMPO de resposta viraria o oráculo que o corpo da resposta evita (rede real vs. nenhuma
chamada de rede). Revogar tudo em vez de "exceto a atual": quem usa o link de reset por
definição não está autenticado, não há sessão a preservar — ao contrário da troca de senha
logada (D-154).
**Impacto:** `backend/migrations/024_password_reset_tokens.sql` (nova tabela + RLS),
`backend/src/repositories/password-reset-token.repository.ts` (novo),
`backend/src/lib/email.ts` (novo — driver mock quando `RESEND_API_KEY` ausente, mesmo padrão do
`WHATSAPP_API_URL` vazio), `backend/src/services/auth.service.ts` (`forgotPassword`,
`resetPassword`), `backend/src/controllers/auth.routes.ts`, `backend/src/config/env.ts`,
`backend/src/http/middleware/rate-limit.ts` (`/auth/forgot-password` entra na allow-list de
rotas públicas do D-139), `shared/types/{auth,api}.types.ts` (`RESET_TOKEN_INVALID`),
`docs/api/{API_CONTRACTS,API_ERRORS}.md`, `frontend/src/pages/{ForgotPassword,ResetPassword}.tsx`
(novos), `frontend/src/routes/index.tsx`.

### D-173: Mensagem enviada pelo celular entra na conversa; eco do CRM é descartado por `externalId` com espera do envio em voo (CRMLAB-46)
**Decisão:** `MESSAGES_UPSERT` do Evolution com `key.fromMe: true` deixa de ser descartado.
O `key.id` decide o que é:
1. **`key.id` já gravado** (`messages.external_message_id`) → eco do próprio CRM ou reentrega:
   nada é gravado, nada é emitido.
2. **`key.id` desconhecido e a conversa tem envio do CRM EM VOO** — mensagem de atendente,
   com autor (`sender_id` não nulo), `status = 'sent'`, `external_message_id IS NULL`, criada há
   menos de 60 s — → o webhook **espera** (sondagem a cada 250 ms, teto de 8 s) o envio gravar
   o `externalId` e confere de novo. Apareceu → eco, descarta.
3. **Senão** → mensagem digitada no celular: `MessageService.createFromPhone` grava
   `sender_type = 'agent'`, `sender_id = NULL`, `status = 'sent'`, `external_message_id =
   key.id`. Não incrementa `unread_count`, sobe `last_message_at`, emite
   `conversation.new_message`. `senderName` volta **`"Enviada pelo celular"`** (derivado no SQL
   de `agent` + `sender_id NULL` — não há exclusão física de usuário no app).
**Rede de segurança:** se o envio do CRM passar do teto de espera (retry do gateway: até
~31 s em texto, ~46 s em mídia), a cópia do passo 3 chega a ser gravada. Quando o envio então
tenta gravar o mesmo `externalId`, o índice único da 019 recusa; `setStatus` trata isso
**apagando a cópia do celular** (agente sem autor, mesmo `externalId`) e gravando o id na
mensagem do CRM, na mesma transação — e reemite `conversation.new_message` para a tela
refazer a lista. Pior caso: a duplicata pisca; nunca fica.
**Número sem conversa:** cria a conversa (decisão do usuário, opção a) pelo mesmo
`findOrCreateByPhone`, mas **sem nome**: o `pushName` de uma mensagem `fromMe` é o nome do
LABORATÓRIO, não do paciente. Conversa arquivada/fechada recebe a mensagem como qualquer
outra (`findOrCreateByPhone` não reabre nem cria atendimento novo). Grupo (`@g.us`) e `@lid`
sem `remoteJidAlt` continuam descartados. Mídia e legenda: mesmo parser e mesmo
`storeInbound` das recebidas.
**Motivo:** o atendente que responde pelo celular deixava metade da conversa invisível no CRM
— quem olhava achava que o paciente ficou sem resposta. O difícil é o eco: a Evolution devolve
com `fromMe: true` também o que o CRM mandou, e o webhook do eco pode chegar ANTES de
`setStatus(..., 'sent', externalId)` — o id só é conhecido quando o `sendText` responde. O
estado "em voo" já existe no banco (a mensagem é gravada ANTES do envio), então a espera não
precisa de cache nem de tabela nova. Casar por conteúdo foi descartado: falha com mídia
(o eco de uma imagem sem legenda não tem o nome do arquivo que o CRM gravou) e com duas
respostas iguais seguidas. A espera cobre o caso normal sem piscar; a rede de segurança fecha a
janela que sobra, sem depender de timing.
**Impacto:** `backend/src/controllers/webhook.routes.ts` (`inboundPhoneOf` devolve a
direção; `from_me` sai de `DiscardReason`), `backend/src/services/message.service.ts`
(`createFromPhone`, espera injetável), `backend/src/repositories/message.repository.ts`
(`hasPendingOutbound`, `setStatus` com conflito de `externalId`, `sender_name` do celular),
`docs/api/API_CONTRACTS.md` §6.1, `docs/backend/SERVICES.md` §3/§16. Sem migração.

### D-174: Encerrar atendimento substitui Arquivar; paciente que volta a escrever reabre na fila livre (CRMLAB-48)
**Decisão:** a conversa passa a ter **dois** status, `active | closed`. `archived` deixa de
existir: a migração 025 converte as arquivadas em `closed` e troca a coluna por um `CHECK`.
Decisões do PO (24/09/2026):
1. **Quem encerra:** a **dona** da conversa, **gestor** e **admin**. Atendente que não é dona
   (inclusive em conversa da fila livre) → `FORBIDDEN` (403). O 403 não vaza nada: a conversa
   de outra atendente continua respondendo `NOT_FOUND` antes (recorte por papel), então o 403
   só aparece em conversa que o usuário JÁ enxerga. A mesma alçada vale para reativar pelo
   `PATCH { status: 'active' }`.
2. **Encerrar** mantém `assigned_to` (o filtro "Encerradas" mostra quem atendeu), grava a
   mensagem de sistema "Atendimento encerrado por <nome>" e o audit log
   `update_conversation_status`.
3. **Paciente escreve numa conversa `closed`** (`MessageService.createFromPatient`) → a
   conversa volta para `active` **sem dona** (`assigned_to = NULL`, fila "Não atribuídas"),
   com a mensagem de sistema "Atendimento reaberto pelo paciente" ANTES da mensagem dele. A
   reabertura é um `UPDATE ... WHERE status = 'closed'`: duas mensagens simultâneas reabrem uma
   vez só, e a reentrega (mesmo `externalId`) sai pelo dedupe antes de chegar aqui. Audit log
   `update_conversation_status` com `userId = null` (quem reabriu foi o canal).
4. **Atendimento manual** (`POST /conversations`) num telefone cuja conversa está `closed` →
   reabre a conversa **atribuída a quem cadastrou**, qualquer que fosse a dona anterior, com a
   mensagem de sistema "Atendimento reaberto por <nome>". Conversa encerrada não pertence mais
   a ninguém para efeito de bloqueio: o 409 `CONVERSATION_ALREADY_ASSIGNED` continua só para
   conversa `active` de outra atendente.
5. **Mensagem enviada pelo celular do laboratório** (`fromMe`, D-173) **não reabre**: só o
   paciente reabre.
6. O código `CONVERSATION_ARCHIVED` (409 ao enviar mensagem em conversa não ativa) é
   **mantido** — renomear quebraria cliente sem ganho; a mensagem passa a "Atendimento
   encerrado".
**Motivo:** Arquivar e Encerrar eram a mesma coisa para quem atende, e nenhum dos dois voltava
sozinho: o paciente que respondia uma conversa arquivada ficava invisível na fila. Reabrir na
fila livre (e não com a antiga dona) é escolha do PO: quem volta a escrever pode estar num
horário em que a antiga dona não está.
**Impacto:** `shared/types/conversation.types.ts` (enum), `backend/migrations/025_*`,
`conversation.service.ts` (alçada de status, reabertura manual), `message.service.ts`
(`createFromPatient` reabre), `conversation.repository.ts` (`reopenIfClosed`),
`conversation.routes.ts` (zod), `frontend/src/pages/Attendance` ([Encerrar], chip
"Encerradas"), `docs/api/API_CONTRACTS.md` §2, `API_ERRORS.md`, `WORKFLOWS.md` §5,
`SCHEMA.md`, `PAGES.md` §2, `SERVICES.md` §2/§3.

### D-175: "Nova conversa" — `POST /conversations/whatsapp` reaproveita a conversa do número e envia pelo caminho de sempre (CRMLAB-50)
**Decisão:** O botão "+" do topo da lista de conversas (tooltip "Nova conversa", atalho
Ctrl+Alt+N) abre um modal com telefone e primeira mensagem, e chama um endpoint **novo**,
`POST /conversations/whatsapp { phone, content }` → `201 { conversation, message }`.
1. **Endpoint separado de `POST /conversations`.** Aquele é o atendimento manual (`direct`/`web`/
   `sms`, exige nome, não envia nada) e recusa `whatsapp` de propósito; este cria/reaproveita e
   **envia**. Juntar os dois poria um "se canal = whatsapp, envie" dentro de um contrato que hoje
   é só cadastro.
2. **Telefone brasileiro, validado por uma função só** (`normalizeBrazilianPhone` em
   `@crm-lab/shared`, usada pelo zod e pelo formulário): DDD de dois dígitos 1–9 + 9 dígitos
   começando por 9 ou 8 dígitos começando de 2 a 9, com ou sem `55`. Vira E.164 (`+55…`), o
   mesmo formato de `createManual`.
3. **Não duplica:** mesmo `findOrCreateByPhone` do webhook e do atendimento manual — conversa e
   paciente reaproveitados pelos dígitos do telefone. Número novo cria conversa **e paciente sem
   nome**, espelhando o número desconhecido que escreve pela primeira vez sem nome de perfil
   (toda conversa nasce ligada a um paciente desde D-072; "contato sem paciente" não existe).
4. **Dono:** conversa nova nasce **atribuída a quem enviou** (como `createManual`: quem inicia o
   contato é quem atende). Conversa existente segue as regras de `createManual`: fila livre fica
   como está (enviar não assume), encerrada reabre para quem enviou (D-174), ativa de outro
   atendente devolve 409 `CONVERSATION_ALREADY_ASSIGNED` com o nome.
5. **Conversa existente de outro canal** (`direct`/`web`/`sms`) é **promovida a `whatsapp`**
   (audit `update_conversation_channel`). `createFromAgent` só manda para o gateway quando
   `channel = 'whatsapp'`; sem a promoção, a "primeira mensagem de WhatsApp" ficaria só na tela.
6. **Envio pelo `MessageService.createFromAgent`** — nenhum caminho paralelo. Canal fora do ar,
   sem credencial ou desligado: a conversa fica criada, a mensagem fica `failed` (a regra de
   sempre: falha não some da tela) e o 502 `MESSAGE_SEND_FAILED` ganha `conversationId` em
   `details` para a tela abrir a conversa mesmo assim.
**Motivo:** o card pede iniciar conversa com número sem conversa prévia sem criar segundo
cadastro para quem já existe. Reusar `findOrCreateByPhone` + `createFromAgent` mantém uma única
regra de dedupe e uma única regra de envio (retry, eco D-173, `failed`).
**Impacto:** `shared/types/conversation.types.ts` (request/response + `normalizeBrazilianPhone`),
`conversation.routes.ts`, `conversation.service.ts` (`startWhatsApp`),
`conversation.repository.ts` (`setChannel`), `frontend/src/pages/Attendance`
(`ConversationList` + `NewConversationModal`), `frontend/src/api/conversations.ts`,
`API_CONTRACTS.md` §2, `API_ERRORS.md`, `PAGES.md` §2, `SERVICES.md` §2.

### D-176: Dedupe por telefone reconhece o celular brasileiro com e sem o nono dígito (CRMLAB-50)
**Decisão:** `selectByPhone` (o dedupe de `findOrCreateByPhone`, usado pelo webhook, pelo
atendimento manual e pela "Nova conversa") procura a conversa pelos dígitos do telefone **e**
pela variante do celular brasileiro com/sem o nono dígito: `55 DD 9XXXXXXXX` ≡ `55 DD XXXXXXXX`
quando o número local (sem o 9) começa de 6 a 9. O casamento exato vem primeiro; a variante só é
usada quando não há exato.
**Motivo:** o WhatsApp ainda identifica muitos celulares brasileiros pelo JID antigo, de 12
dígitos (`554899991234@s.whatsapp.net`). Com a "Nova conversa", o atendente digita o número
atual de 11 dígitos; quando o paciente respondesse, o webhook não acharia a conversa e criaria
uma **segunda** conversa e um segundo paciente. Fixo começa de 2 a 5, então a regra não junta
fixo com celular.
**Impacto:** `conversation.repository.ts` (`phoneMatchKeys` + `selectByPhone`). Nenhuma
mudança de schema; conversas já duplicadas pelos dois formatos continuam separadas (o exato
tem prioridade).

### D-183: Negrito com asterisco no padrão WhatsApp, só na exibição; prévia da lista fica crua (CRMLAB-51)
**Decisão:**
1. `*texto*` é exibido em negrito na bolha (`MessageBubble`), enviada ou recebida. É só
   exibição: o `content` guardado e enviado ao WhatsApp continua com os asteriscos — o próprio
   WhatsApp formata do lado do paciente. Sem mudança de API, banco ou `shared/`.
2. Regra (`splitBold`, `frontend/src/lib/whatsapp-format.ts`), a do WhatsApp: o `*` de abertura
   não é seguido de espaço, o de fechamento não é precedido de espaço, o trecho não atravessa
   quebra de linha e não contém outro `*`; `**` vazio, asterisco solto e `2 * 3 * 4` não formatam.
   Além disso o `*` precisa estar na **borda da palavra** (não colado a letra/dígito por fora),
   como no WhatsApp: `2*3*4` e `a*b*c` ficam como estão. `_`/`~` por fora não bloqueiam
   (`_*texto*_`, negrito + itálico no WhatsApp, mostra o negrito).
3. Renderiza como nós React (`<strong>` + texto), **nunca** `dangerouslySetInnerHTML` — o React
   escapa o texto do paciente e não há XSS. A bolha continua com `whitespace-pre-wrap` (quebras
   de linha preservadas); hoje ela não gera links, então nada mais muda.
4. Compositor: **Ctrl+B / Cmd+B** envolve a seleção em `*` e mantém o texto selecionado; sem
   seleção insere `**` com o cursor no meio. Espaço nas pontas da seleção (duplo clique no
   Windows pega `palavra `) fica fora dos asteriscos, senão não formataria. Mudança mínima no
   `Composer` (um ramo no `onKeyDown`).
5. **Prévia da última mensagem** na lista (`ConversationItem`) fica **como está**, com os
   asteriscos: é o mais simples (zero mudança) e a prévia é truncada e em `text-caption`, onde
   negrito não ajuda a ler.
6. Itálico (`_`), tachado (`~`) e monoespaçado ficam fora — o card pede só negrito.
**Motivo:** A recepção já escrevia `*Resultado disponível*` pensando no WhatsApp do paciente e via
os asteriscos crus na tela. A regra de borda evita negrito acidental em conta (`2*3*4`).
**Impacto:** `frontend/src/lib/whatsapp-format.ts` (novo), `MessageBubble.tsx`, `Composer.tsx`
(atalho), `docs/frontend/COMPONENTS.md` (MessageBubble e Composer).

### D-177: Importação do catálogo por CSV — admin apenas, pré-visualização sem estado e confirmação tudo-ou-nada; código existente atualiza, célula vazia preserva (CRMLAB-23)
**Decisão:**
1. Dois endpoints com o mesmo corpo (`{ fileName, contentBase64 }`): `POST /exams/import/preview`
   (lê, valida, classifica — não grava nada) e `POST /exams/import` (revalida do zero e grava).
   O servidor **não guarda** o arquivo entre as duas chamadas: o cliente reenvia o mesmo
   arquivo ao confirmar.
2. **Só `admin`** — diferente de `POST/PATCH /exams`, que aceitam gestor. A rota recusa com
   `FORBIDDEN` (`requiredRoles: ["admin"]`) e o service confere de novo.
3. **Tudo ou nada:** qualquer linha com erro → `VALIDATION_ERROR` (`details.reason:
   "invalid_rows"`) e nada é gravado; sem erro, todas as linhas vão num único
   `db.withTenant` (`INSERT ... ON CONFLICT (tenant_id, code) DO UPDATE`, em lotes de 500
   linhas por statement). Falha no meio desfaz tudo.
4. **Código que já existe no laboratório atualiza** o exame (decisão do usuário). `nome` e os
   dois preços são sempre regravados; **célula vazia de coluna opcional preserva** o valor
   atual (`COALESCE`). Import não mexe em `isActive`, TUSS/AMB/material, sinônimos,
   `exam_prices` nem pacotes. Exame novo nasce ativo com `source: "manual"` (o CHECK de
   `source` só aceita `manual | lis`, e `lis` fica para a sincronização com o Bitlab).
5. Audit `import_exam_catalog` (`entityType: "exam_catalog"`, `entityId` = tenant, contadores
   em `newValues`) — um registro por importação, não um por exame.
**Motivo:** O preview sem estado evita tabela/arquivo temporário (e a limpeza deles) e
fecha a corrida "o catálogo mudou entre ver e confirmar": a confirmação reclassifica dentro
da transação. Tudo-ou-nada é o que o admin espera de uma planilha ("subiu ou não subiu"),
sem precisar descobrir quais linhas entraram. Preservar célula vazia protege contra planilha
parcial (só código + preços) apagar descrições e preparos cadastrados — limpar um campo
continua possível pelo modal. Admin apenas porque a operação reescreve o catálogo inteiro de
uma vez e o card pediu assim.
**Impacto:** `shared/types/exam.types.ts` (tipos + constantes), `backend/src/lib/exam-csv.ts`
(novo, parser puro), `exam-catalog.service.ts` (`previewImport`/`confirmImport`),
`exam.repository.ts` (`findExistingCodes`/`upsertImported`), `exam.routes.ts` (2 rotas),
`frontend/src/components/catalog/ExamImportModal.tsx` (novo), `pages/Catalog.tsx`,
`api/exams.ts`; docs `API_CONTRACTS.md` §4, `API_ERRORS.md`, `WORKFLOWS.md` §7.1,
`PAGES.md` §7, `SERVICES.md` §5. Sem migração (a `UNIQUE (tenant_id, code)` já existe).

### D-178: Formato aceito no CSV do catálogo — UTF-8 estrito, `;` ou `,`, preço brasileiro sem adivinhação, limites 2 MiB / 5000 linhas (CRMLAB-23)
**Decisão:**
1. **Encoding:** UTF-8 com ou sem BOM, decodificado com `TextDecoder('utf-8', { fatal: true })`.
   Bytes inválidos → `invalid_encoding` (não há fallback silencioso para Windows-1252: a tela
   orienta a salvar como "CSV UTF-8"). Byte NUL também é `invalid_encoding`: é UTF-8 válido,
   mas denuncia UTF-16 sem BOM/binário e o Postgres recusa `\0` em texto (o preview aprovaria
   e a confirmação daria 500). O modelo baixável sai com BOM, para o Excel abrir os
   acentos certos.
2. **Separador:** detectado no cabeçalho — conta `;` e `,` fora de aspas; o maior vence e
   empate fica com `;` (padrão do Excel pt-BR). Parser RFC 4180 próprio (~60 linhas em
   `lib/exam-csv.ts`): aspas duplas, `""` escapado, quebra de linha dentro de aspas. Aspas
   nunca fechadas → `malformed`. Nenhuma dependência nova: o leitor de CSV do `exceljs` exige o
   separador de antemão (não detecta) e trabalha com stream/arquivo; o parser próprio é
   pequeno, síncrono sobre a string já decodificada e testável sem I/O.
3. **Cabeçalho:** casado sem caixa/acento, pontuação vira `_`; `prazo` é apelido de
   `prazo_horas`. Coluna desconhecida é ignorada; obrigatória ausente (`nome`, `codigo`,
   `preco_convenio`, `preco_particular`) → `missing_column`; repetida → `duplicate_column`.
4. **Preço:** aceita `1.234,56`, `1234,56`, `1234.56`, `1234`, com ou sem `R$`. Com os dois
   separadores, o último é o decimal. Mais de 2 casas decimais é erro — é isso que recusa
   `1.234` (ambíguo) em vez de adivinhar entre 1234 e 1,234. Negativo é erro. Teto
   `9.999.999.999,99` (NUMERIC(12,2)).
5. **Código repetido no arquivo** (comparação exata após `trim`, a mesma da `UNIQUE` do banco)
   → erro em todas as linhas que o repetem, com `column: null`.
6. **Linha:** número da planilha (cabeçalho = 1); registro com quebra de linha entre aspas
   conta como uma linha. Linha totalmente em branco é pulada e não conta.
7. **Limites:** 2 MiB decodificado (`MEDIA_TOO_LARGE`, 413) e 5000 linhas de dado
   (`too_many_rows`); a lista `errors` corta em 1000 (`errorsTruncated`), `errorCount` exato.
   5000 linhas cabe folgado no `statement_timeout` de 30 s porque a gravação vai em
   statements de 500 linhas.
**Motivo:** Planilha brasileira sai do Excel com `;` e vírgula decimal; o sistema tem que
aceitar isso sem o admin mexer em configuração regional. Adivinhar encoding ou preço
ambíguo gravaria dado errado em silêncio no catálogo que precifica orçamento — recusar com
motivo por linha é mais barato que descobrir o preço errado numa proposta. Os limites cobrem
com folga catálogo real de laboratório (centenas a poucos milhares de exames) e mantêm o
preview num payload razoável.
**Impacto:** `backend/src/lib/exam-csv.ts` + `backend/tests/catalog/exam-csv.spec.ts`;
constantes em `shared/types/exam.types.ts`; `API_CONTRACTS.md` §4 (formato do arquivo).

### D-179: Carga das vendas dos dois Supabases — união por `id`, vence o `updated_at` mais recente (CRMLAB-45)
**Decisão:** o script `npm run import:sales-supabase` lê um CSV de `public.vendas` de cada
Supabase (FluxoLab/Vercel e app original/Lovable) e junta as duas bases **por `id`** (o UUID da
venda é preservado no CRM Lab):
1. Cada linha é validada **antes** da junção (UUID, data, valor com até 2 casas, tipo,
   timestamps). Linha inválida — inclusive `valor <= 0`, que o `CHECK (value > 0)` de `sales`
   recusaria — vai para **rejeitadas com motivo** e não participa da junção; nunca é
   descartada em silêncio.
2. Mesmo `id` nas duas bases (ou repetido no mesmo arquivo): vence a versão com o
   **`updated_at` mais recente**. Se o conteúdo de negócio diferir (atendente dobrado, data,
   código, valor, exames, tipo, `created_by`, `created_at`), o `id` entra no relatório de
   **conflitos** com as duas versões. `updated_at` empatado com conteúdo diferente → vence o
   **FluxoLab** (a base mais nova, sucessora do app original) e o conflito é reportado do mesmo
   jeito.
3. **Idempotência contra o destino:** venda que já existe no tenant só é regravada se o
   `updated_at` de origem for **estritamente mais novo** que o gravado. Reexecutar com os
   mesmos CSVs não insere nem altera nada; uma venda editada no CRM depois da carga (o trigger
   põe `updated_at = NOW()`) também não é sobrescrita.
**Motivo:** as duas bases conviveram por um tempo e parte das vendas existe nas duas, às vezes
editada em uma só. `updated_at` é o único sinal de "qual versão é a última" que as duas têm; o
relatório de conflitos deixa a escolha auditável em vez de escondida.
**Impacto:** `backend/src/services/sales-supabase-import.service.ts`,
`backend/src/db/cli/import-sales-supabase.ts`, `docs/guides/MIGRACAO_SANTE.md`. Sem migração.

### D-180: Como a carga de vendas grava — timestamps preservados, atendente sem acento, isolamento (CRMLAB-45)
**Decisão:** detalhes de implementação da carga de D-179:
1. **Atualização = `DELETE` + `INSERT` na mesma transação.** O trigger `trg_sales_updated_at`
   sobrescreve `updated_at` em todo `UPDATE`, e a role `crm_app` (a do `withTenant`) não pode
   desligá-lo. Como nenhuma tabela referencia `sales` (SCHEMA.md §27), apagar e reinserir com o
   mesmo `id` é seguro e preserva `created_at`/`updated_at` da origem. Timestamps de origem
   (`timestamptz`) são gravados convertidos para **UTC** (as colunas são `TIMESTAMP`).
2. **Atendente casado por nome sem acento:** `atendente` (texto) é comparado com
   `attendants.name` do tenant depois de tirar acento, caixa e espaços extras ("José  Silva" =
   "jose silva"). Sem par, o atendente é **criado** (nome com espaços colapsados). É mais
   frouxo que o `folded_name` do banco (que mantém acento, D-111), de propósito: na carga, dois
   cadastros para a mesma pessoa custam mais que o risco de juntar homônimos que só diferem por
   acento. O atendente só é resolvido (e criado) para venda que vai ser **gravada**
   (inserida ou atualizada): venda inalterada mantém o atendente já gravado — assim renomear o
   atendente no CRM não faz a reexecução criar outro — e um atendente criado só para uma venda
   recusada ("id já usado por outro tenant") é desfeito na mesma transação.
3. **`created_by`** fica com o mesmo UUID só se existir um usuário **daquele tenant** com esse
   `id`; senão `NULL` (o login do Supabase não é migrado por este script).
4. **Tudo dentro de `db.withTenant(tenantId)`**, numa transação única. A exceção é resolver
   `--tenant <slug>` para o `id`: uma leitura de `tenants` via `withoutTenant` (quarto caso
   auditado de `DbClient.withoutTenant`, só leitura, CLI de operador); `--tenant <uuid>` nem
   isso usa. Um `id` de venda que já exista **em outro tenant** não é tocado: o `INSERT ... ON
   CONFLICT (id) DO NOTHING` não enxerga nem altera a linha alheia, e a venda vai para
   rejeitadas ("id já usado por outro tenant").
5. **`--dry-run` executa a carga inteira e desfaz no fim** (`ROLLBACK`): o relatório — inclusive
   atendentes que seriam criados e a paridade — é exatamente o da gravação real, sem nada
   persistir.
6. **Paridade sem float:** somas em centavos inteiros (`numeric` → texto → centavos), em 3
   janelas (mês anterior, mês corrente, tudo) e por atendente, comparando a união das origens
   (linhas aceitas) com o que está gravado no tenant.
7. É script de carga pontual (como os seeds), não um service de domínio: ele lê/escreve
   `sales`, `attendants` e lê `users` diretamente, sem passar pelos services donos — a exceção à
   convenção de SERVICES.md vale só para este CLI.
**Motivo:** preservar o histórico da origem (datas de criação/edição entram em relatórios) sem
abrir brecha no isolamento; o ensaio precisa ser idêntico à execução real para a paridade servir
de conferência antes de gravar em produção.
**Impacto:** `backend/src/repositories/sales-import.repository.ts`,
`backend/src/services/sales-supabase-import.service.ts`, `backend/src/db/types.ts` (comentário
do `withoutTenant`), `docs/guides/MIGRACAO_SANTE.md`. Sem migração.

### D-184: Queda do WhatsApp é o WhatsApp removendo o aparelho (401 `device_removed`), não timeout nem OOM; o motivo passa a ser registrado e mostrado (CRMLAB-17)
**Decisão:** não mexer em timeout, keepalive, `mem_limit` nem reconexão automática. A
investigação (somente leitura na VPS em 25/09/2026, logs do Evolution de 20/09 a 25/09)
mostrou:
1. **Não é recurso nem restart.** `crm-lab-prod-evolution-1`: `RestartCount=0`,
   `OOMKilled=false`, ~200 MiB de 768 MiB, nenhum OOM no kernel; o único reinício foi o
   reboot do host em 21/09 18:58 UTC, com o canal já desconectado desde antes. Nenhum
   `timedOut` (408) nem `connectionLost` (428) do Baileys derrubou sessão aberta. O Redis
   que guarda as chaves Signal da sessão (`useMultiFileAuthStatePrisma` com
   `CACHE_REDIS_ENABLED`) tem `evicted_keys: 0`.
2. **As quedas "sozinhas" são o servidor do WhatsApp desvinculando o aparelho:**
   `stream:error code 401` + `conflict type="device_removed"` em 24/09 às 13:23:44 UTC (~5 min
   depois de parear) e às 14:06:14 UTC (~39 min depois de parear, no meio do atendimento).
   Com 401 o Evolution trata como `LOGOUT` e **apaga a sessão** — não existe reconexão
   automática possível, só um QR novo. Reconexão automática no backend não resolveria nada.
3. **Outras duas quedas (22/09 12:14 e 12:15, 24/09 13:16 e 13:18 UTC)** chegaram como
   `close` com `statusReason: 401` **sem** nenhum `stream:error` do WhatsApp antes, ~80 s depois
   de parear e com um QR novo pedido 2–3 s depois — assinatura de logout pedido pela API
   (`POST /settings/channels/whatsapp/disconnect` → `/instance/logout`), não de queda. Conferir
   no `audit_logs` (`disconnect_whatsapp`) antes de concluir; o log do backend daquela hora
   já tinha ido embora com a recriação do container no deploy.
4. **O que muda no código:** o webhook `CONNECTION_UPDATE state: "close"` passa a levar o
   `statusReason` do gateway para o log estruturado (`channel.whatsapp_disconnected` com
   `statusReason` e `requiresNewQr`) e para o evento WS `channel.connection_changed`
   (`requiresNewQr: true` quando o motivo é 401). O toast diz "escaneie o QR de novo" em vez de
   só "desconectado" — a sessão não volta sozinha e quem atende precisa saber disso na hora.
**Motivo:** o card pedia "investigar timeout e estabilizar a sessão"; a evidência aponta para
a política do WhatsApp contra cliente não oficial (o risco que o termo de aceite já descreve,
SECURITY.md), sobre a qual o repositório não tem alavanca. Inventar ajuste de timeout ou
memória mudaria prod sem atacar a causa. O que o repositório pode fazer é não deixar a
próxima queda sem motivo registrado e sem instrução clara na tela.
**Riscos anotados, sem mudança nesta rodada:** (a) as chaves Signal da sessão moram no
Redis com `allkeys-lru` (D-167) — hoje sem pressão, mas uma evicção corromperia a sessão;
`volatile-lru` protegeria as chaves sem TTL; (b) o Evolution loga em nível verboso, com o
conteúdo das mensagens dos pacientes e a apikey da instância no payload de webhook, retido
em até 250 MB de `docker logs`; (c) a imagem `evoapicloud/evolution-api:v2.3.7` é de
12/2025 e está fixada só por tag; versão nova do Baileys é o único ajuste do nosso lado
que conversa com `device_removed`, e a D-083 registra que as seguintes exigem licença.
**Impacto:** `backend/src/controllers/webhook.routes.ts`, `shared/types/websocket.types.ts`,
`frontend/src/api/ws.ts`, `docs/api/API_CONTRACTS.md` (webhook Evolution),
`docs/ARCHITECTURE.md` (eventos WS). Sem migração, sem mudança de compose.

### D-181: Recado de voz gravado no navegador — clique para gravar, clique para parar, 5 min no máximo (CRMLAB-24)
**Decisão:**
1. Botão de microfone no `Composer`, ao lado do anexo e do emoji. **Clique inicia, clique para**
   (decisão do usuário: nada de segurar o botão). Enquanto grava, o compositor mostra
   "Gravando", o tempo decorrido (`m:ss / 5:00`) e os botões **Cancelar** e **Parar**. Parado,
   vira prévia: `<audio controls>` nativo para ouvir, com **Cancelar** e **Enviar**. O texto que
   estava sendo digitado fica guardado e volta quando a gravação termina.
2. Formato: o primeiro que `MediaRecorder.isTypeSupported` aceitar entre
   `audio/ogg;codecs=opus` (Firefox), `audio/webm;codecs=opus` (Chrome/Edge) e `audio/mp4`
   (Safari), a 32 kbps (voz; é a faixa do próprio recado do WhatsApp). Nenhum dos três → aviso de
   navegador sem suporte, sem gravar num formato que o backend recusaria.
3. **Tempo máximo 5 min**, com parada automática e aviso na prévia. Conta de tamanho: 5 min a
   32 kbps ≈ 1,2 MB; mesmo que o navegador ignore o bitrate (Safari/AAC a 256 kbps) são ~9,6 MB,
   abaixo do teto efetivo do anexo — 15 MiB do `MediaService` (`MAX_MEDIA_BYTES`); o nginx
   (`client_max_body_size 25m`, CRMLAB-20) e o `express.json` (25 MB) comportam os ~20 MB do
   base64 desse teto. **Mínimo 1 s**: parar antes disso descarta com o aviso "Áudio curto
   demais", em vez de mandar um recado vazio de 0 s.
4. Sem microfone utilizável a gravação **nunca é um botão que não faz nada**: o clique mostra uma
   mensagem na linha acima do compositor — contexto inseguro (http) → "só funciona em conexão
   segura"; sem `getUserMedia`/`MediaRecorder` → navegador sem suporte; `NotAllowedError` →
   como liberar no cadeado da barra de endereço; `NotFoundError` → nenhum microfone;
   `NotReadableError` → microfone em uso por outro programa.
5. O microfone é **liberado** (`track.stop()` em todas as trilhas) ao parar, cancelar, dar erro
   e desmontar — inclusive quando a permissão chega depois de a pessoa ter cancelado ou trocado de
   conversa. O object URL da prévia é revogado ao enviar, cancelar e desmontar.
6. O `Composer` passa a ser **montado por conversa** (`key={conversation.id}` no
   `ConversationPanel`): trocar de conversa no meio da gravação cancela e solta o microfone, em vez
   de a gravação feita para um paciente ser enviada para o próximo. O rascunho de texto também
   deixa de "vazar" de uma conversa para a outra.
7. Envio pelo **mesmo** caminho do clipe: `POST /conversations/:id/attachments` com o base64 do
   `Blob`, nome `recado-de-voz.<ogg|webm|m4a>`. O botão Enviar trava enquanto a requisição voa
   (sem duplo envio); falhou, a prévia fica para tentar de novo. A conversa de destino é lida
   **no clique**, antes do `FileReader`: trocar de conversa nessa janela mandava o anexo (clipe
   ou recado) para o paciente que estava aberto quando o POST saiu.
**Motivo:** o CRMLAB-2 entregou ouvir o recado do paciente, mas responder em áudio obrigava a
sair para o WhatsApp Web. Clique/clique (e não segurar) é mais confortável para recado longo e
funciona igual com mouse e teclado.
**Impacto:** `frontend/src/components/conversation/` (`useVoiceRecorder.ts` e `VoiceRecorder.tsx`
novos, `Composer.tsx`), `pages/Attendance/` (`index.tsx`, `ConversationPanel.tsx`),
`docs/frontend/COMPONENTS.md` (Composer).

### D-182: Áudio de saída vai como recado de voz (`sendWhatsAppAudio`); `audio/webm` entra na allow-list (CRMLAB-24)
**Decisão:**
1. `EvolutionClient.sendMedia` manda **todo** anexo `audio/*` por
   `POST /message/sendWhatsAppAudio/:instance` (`{ number, audio: <base64> }`) em vez de
   `/message/sendMedia`. Esse endpoint do Evolution converte no próprio gateway (ffmpeg da
   imagem dele) para `ogg/opus` e entrega como recado de voz (PTT) — resolve o `webm` do Chrome
   e o `mp4` do Safari sem conversão e sem dependência nova no nosso backend (o §4.4 da spec da
   Onda 8 pedia exatamente isso: nenhuma linha de conversão aqui). Imagem, PDF e documento
   continuam em `sendMedia`. Vale também para áudio anexado pelo clipe (um `.mp3` chega ao
   paciente como recado de voz): uma regra só, e a bolha do CRM é a mesma nos dois casos.
2. `audio/webm` entra em `ALLOWED_MEDIA_MIME_TYPES`. Sem isso o recado gravado no Chrome era
   `400 VALIDATION_ERROR` (D-169: saída rejeita).
3. Sniff de magic bytes: o `file-type` rotula **qualquer** WebM como `video/webm` e MP4 que não
   seja `M4A ` como `video/mp4` — é o caso do `MediaRecorder` (Chrome e Safari). Declarado
   `audio/webm` com detectado `video/webm`, ou `audio/mp4`/`audio/aac` com detectado
   `video/mp4`, é o **mesmo contêiner**, não troca de categoria, e o declarado é mantido. Sem essa
   regra o recado virava `application/octet-stream`, ia como "documento" e perdia o player. A
   regra não abre nada para HTML/SVG: só vale para esses dois contêineres de mídia.
**Motivo:** o `sendMedia` com `mediatype: audio` repassa o arquivo como está; `webm` não é
formato de áudio do WhatsApp e o paciente no iPhone não conseguiria ouvir. O `sendWhatsAppAudio`
é o caminho documentado do Evolution para recado de voz.
**Pendência:** só um teste com WhatsApp real confirma que o gateway v2.3.7 converte o `webm` do
Chrome e o `mp4` do Safari e que o paciente ouve no Android e no iPhone.
**Impacto:** `backend/src/lib/evolution-client.ts`, `backend/src/services/media.service.ts`
(sniff), `shared/types/media.types.ts` (allow-list), `docs/api/API_CONTRACTS.md` §2d
(attachments e Hardening de mídia).

## 2026-09-25 — Conciliação com o LIS pela API do Bitlab (CRMLAB-52)

### D-119: Conciliação LIS ↔ propostas — nº do orçamento na proposta, requisição fecha como `ganho`
**Decisão:** o vínculo entre uma proposta do CRM e um orçamento do LIS é o **número do orçamento
do LIS** (`lis_budget_number`), digitado pela atendente na proposta. A API do Bitlab não tem campo
livre de referência (confirmado no manual de 25/09/2026), então o vínculo nasce do lado do CRM.
Escrita pelo `PATCH /proposals/:id/lis-reference` (API_CONTRACTS.md §3). Quem pode: a dona da
proposta ou manager+.
1. **Formato do número:** só dígitos, 1 a 20, sem os zeros à esquerda (`"001234"` grava
   `"1234"`). `lis_budgets.number` já chega assim da planilha (célula numérica) e da API
   (`String(ORCAMENTO)`, que é inteiro). A comparação é exata sobre o valor normalizado.
2. **Um orçamento, uma proposta:** o índice único parcial de D-118 recusa um número que outra
   proposta do tenant já usa → `CONFLICT` com `details.reason: "lis_budget_number_taken"`.
   `null` desfaz o vínculo. Em proposta `ganho` → `PROPOSAL_ALREADY_CLOSED` (o vínculo que fechou
   a proposta não pode sumir depois). Em proposta `perdido` é aceito: o número serve para auditar
   o conflito do item 5.
3. **Concilia em dois momentos:** (a) no `PATCH`, contra o `lis_budgets` que já existe. Com a
   sincronização incremental (D-185), um orçamento que não muda mais nunca volta pela API, então
   esperar a próxima carga deixaria sem conciliar a proposta cujo número foi digitado depois;
   (b) no fim de cada chunk de importação ou sincronização, só para os números daquele chunk.
4. **Requisição encontrada** (`lis_budgets.requisition_number` preenchido) numa proposta **não
   terminal** → a proposta vai para `ganho` **em qualquer estágio não terminal**, inclusive
   `novo_contato`, que a matriz manual não deixa ir direto para `ganho`. É a única exceção a
   `ALLOWED_TRANSITIONS`, e só vale pela origem LIS (BUSINESS_RULES.md §3, WORKFLOWS.md §4).
   `ProposalService.markWonFromLis` reaproveita o que `updateStatus` já faz: histórico de
   estágio, mensagem de sistema, invalidação de analytics, audit log `update_proposal_status`
   com `newValues.source: "lis"` e WS `proposal.status_changed`. `changedBy` fica `null`: quem
   fechou foi o LIS, não uma pessoa. Grava `lis_reconciled_at = NOW()`.
   Proposta com aprovação de desconto `pending` também fecha: a alçada era sobre o desconto
   oferecido, e o LIS confirma que o paciente seguiu com o pedido.
5. **`perdido` não reabre.** Requisição num orçamento de proposta `perdido` grava os campos
   `lis_*` e um audit log `lis_reconcile_conflict`, e o status não muda. Reabrir desfaria a
   decisão de uma pessoa com base num dado externo. O gestor decide.
6. **Pagamento só grava valor e data.** `lis_requisition_number`, `lis_paid_value` e
   `lis_paid_on` espelham o orçamento a cada conciliação, qualquer que seja o status. Pagamento
   **sem** requisição não muda status.
7. **Idempotente:** reconciliar o mesmo orçamento duas vezes não gera segundo histórico, segunda
   mensagem nem segundo audit. O `UPDATE ... WHERE status NOT IN ('ganho','perdido')` decide
   quem transiciona, e o `WHERE` dos campos `lis_*` só escreve se algo mudou.
8. `lis_budgets.proposal_id` é gravado junto com o vínculo e zerado quando ele é desfeito.
   **Purge bloqueado** se houver qualquer `lis_budgets.proposal_id` no tenant → `CONFLICT` com
   `details.reason: "lis_budgets_reconciled"`. Limpar a base apagaria o lado B de propostas já
   fechadas.
9. `ImportLisResponse.proposalsWon` e `lis_imports.proposals_won` contam as propostas que aquela
   rodada levou para `ganho`. `FunnelReport` ganha `realized: { wonFromLis, paidCount, paidValue }`
   (API_CONTRACTS.md §5): propostas ganhas pelo LIS por `closedAt` no período, e pagamentos por
   `lis_paid_on` no período (janela de pagamento, BUSINESS_RULES.md §11.7).
**Motivo:** era a decisão 3 do lead no spec da fusão (08/09), nunca escrita aqui. O item 3(a) é
novo: a sincronização por alteração (D-185) tornou obrigatório conciliar também na hora do
`PATCH`.
**Impacto:** `shared/types/proposal.types.ts`, `analytics.types.ts`, `lis.types.ts`;
`proposal.service.ts` (`setLisReference`, `markWonFromLis`), `lis-reconcile.service.ts` (novo),
`lis-import.service.ts` (hook por chunk, purge bloqueado), `analytics.repository.ts`
(`realized`); frontend `ProposalModal.tsx` (campo + selo "Conciliado"), `Analytics.tsx`
(cartão "Receita realizada (LIS)"); API_CONTRACTS §3/§5/§10, SERVICES §4/§19/§25,
BUSINESS_RULES §3, WORKFLOWS §4, PAGES.

### D-185: Orçamentos do LIS entram também pela API do Bitlab, por sincronização incremental agendada
**Decisão:** além da planilha (que continua como plano B), o CRM **puxa** os orçamentos do
Bitlab pela **API de Orçamentos v1** (`POST {BITLAB_API_BASE_URL}/v1/bitlab/orcamentos`, manual
de 25/09/2026, contrato assumido em SERVICES.md §24.1).
1. **Chave por laboratório, cifrada:** `lis_sync_settings.api_key` (SCHEMA.md §31), cifrada em
   repouso pelo mesmo `secret-box` de `tenant_channels` (D-076, chave `CHANNEL_SECRET_KEY`). O
   admin cola a chave em **Configurações → Integração LIS**. A chave nunca volta pela API (sai
   `apiKeyMasked`, D-064), nunca vai para log nem para audit (`"[REDACTED]"`) e nunca chega ao
   frontend. A URL base é da instalação (`BITLAB_API_BASE_URL`, env), não do tenant: o Bitlab é
   um só.
2. **Carga incremental** com `tipoData: "alteracao"`, de `lis_sync_settings.watermark` até
   agora, percorrendo as páginas enquanto `temProxima` (`tamanhoPagina` 500, no máximo 200
   páginas por rodada). A **maior** `marcaDagua` da rodada só é gravada **depois** de todas as
   páginas gravadas com sucesso. Se a rodada falhar no meio, a próxima recomeça da marca antiga,
   e a idempotência do upsert (BUSINESS_RULES.md §11.1) absorve o que for relido. **Primeira
   carga:** sem marca, parte de 90 dias atrás (`LIS_SYNC_INITIAL_DAYS`).
3. **Mesmo caminho da planilha:** cada orçamento da API vira um `LisSpreadsheetRow` (mapeamento
   em BUSINESS_RULES.md §11.10) e passa pelo `consolidateLisRows` e pela resolução de
   convênio/atendente do `LisImportService`, com o mesmo upsert em chunks. Não existe segunda
   implementação da regra. `lis_imports` ganha `kind: 'sync'` (`file_name NULL`).
4. **Uma linha de histórico só quando entra dado:** a rodada que recebe ≥ 1 orçamento grava um
   `lis_imports(kind: 'sync')`, e é dele o `import_id` das linhas. Rodada vazia não polui o
   histórico de importações: só atualiza `last_run_at`/`last_success_at` em `lis_sync_settings`.
   Falha grava `last_error`, e a tela mostra.
5. **Agendamento:** `setInterval` no processo, a cada 30 min (`LIS_SYNC_INTERVAL_MS`), o mesmo
   padrão da limpeza de `refresh_tokens` (D-155), com `.unref()`, best effort e sem derrubar o
   boot. O backend roda numa instância só (VPS única): uma trava em memória por tenant impede
   duas rodadas simultâneas (timer + "Sincronizar agora" → `CONFLICT` com
   `reason: "lis_sync_running"`).
6. **Chave recusada desliga a sincronização:** um `403` do Bitlab grava `last_error` e põe
   `enabled = false`. Isso evita bater 48 vezes por dia com uma chave errada. O admin religa
   depois de corrigir. Timeout, `5xx` e resposta fora do contrato só gravam `last_error`, e a
   próxima rodada tenta de novo.
7. **Campos que NÃO são gravados:** `ID_CPF` e `DT_NASCIMENTO`. É dado pessoal sem uso na
   conciliação, e a retenção de `patient_name` do LIS ainda está em aberto (spec da fusão,
   pendência 4). Também ficam de fora `QTD_EXAMES`, `CONVENIO_REQUISICAO` e `CONTA_NULO`: nada
   no CRM os usa. `CONTA_NULO` é redundante com `REQUISICAO` preenchido.
8. **Fonte instável, validação na borda:** o cliente valida o envelope com zod e lê `sucesso` e
   `status` além do código HTTP. Registra em log `warn` qualquer `avisos[]` não vazio e o header
   `X-API-Deprecation: true`, que é o aviso de mudança prometido pelo Bitlab.
**Motivo:** a planilha exigia que alguém exportasse e subisse o arquivo. Sem isso, o "ganho
automático" de D-119 só acontecia quando alguém lembrava. A API entrega o mesmo dado com
paginação e filtro por alteração, o que resolve o pagamento que chega semanas depois da emissão.
A chave fica por tenant, e não no `.env`, porque o CRM é multi-laboratório e trocar a chave não
pode exigir deploy.
**Impacto:** `backend/migrations/026_lis_sync.sql`, `shared/types/lis.types.ts`,
`backend/src/lib/bitlab-client.ts` (novo), `lis-sync.service.ts` e `lis-sync-settings.repository.ts`
(novos), `lis-import.service.ts` (entrada comum para planilha e API), `main.ts` (agendamento),
`config/env.ts`, frontend `/settings/lis-integration` (novo); API_CONTRACTS §10.3, SERVICES
§24, SCHEMA §25/§31, BUSINESS_RULES §11.10, PAGES §20, SECURITY, ENVIRONMENTS.

### D-186: O agendador da sincronização lista os tenants devidos com `withoutTenant()`, e só isso
**Decisão:** a cada tique, o agendador precisa saber **quais** tenants sincronizar antes de ter
um contexto de tenant, o mesmo problema do login e do webhook. Ele chama
`lisSyncSettingsRepo.listEnabledTenantIds()` dentro de `db.withoutTenant()`, e a consulta devolve
**só `tenant_id`** (`WHERE enabled AND api_key IS NOT NULL`). Toda a rodada de cada tenant (ler
a chave, chamar o Bitlab, gravar) roda dentro de `db.withTenant(tenantId)`, sob RLS, como uma
requisição comum.
**Motivo:** a lista de exceções de SCHEMA.md (RLS) diz que nenhum outro caminho deve usar
`withoutTenant()`. Na prática, o webhook e a limpeza de tokens já usam. Registrar a exceção,
com a projeção mais estreita possível, é melhor que deixá-la implícita. Ler a chave fora do
contexto do tenant daria a um bug no agendador acesso às chaves de todos os laboratórios.
**Impacto:** `lis-sync-settings.repository.ts`, `main.ts`, SCHEMA.md (tabela de exceções).

### D-187: Data e hora do Bitlab viram a forma canônica `YYYY-MM-DD HH:mm:ss` (Brasília) pelos componentes da string
**Decisão:** toda data/hora que chega do Bitlab (`DATA_ORÇAMENTO`, `Data_Pagamento`,
`marcaDagua`) passa por uma função só, `parseBitlabDateTime` (`bitlab-client.ts`), que devolve
`YYYY-MM-DD HH:mm:ss` no relógio de Brasília **pelos componentes da string**, sem `new Date()`
(mesmo princípio de D-110). `issued_on`/`paid_on` são os 10 primeiros caracteres dessa forma.
A `marcaDagua` é gravada já canônica, e é por isso que a comparação "maior marca das páginas"
pode ser feita como texto: nessa forma a ordem léxica é a cronológica. A marca volta ao Bitlab
como `dataInicio` na mesma forma, que é a do pedido documentado no manual.
Formas aceitas: `dd/mm/yyyy hh:mm:ss` (e só `dd/mm/yyyy`, que vira 00:00:00) e o ISO antigo
`YYYY-MM-DDTHH:mm:ss.sssZ`, lido sem conversão de fuso. `marcaDagua` que não é data reconhecível
é resposta fora do contrato (`contract`): gravá-la faria a rodada seguinte partir de lugar nenhum.
**Motivo:** na resposta ao e-mail de integração (25/09/2026), o Bitlab confirmou que o `Z` estava
errado (a hora já era de Brasília) e trocou o formato para `dd/mm/yyyy hh:mm:ss`, sem `Z`. Com o
formato brasileiro, comparar a marca como texto seria errado ("30/09" > "01/10"), e cortar os 10
primeiros caracteres daria `dd/mm/yyyy` em vez de data. Normalizar na borda mantém o resto do
código com uma forma só. O ISO continua aceito porque custa uma alternativa na regex e protege
de uma volta atrás do Bitlab.
**Conferido no primeiro teste real (25/09/2026, a partir da VPS, chave válida):** as datas dos
orçamentos vêm `dd/mm/yyyy hh:mm:ss`; a `marcaDagua` vem **já** em `YYYY-MM-DD HH:mm:ss` (a forma
canônica) e é aceita de volta como `dataInicio`. O filtro compara com `>=`: o último orçamento da
rodada anterior volta na seguinte, o que é inofensivo porque o upsert é idempotente.
**Impacto:** `bitlab-client.ts` (`parseBitlabDateTime`, `bitlabDateToIsoDate`,
`watermarkToBitlabDateTime`), SERVICES.md §24.1, BUSINESS_RULES.md §11.10.

### D-188: Recebido do LIS = soma dos pagamentos ativos, a partir de um extrato por `ID_PAGAMENTO` (CRMLAB-53)
*(Número reservado em 25/09/2026; decisão escrita em 28/09/2026, depois da resposta do Bitlab.)*
**Decisão:**
1. **Extrato de pagamentos:** tabela nova `lis_budget_payments` (migração 032, RLS por tenant),
   uma linha por pagamento: `budget_number`, `requisition_number`, `payment_key`, `source`
   (`api` | `planilha`), `paid_at` (`TIMESTAMP` sem fuso, com segundos, relógio de Brasília,
   D-187), `paid_value`, `status` (`ativo` | `estornado`), `reversed_at`, `payment_method`,
   `card_brand`, `import_id`, `updated_at`. Chave única `(tenant_id, budget_number, payment_key)`.
2. **Chave do pagamento:** na API é o `ID_PAGAMENTO`. Na planilha, que não tem ID nem situação,
   é `planilha:<paid_at>:<valor>`.
3. **Gravação:** `ON CONFLICT ... DO UPDATE` de situação, data do estorno, forma e bandeira. O
   pagamento muda de `ATIVO` para `ESTORNADO` **na mesma linha**; rodar a mesma carga duas vezes
   não muda nada. A linha nunca é apagada pela carga (o LIS não apaga: o mecanismo é o estorno).
   Linha da API sem `ID_PAGAMENTO` (orçamento sem pagamento) não gera extrato.
4. **Valor derivado** em `lis_budgets`, recalculado no mesmo chunk, para os orçamentos do chunk:
   - Se o orçamento tem **algum pagamento da API**: `paid_value = LEAST(SUM(ativos da API),
     requisition_value)`. Os da planilha desse orçamento são ignorados (a API manda, e somar os
     dois contaria o mesmo pagamento duas vezes).
   - Senão, se tem pagamentos **só da planilha**: `LEAST(SUM(todos), requisition_value)` (a
     planilha não diz quem foi estornado; o teto é a proteção).
   - `paid_on` = data do último pagamento considerado, **de qualquer valor** (a régua de fatos da
     D-204 conta pagamento de R$ 0 como pagamento, e isso não muda); nenhum considerado (só
     estornados) → `paid_value = 0`, `paid_on = NULL`.
   - Orçamento **sem nenhuma linha no extrato** (carga anterior ao card) fica como está.
   - `requisition_value` nulo → sem teto.
5. **`consolidateLisRows`** deixa de decidir pagamento: só consolida os campos do orçamento (maior
   total vence, §11.1). O `upsertBudget` deixa de gravar `paid_value`/`paid_on`.
6. **Relatórios:** continuam lendo `lis_budgets.paid_value`/`paid_on`. O `DISTINCT ON
   (requisition_number)` da §11.2 **fica**, porque ele resolve outra coisa: dois orçamentos com a
   mesma requisição.
7. **Estorno depois de `ganho`:** a proposta **não reabre** (D-192 item 2); `lis_paid_value` e
   `lis_paid_on` são atualizados pela conciliação (D-119 item 6), e Resultados/comissão refletem o
   valor novo.
**Motivo:** o Bitlab confirmou em 28/09/2026 que a API devolve um movimento por linha, que linha
zerada, valor repetido e soma acima da requisição são **estornos**, e que a linha estornada continua
saindo. Ele incluiu na v1 `ID_PAGAMENTO`, `SITUACAO_PAGAMENTO` (`ATIVO`/`ESTORNADO`), `DATA_ESTORNO`,
`FORMA_PAGAMENTO` e `BANDEIRA_CARTAO`, que a consulta pela VPS confirmou já estarem em produção
(1.198 pagamentos, `ID_PAGAMENTO` único). Os casos 66760 (528,26), 68905 (783,55), 68785 (837,47) e
66210 (676,24) fecham com a soma dos ativos. A regra antiga ("a última linha sobrescreve") zerava
orçamentos pagos (68281) e deixava R$ 17 mil de fora.
**Impacto:** migração 032; `bitlab-client.ts` (schema e `toLisRow` com os campos novos, `paidAt`
com segundos), `lis-spreadsheet.ts` (`paidAt` com hora; `consolidateLisRows`),
`lis-import.repository.ts` (`upsertPayments`, `recomputePaidValues`), `lis-import.service.ts`;
BUSINESS_RULES §11.1/§11.2/§11.10, SCHEMA §26 + tabela nova, SERVICES §19/§24.1.

### D-189: Releitura diária de 90 dias pega o estorno; a planilha vira plano B, ligada por regra (CRMLAB-53)
**Decisão:**
1. **O estorno não volta na consulta incremental.** A consulta pela VPS (28/09/2026) mostrou que
   `tipoData=alteracao` filtra só por emissão/`Data_Pagamento`: nos 5 estornos testados, a linha
   não voltou na janela da `DATA_ESTORNO`. O maior intervalo observado entre pagamento e estorno
   foi de 15 dias.
2. **Duas marchas na mesma sincronização:**
   - **incremental**, a cada tique (2 min, D-199), como hoje, a partir da `marcaDagua`;
   - **releitura completa**, uma vez por dia, no primeiro tique depois das **03:00 de Brasília**:
     janela dos últimos `LIS_SYNC_INITIAL_DAYS` (90) dias. Grava pelo mesmo `ingestRows`, e os
     estornos corrigem a situação pelo `ID_PAGAMENTO` (D-188 item 3).
   - A releitura **não recua a marca**: a marca gravada é a maior entre a atual e a recebida.
   - Controle em `lis_sync_settings.last_full_scan_on` (`DATE`, Brasília): só é gravado quando a
     releitura termina sem erro; se falhar, o próximo tique tenta de novo.
   - "Sincronizar agora" continua incremental.
3. **Estorno com mais de 90 dias** não é pego. Aceito: o maior intervalo visto foi de 15 dias, e
   o laboratório fecha comissão mensalmente. O pedido ao Bitlab para a `DATA_ESTORNO` contar no
   filtro `alteracao` fica registrado no card; se ele atender, a releitura continua como rede de
   segurança.
4. **Planilha como plano B:** nova seção nas Regras (D-190), `lisSource.spreadsheetImport`
   (`enabled: boolean`), **desligada por padrão**. Desligada: o botão "Importar planilha" some em
   Resultados e `POST /lis-imports` devolve `SPREADSHEET_IMPORT_DISABLED` (mesmo padrão de
   `MANUAL_PROPOSAL_DISABLED`, D-193). Ligada: a importação funciona como hoje, com a regra da
   planilha da D-188 item 4. Limpar a base (`purge`, admin) não depende da flag.
5. **Emenda à D-191:** este padrão **não** reproduz o comportamento anterior (a planilha estava
   sempre disponível). É intencional: o Michel decidiu em 28/09/2026 que a API é a carga principal.
**Motivo:** sem a releitura, um pagamento lido como ativo e estornado depois ficaria ativo para
sempre, e o recebido e a comissão ficariam acima do real. A consulta completa de 01/05 até hoje
tem 4 páginas, então reler 90 dias por dia custa pouco. A planilha não tem situação por pagamento,
então só serve de reserva para o caso de a API ficar fora do ar.
**Impacto:** migração 032 (`last_full_scan_on`); `lis-sync.service.ts` (modo da rodada,
`windowStart`); `shared/types/funnel-rules.types.ts` + `funnel-rules.service.ts` (seção nova);
`lis-import.service.ts` (trava); `errors.ts`/`api.types.ts` (`SPREADSHEET_IMPORT_DISABLED`);
frontend `Settings/Rules.tsx` e `Results.tsx`; SERVICES §24/§26, API_CONTRACTS §6c/§10.1.

## 2026-09-26 — Página de Regras do funil (CRMLAB-56)

### D-190: Regras do funil por laboratório, numa linha JSONB própria, com um ponto único de leitura
**Decisão:** as regras que o laboratório define na página **Configurações → Regras** ficam em
`funnel_rules` (SCHEMA.md §32, migração 027): uma linha por tenant, `rules JSONB` com o objeto
`FunnelRules` inteiro (`shared/types/funnel-rules.types.ts`, API_CONTRACTS.md §6c).
1. **Sem linha = padrões** (`DEFAULT_FUNNEL_RULES`, D-191), sem gravar nada, mesma disciplina de
   D-065. A leitura sempre sobrepõe o que está gravado aos padrões, chave por chave e com
   conferência de tipo: campo novo que um card futuro acrescentar nasce com o padrão em todo
   laboratório, e lixo no JSON cai no padrão em vez de derrubar a tela.
2. **Ponto único de leitura para os outros cards:** `readFunnelRules(tx, tenantId)`
   (`backend/src/services/funnel-rules.service.ts`, também exportado como `funnelRules.get`). Uma
   consulta por chave primária, dentro da transação de quem chama. É daqui que leem
   `ProposalService` (travas e origem, neste card), a proposta do Bitlab (CRMLAB-57), o envio
   (CRMLAB-58), o motor de tempo (CRMLAB-59) e a régua de fatos (CRMLAB-60). Ninguém lê a tabela
   direto.
3. **Quem lê e quem edita:** `GET /settings/funnel-rules` é de todo perfil de laboratório
   (a atendente vê a página, e o front precisa das travas para esconder o que o back recusaria).
   `PATCH` é **manager/admin**.
4. **PATCH parcial em qualquer nível** (`UpdateFunnelRulesRequest`): campo ausente preserva;
   campo desconhecido, tipo errado, prazo fora da faixa ou variável desconhecida no modelo →
   `VALIDATION_ERROR` com `details.fields` pelo caminho (`automation.sentToFollowUp.days`). Listas
   (`roles`) são trocadas inteiras.
5. **Auditoria:** `update_funnel_rules` (`entityType: "funnel_rules"`, `entityId` = tenant), com o
   objeto inteiro antes e depois, só quando algo mudou de fato (diff-then-audit, como a comissão).
6. **Vale dali para frente:** nenhuma regra reprocessa proposta existente. Trava nova vale na
   próxima tentativa de mover; prazo novo vale na próxima rodada do motor (CRMLAB-59).
**Motivo:** o Michel quer "a ferramenta bem ajustável: as regras de negócio o lab define". São ~20
campos em 4 seções, e mais cards vão acrescentar. Uma coluna por campo em `tenant_settings`
exigiria migração a cada regra nova. O JSONB com padrões no código mantém a migração única e o
tipo como contrato.
**Impacto:** `backend/migrations/027_funnel_rules.sql`, `funnel-rules.repository.ts`,
`funnel-rules.service.ts`, `funnel-rules.routes.ts` (novos), `modules.ts`; `shared/types/funnel-rules.types.ts`;
API_CONTRACTS §6c, SCHEMA §32, SERVICES §26, PAGES §21.

### D-191: Os padrões reproduzem o comportamento de hoje; "Criar pelo CRM" nasce ligado
**Decisão:** sem nada gravado, o CRM se comporta **exatamente** como antes do card:
- travas: `skipStages: true` (a matriz `ALLOWED_TRANSITIONS`), `reopenClosed.enabled: false`
  (`ganho`/`perdido` terminais), `requireLossReason: true`, `moveOthersCards: true` (gestor move
  card de qualquer atendente, como hoje);
- origem: `fromBitlab: true` **e** `manualInCrm: true`;
- automação (só guardada, D-190 item 6): Requisição → Negociação ligada; Pagamento → Ganho
  ligada; Orçamento enviado há **3** dias → Follow-up, ligada; Negociação sem pagamento há **7**
  dias → Follow-up, ligada; Follow-up há **15** dias → Perdido ("Silêncio"), **desligada**; alerta
  de "Novo orçamento" parado há **4 h**, ligado; **dias corridos**.
- mensagem de envio: `Olá, {paciente}! Segue o orçamento nº {numero_orcamento} ({convenio}), no
  valor de {valor}.` (o texto que o botão "Enviar orçamento" monta hoje, com as variáveis).
**Motivo:** o card não pode mudar nada até o laboratório editar, e a suíte atual tem que continuar
verde. `manualInCrm` desligado por padrão quebraria o único fluxo de criação que existe hoje (a
proposta do Bitlab chega no CRMLAB-57). **O Michel desliga "Criar proposta manualmente no CRM"
pela página quando quiser só o fluxo Bitlab.** Os prazos são os sugeridos no card; "corridos" é o
mais simples de explicar e de conferir.
**Impacto:** `DEFAULT_FUNNEL_RULES` em `shared/types/funnel-rules.types.ts`.

### D-192: As travas manuais valem no back e no front pela mesma função (`checkTransition`)
**Decisão:** `ALLOWED_TRANSITIONS`/`TERMINAL_STATUSES` deixam de ser a trava final e passam a ser
o **padrão** de uma regra. `checkTransition(rules.manualMoves, from, to, actor)` em
`shared/types/funnel-rules.types.ts` decide toda mudança de estágio **feita por uma pessoa**;
`ProposalService.updateStatus` recusa o que ela recusa, e o front (seletor "Mudar estágio",
botões Ganho/Perdido/Avançar, colunas do kanban) só oferece o que ela aceita (`allowedTargets`).
1. **Pular etapas** (`skipStages`): ligado = `ALLOWED_TRANSITIONS` (inclui `orcamento_enviado →
   negociacao/ganho` e `follow_up → ganho`). Desligado = `SEQUENTIAL_TRANSITIONS`: um passo para a
   frente, um para trás (D-105) e `perdido` de qualquer estágio aberto; `ganho` só a partir de
   `negociacao`.
2. **Reabrir Ganho/Perdido** (`reopenClosed`): desligado = terminais, como antes
   (`PROPOSAL_ALREADY_CLOSED`). Ligado, a proposta fechada volta para `orcamento_enviado`,
   `follow_up` ou `negociacao` (`REOPEN_TARGETS`), limpando `closed_at` e `reason_lost`
   (`sent_at` fica). Quem reabre: os perfis de `roles` (`attendant`/`manager`) e **sempre o
   admin**; perfil fora da lista → `FORBIDDEN` com `details.reason: "reopen_not_allowed"`. **Ganho
   conciliado pelo LIS não reabre** (`lis_reconciled_at` preenchido → `PROPOSAL_ALREADY_CLOSED`
   com `details.reason: "lis_reconciled"`): o LIS diz que virou requisição, e reabrir faria a
   próxima conciliação não fechar de novo. Reabrir grava histórico, audit
   `update_proposal_status` e WS como qualquer transição.
3. **Exigir motivo no Perdido** (`requireLossReason`): desligado, `perdido` sem `reasonLost` é
   aceito (`reason_lost` fica `NULL`, que o relatório de motivos já agrupa). Motivo enviado
   continua tendo que ser do enum (`INVALID_LOSS_REASON`).
4. **Mover card de outra atendente** (`moveOthersCards`): vale para o **gestor**. Desligado, o
   gestor só muda o estágio dos cards que ele mesmo criou → `FORBIDDEN` com `details.reason:
   "move_others_not_allowed"`. O **admin sempre pode** (é quem corrige). A atendente continua
   vendo só as próprias propostas (D-042); a regra não amplia a visibilidade.
5. **Ordem das recusas:** fechada (`closed`/`reopen_role`) → fora da matriz
   (`INVALID_STATUS_TRANSITION`, `details.allowed` = destinos vigentes) → dono do card → motivo de
   perda → aprovação pendente. A ordem antiga (fechada → matriz → motivo → aprovação) fica igual.
6. **Exceção de sistema:** `markWonFromLis` (D-119) **não** passa pelas travas: o LIS fecha em
   qualquer estágio aberto, com qualquer regra. O mesmo vale para as automações de CRMLAB-59/60,
   que são do sistema, não de uma pessoa.
7. **Arrastar no kanban:** durante o `dragover` só o estágio de origem é legível
   (`StageColumn`); a coluna usa `canTransition` com o ator "dono", e o `drop` confere a regra
   completa (dono incluído) antes de chamar a API. Quem decide continua sendo o back.
**Motivo:** o card pede que as travas "valham de fato" e que front e back não possam divergir,
como já era com a matriz compartilhada. Reabrir para um estágio aberto (e não para o estágio
anterior do histórico) evita depender do histórico e deixa a pessoa escolher onde retomar.
**Impacto:** `shared/types/funnel-rules.types.ts`, `proposal.service.ts` (`updateStatus`),
frontend `ActionsRow.tsx`, `ProposalModal.tsx`, `StageColumn.tsx`, `Proposals.tsx`,
`LostReasonForm.tsx`; BUSINESS_RULES §3, WORKFLOWS §4, API_ERRORS.

### D-193: "Criar proposta manualmente no CRM" desligado some da tela e o back recusa
**Decisão:** `origin.manualInCrm: false` → `POST /proposals` devolve **`MANUAL_PROPOSAL_DISABLED`
(409)**, antes de ler catálogo ou conversa. O front esconde "Novo Orçamento" (Atendimento),
"Novo atendimento" (pipeline, que só existe para levar ao `/budget/new`), a tela `/budget/new`
mostra o aviso em vez do formulário, e a seção **Descontos e aprovação** da página de Regras some.
No modal da proposta, a linha de desconto só aparece quando a proposta tem desconto (> 0): as
propostas manuais antigas continuam mostrando o desconto que tiveram.
1. **Ao menos uma origem ligada:** desligar as duas → `VALIDATION_ERROR` em `origin`.
2. **A alçada não muda de lugar nem de regra.** A seção Descontos e aprovação mostra a regra
   vigente (dentro da alçada aprova sozinha; acima vai para aprovação do gestor) e os limites
   padrão por perfil (`DEFAULT_DISCOUNT_LIMIT`). O limite de cada pessoa continua sendo editado em
   **Usuários & Permissões** (admin), e a página leva para lá.
3. **Proposta do Bitlab não passa por aprovação:** isso depende do campo de origem da proposta,
   que nasce no CRMLAB-57. Aqui fica só o liga/desliga e a visibilidade.
**Motivo:** "a UI esconde, o servidor recusa" (FRONTEND_BACKEND.md §4). Código novo e próprio,
em vez de `FORBIDDEN`, porque não é falta de permissão de quem chama: é o laboratório que
desligou o fluxo, e a tela precisa mostrar isso.
**Impacto:** `proposal.service.ts` (`create`), `api.types.ts`/`errors.ts`/API_ERRORS.md
(`MANUAL_PROPOSAL_DISABLED`), frontend `ConversationPanel`, `Proposals.tsx`, `Budget/New.tsx`,
`ProposalModal.tsx`, `Settings/Rules.tsx`.

### D-194: Modelo da mensagem de envio com variáveis fixas; Comissão passa a morar na página de Regras
**Decisão:**
1. **Mensagem de envio** (`sendMessage.template`, 1..1000 caracteres): as variáveis são
   `{paciente}`, `{numero_orcamento}`, `{valor}` e `{convenio}` (`SEND_MESSAGE_VARIABLES`).
   Qualquer outra `{coisa}` → `VALIDATION_ERROR` em `sendMessage.template`, com as desconhecidas
   listadas. `renderSendMessageTemplate(template, values)` em `shared/` é a função pura que o
   envio (CRMLAB-58) vai usar; os valores entram **já formatados** (`valor` em `R$ 1.234,50`). A
   página mostra a pré-visualização com dados de exemplo pela mesma função. Neste card o botão
   "Enviar orçamento" continua com o texto de hoje: trocar é do CRMLAB-58.
2. **Comissão** vira a seção 6 da página de Regras, com o mesmo formulário, o mesmo endpoint
   (`/settings/commissions`, API_CONTRACTS §6b) e as mesmas permissões: gestor lê, **admin
   edita** (a página de Regras deixa o gestor editar as outras seções, mas não a comissão, que
   continua sendo decisão de admin, D-113). A atendente **não vê** a seção (o `GET` é manager+).
   A rota antiga `/settings/commissions` **redireciona** para `/settings/rules#comissoes`, e o
   item "Comissão" sai do menu. Nenhuma regra de cálculo muda.
**Motivo:** o card pede uma página só para as regras do laboratório, e comissão é uma delas. Não
mexer no endpoint nem na permissão mantém `/sales/summary` e os testes da comissão como estão.
**Impacto:** `shared/types/funnel-rules.types.ts`; frontend `Settings/Rules.tsx` (novo),
`Settings/Commissions.tsx` (vira seção), `route-config.ts`, `routes/index.tsx`; PAGES §19/§21.
### D-195: Proposta de origem `bitlab` — sem conversa, sem itens, total = o do orçamento do Bitlab (CRMLAB-57)
**Decisão:** `proposals` ganha `origin` (`'crm'` | `'bitlab'`, `NOT NULL DEFAULT 'crm'`: toda
proposta existente é `crm`). Na origem `bitlab` a proposta nasce do orçamento do LIS (D-196) e:
1. **`conversation_id` e `created_by` passam a aceitar `NULL`**, e só nessa origem: o CHECK
   `proposals_crm_origin_complete` exige os dois quando `origin = 'crm'`. A API de Orçamentos não
   traz telefone, então não há conversa nem paciente; o vínculo com a conversa é do CRMLAB-58.
2. **Total:** `total_price` espelha `lis_budgets.total_value`. É a exceção declarada à regra §1 de
   BUSINESS_RULES: a proposta `bitlab` **não tem itens** do catálogo, e a fonte da verdade do
   valor é o orçamento do Bitlab. `discount_percent = 0`, `approval_status = 'none'`. A cada
   ingestão do mesmo orçamento a conciliação regrava `total_price` (e `insurance_id`) se
   mudaram, **enquanto a proposta não for terminal**. Guardar o número em `total_price` (e não
   só no JOIN) mantém o funil, o pipeline, a receita e o ranking sem nenhum caso especial.
3. **Nada de dado pessoal novo:** nome do paciente, data do orçamento e atendente do Bitlab vêm
   por JOIN com `lis_budgets` (`patient_name`, `issued_on`, `attendant_name`), nunca copiados.
   Na resposta: `patientName` = `COALESCE(conversa, lis_budgets)`, `lisIssuedOn`,
   `lisAttendantName`. `lisRequisitionNumber` sobe de `ProposalDetail` para `Proposal` (o selo
   "Pré-cadastro feito" do cartão lê a listagem).
4. **Convênio** = `lis_budgets.insurance_id` (o mesmo resolvido pela ingestão, D-114).
5. **Responsável provisório** = o login ligado ao atendente do Bitlab (`lis_budgets.attendant_id
   → attendants.user_id`, só usuário ativo). Sem vínculo, `created_by` fica `NULL`. O dono
   definitivo é quem enviar (CRMLAB-58).
6. **Visibilidade:** proposta `bitlab` **sem responsável** é vista por qualquer pessoa do tenant
   (fila comum de "Novo orçamento"); com responsável, vale D-042 (atendente vê só as suas). Sem
   isso, a atendente que emitiu o orçamento no Bitlab e ainda não tem o login ligado ao nome do
   LIS não veria o próprio cartão.
7. **O que ela não faz:** não edita itens, desconto nem o nº do orçamento (é a identidade dela):
   `PATCH /items`, `/discount` e `/lis-reference` → `PROPOSAL_EDIT_NOT_ALLOWED` com
   `details.reason: "bitlab_origin"`. Não passa por aprovação de desconto. Transição de estágio
   sem conversa não grava mensagem de sistema (não há onde). A ficha do paciente não a mostra
   (não há paciente), e o ranking por atendente ignora as sem responsável.
**Motivo:** o fluxo das atendentes (Epic CRMLAB-55) é criar o orçamento no Bitlab, como sempre, e
conferir no CRM. Um card que exigisse conversa e itens não poderia nascer sozinho. Deixar os
campos nulos só na origem nova, com CHECK, mantém o invariante antigo intacto para `crm`.
**Impacto:** migração `028_bitlab_origin.sql`, `shared/types/proposal.types.ts`,
`proposal.repository.ts`, `proposal.service.ts`, `analytics.repository.ts`,
`lis-reconcile.service.ts`; frontend `ProposalCard`, `ProposalModal`, `ActionsRow`; SCHEMA §5,
API_CONTRACTS §3, BUSINESS_RULES §1/§3, SERVICES §4.

**Emenda (integração CRMLAB-56 × 57, 26/09/2026):** para a trava "mover card de outra atendente" (D-192), cartão sem responsável conta como da fila comum: `isCardOwner(createdBy, userId)` em `shared/` devolve `true` quando `createdBy` é `null`. Sem isso a atendente via o cartão do Bitlab e não conseguia movê-lo (403 `not_owner`). O gate `isBitlabOriginEnabled` passa a ler `origin.fromBitlab` das Regras.

### D-196: Proposta nasce na ingestão do orçamento, só a partir da ativação, sem duplicar (CRMLAB-57)
**Decisão:** no hook por chunk de `LisImportService.ingestRows` (planilha e sincronização),
depois do upsert e **antes** da conciliação, `createBitlabProposals(tx, tenantId, numbers)` cria
uma proposta `bitlab` em `novo_contato` para cada orçamento do chunk **sem proposta vinculada**.
1. **Liga/desliga:** `isBitlabOriginEnabled(tx, tenantId)` (`backend/src/services/bitlab-origin-gate.ts`),
   uma função só. Enquanto a regra "Nascer do orçamento do Bitlab" (CRMLAB-56) não existe, devolve
   `true`; a integração troca o corpo.
2. **Sem avalanche de histórico:** `tenant_settings.bitlab_proposals_since` (`DATE`, dia de
   Brasília). É gravado na **primeira ingestão com a regra ligada** (`COALESCE`: nunca anda
   depois) e só nasce proposta de orçamento com `issued_on >= bitlab_proposals_since`. A migração
   não preenche nada. Orçamento sem data de emissão não nasce. Assim, a primeira carga de 90 dias
   e o dump de produção restaurado na hml (com `lis_budgets` antigos) não viram cartão, e não
   existe backfill. Quando a regra do CRMLAB-56 for ligada pela primeira vez, a marca é a data
   dessa ligação (a primeira ingestão depois dela).
3. **Idempotente e à prova de corrida:** a seleção é "orçamento do chunk sem `proposals` com
   esse `lis_budget_number`", e o INSERT usa `ON CONFLICT (tenant_id, lis_budget_number) WHERE
   lis_budget_number IS NOT NULL DO NOTHING` sobre o índice único parcial de D-118. Reimportar a
   planilha, reler a janela da sincronização ou repetir um chunk não duplica. Planilha e
   sincronização ao mesmo tempo também não: o `pg_advisory_xact_lock` do `proposal_number`
   serializa as duas transações, e a segunda cai no `DO NOTHING`.
4. **Registro:** histórico `novo_contato` com `changedBy: null`; audit `create_proposal` na
   transação do chunk com `userId: null` e `newValues: { origin: "bitlab", lisBudgetNumber,
   totalPrice, status }`. `lis_imports.proposals_created` conta as criadas na rodada.
5. **Tempo real:** WS `proposal.created` (`{ proposalId }`) por proposta, **depois do commit**, e
   invalidação do cache de analytics. O cartão aparece no Kanban sem recarregar.
**Motivo:** o card tem que aparecer sozinho, pelos dois caminhos de entrada, sem inundar o funil
com meses de orçamentos antigos e sem cartão duplicado quando a mesma janela é relida (a
sincronização relê o último orçamento a cada rodada, D-187).
**Impacto:** `028_bitlab_origin.sql`, `bitlab-origin-gate.ts` e `bitlab-proposal.service.ts`
(novos), `lis-import.service.ts`, `shared/types/websocket.types.ts`, `lis.types.ts`; frontend
`api/ws.ts`; SERVICES §19/§26, SCHEMA §5/§16/§25, FRONTEND_BACKEND "Real-time".

### D-197: Exceção à D-119 — orçamento do Bitlab com requisição em "Novo orçamento" não vira `ganho`, ganha o selo "Pré-cadastro feito" (CRMLAB-57)
**Decisão:** na conciliação (D-119 item 4), proposta de origem `bitlab` **em `novo_contato`** com
requisição encontrada **não** vai para `ganho`: só espelha `lis_requisition_number` (e
pagamento), que o cartão mostra como o selo **"Pré-cadastro feito"**. Isso vale também para o
orçamento que já chega com requisição (pré-cadastro): o cartão nasce em "Novo orçamento". Em
qualquer outro estágio, e em toda proposta de origem `crm`, a D-119 continua como está.
**Motivo:** requisição no mesmo dia do orçamento é, no balcão, o pré-cadastro, não o paciente
aceitando uma proposta que o CRM enviou. Fechar como ganho um cartão que ninguém conferiu nem
enviou inflaria a conversão. A régua nova (requisição → negociação, pagamento → ganho) é o
CRMLAB-60.
**Limitação conhecida:** a conciliação só roda quando o orçamento volta numa ingestão ou quando
alguém digita o número. Um cartão com pré-cadastro que depois é enviado (`orcamento_enviado`) só
vai a `ganho` na próxima vez que esse orçamento mudar no Bitlab. Fica para o CRMLAB-60.
**Impacto:** `lis-reconcile.service.ts`, BUSINESS_RULES §3, SERVICES §25, WORKFLOWS §4.

### D-198: Número digitado numa proposta do CRM absorve o cartão automático ainda não enviado (CRMLAB-57)
**Decisão:** em `PATCH /proposals/:id/lis-reference` numa proposta de origem `crm`, se o número
já pertence a uma proposta `bitlab` que está em `novo_contato`, **nunca foi enviada**
(`sent_at IS NULL`) e não tem conversa, o cartão automático é **absorvido**: apagado (`DELETE`,
o histórico e os itens vão em cascata, `lis_budgets.proposal_id` vira `NULL`), com audit
`absorb_bitlab_proposal` no id apagado (`oldValues: { proposalNumber, lisBudgetNumber,
totalPrice }`, `newValues: { absorbedBy }`), e o vínculo passa para a proposta manual, que
concilia na mesma transação. Depois do commit sai `proposal.updated` com o id apagado, para o
Kanban tirar o cartão. Em qualquer outro caso (cartão automático já enviado, em outro estágio ou
número de outra proposta `crm`), continua `CONFLICT` `lis_budget_number_taken`.
**Motivo:** é o mesmo orçamento. A atendente que fez tudo pela conversa, do jeito antigo, não
pode ficar bloqueada por um cartão que o sistema criou sozinho, e deixar os dois produziria dois
cartões para uma venda. O cartão absorvido não tinha nada que a pessoa fez (sem envio, sem
conversa, sem itens), então apagar não perde trabalho; o audit guarda o que ele era.
**Impacto:** `proposal.service.ts` (`setLisReference`), `proposal.repository.ts`,
API_CONTRACTS §3, SERVICES §4.

### D-199: Sincronização a cada 2 minutos, sem sobrepor rodadas e sem log a cada tique vazio (CRMLAB-57)
**Decisão:** o padrão de `LIS_SYNC_INTERVAL_MS` cai de 30 min para **2 min** (`120000`), em
`env.ts`, `.env.example` e `docker-compose.prod.yml`. Isso emenda D-185 item 5. Para aguentar o
ritmo:
1. **Um tique por vez:** além da trava por tenant (D-185 item 5), o agendador ignora o tique
   quando o anterior ainda está rodando (`tickInProgress` no módulo). Uma rodada lenta nunca
   empilha outra.
2. **Log:** rodada **com** orçamentos recebidos continua `info` `lis_sync.completed`. Rodada
   vazia vira `debug`. Com 720 tiques por dia por laboratório, `info` em todos seria ruído.
3. **Chave recusada** continua desligando a sincronização (D-185 item 6). Com 2 min isso passa a
   ser o que evita 720 chamadas por dia com chave errada, em vez de 48.
A carga incremental (D-185 item 2, `dataInicio` = marca d'água) já relê só o que mudou desde a
marca. Uma rodada vazia é uma página com `orcamentos: []`.
**Motivo:** o cartão de "Novo orçamento" tem que aparecer enquanto a atendente ainda está com o
paciente no WhatsApp. 30 min é tarde demais para isso.
**Impacto:** `config/env.ts`, `backend/.env.example`, `docker-compose.prod.yml`,
`lis-sync.service.ts`; DEPLOYMENT.md, ENVIRONMENTS.md, SERVICES §24.

## 2026-09-26 — Enviar orçamento pelo cartão (CRMLAB-58)

### D-200: "Enviar orçamento" do cartão do Bitlab escolhe a conversa, envia e define o dono e o estágio (CRMLAB-58)
**Decisão:** o cartão de origem `bitlab` em `novo_contato` ganha o envio pelo próprio cartão,
`POST /proposals/:id/send` com `{ conversationId, message }` (API_CONTRACTS §3). A atendente
confere os dados do Bitlab, **escolhe** a conversa do paciente (o sistema só sugere, D-203) e
revisa a mensagem montada pelo modelo das Regras (`sendMessage.template` +
`renderSendMessageTemplate`, `valor` em R$, `convenio` = nome do convênio ou "Particular"). O
texto final é o que ela confirmou: o servidor não remonta o modelo.
1. **Só a partir de "Novo orçamento"** e só na origem `bitlab`. Origem `crm` →
   `PROPOSAL_EDIT_NOT_ALLOWED` com `details.reason: "crm_origin"` (a proposta do CRM continua
   com o "Enviar orçamento" de sempre, que muda o estágio e leva à conversa). Outro estágio
   aberto → `INVALID_STATUS_TRANSITION`; fechada → `PROPOSAL_ALREADY_CLOSED`; já enviada
   (já tem conversa vinculada) ou sendo enviada agora → `PROPOSAL_ALREADY_SENT` (409, código novo,
   `details.reason: "sent" | "in_progress"`). A atendente que perdeu a corrida para a colega
   deixa de enxergar o cartão (ele virou da colega, D-042), e mesmo assim recebe
   `PROPOSAL_ALREADY_SENT` `sent`, e não `NOT_FOUND`: ela o via na fila comum um instante antes,
   e o erro não revela nada além disso (achado do teste de concorrência).
2. **Quem envia:** quem vê o cartão (fila comum ou dona) e pode mexer nele pela trava "mover card
   de outra atendente" (`canActOnCard`, a mesma de `checkTransition`): dona ou cartão sem
   responsável, admin sempre, gestor se `moveOthersCards`. Recusa → `FORBIDDEN` com
   `details.reason: "move_others_not_allowed"`.
3. **A conversa** tem que ser uma que quem envia enxerga (atendente: as dela e a fila livre;
   gestor/admin: todas) e estar ativa. De outro tenant ou fora da visibilidade → `NOT_FOUND`;
   encerrada → `CONVERSATION_ARCHIVED`.
4. **O que o envio grava:** `conversation_id` = a conversa escolhida (o paciente vem junto, pelo
   `conversations.patient_id`: a ficha passa a listar a proposta); **`created_by` = quem enviou**
   (o responsável provisório da D-195 item 5 é substituído; é quem enviou que ganha a comissão);
   `sent_at = NOW()`; histórico de estágio com `changedBy` = quem enviou; mensagem de sistema
   "Orçamento #… enviado — R$ …" na conversa; audit `update_proposal_status` com
   `newValues: { status, source: "send", conversationId, createdBy, messageId }` e
   `oldValues: { status, conversationId: null, createdBy }`; WS `proposal.status_changed` depois
   do commit; cache de analytics invalidado.
5. **Estágio de destino** (`bitlabSendTarget` em `shared/`): **sem requisição →
   `orcamento_enviado`**; **com requisição (pré-cadastro, D-197) → `negociacao`**, se a regra
   "Requisição → Negociação" (`automation.requisitionToNegotiation`) estiver ligada; desligada,
   vai para `orcamento_enviado`. `novo_contato → negociacao` não existe na matriz manual: é uma
   **transição de sistema** (como a D-119 fez com `ganho`), que não passa por `checkTransition`
   no destino — só pela trava de dono do item 2. O paciente já fez o pré-cadastro: o orçamento
   enviado nesse caso já está em negociação.
**Motivo:** o fluxo do Epic CRMLAB-55 é o orçamento nascer no Bitlab e a atendente só conferir e
mandar. O vínculo com a conversa é o momento em que o cartão ganha paciente e dona.
**Impacto:** `proposal.service.ts` (`sendFromCard`), `proposal.routes.ts`,
`shared/types/{proposal,funnel-rules,api}.types.ts`, `errors.ts`; frontend `ProposalModal`,
`SendProposalPanel` (novo), `ActionsRow`; API_CONTRACTS §3, API_ERRORS, SERVICES §4, WORKFLOWS §4,
BUSINESS_RULES §3, PAGES §6.

### D-201: Tudo ou nada no envio — reserva do cartão, envio pelo caminho do atendimento, e só então o vínculo (CRMLAB-58)
**Decisão:** o envio acontece em três passos, e o cartão só muda no último:
1. **Reserva** (transação curta, `SELECT … FOR UPDATE` na proposta): todas as checagens da D-200
   e, se passarem, grava `send_claim_id` (UUID novo) e `send_claimed_at = NOW()` (migração 029).
   Duas atendentes ao mesmo tempo: a trava de linha serializa, a segunda vê a reserva viva e
   recebe `PROPOSAL_ALREADY_SENT` `in_progress` **sem mandar nada ao paciente**. Reserva com mais
   de **2 minutos** é considerada abandonada (queda do processo no meio do envio) e pode ser
   retomada; o envio mais lento possível (3 tentativas, teto de 60 s do nginx) cabe folgado.
2. **Envio** fora da transação, por `MessageService.createFromAgent`, o **mesmo** caminho do
   Composer do atendimento: grava a mensagem, emite `conversation.new_message`, respeita o canal
   (WhatsApp sai pelo driver do tenant; `direct`/`web` só grava) e o retry. **Falhou → desfaz a
   reserva e devolve o erro do envio** (`MESSAGE_SEND_FAILED` 502, `CONVERSATION_ARCHIVED`):
   estágio, conversa, dono e `sent_at` ficam como estavam. A mensagem fica na conversa com
   `status: "failed"`, como qualquer envio que falha no atendimento (a atendente vê o que não
   saiu); isso é histórico da conversa, não vínculo.
3. **Vínculo** (transação curta): confere que a reserva ainda é a dela (`send_claim_id`) e grava
   tudo da D-200 item 4 de uma vez, limpando a reserva. Se nesse meio-tempo o estágio mudou por
   outro caminho (a conciliação levou a `ganho`, alguém moveu à mão), o vínculo, o dono e o
   `sent_at` são gravados e o estágio fica como está.
**Por que não enviar dentro da transação:** `db.withTenant` não aninha (o driver de teste tem uma
conexão e serializa as transações, D-008), e o `MessageService` abre as próprias transações;
reproduzir o envio dentro da nossa duplicaria o caminho do atendimento. Além disso, segurar a
trava de linha durante uma chamada de rede de até 60 s travaria a conciliação daquele orçamento.
E enviar dentro da transação não elimina o risco que sobra: o commit ainda pode falhar depois do
WhatsApp aceitar.
**Risco que sobra (declarado):** se o passo 3 falhar depois de o WhatsApp aceitar (banco fora do
ar entre os dois passos), o paciente recebeu a mensagem e o cartão continua em "Novo orçamento",
com a reserva até expirar. É logado como `proposal.send_finalize_failed` com o `messageId`, a
mensagem aparece na conversa e a atendente recebe o erro. Tentar de novo depois de 2 minutos
reenvia a mensagem.
**Impacto:** migração `029_proposal_send_claim.sql`, SCHEMA §5, `proposal.service.ts`,
`proposal.repository.ts`, SERVICES §4.

### D-202: Depois do envio — "Reenviar mensagem", trocar a conversa e editar o responsável (CRMLAB-58)
**Decisão:**
1. **Reenviar mensagem** — `POST /proposals/:id/resend` `{ message }`: cartão `bitlab` já
   vinculado (conversa preenchida) em `orcamento_enviado`, `follow_up` ou `negociacao`. Manda de
   novo pela conversa vinculada, pelo mesmo `createFromAgent`, **sem mudar estágio nem
   `sent_at`**. Quem: a dona, gestor ou admin. Audit `resend_proposal_message`
   (`newValues: { conversationId, messageId }`). Resposta `201` com a `Message`. Falha do canal →
   o erro do envio, nada muda no cartão. Só na origem `bitlab`: a proposta `crm` não mudou (item
   8 do card), e o texto das Regras usa o nº do orçamento do Bitlab.
2. **Trocar a conversa vinculada** — `PATCH /proposals/:id/conversation` `{ conversationId }`:
   cartão `bitlab` já enviado, **não fechado** (`PROPOSAL_ALREADY_CLOSED`). Quem: dona, gestor ou
   admin (atendente que não é dona → `FORBIDDEN`). A conversa nova segue a regra de
   visibilidade da D-200 item 3 (encerrada é aceita: é correção de vínculo, nada é enviado). Não
   manda mensagem. Audit `update_proposal_conversation` (`oldValues/newValues: {
   conversationId }`), WS `proposal.updated`. Mesma conversa → nada gravado.
3. **Responsável** — `PATCH /proposals/:id/responsible` `{ userId }`, qualquer origem. É o
   `created_by`, que decide visibilidade e **comissão**:
   - **gestor/admin**: qualquer usuário **ativo** do laboratório com papel de tenant
     (`attendant`, `manager`, `admin`), em qualquer estágio, inclusive `ganho` (é como se
     corrige a comissão de uma venda atribuída errado);
   - **atendente**: só no cartão **de que ela é dona**, **não fechado**, e só para **outra
     atendente ativa**. Cartão sem responsável não é "dela": quem o assume é o envio. Fora disso
     → `FORBIDDEN` (`details.reason: "not_owner"` / `"closed"`); destino inválido (inativo, outro
     tenant, papel de fora) → `VALIDATION_ERROR` em `userId`.
   Audit `update_proposal_responsible` (`oldValues/newValues: { createdBy }`), WS
   `proposal.updated`, cache de analytics invalidado (ranking e comissão mudam). Mesmo usuário →
   nada gravado.
**Motivo:** o envio é o que fixa dona e conversa, mas quem erra de conversa ou pega o cartão da
colega precisa corrigir sem abrir um card novo. A atendente passar só para outra atendente e só o
que é dela é o recorte mais conservador que ainda resolve "fiquei com o cartão da Ana"; mexer em
venda fechada é do gestor, porque muda comissão paga.
**Impacto:** `proposal.service.ts` (`resendFromCard`, `relinkConversation`, `setResponsible`),
`proposal.routes.ts`, `shared/types/proposal.types.ts`; frontend `ProposalModal`,
`SendProposalPanel`, `ResponsibleField` (novo); API_CONTRACTS §3, SERVICES §4, PAGES §6.

### D-203: Sugestão de conversa por nome — tokens em comum, sem acento e sem caixa, a atendente sempre confirma (CRMLAB-58)
**Decisão:** o painel de envio lista as conversas **ativas** que a pessoa enxerga (o mesmo
`GET /conversations?status=active`, 100 mais recentes, ou o resultado da busca livre por nome ou
telefone, que é a busca do atendimento). Em cima vêm as **sugeridas**: as que têm nota de
semelhança > 0 entre o nome do paciente no Bitlab e o nome do contato/paciente da conversa, da
maior para a menor. A nota é `nameSimilarity(a, b)` em `shared/` (função pura, sem dependência):
1. normaliza (NFD sem diacríticos, minúsculas, só letras e dígitos) e quebra em palavras;
2. descarta partículas (`da`, `de`, `do`, `das`, `dos`, `e`) e palavras de 1 letra;
3. nota = palavras em comum ÷ palavras do nome menor (0 a 1). "MARIA DA SILVA SOUZA" × "Maria
   Souza" = 1; × "Maria Oliveira" = 0,5; × "João" = 0.
Nunca vincula sozinho: a sugestão só ordena e destaca; o botão fica desligado até a atendente
clicar numa conversa.
**Motivo:** o nome do Bitlab (cadastro, caixa alta, completo) e o do WhatsApp (o que o paciente
escreveu no perfil, curto) raramente são iguais, mas quase sempre dividem prenome e um sobrenome.
Palavras em comum explicam-se sozinhas, são determinísticas e testáveis; distância de edição ou
fonética seria dependência nova para ganho pequeno. Fazer no front sobre a lista que a tela já
busca evita um endpoint novo (Regra Zero) e reaproveita o recorte de visibilidade das conversas.
**Limitação:** a sugestão só enxerga as 100 conversas ativas mais recentes (ou o resultado da
busca). O paciente que está sendo atendido agora está nelas; para os outros existe a busca.
**Impacto:** `shared/types/name-similarity.ts` (novo); frontend `SendProposalPanel`; PAGES §6.

### D-204: Régua de fatos do LIS para o cartão do Bitlab — requisição leva a Negociação, pagamento leva a Ganho (CRMLAB-60 parcial; emenda D-119 e D-197)
**Decisão:** na conciliação (D-119 item 4), a proposta de origem **`bitlab`** deixa de ir a
`ganho` pela requisição e passa a seguir as duas regras de automação das Regras (CRMLAB-56). A
origem **`crm` continua exatamente com a D-119** (requisição em qualquer estágio aberto →
`ganho`, sem olhar as Regras).
1. **Pagamento → Ganho** (`automation.paymentToWon`): `lis_budgets.paid_on` preenchido, com
   **qualquer valor**, num cartão `bitlab` em **qualquer estágio não terminal**, inclusive
   `novo_contato` (o paciente pagou no balcão antes de qualquer envio) → `ganho`, com
   `lis_reconciled_at` (selo "Conciliado"; não reabre, D-192 item 2). Desligada: não move.
2. **Requisição → Negociação** (`automation.requisitionToNegotiation`): requisição encontrada
   num cartão `bitlab` em `orcamento_enviado` ou `follow_up` → `negociacao`. Desligada: não
   move. Em `novo_contato` continua só o selo "Pré-cadastro feito" (D-197); em `negociacao`, com
   requisição e sem pagamento, o cartão fica onde está.
3. **Requisição sozinha nunca mais leva um cartão `bitlab` a `ganho`.** Requisição e pagamento
   juntos: vence o pagamento (vai direto a `ganho`).
4. **`perdido` não reabre** (D-119 item 5 continua): o espelho é gravado e o conflito de
   requisição é auditado uma vez (`lis_reconcile_conflict`).
5. **Transição de sistema reaproveitável:** `applySystemTransition(tx, tenantId, proposalId, {
   to, source, systemMessage, lisReconciled? })` em `proposal.service.ts` generaliza o antigo
   `markWonFromLis` (que agora a chama com `to: 'ganho', source: 'lis'`): trava a linha, não
   mexe em proposta fechada nem no mesmo estágio, grava histórico com `changedBy: null`,
   mensagem de sistema **só se houver conversa**, audit `update_proposal_status` com
   `userId: null` e `newValues.source` (`lis` = D-119 da origem `crm`, `lis_payment`,
   `lis_requisition`), tudo na transação de quem chama. Devolve `SystemTransition { proposalId,
   from, to, source }` ou `null`. Depois do commit, `announceSystemTransitions` emite um
   `proposal.status_changed` por transição (com o estágio de destino) e invalida o cache de
   analytics. `ImportLisResponse.proposalsWon` conta só as que foram a `ganho`.
6. **Idempotente** como a D-119 item 7: a segunda conciliação do mesmo orçamento não acha
   transição a fazer (o cartão já está no destino ou fechado).
**Provisória.** O valor pago que a sincronização grava ainda pode ser sobrescrito (é o que o
**CRMLAB-53** corrige, e a sincronização de produção está desligada até lá); por isso esta
decisão olha só a **data** de pagamento e vale "qualquer valor". O **CRMLAB-60 completo** fecha o
resto da régua (o que depende do valor pago e a conciliação que hoje só roda quando o orçamento
volta numa ingestão, D-197 "Limitação conhecida"). Até lá, esta regra é o comportamento.
**Motivo:** no fluxo novo (Epic CRMLAB-55) requisição é o paciente avançando, não fechando: o
dinheiro é que fecha. A D-119 fazia sentido quando a proposta nascia no CRM e o LIS só
confirmava; para o cartão que nasce do Bitlab ela inflava a conversão.
**Impacto:** `proposal.service.ts` (`applySystemTransition`, `announceSystemTransitions`,
`markWonFromLis`), `lis-reconcile.service.ts`, `lis-import.service.ts`; SERVICES §4/§25,
BUSINESS_RULES §3, WORKFLOWS §4.
## 2026-09-26 — Motor de tempo do funil (CRMLAB-59)

### D-205: O motor de tempo é um job periódico que conta o prazo desde a entrada no estágio atual
**Decisão:** `FunnelTimerService` (`backend/src/services/funnel-timer.service.ts`, SERVICES.md
§27) executa as três regras de prazo das Regras (D-190) e o alerta de "Novo orçamento" parado
(D-207). Cada regra só roda se estiver ligada.

| Regra (`automation.*`) | De → para | Quando |
|---|---|---|
| `sentToFollowUp` | `orcamento_enviado` → `follow_up` | há X dias no estágio |
| `negotiationToFollowUp` | `negociacao` → `follow_up` | há Y dias no estágio e `lis_paid_on` nulo |
| `followUpToLost` | `follow_up` → `perdido` (`reasonLost: "silencio"`) | há Z dias no estágio |

1. **Relógio:** conta a partir da **última linha de `proposal_status_history` com o estágio
   atual** da proposta. Toda mudança de estágio (manual, reabertura, LIS, régua de fatos, o
   próprio motor) grava uma linha nova, então o relógio zera sozinho, sem estado extra. Proposta
   sem linha para o estágio atual (não deveria existir, SCHEMA §10) é ignorada.
2. **Dias corridos** (`dayCounting: "calendar"`): o prazo vence quando `agora − entrada ≥ X × 24 h`.
   "X = 3" move no terceiro dia depois da entrada, na mesma hora, e não antes.
3. **Dias úteis** (`"business"`): segunda a sexta no relógio de Brasília. Entrada no fim de
   semana começa a contar na segunda 00:00. Cada dia útil soma 24 h e pula sábado e domingo
   (entrada quinta 10:00 com X = 3 vence terça 10:00). **Feriados ficam fora** (nem nacionais nem
   municipais): não há calendário de feriados no produto. Fuso fixo UTC−3 (`America/Sao_Paulo`,
   sem horário de verão desde 2019), mesma referência do Bitlab (D-187).
4. As funções são puras e ficam em `shared/types/funnel-timer.types.ts` (`timerDeadline`,
   `isDelayElapsed`, `isStaleNewBudget`): o front usa as mesmas para o selo (D-207).
5. **Agendamento:** `setInterval` no `main.ts`, mesmo padrão da sincronização LIS (D-185 item 5,
   D-199): `FUNNEL_TIMER_INTERVAL_MS` (padrão **300000 = 5 min**; **`0` desliga**), `.unref()`,
   best effort. Um tique por vez (`tickInProgress` no módulo): tique lento não empilha o seguinte.
6. **Percorre os laboratórios** com `withoutTenant()` projetando só `tenant_id` (tenants ativos
   com proposta aberta), a mesma exceção de D-186; todo o resto roda em `withTenant()`, sob RLS.
   Um laboratório com erro não para os outros (`warn` `funnel_timer.tenant_failed`).
7. **Lotes:** no máximo 200 cartões por regra, por laboratório, por tique (`FUNNEL_TIMER_BATCH`,
   constante), do mais antigo para o mais novo. O excedente anda nos tiques seguintes.
8. **Idempotente:** cada transição roda na própria transação, com `FOR UPDATE` e a conferência de
   que o estágio e a linha de entrada ainda são os que foram lidos. Dois tiques seguidos fazem uma
   transição só; um cartão que alguém moveu entre a leitura e a escrita não é tocado.
9. **Log:** tique com transição ou alerta → `info` `funnel_timer.completed` (por laboratório,
   com as contagens); tique vazio → `debug` `funnel_timer.tick_empty`.
**Motivo:** o card pede que os cartões parados andem sozinhos pelos prazos que o laboratório
definiu. Contar pelo histórico reaproveita o que toda transição já grava; guardar um "relógio"
separado exigiria zerá-lo em cada caminho de transição (e o próximo caminho novo esqueceria).
**Impacto:** `shared/types/funnel-timer.types.ts` (novo), `funnel-timer.service.ts` (novo),
`main.ts`, `config/env.ts`, `.env.example`, `docker-compose.prod.yml`; SERVICES §27, DEPLOYMENT,
ENVIRONMENTS, SCHEMA (exceções de RLS), BUSINESS_RULES §3, WORKFLOWS §4.

### D-206: Fato vence tempo; o motor respeita a matriz vigente e nunca toca terminal
**Decisão:**
1. **Fato vence tempo.** O motor não move cartão com pagamento (`lis_paid_on` preenchido), em
   nenhuma regra: ele é da régua de fatos (pagamento → ganho, CRMLAB-60/58). Também não move para
   `follow_up`/`perdido` o cartão de `orcamento_enviado` ou `follow_up` que já tem requisição
   (`lis_requisition_number`): o paciente foi ao laboratório, e perseguir ou perder esse cartão
   seria errado. Em `negociacao` a regra é literalmente "sem pagamento", então requisição sem
   pagamento **anda** para `follow_up` no prazo Y. Isso vale com a régua de fatos ligada ou
   desligada: o fato impede o tempo mesmo quando ninguém o transforma em transição.
2. **Ordem com a régua de fatos:** as duas nunca brigam pelo mesmo cartão, porque (a) a régua de
   fatos roda na ingestão/conciliação e o motor no seu tique, cada um na própria transação com
   `FOR UPDATE`; (b) o motor confere de novo, sob a trava, o estágio, a linha de entrada e os
   campos `lis_*`. Se a régua de fatos mudou o cartão antes, o motor não encontra mais a condição
   e não faz nada; se o motor moveu antes, a régua de fatos age sobre o estágio novo (que é aberto)
   normalmente. Ordem declarada: **fatos primeiro, tempo depois**.
3. **Matriz vigente:** o passo do motor tem que estar em
   `buildAllowedTransitions(rules.manualMoves)[de]`. Se a matriz configurada não tiver o passo, a
   regra não roda naquele tique (`debug` `funnel_timer.step_not_allowed`). Com as duas matrizes de
   hoje (`ALLOWED_TRANSITIONS` e `SEQUENTIAL_TRANSITIONS`) os três passos existem; a conferência
   protege uma matriz futura. As demais travas manuais (dono do card, motivo obrigatório) não se
   aplicam: quem move é o sistema (D-192 item 6), e o motivo do `perdido` é sempre `silencio`.
4. **Terminais nunca se movem** (`ganho`, `perdido`), com ou sem "Reabrir" ligado.
5. **Aprovação pendente** não é obstáculo: nenhum dos três passos leva a `orcamento_enviado`.
**Motivo:** o card pede "fato vence tempo" e que o motor não brigue com a régua de requisição e
pagamento feita em paralelo. A condição re-conferida sob trava é o que torna a ordem irrelevante
para a consistência.
**Impacto:** `funnel-timer.service.ts`; BUSINESS_RULES §3, WORKFLOWS §4.

### D-207: Alerta de "Novo orçamento" parado — uma vez por entrada, por WS, e selo calculado no front
**Decisão:** com `staleNewBudgetAlert` ligado, cartão em `novo_contato` há N horas ou mais (horas
**corridas**, qualquer `dayCounting`) e sem pagamento gera **um** alerta, **sem mover** o cartão.
1. **Uma vez por entrada na coluna:** a linha de entrada do histórico ganha `stale_alerted_at`
   (migração 030). O motor só alerta linha com `stale_alerted_at` nulo e grava a marca na mesma
   transação. Sair e voltar para "Novo orçamento" cria outra linha, e o alerta pode sair de novo.
   Mudar N depois de alertado não repete o alerta daquela entrada.
2. **Para quem:** o responsável (`created_by`, se ativo); sem responsável (cartão do Bitlab na fila
   comum, D-195) ou com responsável inativo, todos os **gestores e admins ativos** do laboratório.
3. **Como chega:** WS `proposal.stale_alert` (`{ proposalId, hours }`) por `emitToUser`, depois do
   commit. O front mostra um toast de atenção e invalida `['proposals']`. Não existe central de
   notificações persistente no produto (o chat interno é por canal, não por pessoa), então quem
   estava desconectado não recebe o toast.
4. **Selo persistente:** por isso o cartão em "Novo orçamento" mostra **"Parado há N h"** calculado
   no front com `isStaleNewBudget(status, stageEnteredAt, regra, agora)`, a mesma função do motor.
   `Proposal.stageEnteredAt` (novo, opcional) é a entrada no estágio atual, lida do histórico.
   O selo aparece para quem abrir o pipeline, conectado ou não na hora do alerta.
**Motivo:** o card pede o alerta sem repetir a cada tique e sem mexer no cartão. Marcar na linha
de entrada dá o "uma vez por entrada" sem tabela nova e sem precisar zerar nada nos outros caminhos
de transição. Horas corridas porque o alerta é sobre o paciente esperando agora (ver pergunta ao
Michel no relatório do card).
**Impacto:** migração `030_funnel_timer.sql`, `shared/types/websocket.types.ts`,
`proposal.types.ts` (`stageEnteredAt`), `proposal.repository.ts`, `funnel-timer.service.ts`;
frontend `api/ws.ts`, `ProposalCard`, `StageColumn`, `Proposals.tsx`; FRONTEND_BACKEND "Real-time",
API_CONTRACTS §3, PAGES §5.

### D-208: Transição do motor — `changedBy: null`, `automation` no histórico, audit `source: "rule"`
**Decisão:** `applyTimerTransition(tx, input)` (exportada de `funnel-timer.service.ts`) é a
transição de sistema do motor, no molde de `markWonFromLis` (D-119 item 4):
1. `UPDATE proposals` condicionado ao estágio de origem e aos fatos (D-206); `perdido` grava
   `reason_lost = 'silencio'` e `closed_at`.
2. Histórico com `changed_by = NULL` e `automation` preenchido (`{ rule, days, dayCounting }`,
   coluna `JSONB` nova da migração 030). É assim que "movido pela regra" se distingue de uma
   pessoa (`changed_by` preenchido) e do LIS/criação automática (`changed_by` nulo, `automation`
   nulo). A API expõe `history[].automation` (API_CONTRACTS §3).
3. Mensagem de sistema na conversa **só se houver conversa** (cartão do Bitlab sem conversa não
   grava, D-195): `"Proposta #ref movida para Follow-up pela regra: enviado há 3 dias."`.
4. Audit `update_proposal_status`, `userId: null`, `newValues: { status, source: "rule", rule,
   days, dayCounting }` (+ `reasonLost` no `perdido`), na mesma transação.
5. Depois do commit: WS `proposal.status_changed` e invalidação do cache de analytics do tenant.
6. O modal da proposta mostra no histórico **"movido pela regra: Enviado há 3 dias"**
   (`describeStageAutomation` em `shared/`).
**Motivo:** o CRMLAB-58/60 vai generalizar `markWonFromLis` numa transição de sistema. Deixar a do
motor separada, exportada e com o mesmo contrato (transação de quem chama; WS e cache depois do
commit) facilita a unificação na integração.
**Impacto:** migração 030, `proposal.repository.ts` (`insertHistory` aceita `automation` e
`changedAt`; `mapHistory`), `shared/types/proposal.types.ts`; SCHEMA §10, API_CONTRACTS §3,
SERVICES §27; frontend `StageHistory.tsx`.

### D-209: Prazo mudado vale no próximo tique, inclusive para trás; sem marco de ativação
**Decisão:** o motor recalcula o prazo de cada cartão **a cada tique**, com a regra vigente, a
partir da entrada no estágio. Consequências, todas declaradas:
1. **Encurtar o prazo** (ex.: 7 → 3 dias): cartão que já está há 3 dias ou mais anda **no próximo
   tique**. Não há reprocessamento além disso: nada que já foi movido volta, nenhum alerta antigo
   é repetido.
2. **Alongar o prazo:** cartão ainda não movido espera o prazo novo.
3. **Desligar** a regra: para de mover a partir do próximo tique. **Ligar** (inclusive a primeira
   vez, no deploy do card): todo cartão já vencido anda no próximo tique, respeitando o lote de 200
   por regra e laboratório (D-205 item 7).
4. **Trocar corridos ↔ úteis:** idem, recalculado no próximo tique.
5. Não existe "marco de ativação" (como `bitlab_proposals_since`, D-196): o prazo é sobre a
   **idade no estágio**, e é o que o laboratório pediu. Com os padrões (D-191), o primeiro tique
   em produção leva para `follow_up` os cartões em "Orçamento enviado" há 3 dias ou mais e os em
   "Negociação" sem pagamento há 7 dias ou mais; "Follow-up → Perdido" nasce desligada, então
   ninguém é perdido sem o gestor ligar.
**Motivo:** é a regra mais simples de explicar ("o cartão anda quando passa do prazo que está na
tela") e é a que o card descreve. Um marco de ativação esconderia do laboratório cartões que ele
considera parados.
**Impacto:** `funnel-timer.service.ts`; SERVICES §27; relatório do card (pergunta ao Michel sobre o
primeiro tique em produção).

### D-220: Mensagem apagada ou editada pelo remetente é escondida, nunca apagada (CRMLAB-66)
**Decisão (Michel, 28/09/2026):** quando o paciente (ou o celular do laboratório) apaga "para
todos" ou edita uma mensagem no WhatsApp, o CRM **não apaga nada**:
1. **Apagada:** a linha de `messages` e o arquivo de `message_media` continuam como estavam.
   Grava `deleted_at` e `deleted_by` (`patient` | `agent` — o lado de quem mandou a original; no
   WhatsApp só o autor apaga para todos). Nenhum `DELETE` físico.
2. **A API não devolve o conteúdo escondido** para a tela: com `deletedAt` preenchido, `content`
   vem `''`, `attachmentUrl` `null`, `quoted` `null` e `reactions` `[]`. A prévia da lista de
   conversas e a timeline do paciente também mostram `''` para a mensagem apagada. A tela desenha
   "🚫 Mensagem apagada".
3. **Editada:** o texto novo substitui `messages.content` e `edited_at` é gravado; a versão
   ANTERIOR vai para `message_edits` (uma linha por edição, nunca sobrescrita). A tela mostra o
   texto novo + "Editada".
4. **Os dois geram audit log** (`message_deleted_by_sender`, `message_edited_by_sender`,
   `entityType: 'message'`, `userId: null`). O registro **não carrega o texto**: só `externalId`,
   quem, quando e o id da versão guardada. Motivo: a anonimização LGPD (D-063/D-075) reescreve os
   valores do audit log do paciente, mas não o texto das mensagens (limitação declarada); copiar o
   texto para o audit criaria uma terceira cópia fora do alcance dela.
5. **Quem vê o original:** só quem faz auditoria, por consulta ao banco (`messages.content` da
   apagada, `message_edits.previous_content`). Tela de auditoria: fora de escopo. O export LGPD
   (`GET /patients/:id/export`, admin) continua trazendo o conteúdo — é dado do titular e a rota é
   de admin.
6. Mensagem apagada não pode ser citada nem receber reação pelo CRM (`NOT_FOUND`, igual a
   inexistente). Edição de mensagem já apagada é ignorada.
**Motivo:** auditoria. Em laboratório, o que o paciente disse (pedido, reclamação, resultado
enviado) pode precisar ser consultado depois; apagar do banco porque ele apagou no celular
destruiria a prova.
**Impacto:** migração 040; `message.repository.ts` (`toMessage`, `markDeletedByExternalId`,
`applyEdit`); prévia em `conversation.repository.ts` e timeline em `patient.repository.ts`;
webhook Evolution; API_CONTRACTS §2/§2b, SCHEMA §4/§33/§34; MessageBubble.

### D-221: Citação guarda o id externo e o id interno, e resolve na leitura (CRMLAB-66)
**Decisão:**
1. `messages.quoted_external_id` guarda o `stanzaId` que veio do WhatsApp (ou o id externo da
   original, no envio do CRM); `messages.quoted_message_id` guarda a original quando ela já está no
   CRM. A leitura resolve pela id interna e, sem ela, pelo `(tenant, external_message_id)` —
   original que chegou depois da resposta (fora de ordem) aparece sem backfill.
2. Citação só vale **dentro da mesma conversa**. `quotedMessageId` de outra conversa, de outro
   tenant ou de mensagem apagada → `NOT_FOUND` (nunca `FORBIDDEN`, regra 8).
3. `Message.quoted` é um RESUMO (`id`, `senderType`, `senderName`, `preview` de até 160
   caracteres, `messageType`, `deleted`), não a mensagem inteira. Original ausente do CRM (anterior
   à conversa): `id: null`, `preview: ''` — a tela diz "Mensagem original indisponível".
4. Envio: Evolution recebe `quoted: { key: { id, remoteJid, fromMe }, message: { conversation } }`
   em `sendText`/`sendMedia` (o `message` evita depender do cache do gateway); a Cloud API da Meta
   recebe `context.message_id`. Original sem id externo (canal `direct`, envio que falhou): a
   mensagem sai sem citação para o WhatsApp e continua citada no CRM.
5. A leitura do `stanzaId` aceita `data.contextInfo` (o Evolution v2 sobe o `contextInfo` para o
   topo do `data`) e `message.<tipo>.contextInfo` (forma crua do Baileys).
**Motivo:** o `stanzaId` é a única ligação que o WhatsApp manda; guardar só a id interna perderia
a citação de mensagem que ainda não chegou.
**Impacto:** migração 040; `message.repository.ts`, `message.service.ts`, drivers do
`whatsapp.service.ts`, `evolution-client.ts`; API_CONTRACTS §2; MessageBubble, Composer.

### D-222: Reação é uma por LADO (paciente / laboratório), não uma por usuário (CRMLAB-66)
**Decisão:**
1. `message_reactions` tem no máximo **uma linha por `(mensagem, reactor_type)`**, com
   `reactor_type` ∈ `patient` | `agent`. `user_id` diz qual atendente reagiu pelo CRM (informativo;
   `NULL` quando veio do celular do laboratório).
2. Reação nova do mesmo lado **substitui** a anterior; emoji vazio **remove** (a linha sai — reação
   não é conteúdo de mensagem, D-220 não se aplica).
3. Pelo CRM a reação sai para o WhatsApp **antes** de gravar (fila com 3 tentativas); falhou →
   `MESSAGE_SEND_FAILED` e nada gravado. Mensagem sem id externo (canal `direct`) grava só no CRM.
4. O eco `fromMe` da reação feita pelo CRM volta pelo webhook: mesmo emoji preserva o `user_id`
   gravado; emoji diferente (reagiu pelo celular) grava com `user_id` nulo.
5. Barra rápida da tela: 👍 ❤️ 😂 😮 😢 🙏 (`QUICK_REACTIONS` em `shared/`). A API aceita qualquer
   emoji de até 32 bytes.
**Motivo:** para o paciente, o laboratório é UM número. Duas atendentes reagindo com emojis
diferentes apareceriam no celular dele como uma só (a última). Guardar duas linhas faria o CRM
mostrar algo que o paciente não vê.
**Impacto:** migração 040; `message.repository.ts`, `message.service.ts`, rota
`PUT|DELETE /conversations/:id/messages/:messageId/reaction`; API_CONTRACTS §2; MessageBubble.

### D-223: Eventos do webhook do Evolution numa constante única, reaplicados sozinhos (CRMLAB-66)
**Decisão:**
1. `EVOLUTION_WEBHOOK_EVENTS` (`lib/evolution-client.ts`) é a **única** lista de eventos
   assinados: `MESSAGES_UPSERT`, `MESSAGES_EDITED`, `MESSAGES_DELETE`, `CONNECTION_UPDATE`,
   `QRCODE_UPDATED`. Criar instância e `/webhook/set` usam a mesma constante. Card que precisar
   de evento novo (ex.: CRMLAB-67 com `MESSAGES_UPDATE`/`PRESENCE_UPDATE`) só acrescenta aqui.
2. **Instância já criada se corrige sozinha, sem script e sem ninguém entrar na VPS:**
   - **ao subir o backend** (`main.ts` → `syncEvolutionWebhooks`): para cada laboratório com canal
     WhatsApp em `connection_mode = 'qr'`, reenvia `/webhook/set` com a lista vigente.
     Best-effort: instância ausente no gateway é ignorada, erro vira log `warn` e não derruba o
     boot. Todo deploy recria o container, então todo deploy reaplica;
   - **ao conectar** (`connectWhatsAppQr`): `createInstance` já reaplica o webhook quando a
     instância existe (`already in use`).
3. Lida fora do contexto de tenant: só `tenant_id` de `tenant_channels` (mesma exceção de D-205
   item 6); o resto roda por laboratório.
4. WebSocket: `conversation.message_updated { conversationId, messageId }` avisa reação, edição e
   apagamento. Evento separado de `conversation.new_message` de propósito — quem conta mensagem
   nova (aviso, som, badge) não pode disparar por uma reação.
**Motivo:** a lista estava escrita dentro de `webhookBody` e a instância criada antes do deploy
nunca receberia os eventos novos. Reaplicar no boot é idempotente e barato (1 POST por
laboratório conectado).
**Impacto:** `evolution-client.ts`, `channel-settings.service.ts`, `main.ts`; webhook Evolution;
`shared/types/websocket.types.ts`; FRONTEND_BACKEND "Real-time"; API_CONTRACTS §2b; SERVICES §16.

## 2026-09-28 — Aviso de mensagem nova (CRMLAB-72)

### D-240: A notificação do navegador NUNCA mostra o conteúdo da mensagem (CRMLAB-72)
**Decisão:** a `Notification` de mensagem nova leva **só** o nome do paciente no título
(`patientName`; sem nome, o telefone que a fila já mostra) e, no `body`, **"Nova mensagem"** ou
**"N novas mensagens"**. Nunca o texto, nunca a legenda, nunca a mídia (`icon`/`image` não
recebem anexo). **Não existe opção para ligar a prévia**, nem por usuário, nem por laboratório.
O `body` é montado por uma função pura (`alertBody(count)`) que só recebe um número, e um teste
automatizado garante que o `body` não contém `message.content` nem `lastMessagePreview`.
`tag = conversationId`: a notificação nova da mesma conversa substitui a anterior em vez de
empilhar. Clicar traz a aba para a frente (`window.focus()`) e abre a conversa
(`/attendance?conversationId=…`).
**Motivo:** decidido pelo Michel em 28/09/2026. Mensagem de laboratório é dado de saúde
(resultado, exame, sintoma). A notificação aparece na tela bloqueada, na central de
notificações do sistema e para quem passa perto do computador; a LGPD trata dado de saúde como
sensível. Saber *quem* escreveu basta para a atendente decidir voltar à aba.
**Impacto:** `frontend/src/hooks/useNewMessageAlerts.ts` e o spec; PAGES.md §2 ("Aviso de
mensagem nova"). Se um dia pedirem prévia, é decisão nova, não flag.

### D-241: Quem é avisado, onde o aviso vive e de onde sai o contador do título (CRMLAB-72)
**Decisão:**
1. **Quem é avisado = a fila da atendente:** conversa **atribuída a ela** ou **sem dona**
   (`assignedTo === userId || assignedTo === null`) — o mesmo recorte de visibilidade do
   `ConversationRepository.list` para atendente (`c.assigned_to = $me OR c.assigned_to IS NULL`)
   e o mesmo par dos chips "Minhas"/"Não atribuídas". Para **gestor e admin**, que enxergam todas
   as conversas, o aviso usa o **mesmo recorte da fila** (dele + sem dona), não a visibilidade
   total: conversa de outra atendente não toca para ninguém além dela (interpretação mais
   restritiva do card, "Conversa de outra atendente não toca"). A regra mora em uma função só
   (`isInMyQueue`) e é a mesma para aviso e contador.
2. **Só mensagem do paciente avisa.** O sinal é o `unreadCount` da conversa **subir** junto com o
   `lastMessageAt` — e o servidor só incrementa `unread_count` em `createFromPatient`
   (`message.service.ts`). Mensagem de agente (`fromMe`) e evento de sistema não sobem o
   contador, então não avisam, sem campo novo no payload WS (que continua só com ids). Conversa
   que aparece na lista pela primeira vez só avisa se o `lastMessageAt` dela for mais novo que o
   da lista anterior (conversa nova ou reaberta pelo paciente); conversa que chega por
   transferência, com mensagens antigas, não avisa. A primeira carga é linha de base: não avisa.
3. **Conversa aberta:** é a que o Atendimento publica (`useMessageAlertsStore.openConversationId`).
   Abrir a conversa zera o `unreadCount` no servidor (`GET /conversations/:id`), então para ela o
   sinal é o **detalhe**: mensagem `senderType: 'patient'` mais nova que a última vista. Com a aba
   em foco, a conversa aberta não gera nada (nem som).
4. **Foco:** "aba em foco" = `document.visibilityState === 'visible' && document.hasFocus()`.
   Notificação só **sem foco**. Som sem foco, ou com foco quando a mensagem é de **outra** conversa.
5. **Onde vive:** o hook é montado no `AppShell` (todas as telas do laboratório, não só
   `/attendance`), como o WhatsApp Web, que avisa em qualquer lugar enquanto a aba está aberta. O
   Console da Plataforma (`PlatformShell`) não monta. O pedido de permissão **não** sai no
   carregamento: um aviso discreto "Ativar notificações" no topo da fila do Atendimento pede com um
   clique, e some com a permissão concedida, negada, ou com a notificação desligada na preferência.
6. **Contador do título "(N) <título>":** N = conversas da fila (regra do item 1) com
   `unreadCount > 0`, derivado da query `GET /conversations?status=active&scope=all&
   sortBy=unreadCount&order=desc&limit=100` (a chave vem de `queryKeys.conversations`, então o
   mesmo evento WS `conversation.new_message` que invalida a fila invalida esta, e ler uma conversa
   também). É **uma** query a mais por aba, a mesma do aviso: a fila do Atendimento é paginada e
   filtrada por chip (e não existe fora de `/attendance`), então não serve de fonte para um número
   que vale em qualquer tela. Ordenar por não lidas faz os 100 primeiros conterem todas as não lidas
   em qualquer operação realista; acima de 100 conversas não lidas o número satura em 100.
   Zerado, o título volta ao original.
7. **Som:** tom sintético curto gerado por WebAudio (`OscillatorNode`, ~180 ms), sem arquivo de
   terceiros e sem download. Não depende de `media-src` (a CSP em `nginx/security-headers.conf`
   já tem `media-src 'self' blob:` e segue sem mudança).
8. **Preferências** (som, notificação) por navegador, em `localStorage`
   (`crm-lab.alerts.sound`, `crm-lab.alerts.notifications`, padrão ligado), com `try/catch`:
   armazenamento bloqueado só faz a preferência não persistir. Ficam no menu do usuário (rodapé
   da Sidebar).
9. **Permissão negada ou API ausente:** nada quebra; título e som seguem funcionando.
**Motivo:** o card pede que o aviso siga a regra da fila e que agente/`fromMe` não avise; o
`unreadCount` já é exatamente "mensagem de paciente ainda não lida", então reaproveitá-lo evita
um segundo critério no cliente e mudança no contrato WS (que CRMLAB-66 e CRMLAB-71 estão
mexendo em paralelo).
**Limitações declaradas:** (a) várias abas abertas tocam o som em cada uma (a notificação se
sobrepõe pela `tag`); (b) conversa aberta com a aba escondida é marcada lida no servidor pelo
refetch do detalhe, comportamento anterior a este card.
**Impacto:** `frontend/src/hooks/useNewMessageAlerts.ts`, `stores/message-alerts.store.ts`,
`lib/notification-sound.ts`, `pages/Attendance/EnableNotificationsBanner.tsx`,
`pages/Attendance/index.tsx` (publica a conversa aberta, reabre por `?conversationId=` a cada
navegação, banner), `components/layout/{AppShell,InboxLayout,Sidebar}.tsx`; PAGES.md §2,
COMPONENTS.md (`layout/`).

## 2026-09-28 — Leitura da conversa estilo WhatsApp Web (CRMLAB-71)

### D-237: Histórico da conversa paginado por cursor (`before=<messageId>`), com a ordem `(created_at, id)`
**Decisão:** `GET /conversations/:id` aceita `?before=<messageId>`: devolve as `messageLimit`
mensagens **imediatamente anteriores** à mensagem indicada, na ordem `(created_at, id)` — a mesma
do `ORDER BY` de sempre, com o `id` desempatando mensagens do mesmo instante. A resposta ganha
`cursors: { before, after }`:
1. `cursors.before` é o id da mensagem mais antiga da página **quando ainda existe histórico
   anterior**; `null` quando a página chegou ao começo da conversa. É o valor que o cliente manda
   no próximo `before` — fim do histórico é `null`, e o cliente para de pedir.
2. `cursors.after` fica **sempre `null` neste card**. Existe no shape para o CRMLAB-68
   ("carregar ao redor de uma mensagem", `around=<messageId>`), que vai abrir uma janela no meio
   da conversa e precisar do cursor para as mensagens mais novas. `around` e `after` **não** são
   aceitos como parâmetro hoje.
3. `before` e `page` são excludentes: os dois juntos → `VALIDATION_ERROR`. `before` que não é
   mensagem **desta** conversa (outra conversa, outro tenant, id inexistente) → `NOT_FOUND`
   (`resource: "message"`), nunca uma lista vazia que a tela confundiria com "fim do histórico".
4. `page`/`messageLimit` continuam funcionando como antes (compatibilidade: e2e e qualquer
   cliente antigo). Sem `before` e sem `page`, a resposta é a página mais recente — e já traz
   `cursors.before`, então a primeira página é o ponto de partida do cursor.
5. `pagination` continua com os quatro campos (D-070): `total`/`totalPages` são da conversa
   inteira; com `before`, `page` volta `1` — é campo da navegação por página, que o cursor não usa.
6. Sem migração nova: o índice `idx_messages_conversation_created (conversation_id, created_at
   DESC)` da 001 já serve o `WHERE conversation_id = $1 AND (created_at, id) < (...)`. O número 046
   reservado para o card fica sem uso.
**Motivo:** o botão antigo aumentava o `LIMIT` de 50 em 50 e rebuscava a conversa inteira a cada
clique — e passava de 100, o máximo do contrato, na terceira página (400). O cursor vai no fio
como **id da mensagem**, não como o par `createdAt,id` em texto: `created_at` é `TIMESTAMP` com
microssegundos e o `createdAt` do fio é ISO com milissegundos, então um cursor montado pelo cliente
a partir do `createdAt` pularia mensagens gravadas no mesmo milissegundo. Com o id, o par exato é
lido no banco (`SELECT created_at, id FROM messages WHERE id = $2 AND conversation_id = $1`), e o
formato é o mesmo que o `around=<messageId>` do CRMLAB-68 vai usar.
**Impacto:** backend (`conversation.routes.ts`, `message.service.ts`, `message.repository.ts`),
`shared/types/conversation.types.ts` (`GetConversationQuery`, `MessageCursors`,
`GetConversationResponse.cursors`), API_CONTRACTS §2, SERVICES §3.

### D-238: Tela de Atendimento carrega o histórico com `useInfiniteQuery` e rolagem, sem botão
**Decisão:**
1. O detalhe da conversa vira uma `useInfiniteQuery` com a chave
   `[...queryKeys.conversation(id), 'messages']` (continua sob o prefixo que o WS
   `conversation.new_message` invalida). `pageParam` é o `before` (D-237); a primeira página não
   manda cursor; `getNextPageParam` devolve `cursors.before` — "próxima página" é **mais antiga**.
   A tela junta as páginas de trás para frente, cada uma já em ordem crescente.
2. `useMarkAsRead` chama `fetchInfiniteQuery` com as **mesmas** opções: abrir a conversa continua
   sendo um GET só.
3. Invalidação (mensagem nova pelo WS, envio, transferência) refaz **todas** as páginas carregadas,
   em sequência, e o TanStack v5 recalcula cada cursor a partir da página que acabou de voltar —
   não fica buraco entre páginas. Efeito colateral aceito: com várias páginas abertas, cada
   mensagem nova custa uma requisição por página, e a mensagem mais antiga carregada pode sair do
   topo (a janela anda junto com a conversa). A rolagem se ancora numa mensagem visível
   (`data-anchor-id` na linha), então nem o carregamento de cima nem essa saída fazem a tela pular.
4. O botão "Carregar mensagens anteriores" sai. Chegou a menos de 200px do topo e existe
   `cursors.before`, a tela pede a página anterior — **uma de cada vez** (nada sai enquanto a query
   está buscando) e **nenhuma** quando o cursor é `null` (começo da conversa). Enquanto carrega,
   um "Carregando mensagens anteriores…" pequeno sobre o topo da lista — **fora** da área
   rolável, senão o próprio indicador empurraria as mensagens.
5. A âncora nativa do navegador (`overflow-anchor`) fica desligada na lista: a tela faz a
   compensação sozinha, e as duas juntas somariam o deslocamento duas vezes.
**Motivo:** é o comportamento do WhatsApp Web que o card pede, e o cursor evita rebuscar o que já
está na tela. Refazer todas as páginas é o que o TanStack já faz; buscar só o que chegou depois
exigiria o `after` (D-237 item 2), que é escopo do CRMLAB-68.
**Impacto:** `pages/Attendance/{queries.ts,index.tsx,ConversationPanel.tsx,useConversationScroll.ts}`;
PAGES.md §2 e a tabela de chaves do Atendimento.

### D-239: Leitura da conversa — separador de data, faixa de não lidas e botão ↓
**Decisão:**
1. **Separador de data** (`DateSeparator`) entre mensagens de dias diferentes, **no fuso do
   navegador** (o fio é ISO UTC): "Hoje", "Ontem", o dia da semana por extenso ("Segunda-feira")
   de 2 a 6 dias atrás, e `dd/mm/aaaa` a partir de 7 dias (7 dias atrás é o mesmo dia da semana
   de hoje, então o nome seria ambíguo) e para qualquer data futura. A conta é por **dia de
   calendário** local, não por 24h: 23h59 e 00h01 são dias diferentes. A pílula fixa no topo
   durante a rolagem (opcional no card) **não** entrou.
2. **Faixa "N mensagens não lidas"** ("1 mensagem não lida" no singular). N é o `unreadCount` da
   **lista** no momento do clique — o `GET` do detalhe zera o contador (D-035) antes de a tela ler.
   A faixa vai antes da N-ésima mensagem **do paciente** contando do fim (só mensagem de paciente
   soma no contador, D-035/§5), fica presa àquela mensagem (mensagem nova não a desloca) e a
   conversa abre rolada nela, não no fim. Se N passa das mensagens de paciente carregadas, a faixa
   vai antes da primeira mensagem carregada, com o N verdadeiro. Some ao trocar ou fechar a
   conversa e quando a atendente envia (texto, anexo ou áudio). Abrir por link direto
   (`?conversationId=`) antes de a lista carregar não mostra faixa: não há contador para ler.
3. **Botão ↓** aparece quando a lista está a mais de 80px do fim. Clique: rolagem suave até a
   última mensagem e o contador zera. Mensagem nova com a atendente longe do fim **não** move a
   tela e soma no contador (`Badge`, a mesma pílula de não lidas da fila), que zera ao chegar no
   fim por qualquer caminho. Perto do fim, mensagem nova continua descendo sozinha. Quem envia
   vai para o fim na hora, esteja onde estiver — como no WhatsApp Web.
**Motivo:** são as regras do card; os limites (80px do fim, 200px do topo) são de interface e
ficam como constantes no hook.
**Impacto:** `components/conversation/DateSeparator.tsx`, `pages/Attendance/*`; COMPONENTS.md
(`DateSeparator`), PAGES.md §2.
<!-- D-210 é do CRMLAB-60 (branch feature/CRMLAB-60-unifica-transicao-sistema, ainda fora da main). -->

### D-211: Reingajamento da conversa roda no motor de tempo, com uma linha por disparo
**Decisão:** quando a atendente fala por último e o paciente para de responder, o sistema manda
sozinho uma mensagem (CRMLAB-62). Regras em `FunnelRules.reengagement` (página de Regras, §6c):
`first` e `second`, cada um com `enabled`, `hours` (1..720) e `message` (1..1000, texto fixo).
1. **Onde roda:** dentro do tique do `FunnelTimerService` (D-205), no fim de cada laboratório,
   pelo `ReengagementService` (SERVICES §28). O tique passa a incluir laboratórios com o 1º ligado,
   mesmo sem proposta aberta. Falha do reingajamento não desfaz o que o funil fez.
2. **Silêncio e âncora:** a âncora é a última mensagem de pessoa do laboratório na conversa
   (`sender_type = 'agent'` e `automation` nulo: CRM **ou celular**, D-173). Há silêncio quando
   não existe mensagem do paciente depois dela e a conversa está `active`. A mensagem automática
   **nunca vira âncora**: não há loop. Resposta do paciente seguida de nova mensagem da atendente
   abre um silêncio novo.
3. **Uma linha por disparo** em `conversation_reengagements` (migração 031), com
   `UNIQUE (anchor_message_id, step)`: `sent` | `discarded` (+ motivo) | `failed`. A linha `sent`
   é gravada **antes** do envio, sob `FOR UPDATE` na conversa e com a reconferência do silêncio;
   tique concorrente cai no `ON CONFLICT DO NOTHING`. Se o processo cair entre a linha e o envio,
   o paciente fica sem a mensagem, nunca com duas. Falha do canal: mensagem `failed`, decisão
   `failed`, **sem nova tentativa**.
4. **O 2º** conta a partir do envio do 1º (`decided_at` da linha `sent`) e só existe depois de um
   1º **enviado**; o 1º descartado ou com falha encerra o silêncio. Não há terceiro. O `PATCH`
   recusa ligar o 2º com o 1º desligado; a tela desliga o 2º junto com o 1º.
5. **Na conversa:** `MessageService.createAutomated` grava `agent` sem autor com
   `messages.automation = 'reengagement'`, emite `conversation.new_message` e envia pelo mesmo
   caminho do Composer. A API devolve `senderName: "Mensagem automática"`. A mensagem entra no
   "envio em voo" do eco (D-173) e nunca é apagada como cópia do celular.
6. **Padrões:** os dois desligados (quem já usa não passa a mandar nada), 1º em 1 h, 2º em 24 h,
   textos profissionais editáveis.
**Motivo:** o Michel pediu que o motor de tempo fosse reaproveitado e que o reingajamento
dispare uma vez por silêncio. Gravar a decisão (e não só a mensagem) é o que permite o descarte
de feriado ser definitivo e o 2º contar do envio real do 1º.
**Impacto:** migração 031; `shared/types/funnel-rules.types.ts`, `reengagement.types.ts` (novo);
`reengagement.service.ts`, `reengagement.repository.ts` (novos), `funnel-timer.service.ts`,
`message.service.ts`, `message.repository.ts`, `funnel-rules.service.ts`, `main.ts`; SCHEMA §4/§33,
API_CONTRACTS §2/§6c, SERVICES §27/§28, BUSINESS_RULES §3, PAGES §21.

### D-212: Quando o reingajamento sai — horário de funcionamento, feriado e atraso máximo
**Decisão:** a hora de sair é calculada a cada tique, com a regra vigente (como D-209):
1. **Horário:** o de `tenant_settings.business_hours` (tela de Canais, o mesmo da resposta de
   fora do horário). Ele é **do laboratório**, não de cada canal. Sem nenhum dia com faixa =
   **sempre aberto** (decisão do Michel, 28/09/2026).
2. **Prazo vencido fora do horário** → sai na **próxima abertura** (`nextOpening`, só dia da
   semana e faixa, no fuso IANA do horário). As horas contam em tempo corrido; o horário decide
   só **quando** sai.
3. **Feriado não mantém** (Michel, 28/09/2026): se a data local da hora de sair é feriado
   (nacional ou do laboratório, D-213), o disparo é **descartado** (`holiday`), sem empurrar para
   depois. Vale também para o canal sempre aberto.
4. **Atraso máximo de 2 h** (`REENGAGEMENT_STALE_GRACE_MS`): se o tique que enviaria roda mais de
   2 h depois da hora de sair, descarta (`stale`). Cobre sistema fora do ar, regra recém-ligada e
   canal que voltou da API oficial para QR — em vez de mandar "ainda está aí?" horas ou dias
   depois.
5. **Janela de busca:** o motor só olha silêncios com âncora posterior a
   `agora − (horas do 1º + do 2º) − 8 dias` (`REENGAGEMENT_LOOKBACK_DAYS`). Ligar a regra não
   dispara para conversas paradas há semanas: as da janela viram `stale` uma vez, as de fora
   são ignoradas.
6. Na hora de enviar, reconfere: conversa ainda ativa, mesma âncora, paciente sem responder.
**Motivo:** o card pede "respeitar o horário" e "feriado não mantém". O atraso máximo e a janela
evitam o disparo em massa ao ligar a regra e a mensagem fora de contexto depois de uma queda.
**Impacto:** `shared/types/reengagement.types.ts` (`nextOpening`, `planReengagement`),
`channel-settings.service.ts` (`readBusinessHours`), `reengagement.service.ts`; SERVICES §28.

### D-213: Feriados — nacionais calculados no código, os do laboratório cadastrados nas Regras
**Decisão:** (opção "b" do Michel, 28/09/2026)
1. **Nacionais prontos**, calculados por ano em `shared/` (`nationalHolidays`), **não gravados**:
   fixos 1/1, 21/4, 1/5, 7/9, 12/10, 2/11, 15/11, 20/11, 25/12; móveis pela Páscoa (algoritmo
   gregoriano): **segunda e terça de Carnaval**, Sexta-feira Santa, Corpus Christi. Carnaval e
   Corpus Christi são ponto facultativo, mas entram como feriado (Michel, 28/09/2026).
2. **Do laboratório** em `tenant_holidays` (migração 031, `UNIQUE (tenant_id, holiday_date)`),
   com `GET/POST/DELETE /settings/holidays` (§6d): `GET` todo perfil; incluir e remover
   manager/admin, com audit. Data repetida → `CONFLICT`.
3. **Por ora o feriado só vale para o reingajamento.** O motor de tempo do funil continua sem
   descontar feriados nos dias úteis (D-205 item 3); usar a lista lá é outro card.
**Motivo:** o produto não tinha calendário de feriados (D-205). Nacionais no código dispensam
cadastro e manutenção; os municipais variam por cidade e ficam com o laboratório.
**Impacto:** migração 031; `shared/types/reengagement.types.ts`; `holiday.service.ts`,
`holiday.repository.ts`, `holiday.routes.ts` (novos), `http/modules.ts`; frontend
`api/holidays.ts`, `Settings/HolidaysSection.tsx`; SCHEMA §34, API_CONTRACTS §6d, SERVICES §29,
PAGES §21.

### D-214: Reingajamento só para WhatsApp conectado por QR Code
**Decisão:** o reingajamento só considera o laboratório cujo canal `whatsapp` está **ativo e em
`connection_mode = 'qr'`** (Evolution). Na API oficial da Meta (`cloud_api`) nenhuma conversa
entra na rotina, com a regra ligada ou não (Michel, 28/09/2026). A página de Regras avisa
"Inativo para este canal" quando o gestor/admin vê o WhatsApp em `cloud_api`.
**Motivo:** na API oficial, texto livre só sai até 24 h depois da última mensagem do paciente;
fora disso a Meta exige template aprovado (pago), que o CRM não tem. Em vez de meio suporte, a
regra fica fora. Template aprovado, se o laboratório migrar, é outro card.
**Impacto:** `reengagement.repository.ts` (`isQrWhatsAppActive`), `ReengagementSection.tsx`.

## 2026-09-29 — Busca nas mensagens, "Não lidas" e ir até a mensagem (CRMLAB-68)

### D-228: Busca pelo conteúdo das mensagens — função própria sem acento e GIN parcial
**Decisão:**
1. **Sem extensão `unaccent`.** A migração 043 cria a função `crm_unaccent(text)` (`LANGUAGE sql
   IMMUTABLE`, `translate()` das vogais acentuadas, `ç` e `ñ`, maiúsculas e minúsculas). Funciona
   no PGlite dos testes e no Postgres de prod/hml sem superusuário, e por ser `IMMUTABLE` pode
   entrar em índice. Maiúscula/minúscula quem resolve é o `to_tsvector`.
2. **Índice:** `idx_messages_content_search` — GIN em
   `to_tsvector('portuguese', crm_unaccent(content))`, **parcial** `WHERE deleted_at IS NULL`. A
   consulta repete a expressão e o predicado **caractere a caractere** (constante
   `MESSAGE_SEARCH_EXPRESSION` no repositório), senão o índice não é usado.
3. **Consulta:** o termo vira palavras (só letras e dígitos; o resto separa), cada uma com `:*`
   (prefixo: "hemog" acha "hemograma"), unidas por `&` (todas precisam estar na mensagem),
   passadas por `crm_unaccent` e `to_tsquery('portuguese', …)`. Termo com menos de 2 caracteres
   úteis → `VALIDATION_ERROR`. Termo só de palavras vazias ("de", "a") não acha nada.
4. **O que nunca aparece:** mensagem **apagada** pelo remetente (`deleted_at`, D-220 — nem o
   trecho), evento de sistema (`sender_type = 'system'`), mensagem de outro laboratório (RLS) e,
   para atendente, conversa de outra atendente — o recorte é o **mesmo da fila**
   (`assigned_to = eu OR assigned_to IS NULL`; gestor/admin veem todas). Conversa encerrada
   entra (o recorte não olha status). Mensagem editada é achada pelo texto **novo**.
5. **Rotas:** `GET /conversations/search/messages?q=` (todas as conversas visíveis) e
   `GET /conversations/:id/messages?q=` (uma conversa; invisível → `NOT_FOUND`). As duas
   devolvem `{ results: MessageSearchHit[], pagination }`, da mais nova para a mais antiga
   (`created_at DESC, id DESC`); `limit` padrão 20, máximo 100.
6. **Trecho e destaque são do frontend:** a API devolve o `content` inteiro, e a tela recorta o
   trecho em volta da primeira ocorrência e destaca o termo comparando **sem acento e sem
   caixa** (função pura). `ts_headline` ficou de fora: devolve HTML (a tela nunca usa
   `dangerouslySetInnerHTML`) e não destaca "orçamento" quando a pessoa digitou "orcamento".
**Motivo:** o card pede ignorar acento e responder rápido com volume de produção. A extensão
`unaccent` exige `CREATE EXTENSION` (superusuário no Postgres gerenciado) e não existe no PGlite;
a função própria cobre o português, que é o que o laboratório escreve. O índice parcial não
guarda as apagadas, que nunca podem ser achadas.
**Impacto:** migração 043; `message.repository.ts` (`search`), `message.service.ts`,
`conversation.routes.ts`; `shared/types/conversation.types.ts` (`MessageSearchHit`,
`SearchMessagesQuery`, `SearchMessagesResponse`); API_CONTRACTS §2, SCHEMA §4, SERVICES §3.

### D-229: "Não lidas" continua por conversa; marcar como não lida é `unread_count ≥ 1`
**Decisão:**
1. O contador **continua por conversa** (`conversations.unread_count`), como sempre foi: não
   existe contador por atendente. Marcar como não lida vale para quem mais vê a conversa (a
   colega da fila livre, a gestora) — é o mesmo número que a fila já mostra.
2. `POST /conversations/:id/unread` (204, idempotente) grava
   `unread_count = GREATEST(unread_count, 1)`: a conversa sem não lidas volta com 1; a que já tinha
   fica como está. **Não** mexe em `last_message_at`, **não** mexe no status das mensagens e **não**
   emite WebSocket. Recorte igual ao do `POST /read`: invisível → `NOT_FOUND`. Sem audit log
   (preferência de tela, como o pin). Abrir a conversa zera de novo (o `GET /:id` de sempre).
3. Como o `lastMessageAt` não muda, o aviso de mensagem nova (D-241 item 2) **não** dispara: ele
   exige o contador subir **junto** com o `lastMessageAt`. O título da aba passa a contar a
   conversa, como no WhatsApp Web.
4. **Listagem:** `GET /conversations?unread=true` filtra `unread_count > 0`, e `counts.unread`
   sai do mesmo `COUNT(*) FILTER` dos outros chips. `unread` é recorte de listagem como o
   `scope`: entra no `total`, **não** nos `counts` (o chip não clicado mantém o número).
5. **Tela:** ~~chip "Não lidas N"~~ — **retirado na validação (Michel, 29/09/2026):** com o número
   de não lidas no item e no título da aba, o chip repetia a informação; ficam Minhas / Não
   atribuídas / Encerradas. A API mantém `?unread=true`/`counts.unread` (baratos, testados). No item da lista, clique direito
   ou o botão "⋯" abre o menu com "Marcar como não lida" (só aparece com `unreadCount === 0`).
   Marcar a conversa **aberta** fecha o painel — senão o próximo refetch do detalhe zeraria o
   contador na hora.
**Motivo:** o card pede seguir o que já existe e registrar. Contador por atendente exigiria tabela
nova, mudaria o significado do número que a fila, os chips e o título da aba já usam, e a
maioria das conversas tem uma atendente só.
**Impacto:** `conversation.repository.ts` (`list`, `markAsUnread`), `conversation.service.ts`,
`conversation.routes.ts`; `shared/types/conversation.types.ts` (`ListConversationsQuery.unread`,
`counts.unread`); frontend `ConversationList.tsx`, `ConversationItem.tsx`, `index.tsx`;
API_CONTRACTS §2, PAGES §2, COMPONENTS.

### D-230: Ir até a mensagem — `around` e `after` no mesmo cursor do CRMLAB-71
**Decisão:**
1. `GET /conversations/:id` aceita `around=<messageId>` (a janela em volta da mensagem: até
   `floor(messageLimit/2)` mais novas que ela, e o resto com ela e as anteriores — perto do fim da
   conversa a janela completa com histórico) e `after=<messageId>` (as `messageLimit` mensagens
   **imediatamente posteriores**, em ordem crescente). `before`, `after`, `around` e `page` são
   **excludentes** entre si → `VALIDATION_ERROR`. Mensagem que não é desta conversa (outra
   conversa, outro tenant, inexistente) → `NOT_FOUND` (`resource: "message"`), igual ao `before`.
2. `cursors.after` deixa de ser sempre `null` (fecha o D-237 item 2): é o id da mensagem **mais
   nova** da página quando **existem** mensagens mais novas que ela; `null` quando a página chega à
   última mensagem. Vale para todo modo: página mais recente → `null`; página `before` → id da
   mais nova (sempre há mais novas); `after`/`around` → conforme o caso.
3. Abrir com `around` também marca a conversa como lida (é o `GET /:id` de sempre).
4. **Frontend:** o `pageParam` da query infinita vira `{ before } | { after } | { around } | null`
   e `getPreviousPageParam` lê `cursors.after` da primeira página. Aberta por `around`, a chave
   ganha um 4º elemento — `[...queryKeys.conversation(id), 'messages', { around }]` —, continua
   sob o prefixo que o WS invalida, e o `useMarkAsRead(id, around)` usa as mesmas opções (abrir
   continua sendo um GET só). Trocar de janela na mesma conversa mantém a anterior na tela
   (`placeholderData` só da mesma conversa) até a nova chegar.
5. **Rolagem:** abrir numa mensagem rola até ela (centro da tela) e acende o destaque; a faixa de
   não lidas não aparece (`unreadAtOpen = 0`). Perto do fim com `cursors.after`, a tela pede as
   mais novas — página carregada embaixo **não** é mensagem nova: a tela fica parada e o contador
   do ↓ não sobe. O botão ↓ com mais novas ainda não carregadas volta para a chave da ponta (sem
   `around`) e desce ao fim; enviar mensagem faz o mesmo.
6. **Busca dentro da conversa:** lupa no cabeçalho abre a barra com o campo, "N de M" e ↑ ↓
   (↑ = ocorrência mais antiga, ↓ = mais nova; Enter = ↑), e a lista de resultados (data +
   trecho). Clicar ou navegar: se a mensagem já está carregada, só rola (`scrollToMessage`);
   senão, reabre a conversa com `around`. A busca da lista ganha o bloco **Mensagens** (nome do
   paciente, data e trecho com destaque) e o clique abre a conversa com `around`.
**Motivo:** "abrir na mensagem certa, mesmo antiga" sem baixar a conversa inteira. Reaproveitar o
cursor por id do CRMLAB-71 mantém um formato só e a mesma leitura do par `(created_at, id)` no
banco (nunca do `createdAt` do fio).
**Impacto:** `message.repository.ts`, `message.service.ts`, `conversation.routes.ts`;
`shared/types/conversation.types.ts` (`GetConversationQuery`, `MessageCursors`); frontend
`queries.ts`, `index.tsx`, `ConversationPanel.tsx`, `useConversationScroll.ts`,
`scroll-to-message.ts`, `ConversationSearch.tsx` e `MessageResults.tsx` (novos),
`lib/search-snippet.ts` (novo), `hooks/useNewMessageAlerts.ts` (linha de base do detalhe);
API_CONTRACTS §2, PAGES §2, COMPONENTS.

## Template para novas decisões

```
### D-XXX: Título curto
**Decisão:** O que foi decidido.
**Motivo:** Por quê.
**Impacto:** Domínios afetados + o que muda na prática.
```
