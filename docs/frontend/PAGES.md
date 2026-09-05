# 📺 Páginas do Frontend

Especificação das telas: rota, layout, componentes, dados consumidos e permissões. O Agent-UI implementa exatamente estas telas.

---

## Mapa de Rotas

```
/login                        → Login (público)
/                             → redirect por perfil (atendente → /attendance)
/attendance                   → Atendimento (inbox 3 colunas)
/patients/:id                 → Ficha do Paciente
/budget/new?conversationId=   → Novo Orçamento
/proposals                    → Pipeline de Propostas
/catalog                      → Catálogo de Exames
/analytics                    → Conversão
/internal-chat                → Chat Interno
/decisions                    → Decisões (aprovações)    (gestor+)
/settings/channels            → Canais & Equipe          (admin; gestor lê)
/settings/operation           → Gestão da Operação        (gestor+)
/settings/insurances          → Convênios                 (gestor+)
/settings/users               → Usuários & Permissões     (admin)
/settings/theme               → Personalização            (admin)
/platform/tenants             → Laboratórios Clientes     (operador plataforma)
/platform/billing             → Assinaturas & Uso         (operador plataforma)
```

**Guard de rotas:** cada rota declara `requiredRoles`; usuário sem permissão → redirect + toast. O servidor TAMBÉM valida (a UI esconde, o servidor recusa).

### Papéis por rota (implementado em `src/routes/route-config.ts`)

| Rota | `requiredRoles` | No trilho da Sidebar |
|------|-----------------|----------------------|
| `/login` | — (público) | não |
| `/` | qualquer sessão → redirect por perfil | não |
| `/attendance` | attendant · manager · admin | sim |
| `/patients/:id` | attendant · manager · admin | não |
| `/budget/new` | attendant · manager · admin | não |
| `/proposals` | attendant · manager · admin | sim |
| `/catalog` | attendant · manager · admin | sim |
| `/analytics` | attendant · manager · admin | sim |
| `/internal-chat` | attendant · manager · admin | sim |
| `/decisions` | manager · admin | sim |
| `/settings/channels` | manager · admin | sim |
| `/settings/operation` | manager · admin | sim |
| `/settings/insurances` | manager · admin | sim |
| `/settings/users` | admin | sim |
| `/settings/theme` | admin | sim |
| `/platform/tenants` | platform_operator | sim |
| `/platform/billing` | platform_operator | sim |

Duas leituras registradas aqui porque o doc original não as fixava:

1. **`platform_operator` não entra em nenhuma rota de tenant.** §11 diz "sem acesso: conversas,
   pacientes, canais internos de labs (requisito, não configuração)" — a interpretação mais
   restritiva é o operador ficar restrito a `/platform/*`. Simetricamente, papel de tenant não
   entra em `/platform/*`.
2. **Redirect de `/` por perfil:** `attendant → /attendance` (fixado no doc);
   `manager` e `admin → /proposals`; `platform_operator → /platform/tenants`.
   Fonte única: `ROLE_HOME` em `src/routes/route-config.ts`.

---

## 1. Login (`/login`)

- Campos: email, senha (pílula, ver DESIGN_TOKENS)
- `POST /auth/login` → armazena tokens → aplica tema do response → redirect por role
- Erro: mensagem genérica "credenciais inválidas"

---

## 2. Atendimento (`/attendance`) — TELA PRINCIPAL

**Layout:** Inbox 3 colunas (336px | flex min 440px | 316px recolhível). Sidebar recolhe automaticamente (72px) nesta tela para atendentes.

### Coluna 1 — Lista de conversas
- Filtros em chips: "Minhas N" (accent sólido), "Não atribuídas N" (cinza)
- Busca (pílula): paciente, telefone ou exame
- **A mesma busca também procura PACIENTE** (D-079): com 2+ caracteres a coluna consulta
  `GET /patients?search=&limit=5` e mostra um bloco "Pacientes" abaixo da fila; cada linha leva
  a `/patients/:id`. Sem termo digitado o bloco não existe. É o consumidor de `GET /patients`
  e a busca que API_CONTRACTS §2c chama de "a busca do inbox". A lista já vem recortada por
  papel pelo servidor (D-060): o atendente só recebe paciente que ele poderia abrir
- `ConversationItem` (ver COMPONENTS): avatar iniciais, nome, hora (sálvia-700 se não lidas), prévia truncada 1 linha, badge contagem, chips de status
- Dados: `GET /conversations` + WS `conversation.new_message` (refetch)

### Coluna 2 — Conversa
- Header: nome, telefone, botões [Transferir] [Novo Orçamento] [Arquivar]
- Bolhas: recebida / enviada / evento de sistema (3 tipos, máx. 62% largura)
- Composer: input pílula + anexos + enviar
- Dados: `GET /conversations/:id`, `POST /conversations/:id/messages`
- Ao abrir: `markAsRead`

### Coluna 3 — Contexto do paciente (recolhível)
- Cadastro resumido, propostas da conversa (cartões clicáveis → modal), tags
- **Link "Ver ficha completa" → `/patients/:id`**, a porta de entrada da Ficha (§3). Usa
  `conversation.patientId` (D-079), que vem em `GET /conversations/:id`. Conversa anterior ao
  backfill da migração 003 tem `patientId: null` e **o link não é renderizado** — nem link
  quebrado, nem botão desabilitado sem explicação

