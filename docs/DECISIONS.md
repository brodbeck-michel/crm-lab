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

### D-132: Editar itens/desconto/médico solicitante de uma proposta já criada (CRMLAB-12)
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

## Template para novas decisões

```
### D-XXX: Título curto
**Decisão:** O que foi decidido.
**Motivo:** Por quê.
**Impacto:** Domínios afetados + o que muda na prática.
```
