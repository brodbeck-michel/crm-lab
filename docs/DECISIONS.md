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

## Template para novas decisões

```
### D-XXX: Título curto
**Decisão:** O que foi decidido.
**Motivo:** Por quê.
**Impacto:** Domínios afetados + o que muda na prática.
```