---

## 3. Ficha do Paciente (`/patients/:id`)

- Página de leitura: max-width 1180px, padding 30px 36px 48px
- `:id` é o **id do paciente** (`patients.id`, D-059), não o da conversa. O inbox chega aqui
  pelo `patientId` da conversa; conversa anterior ao backfill tem `patientId: null` e o link
  não aparece
- **Portas de entrada** (D-079) — a ficha não é alcançável só por URL:
  1. Atendimento, coluna 3: "Ver ficha completa" (`conversation.patientId`);
  2. Atendimento, coluna 1: bloco "Pacientes" da busca (`GET /patients`);
  3. Gestão da Operação (§10): nome do paciente na fila (`QueueItem.patientId`).
  Em todas, `patientId: null` vira texto puro — o link só existe quando o cadastro existe

**Três chamadas, três blocos** — a ficha NÃO vem em um payload só (D-060). Cada bloco tem seu
ciclo de atualização e sua paginação:

| Bloco | Chamada | Observação |
|-------|---------|------------|
| Cadastro completo (editável) | `GET /patients/:id` → `PATCH /patients/:id` | `PatientDetail` cru; `null` apaga campo, ausente preserva; `phone` **não** é editável |
| Contadores (conversas, propostas, última interação) | vêm no mesmo `GET /patients/:id` | derivados, e no **recorte do usuário** — dois usuários podem ver números diferentes |
| Histórico de interações (timeline) | `GET /patients/:id/timeline?page&limit&kind&order` | união de mensagens, aberturas de conversa, criação de proposta e mudança de estágio; `desc` por padrão |
| Propostas do paciente | `GET /proposals?patientId=<id>` | não há endpoint próprio: reusa a listagem, a visibilidade (D-042) e o `ProposalCard`/modal de §6 |
| Seção LGPD | `GET /patients/:id/export` e `POST /patients/:id/anonymize` | **admin apenas** — esconder para os demais é UX; o servidor recusa (403) de qualquer forma |

**Timeline:** cada entrada é uma união discriminada por `kind`
(`conversation_started | message | proposal_created | proposal_stage_changed`) — o componente
faz switch em `kind`, nunca em heurística de campo presente. `entry.id` é
`"<kind>:<uuid>"` e serve **só** de `key` de lista. `preview` da mensagem já chega truncado em
160 caracteres pelo backend: a tela não re-trunca nem promete texto completo.

**Seção LGPD:**
- **Exportar dados** baixa um JSON (`Content-Disposition: attachment`) com cadastro, conversas,
  mensagens e propostas do titular. Gera audit log no servidor.
- **Anonimizar** exige `reason` (1..500) e é **irreversível**: pede confirmação explícita
  dizendo o que acontece — o cadastro esvazia, o nome some do inbox, e as propostas históricas
  permanecem (sem nome). É idempotente: repetir devolve 200, não erro.
- Paciente com `anonymizedAt != null` renderiza o cadastro em estado vazio e **desabilita a
  edição** (o `PATCH` responde `409 CONFLICT` com `details.reason: "patient_anonymized"`).

**Papéis:** a rota é `attendant · manager · admin`. O atendente só abre a ficha de paciente com
conversa visível a ele — fora disso a API responde `404` e a tela mostra "não encontrado",
nunca "sem permissão" (não vazar existência).

---

## 4. Novo Orçamento (`/budget/new`)

**Layout:** 2 colunas (catálogo flex min 520px | resumo 372px fixo)

### Coluna esquerda — Catálogo
- Segmentado de 4 modos: [Catálogo | Pedido médico | IA | Pacotes]
- **Seletor de convênio (`InsuranceSelector`, Onda 7, D-082):** `Select` sobre
  `useInsuranceList({ active: true })`, com "Particular" fixo no topo — nunca
  vem da API, é o mapeamento local para `insuranceId: null` (a ausência de
  convênio, não uma linha de `insurances`). Nasce em "Particular". Substituiu
  o toggle local Particular/Convênio da Onda 6: aquele fixava o preço exibido
  sem refletir o convênio de fato escolhido para a proposta — duas fontes de
  verdade para o mesmo dado.
- Busca + lista de exames com preço. Sem convênio selecionado, sempre
  `pricePrivate`; com convênio, `GET /exams?insuranceId=` devolve
  `effectivePrice`/`priceSource` por exame (fallback para `pricePrivate`/
  `'private'` quando o exame não tem preço próprio no convênio — "fallback
  nunca bloqueia", D-004) e a lista mostra `effectivePrice`
- Clique adiciona ao resumo, carregando também o `priceSource` do exame
- Trocar o convênio refaz a busca (`insuranceId` faz parte da chave de cache
  de `useExamListInfinite`)
- Dados: `GET /exams?active=true[&insuranceId=]` (20 por página, `useExamListInfinite`)
- **Alcance do catálogo — busca server-side + carga incremental (D-080).**
  Esta coluna também carregava só a primeira página: `useExamList` +
  `data.exams`, `limit: 50`. Num laboratório com mais de 50 exames ativos os
  demais ficavam INALCANÇÁVEIS — não dava para montar orçamento com eles. Era a
  metade da D7 da Onda 5 que ficou aberta (fechada em `/proposals` e `/catalog`,
  esquecida aqui).
  Aqui **não** entra o `Pagination` numerado das outras duas telas: isto é um
  *seletor*, não uma tabela — o usuário monta um carrinho na coluna da direita
  enquanto procura na esquerda, e trocar a página sob ele tiraria da tela o que
  ele acabou de ver sem devolver nada (não existe "voltar à linha 47" num
  seletor). O que existe é:
  1. **busca server-side** — o `search` vai para `GET /exams` e recorta o
     catálogo inteiro no banco, não as linhas já carregadas;
  2. **carga incremental** — botão `Carregar mais` acumula páginas
     (`useInfiniteQuery`), com rodapé `N de M exames` enquanto houver resto.
     Sem o contador, "Carregar mais" não distingue "faltam 3" de "faltam 300".
  A página **não** vai para a URL (ao contrário de `/proposals` e `/catalog`):
  não há estado de página a compartilhar — `/budget/new?conversationId=` é uma
  tela de rascunho, e o que a URL carrega é a conversa.
  Chave de cache própria (`queryKeys.examsInfinite`, `['exams','infinite',…]`):
  `useInfiniteQuery` guarda `{ pages, pageParams }`, shape diferente do
  `ListExamsResponse` de `useExamList`. Continua sob o escopo `['exams']`, então
  uma invalidação do catálogo pega as duas.

### Coluna direita — Resumo
- Itens adicionados (nome, preço, remover)
- **Badge "Particular" por item (Onda 7, D-082):** só aparece quando HÁ
  convênio selecionado E o item caiu no preço particular por fallback (sem
  tabela própria no convênio) — a exceção que precisa ficar visível. Com
  "Particular" selecionado (`insuranceId: null`) todo item já é particular; o
  badge seria redundante e não aparece
- Desconto: input % com validação visual contra `user.discountLimit`
  - Acima da alçada: aviso "Exigirá aprovação do gestor" (chip terracota)
- **Total: rodapé fixo da coluna**, sempre derivado (nunca digitado)
- Botão [Criar orçamento] → `POST /proposals` (com o `insuranceId` escolhido)
  → redirect para conversa

---

## 5. Pipeline de Propostas (`/proposals`)

- **Duas visões**, alternadas por `SegmentedControl` no cabeçalho e gravadas na URL
  (`?view=lista`; kanban é o default e não escreve nada):
  - **Kanban** — os 6 estágios em `grid grid-cols-6`: cabem todos na largura, sem scroll
    horizontal, e cada coluna rola verticalmente por dentro. Carrega `limit=100` (o teto do
    contrato) de uma vez e **não** pagina — pipeline picotado em "página 2" não é pipeline.
    Acima de 100 a tela avisa o total e manda usar busca/filtros.
  - **Lista** — grade de `ProposalCard` (1/2/3 colunas conforme a largura) com a `Pagination`
    padrão e `limit=20`. Trocar de visão reinicia a página, porque os limites diferem.
- Colunas por estágio: novo contato → orçamento enviado → follow-up → negociação | ganho | perdido
- Header de coluna: nome + contagem + soma (derivada)
- `ProposalCard`: nome, #id, nota, valor (heading nowrap), dias, chip status
- Todo cartão clicável → Modal da Proposta
- **Arrastar o cartão** entre colunas move o estágio (HTML5 drag-and-drop nativo, sem
  biblioteca). A proposta viaja no `dataTransfer` como JSON **e o estágio de origem viaja
  também no nome do tipo** (`application/x-crm-proposal-status-<status>`): durante o `dragover`
  o drag data store está em modo protegido pela spec do HTML5 — só `types` é legível,
  `getData()` devolve `''`. Sem esse truque a coluna não teria como decidir se aceita, nunca
  chamaria `preventDefault()` e o navegador nem dispararia o `drop`. Com o estágio de origem em
  mãos a coluna confere `isTransitionAllowed(origem, destino)` — destino inválido nem realça nem
  aceita o drop. Isso
  é só economia de request: quem decide continua sendo o backend, e erro dele vira toast.
  Soltar em **Perdido** não muta direto — abre o Modal da Proposta, porque a transição exige
  `reasonLost` e o formulário de motivo já mora lá.
- Filtros: busca por nome do paciente (`SearchInput`, debounce 300ms → `?search=`), período,
  atendente (gestor+), valor
- **[Novo atendimento]** no cabeçalho: a porta de entrada de quem não chegou pelo
  WhatsApp (ligação, balcão, site). Abre `NewAttendanceModal` — nome, telefone,
  e-mail opcional e **Origem** (`Select`: Ligação/Presencial → `direct`,
  Site/Formulário → `web`, SMS → `sms`, gravado em `conversations.channel`).
  Ao salvar: `POST /conversations` → `navigate('/budget/new?conversationId=…')`,
  onde os itens são montados. O card só entra no pipeline quando a proposta
  existe — o pipeline mostra propostas, não conversas.
  Telefone já conhecido não vira conversa nova (dedupe do backend); se ele for
  de **outro atendente**, o `CONVERSATION_ALREADY_ASSIGNED` (409) vira toast
  pelo handler genérico e o modal continua aberto.
- Dados: `GET /proposals` agrupado por status
- **Paginação** (`Pagination`, 20 por página): a tela lia só a página 1 e
  descartava `pagination`, o que tornava proposta antiga INALCANÇÁVEL pela UI
  (D7 da Onda 5). A página vive na URL (`?page=3`) — compartilhável, sobrevive
  ao F5, volta pelo botão do navegador; **nunca no Zustand**. Trocar filtro
  volta para a página 1.
- *(v1: mover estágio via modal; drag-and-drop é pendência conhecida)*

---

## 6. Modal da Proposta

**Aberto de:** pipeline, conversa, chat interno (anexo), ficha do paciente

- Máx 720px, radius-lg, shadow-lg, backdrop escuro, rolagem interna, fecha por × e clique-fora (stopPropagation no cartão)
- Conteúdo: **convênio da proposta** (chip — nome resolvido via
  `useInsuranceList`, já que `Proposal`/`ProposalDetail` só trazem
  `insuranceId`; "Particular" quando `null`), itens + preços (badge
  "Particular" por item nas mesmas condições da coluna de resumo de
  `/budget/new`), desconto, total derivado, alerta de aprovação (se pending),
  histórico de estágios, ações
- Ações (uma linha): [Mudar estágio ▾] à esquerda, [Marcar como ganho] (accent-2) à direita, [Marcar como perdido] fantasma ao fim
- "Perdido" abre sub-form com motivo OBRIGATÓRIO (select: preço, silêncio, exame indisponível, prazo, outro)
- Dados: `GET /proposals/:id`, `PATCH /proposals/:id/status`

---

## 7. Catálogo de Exames (`/catalog`)

- Tabela: nome, código, preparo, **TUSS, material**, prazo, preço particular, preço convênio, status
- Regras de tabela: container com min-width + overflow-x, cabeçalho 11px caixa alta, valores à direita
- Atendente: somente leitura. Gestor/Admin: criar/editar (modal)
- **Paginação** (`Pagination`, 20 por página) com a página na URL (`?page=2`),
  mesma regra de `/proposals`. Buscar volta para a página 1.
- Dados: `GET /exams`, `POST/PATCH /exams` (gestor+)
- **Modal do exame (Onda 7 — D-081/D-082):** além dos campos anteriores, código TUSS
  (tabela 22 TISS/ANS), código AMB legado e material de coleta — os três `null` quando não
  confirmados, nunca inventados; sinônimos como chips removíveis (`exam_synonyms`, substituídos
  por inteiro a cada gravação). Em **modo edição**, uma segunda aba "Preços por convênio" grava
  o preço do exame por convênio (`ExamPricesTab`): grid convênio × preço, um `Input` por
  convênio ativo, em branco = "sem preço específico — orçamento cai no particular"
  (`priceSource: "private"`). Só existe em edição — não há `examId` para consultar em criação.
- Dados da aba de preços: `GET /exams/:id/prices` (todos os papéis) ·
  `PUT /exams/:id/prices` (gestor+) — semântica de PUT: convênio ausente do corpo tem o preço
  **removido**, não preservado.

---

## 8. Conversão (`/analytics`)

- Grade de indicadores: auto-fit minmax(224px) — taxa de conversão, ticket médio, em aberto, receita do período
- Funil por estágio (barras), motivos de perda (distribuição), desempenho por atendente (tabela — gestor+)
- Atendente vê versão PARCIAL (apenas métricas próprias)
- Dados: `GET /analytics/conversion`, `GET /analytics/pipeline`
- **Todos os números derivam de proposals** — exibir períodos consistentes

---

## 9. Chat Interno (`/internal-chat`)

- Lista de canais + DMs (coluna esquerda), mensagens (direita)
- Mensagem pode anexar proposta → renderiza `ProposalCard` clicável → modal
- Canal `#aprovacoes`: pedidos de aprovação com botões [Aprovar] [Rejeitar] (gestor+)
- Dados: `GET /internal-chat/*` + WS

### Estado de leitura do canal (D-068 — fecha a pendência D5 da Onda 5)

- `Channel.unreadCount` agora **zera de verdade**: ao abrir um canal, a tela chama
  `POST /internal-chat/channels/:id/read` (204, idempotente) e depois invalida
  `queryKeys.internalChannels()` — nessa ordem, senão o badge velho volta. É a mesma sequência
  do `useMarkAsRead` do inbox.
- "Abrir" é o **clique do usuário no canal**, não a auto-seleção do primeiro item da lista.
  A ordem dos canais é fixa (`kind ASC, key ASC`), então o auto-selecionado é quase sempre
  `#aprovacoes`: marcá-lo como lido só porque a tela montou apagaria justamente o aviso que a
  pessoa entrou para ver. Entrar em `/internal-chat` não mexe em `channel_reads`.
- Ler o histórico **não** marca como lido: `GET /internal-chat/channels/:id/messages` não tem
  efeito colateral. Rolar para trás não deve apagar o badge de uma mensagem nova.
- `Channel.lastReadAt` (anulável) é a última leitura **deste** usuário: é o que posiciona o
  divisor "novas mensagens". `null` = nunca abriu.
- Mensagem de sistema conta como não lida — o pedido de aprovação em `#aprovacoes` é o caso
  que mais precisa piscar. Mensagem do próprio usuário nunca conta.

### Paginação do histórico (D-069)

`page=1` é a página das mensagens **mais recentes**, com os itens em ordem cronológica
crescente dentro dela; `page=2` é o bloco anterior. A tela abre o canal com **um** request e
rola para o fim — o `fetchTail` de dois requests (ler `totalPages`, depois buscar a última
página) deixa de existir.

---

## 10. Telas de Configuração

### Canais & Equipe (`/settings/channels`) — admin edita, gestor lê
- Dados: `GET /settings/channels` (gestor+) · `PATCH /settings/channels` (admin)
- Uma chamada só devolve os quatro blocos da tela: `channels`, `distributionMode`,
  `autoMessages`, `businessHours` e `team`
- **Conexão WhatsApp:** por canal — nome exibido, `phoneNumberId`, número, ativo/inativo,
  token e segredo do webhook
  - **O segredo nunca volta do servidor.** A tela recebe `apiTokenMasked`
    (`••••••••` + 4 últimos) e `webhookSecretSet: boolean`; o campo de senha nasce **vazio** e
    exibe "configurado"/"não configurado". Não existe "revelar token": não há o que revelar
  - Salvar sem tocar no campo de segredo **preserva** o valor (o campo simplesmente não vai no
    corpo). Para apagar, o botão "Remover token" envia `null` explicitamente. Campo em branco
    nunca é enviado como `""` — o servidor recusa
- **Modo de distribuição:** `manual | round_robin` (rádio). O que muda no produto: em `manual`
  a conversa nova cai na fila "Não atribuídas" e alguém assume (§2)
- **Mensagens automáticas:** saudação e fora-do-horário, cada uma com liga/desliga e texto
  (1..1000). Ligar sem texto é erro de validação — a tela desabilita o "salvar" antes disso
- **Horário de atendimento:** por dia da semana + timezone. Enviar `businessHours` **substitui**
  o objeto inteiro (dia ausente = fechado): a tela sempre manda o estado completo do formulário
- **Equipe:** `team` traz id, nome, papel e status — **sem e-mail e sem alçada** (D-066). É de
  propósito: assim o gestor lê a tela sem depender de `GET /users`, que é admin. Quem precisa
  editar papel ou alçada vai para `/settings/users`. Usuários inativos aparecem marcados
- Gestor vê tudo em modo leitura: campos desabilitados, sem botão salvar. O servidor recusa o
  `PATCH` dele de qualquer forma (403)

#### Conexão por QR — número próprio (Onda 7, Bloco B · D-083 · API_CONTRACTS §6.1)
Bloco dentro do MESMO cartão do canal WhatsApp, **só para admin** (as quatro rotas de QR são
admin: o bloco inteiro é montado dentro do ramo de escrita, então nem o `GET /status` sai para
gestor).

- Dados: `POST /settings/channels/whatsapp/connect` · `GET .../qr` · `GET .../status` ·
  `POST .../disconnect`
- **Termo de aceite obrigatório** (`WhatsAppConnectModal`): risco de banimento do número, uso
  fora dos ToS do WhatsApp é responsabilidade do laboratório, número dedicado (nunca pessoal),
  o celular precisa abrir o WhatsApp a cada ~14 dias, e a mensagem do paciente (dado de saúde)
  passa pelo gateway. Sem a caixa marcada o botão "Conectar" fica desabilitado; o servidor
  recusa com `VALIDATION_ERROR` de qualquer forma
- **Aceite é dado do canal, não do modal**: gravado em `accepted_terms_at/by` no primeiro
  aceite e nunca sobrescrito. Reconexão já aceita **pula o checkbox** e envia corpo vazio
- **Fluxo:** aceite → `connect` devolve o QR (`status: "pairing"`) → a tela faz polling de
  `GET .../qr` a cada ~2s → `status: "connected"` fecha o modal com toast → o cartão passa a
  mostrar `Conectado — <número>`. O polling **para sozinho** em qualquer estado terminal e no
  primeiro erro (`qrRefetchInterval`) — não existe polling infinito
- **QR expirado** (`pairing` → `disconnected`) mostra "gerar novamente"; `503
  CHANNEL_QR_UNAVAILABLE` (gateway não configurado) é estado de operador, com mensagem própria
- **Desconectar não desativa o canal** (`is_active` intocado) — são dois controles distintos,
  e a confirmação diz isso explicitamente
- Conectar por QR troca `connection_mode` para `qr` e **não há caminho de volta para
  `cloud_api`** pela UI: a partir daí o envio sai pelo gateway Evolution

### Gestão da Operação (`/settings/operation`) — gestor+
- Dados: `GET /operations/overview?queueLimit&decisionsLimit` — **somente leitura**
- Um endpoint, um retrato (D-067): os três blocos vêm do mesmo instante. Não fazer três
  chamadas separadas — a tela exibiria uma fila e uma carga de momentos diferentes
- **Fila agora:** `queue.unassigned` (ativas sem dono) + `queue.waiting` (atribuídas com
  mensagem não lida) e `queue.items` ordenada pela maior espera. Clique na linha leva à
  conversa; o **nome do paciente é link para a ficha** (`/patients/:id`) quando
  `QueueItem.patientId` existe, e texto puro quando é `null` (§7, D-079)
- **Carga por atendente:** `workload[]` — conversas ativas, mensagens não lidas, propostas em
  aberto e aprovações pendentes. Quem está sem carga aparece **zerado**, não some da tabela
- **Decisões pendentes:** `pendingDecisions` — propostas em `approvalStatus: "pending"`, mais
  antiga primeiro; clique abre o Modal da Proposta (§6), onde [Aprovar]/[Rejeitar] já existem
- Todo tempo chega em **segundos** (`waitingSeconds`, `oldestWaitSeconds`), calculado em UTC no
  servidor (D-021). A tela só formata ("há 1h30") — nunca subtrai datas para obter a espera
- Sem cache no servidor: use `staleTime` curto e refetch ao focar a janela. Nada aqui é
  digitado ou configurável: é tudo derivado de conversas e propostas

### Convênios (`/settings/insurances`) — gestor+ (Onda 7, D-081/D-082)
- Dados: `GET /insurances` (todos os papéis do tenant) ·
  `POST /insurances`, `PATCH /insurances/:id` (gestor+)
- Tabela: nome, razão social, código ANS, tipo (`cooperativa | medicina_grupo | seguradora |
  autogestao | especial`), status
- Criar/editar (modal): nome, razão social, código ANS (`Select` para o tipo, `Toggle` para
  ativo — o `Toggle` só aparece em edição, porque `POST` não aceita `isActive`)
- **Sem `DELETE`:** desativar é `PATCH { isActive: false }` (mesmo padrão de `/catalog`) —
  proposta antiga referencia o convênio usado, apagar quebraria o histórico
- **"Particular" não é uma linha desta tabela** — é a ausência de convênio
  (`insuranceId: null` em `POST /proposals`). O preço por (exame, convênio) fica na aba
  "Preços por convênio" do modal do exame em `/catalog` (§7), não aqui
- Botão "Novo Convênio" e a coluna de ações ficam **ausentes do DOM** para quem não é
  manager/admin (mesmo padrão de `Settings/Channels.tsx`): não há controle de escrita a
  desabilitar porque não existe nenhum — o servidor recusaria o `POST`/`PATCH` de qualquer
  forma (403)

### Usuários & Permissões (`/settings/users`) — admin
- Tabela de usuários: nome, email, papel, limite de desconto, status
- Criar/editar (modal): papel + limite desconto
- Log de auditoria (aba)

### Personalização (`/settings/theme`) — admin
- 5 temas prontos (cartões com amostras) + tema livre (5 color pickers)
- Cantos (reto/suave/redondo), fonte, nome exibido, logo
- **Preview em tempo real:** aplica CSS vars localmente antes de salvar
- Salvar → `PATCH /themes/current`

---

## 11. Console da Plataforma (`/platform/*`) — ISOLADO

- Identidade visual própria (não usa tema de tenant)
- **Sem acesso:** conversas, pacientes, canais internos de labs (requisito, não configuração)
- Laboratórios Clientes: lista tenants, onboarding, saúde
- Assinaturas & Uso: planos, faturas, excedente de mensagens

---

## 12. Decisões (`/decisions`) — número próprio

Gestor+. Página dedicada às propostas com `approvalStatus: "pending"` — hoje esse recorte também
aparece dentro de `#aprovacoes` (§9) e no bloco "Decisões pendentes" de Gestão da Operação (§10);
esta tela existe para quem só precisa DISSO, sem entrar no chat nem no resto do painel.

- Mesmo dado de §10: `GET /operations/overview` (D-067), lendo só `pendingDecisions` — nenhum
  endpoint novo, nenhum cálculo novo
- Lista de cartões (mais antiga primeiro): paciente, % de desconto, total, quem pediu, tempo de
  espera — reaproveita o cartão de §10
- Clique no cartão abre o **Modal da Proposta** (§6), onde [Aprovar]/[Rejeitar] já existem
  (`ApprovalActions`). Esta tela NÃO reimplementa a decisão de alçada — duplicar o botão duplicaria
  a regra (CLAUDE.md §3)
- Vazio: "Nenhuma decisão pendente"

**Notificação (sino da Sidebar):** o item "Decisões" do trilho mostra um contador (`Badge`) com
`pendingDecisions.total` para quem tem o item no menu (gestor+). Fonte: o MESMO
`GET /operations/overview` (cache do TanStack Query compartilhado com §10 e com esta tela — não é
uma segunda chamada). Fica live porque os eventos WS `approval.requested` e `approval.decided`
(ws.ts) agora também invalidam `queryScopes.operations`, então o contador cai assim que alguém
decide, sem esperar o refetch de 60s.

---

## Estado Global (Zustand + TanStack Query)

```typescript
// Zustand: estado de UI e sessão
useAuthStore:    { user, tenant, theme, tokens }
useUIStore:      { sidebarCollapsed, contextPanelOpen, activeModal }

// TanStack Query: TODOS os dados de servidor
queryKeys: ['conversations', filters], ['conversation', id],
           ['proposals', filters], ['proposal', id],
           ['exams', filters], ['analytics', period], ['theme']
```

**Regras:**
- Dados de servidor SEMPRE via TanStack Query (nunca copiar para Zustand)
- WS events → `queryClient.invalidateQueries(...)` (refetch, não patch manual)
- staleTime: conversas 10s, catálogo 1h, analytics 5min

---

## Aplicação do Tema (bootstrap)

```typescript
// No login (ou refresh), com o theme do response:
applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.style.setProperty('--color-accent', theme.accent);
  root.style.setProperty('--color-accent-2', theme.accent2);
  root.style.setProperty('--color-bg', theme.bg);
  root.style.setProperty('--color-surface', theme.surface);
  root.style.setProperty('--color-text', theme.text);
  // Rampas 100-900 derivadas via color-mix já definidas no CSS estático
  root.dataset.radius = theme.radiusId; // reto | suave | redondo
  root.dataset.font = theme.fontId;
}
```

---

## Próximas Leituras

- `docs/frontend/COMPONENTS.md` - Componentes usados nestas páginas
- `docs/design/DESIGN_TOKENS.md` - Tokens visuais
- `docs/api/API_CONTRACTS.md` - Shapes dos dados consumidos

---

## Implementação do Shell (Onda 2 — Agent-UI-Shell)

Esqueleto navegável: bootstrap, camada de API, estado, rotas e layouts. As telas
de verdade entram por cima disto, sem tocar em nada abaixo.

### Bootstrap

`src/main.tsx` → importa `@/styles/tokens.css` e monta `<App />`.
`src/App.tsx` → `QueryClientProvider` → `ToastProvider` → `RouterProvider`.
(`ToastProvider` fica ACIMA do router porque o guard de papel emite toast.)
O import de `@/stores` registra a ponte de sessão no client HTTP.

### Camada de API (`src/api/` — único lugar com `fetch`)

| Módulo | Assinatura |
|--------|-----------|
| `client.ts` | `http.get/post/patch/put/delete<T>` · `ApiError { code, statusCode, details }` · `setSessionBridge` · `refreshAccessToken` |
| `error-handler.ts` | `createApiErrorHandler({ toast, redirectToLogin })` → `(error) => { error, fieldErrors?, handledSilently }` |
| `query-keys.ts` | `queryKeys` · `queryScopes` · `staleTimes` |
| `ws.ts` | `createWsClient({ queryClient, getToken, toast })` |
| `auth.ts` | `login` · `refresh` · `logout` · `me` |
| `conversations.ts` | `list` · `get` · `sendMessage` · `update` · `assign` · `archive` |
| `proposals.ts` | `list` · `get` · `create` · `updateStatus` · `updateDiscount` · `approve` · `reject` |
| `exams.ts` | `list` · `create` · `update` |
| `analytics.ts` | `conversion` · `pipeline` |
| `themes.ts` | `current` · `update` |
| `users.ts` | `list` · `create` · `update` |
| `internal-chat.ts` | `channels` · `messages` · `send` |
| `audit.ts` | `list` |
| `platform.ts` | `tenants` · `createTenant` · `billing` |

Fachada: `import { api } from '@/api'` → `api.proposals.list(filters)`.
Todos os shapes vêm de `@crm-lab/shared`; respostas parciais de `PATCH` são
`Pick<ProposalDetail, …>` (derivado, nunca redeclarado).

**Interceptor de refresh:** `401 TOKEN_EXPIRED` → `POST /auth/refresh` → repete a
original com o token novo. N requisições que expiram juntas compartilham UM
único refresh (promise em voo). `REFRESH_TOKEN_INVALID` → limpa sessão → `/login`.

### Query keys (fonte única, `src/api/query-keys.ts`)

```
conversations(filters)      ['conversations', filters]
conversation(id)            ['conversation', id]
proposals(filters)          ['proposals', filters]
proposal(id)                ['proposal', id]
exams(filters)              ['exams', filters]
analytics(period)           ['analytics', period]
analyticsPipeline()         ['analytics', 'pipeline']
theme()                     ['theme']
internalChannels()          ['internal-chat', 'channels']
internalMessages(channelId) ['internal-chat', 'messages', channelId]
users(filters)              ['users', filters]        currentUser() ['users','me']
audit(filters)              ['audit', filters]
platformTenants(filters)    ['platform', 'tenants', filters]
platformBilling()           ['platform', 'billing']
```

`queryScopes.*` são os prefixos para invalidar um escopo inteiro.
`staleTimes`: conversas 10s · catálogo 1h · analytics 5min.

### WebSocket

`VITE_WS_URL?token=<accessToken>`. Evento é NOTIFICAÇÃO: cada um chama
`invalidateQueries` com a chave da tabela acima — nunca `setQueryData`.
Reconexão com backoff exponencial (1s → 2s → 4s… teto 30s); ao reconectar,
`invalidateQueries()` sem filtro (pode ter perdido evento na queda).

### Estado (`src/stores/`)

- `useAuthStore` — `{ user, tenant, theme, tokens }` + `setSession` · `setAccessToken` · `clearSession` · `applySessionTheme`. Persistido em `localStorage` (`crm-lab.session`) com `partialize` que só deixa passar sessão.
- `useUIStore` — `{ sidebarCollapsed, contextPanelOpen, activeModal }`.

**Fronteira testada:** `auth.store.spec.ts` falha se qualquer chave de dado de
servidor aparecer no estado ou no que vai para o `localStorage`.

### Tema

`setSession()` chama `applyTheme(response.tenant.theme)` — o tema vem no payload
do login, **sem request extra**. Ao restaurar a sessão persistida,
`onRehydrateStorage` reaplica. `/platform/*` troca para `PLATFORM_THEME`
(`src/routes/platform-theme.ts`) e devolve o tema do tenant ao sair.

### Como uma tela se pluga numa rota

1. crie `src/pages/Attendance.tsx` exportando o componente;
2. em `src/routes/index.tsx`, troque `element: <AttendancePlaceholder />` por `element: <Attendance />`;
3. só isso — guard, papéis, shell, sidebar e header já estão montados.

Dentro da tela:

```tsx
const { data } = useQuery({
  queryKey: queryKeys.conversations(filters),
  queryFn: () => api.conversations.list(filters),
  staleTime: staleTimes.conversations,
});
const handleApiError = useApiErrorHandler();
```


---

## Implementação de Login e Atendimento (Onda 3 — Agent-UI-Attendance)

### Login (`/login`)

`src/pages/Login.tsx`. Campos em pílula (`Input`), submit → `useLogin()` →
`api.auth.login` → `useAuthStore.setSession()` (que **já aplica o tema do
response**, sem request extra) → `navigate(state.from ?? homeFor(role))`.

Erro: **uma frase só** para credencial errada, e-mail inexistente, usuário
inativo e tenant inativo — dizer qualquer outra coisa transformaria a tela em
oráculo de existência de conta. Falha de infraestrutura (rede, `INTERNAL_ERROR`,
`RATE_LIMIT`) tem mensagem própria, porque não fala nada sobre a conta.
Constantes exportadas: `GENERIC_CREDENTIALS_ERROR`, `SYSTEM_ERROR`,
`EMPTY_FIELDS_ERROR`.

### Atendimento (`/attendance`)

`src/pages/Attendance/` — `index.tsx` (estado + queries), `ConversationList`,
`ConversationPanel`, `PatientContext`, `queries.ts`.

| Dado | Chave | staleTime |
|------|-------|-----------|
| lista | `queryKeys.conversations(filters)` | `staleTimes.conversations` (10s) |
| detalhe | `[...queryKeys.conversation(id), messageLimit]` | idem |
| propostas da conversa | `queryKeys.proposals({ conversationId })` | padrão |

A chave do detalhe leva o `messageLimit` no fim para que "carregar mensagens
anteriores" não precise de um segundo cache. Continua derivada de
`query-keys.ts` e continua sendo invalidada pelo evento WS
`conversation.new_message`, que invalida o **prefixo** `['conversation', id]`.

**Decisões registradas (o doc não fixava):**

1. **`markAsRead` não tem endpoint próprio.** `GET /conversations/:id` é quem
   zera o contador no servidor — o contrato mostra a mesma conversa com
   `unreadCount: 3` na lista e `unreadCount: 0` no detalhe. Então abrir a
   conversa É marcar como lida; `useMarkAsRead()` busca o detalhe e **depois**
   invalida `['conversations']`, nessa ordem (invalidar antes traria o contador
   velho de volta).
2. **[Transferir] na distribuição manual devolve a conversa à fila livre**
   (`PATCH /conversations/:id { assignedTo: null }`); quando a conversa já está
   na fila, o mesmo botão vira **[Assumir]** e atribui ao usuário logado.
   Escolher outro atendente depende de `GET /users`, que hoje é só admin.
3. **Filtros:** `Minhas` e `Não atribuídas` são `scope=mine|unassigned`;
   clicar no chip ligado desliga o filtro (`scope=all`). As contagens **nunca**
   são calculadas no cliente: saem de `counts` da resposta.
4. **Bolha 62%** no inbox (ver COMPONENTS.md).
5. **Anexo do composer** só emite um aviso: não existe endpoint de upload em
   `API_CONTRACTS.md` (pedido aberto em STATUS.md).
6. **Cartão de proposta da coluna 3** já chama `useUIStore.openModal({ kind:
   'proposal', id })`; o Modal da Proposta (§6) é de outro agente — falta só
   montá-lo na árvore.

**Pendência conhecida:** paginação de histórico usa `limit` crescente
(`+50` por clique), não `page`. Uma lista infinita de verdade entra quando o
`MessageService` existir e o volume real aparecer.
