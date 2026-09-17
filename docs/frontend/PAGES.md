# 📺 Páginas do Frontend

Especificação das telas: rota, layout, componentes, dados consumidos e permissões. O Agent-UI implementa exatamente estas telas.

---

## Mapa de Rotas

```
/login                        → Login (público)
/                             → redirect por perfil (atendente → /attendance)
/attendance                   → Atendimento (inbox 3 colunas)
/patients                     → Busca de Pacientes
/patients/:id                 → Ficha do Paciente
/budget/new?conversationId=   → Novo Orçamento
/proposals                    → Pipeline de Propostas
/catalog                      → Catálogo de Exames        (rótulo no trilho: "Cadastro de Exames")
/analytics                    → Conversão
/internal-chat                → Chat Interno
/quick-replies                → Respostas rápidas
/decisions                    → Decisões (aprovações)    (gestor+)
/results                      → Resultados (LIS)          (gestor+)
/reconciliation               → Conferência (LIS)         (gestor+)
/active-search                → Busca Ativa (LIS)         (gestor+)
/sales                        → Vendas                    (atendente vê só as próprias)
/settings/channels            → Canais & Equipe          (admin; gestor lê)
/settings/operation           → Gestão da Operação        (gestor+)
/settings/insurances          → Convênios                 (gestor+)
/settings/attendants          → Atendentes (LIS)           (gestor+)
/settings/commissions         → Comissão (LIS)            (gestor lê; admin edita)
/settings/users               → Usuários & Permissões     (admin)
/settings/theme               → Personalização            (admin)
/platform/tenants             → Laboratórios Clientes     (operador plataforma)
/platform/billing             → Assinaturas & Uso         (operador plataforma)
```

**Guard de rotas:** cada rota declara `requiredRoles`; usuário sem permissão → redirect + toast. O servidor TAMBÉM valida (a UI esconde, o servidor recusa).

### Papéis por rota (implementado em `src/routes/route-config.ts`)

**Grupos do trilho (accordion, CRMLAB-4; revisado em D-129):** itens sem grupo ficam soltos no
topo; os grupos aparecem depois, na ordem Comunicação → Gestão → Configurações. "Gestão" funde os
antigos grupos "Comercial" e "LIS / Operação Laboratorial" (D-129: usuário achou os dois grupos
redundantes na validação de D-128). "Cadastro de Exames" (rota `/catalog`) saiu de lá e passou a
`/catalog` → Configurações. Grupo sem nenhum item visível para o perfil não aparece. Abertos por
padrão; estado por grupo persiste em localStorage por usuário.

| Rota | `requiredRoles` | No trilho da Sidebar | Grupo |
|------|-----------------|----------------------|-------|
| `/login` | — (público) | não | — |
| `/` | qualquer sessão → redirect por perfil | não | — |
| `/attendance` | attendant · manager · admin | sim | solto |
| `/patients` | attendant · manager · admin | sim | solto |
| `/patients/:id` | attendant · manager · admin | não | — |
| `/budget/new` | attendant · manager · admin | não | — |
| `/proposals` | attendant · manager · admin | sim | solto |
| `/catalog` (rótulo "Cadastro de Exames") | attendant · manager · admin | sim | Configurações |
| `/analytics` | attendant · manager · admin | sim | Gestão |
| `/internal-chat` | attendant · manager · admin | sim | Comunicação |
| `/quick-replies` | attendant · manager · admin | sim | Comunicação |
| `/decisions` | manager · admin | sim | Gestão |
| `/results` | manager · admin | sim | Gestão |
| `/reconciliation` | manager · admin | sim | Gestão |
| `/active-search` | manager · admin | sim | Gestão |
| `/sales` | attendant · manager · admin | sim | solto |
| `/settings/channels` | manager · admin | sim | Configurações |
| `/settings/operation` | manager · admin | sim | Gestão |
| `/settings/insurances` | manager · admin | sim | Configurações |
| `/settings/attendants` | manager · admin | sim | Configurações |
| `/settings/commissions` | manager · admin | sim | Configurações |
| `/settings/users` | admin | sim | Configurações |
| `/settings/theme` | admin | sim | Configurações |
| `/platform/tenants` | platform_operator | sim | solto (console) |
| `/platform/billing` | platform_operator | sim | solto (console) |

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
- **Fixar (Onda 8 §2.3):** alfinete à direita de cada item — `POST/DELETE /conversations/:id/pin`.
  O pin é **pessoal**: fixadas vêm primeiro na SUA lista e nada muda para as colegas. Os chips
  não mudam de número (fixar organiza, não filtra)
- Dados: `GET /conversations` + WS `conversation.new_message` (refetch)

### Coluna 2 — Conversa
- Header: nome, telefone, botões [Transferir ▾] [Novo Orçamento] [Arquivar]
- **[Transferir ▾] abre menu** (Onda 8 §2.1) com as colegas que podem receber
  (`GET /conversations/assignees`) e "Devolver para a fila". O rótulo é "Atribuir" enquanto a
  conversa está livre. Quem já é dona não aparece na lista. Os dois caminhos são o mesmo
  `PATCH /conversations/:id` — alçada e mensagem de sistema são do backend
- Bolhas: recebida / enviada / evento de sistema (3 tipos, máx. 62% largura)
- Composer: input pílula + anexos + **emoji** + enviar. O emoji entra na posição do cursor
  (Onda 8 §2.2), grade fixa de 48, sem dependência nova
- Dados: `GET /conversations/:id`, `POST /conversations/:id/messages`
- Ao abrir: `markAsRead`

### Coluna 3 — Contexto do paciente (recolhível)
- Cadastro resumido, propostas da conversa (cartões clicáveis → modal), tags
- **Link "Ver ficha completa" → `/patients/:id`**, a porta de entrada da Ficha (§3). Usa
  `conversation.patientId` (D-079), que vem em `GET /conversations/:id`. Conversa anterior ao
  backfill da migração 003 tem `patientId: null` e **o link não é renderizado** — nem link
  quebrado, nem botão desabilitado sem explicação

---

## 2a. Busca de Pacientes (`/patients`)

Tela de consulta avulsa (fora do inbox): quem precisa achar um paciente sem estar numa conversa
ativa — ex. telefone ligou perguntando de um orçamento antigo. **Não é tela nova de dado**: usa
exatamente `GET /patients` (API_CONTRACTS.md §2c), o mesmo endpoint que já serve o bloco
"Pacientes" da busca do inbox (§2), agora com página própria, paginação completa (não só
`limit=5`) e sem exigir estar dentro do Atendimento.

**Papéis:** attendant · manager · admin (mesmo recorte de `/patients/:id`, D-060 — cada papel só
enxerga quem já veria por uma conversa). `platform_operator` não acessa (§11).

**Layout:** `PageContainer` + `PageHeader` padrão (título "Pacientes"), um campo de busca e uma
`DataTable` paginada.

- **Busca (`SearchInput`, debounce 300ms):** um único campo, rotulado "Buscar por nome, CPF ou
  telefone" — o servidor já casa as três coisas em OR dentro de `?search=` (nome por full-text,
  telefone e documento por dígitos, mínimo 3 dígitos para os dois). Três campos separados exigiam
  filtro AND por campo no backend, que o contrato não tem; um campo só já cobre o pedido de
  "achar paciente por nome, CPF ou telefone" sem inventar parâmetro novo (Regra Zero).
- **Tabela:** colunas Nome, Telefone, CPF (formatado `000.000.000-00` quando 11 dígitos,
  senão o valor cru), Última interação (`DateDisplay`, `—` quando `null`). Linha clicável → 
  `/patients/:id`.
- **Paginação:** `Pagination` (`components/shared`), 20 por página (default do contrato).
- **Vazio:** "Nenhum paciente encontrado" sem termo de busca preenchido também é possível
  (tenant novo) — mesmo componente `EmptyState` da tabela.
- Dados: `GET /patients?search=&page=&limit=` — sem WS, sem refetch automático (cadastro muda
  devagar; `staleTimes.patients`, 30s, já cobre).

---

## 3. Ficha do Paciente (`/patients/:id`)

- Página de leitura: max-width 1180px, padding 30px 36px 48px
- `:id` é o **id do paciente** (`patients.id`, D-059), não o da conversa. O inbox chega aqui
  pelo `patientId` da conversa; conversa anterior ao backfill tem `patientId: null` e o link
  não aparece
- **Portas de entrada** (D-079) — a ficha não é alcançável só por URL:
  1. Atendimento, coluna 3: "Ver ficha completa" (`conversation.patientId`);
  2. Atendimento, coluna 1: bloco "Pacientes" da busca (`GET /patients`);
  3. Gestão da Operação (§10): nome do paciente na fila (`QueueItem.patientId`);
  4. Busca de Pacientes (`/patients`, §2a).
  Em todas, `patientId: null` vira texto puro — o link só existe quando o cadastro existe
- **Botão "Enviar mensagem"** no cabeçalho (D-107): chama `POST /conversations` com o telefone
  e nome do paciente (`channel: "direct"` — mesmo `findOrCreateByPhone` de D-059/D-089, nenhum
  endpoint novo) e navega para `/attendance?conversationId=<id>`, o mesmo deep-link de "Enviar
  orçamento". `409 CONVERSATION_ALREADY_ASSIGNED` (telefone com conversa de outro atendente) vira
  toast com o nome de quem está atendendo — não navega.

**Três chamadas, três blocos** — a ficha NÃO vem em um payload só (D-060). Cada bloco tem seu
ciclo de atualização e sua paginação:

| Bloco | Chamada | Observação |
|-------|---------|------------|
| Cadastro completo (editável) | `GET /patients/:id` → `PATCH /patients/:id` | `PatientDetail` cru; `null` apaga campo, ausente preserva; `phone` é editável (D-106) mas nunca apagável — número já usado por outro paciente vira `409 CONFLICT` |
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
- Segmentado de 4 modos: [Catálogo | Pedido médico | IA | Pacotes]. **Pedido médico** e **IA**
  continuam sem conteúdo implementado (placeholder "ainda não disponível nesta tela") — bug
  CRMLAB-13, backlog separado; o segmento **Pacotes** foi implementado nesta onda (CRMLAB-10,
  D-130) e deixou de cair no conteúdo do Catálogo por engano (defeito que também fazia parte de
  CRMLAB-13, corrigido de passagem: os 3 segmentos sem conteúdo próprio mostravam a lista de
  exames por trás, porque a renderização não olhava para `segment` antes desta correção).
- **Segmento Pacotes:** lista de pacotes ativos (`GET /exam-packages?active=true[&insuranceId=]`,
  sem paginação — até 100, mesmo espírito de seletor do resto da coluna, D-080), cada um com
  nome, contagem de exames e o preço agregado (`effectivePrice ?? pricePrivate` do PACOTE —
  prévia, considerando o convênio selecionado e a tabela própria do pacote,
  `exam_package_prices`). Clicar expande em **N linhas no resumo**, uma por exame incluído, com
  o `pricePrivate` de cada `ExamPackageItem` — **não** o `effectivePrice` do pacote, que só serve
  de prévia agregada aqui no seletor (motivo em SCHEMA.md §30/DECISIONS.md D-130: a listagem de
  pacotes não expõe preço por-convênio POR ITEM, só do pacote inteiro). Mesmo merge por `examId`
  de adicionar exame avulso — exame já no carrinho soma quantidade em vez de duplicar linha.
  Depois de expandido, o desconto geral do orçamento continua sendo o `DiscountSection` já
  existente (o desconto% do pacote não se propaga automaticamente — ele só entra no preço
  MOSTRADO do pacote no seletor).
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
- **Médico solicitante (`Input` de texto, CRMLAB-9):** campo livre, opcional, sem
  autocomplete/cadastro de médicos — só registra o nome digitado. Vazio não bloqueia
  [Criar orçamento]; string em branco é normalizada para `null` pelo backend
  (API_CONTRACTS.md §3)
- **Total: rodapé fixo da coluna**, sempre derivado (nunca digitado)
- Botão [Criar orçamento] → `POST /proposals` (com o `insuranceId` escolhido e o
  `requestingDoctor` digitado) → redirect para conversa

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
  `insuranceId`; "Particular" quando `null`), **médico solicitante** (texto,
  CRMLAB-9 — só aparece quando `requestingDoctor` não é `null`; sem linha/label
  quando a proposta não tem médico informado), itens + preços (badge
  "Particular" por item nas mesmas condições da coluna de resumo de
  `/budget/new`), desconto, total derivado, alerta de aprovação (se pending),
  histórico de estágios, ações
- Ações (uma linha): [Mudar estágio ▾] à esquerda, [Marcar como ganho] (accent-2) à direita, [Marcar como perdido] fantasma ao fim
- "Perdido" abre sub-form com motivo OBRIGATÓRIO (select: preço, silêncio, exame indisponível, prazo, outro)
- Dados: `GET /proposals/:id`, `PATCH /proposals/:id/status`

---

## 7. Catálogo de Exames (`/catalog`)

- **Duas abas** (`SegmentedControl`, D-130): [Exames | Pacotes]. Trocar de aba reinicia busca e
  página (mesmo `?page=` da URL, compartilhado — os conjuntos são diferentes, então trocar de
  aba se comporta como trocar de filtro).

### Aba Exames
- Tabela: nome, código, preparo, **TUSS, material**, prazo, preço particular, preço convênio, status
- Regras de tabela: container com min-width + overflow-x, cabeçalho 11px caixa alta, valores à direita
- Atendente: somente leitura. Gestor/Admin: criar/editar (modal, botão "+ Novo Exame")
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

### Aba Pacotes (`PackageTable`, CRMLAB-10, D-130)
- Tabela: nome, exames incluídos (nomes separados por vírgula), desconto %, preço particular
  (`pricePrivate`, sempre calculado — soma dos exames menos o desconto), status
- Mesma paginação/busca/alçada da aba Exames — atendente só leitura, gestor/admin
  cria/edita (botão "+ Novo Pacote")
- Dados: `GET /exam-packages`, `POST/PATCH /exam-packages` (gestor+)
- **Modal do pacote (`PackageModal`):** nome, desconto % e um seletor de exames (busca +
  checkbox, até 100 exames ativos por vez — teto do contrato). Mostra uma prévia do preço
  particular (`calculatePackagePrivatePrice`, `@crm-lab/shared`) enquanto o usuário monta o
  pacote, a partir dos exames já carregados na busca atual.
  **Limitação conhecida:** se o pacote (em edição) inclui um exame que não está entre os
  carregados pela busca corrente (por ex. um exame cujo nome não bate com o termo digitado, ou
  além do 100º da lista), o checkbox dele não aparece na tela — ele continua marcado no estado
  (`examIds`) e é preservado se o usuário salvar sem tocar na lista, mas fica invisível até uma
  busca que o traga de volta. Não é um bug ativo (nenhum exame se perde), é uma
  ergonomia a melhorar numa v2 (ex.: sempre incluir os já selecionados na consulta,
  independente do termo de busca).
  Em **modo edição**, segunda aba "Preços por convênio" (`PackagePricesTab`) — mesmo mecanismo
  de `ExamPricesTab`, aplicado a `exam_package_prices`.
- Dados da aba de preços: `GET /exam-packages/:id/prices` (todos os papéis) ·
  `PUT /exam-packages/:id/prices` (gestor+) — mesma semântica de PUT do §4.

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

### Buscar usuário (D-101) — iniciar conversa direta

No topo da coluna esquerda, ACIMA dos grupos "Canais" e "Mensagens diretas", um campo de
busca (`SearchInput`, debounce de 300ms) filtra em memória a lista de `GET
/internal-chat/users` (exclui o próprio usuário e inativos, sem paginação — carregada
inteira uma vez). A barra lateral **não** lista usuários permanentemente — só canais e
DMs já abertas; a lista de resultados da busca aparece embaixo do campo apenas enquanto
o usuário digita, e some ao selecionar um nome ou limpar o campo.

Clicar num resultado chama `POST /internal-chat/dms { userId }` (get-or-create
idempotente — clicar de novo num usuário com quem já existe DM só abre a conversa
existente, nunca duplica), seleciona o canal devolvido (mesmo comportamento de clicar
num canal da lista) e a busca é limpa — a partir daí a conversa aparece normalmente no
grupo "Mensagens diretas".

Uma DM mostra o nome do OUTRO participante (`Channel.otherUserName`), nunca o `name`
bruto gravado no canal — dois usuários da mesma DM veem nomes diferentes um do outro.
Sem notificação em tempo real de "nova DM": o destinatário só vê a conversa aparecer
quando a primeira mensagem chega (mesmo evento `internal_chat.new_message` de sempre).

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

### Badge de não lidas no menu lateral (D-132 — CRMLAB-8)

O item "Chat Interno" da Sidebar (`COMPONENTS.md` — Sidebar) mostra um `Badge` com a soma de
`Channel.unreadCount` de todos os canais (mesma lista de `GET /internal-chat/channels` que a
tela usa, cache compartilhado via `queryKeys.internalChannels()` — sem endpoint novo). Se o grupo
"Comunicação" estiver **recolhido** e esse total for maior que zero, o mesmo `Badge` (com o
mesmo total) aparece no cabeçalho do grupo, no lugar do ponto de "item ativo dentro" (D-128);
some ao abrir o grupo, ao entrar num canal (unread zera) ou ao chegar a zero. Sem som e sem
notificação push do navegador — só esse indicador visual dentro do próprio CRM.

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

### 11.1 Detalhe do Laboratório (`/platform/tenants/:id`) — drill-down, D-102

Não é item de sidebar — chega-se clicando numa linha da tabela de "Laboratórios Clientes"
(`DataTable` já suporta `onRowClick`). Fonte: `GET /platform/tenants/:id`
(`TenantDetail` — API_CONTRACTS.md §5b).

- **Cabeçalho:** nome, slug, badge de plano, badge ativo/inativo, criado em — mesmos campos da
  linha da lista, só que num card maior.
- **Integrações:** um cartão por item de `channels[]` — nome do canal (WhatsApp/SMS/Web/Direct),
  badge conectado/desconectado (`isActive`), modo de conexão (`cloud_api`/`qr`), "conectado
  desde" (`connectedAt`, ou "nunca conectou" se nulo). Nunca mostra número de telefone nem
  token — a tela não tem esse dado (a API não devolve).
- **Saúde de uso:** `StatTile`s reaproveitados de "Assinaturas & Uso" (§Billing) — usuários
  ativos/total, último login, propostas no mês, mensagens no mês. Mesma fonte agregada
  (`usage`), sem nome de paciente nem conteúdo.
- **Ação "Suspender"/"Reativar":** botão cujo rótulo muda conforme `isActive`; abre diálogo de
  confirmação (mudar o acesso de um cliente pagante é ação séria, não é um toggle direto) →
  `PATCH /platform/tenants/:id { isActive }`.
- **Ação "Trocar plano":** select com os planos do catálogo + confirmação →
  `PATCH /platform/tenants/:id { subscriptionPlan }`.
- **Ação "Resetar senha do admin":** fonte é `admins[]` (só e-mails, nunca nome). Zero admins →
  botão desabilitado ("nenhum admin cadastrado"); um → botão direto; mais de um → escolher o
  e-mail antes de confirmar. Confirma → `POST
  /platform/tenants/:id/users/:userId/reset-password` → a senha temporária aparece **uma vez**
  num modal com aviso de que não será mostrada de novo e botão de copiar; o modal não guarda a
  senha depois de fechado.

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

## 13. Respostas rápidas (`/quick-replies`) — Onda 8 §3

Página própria, **`TENANT_ROLES`** — atendente, gestor e admin criam, editam e apagam.

**Por que não é uma aba de "Canais & Equipe" (§10):** aquela rota é `MANAGER_PLUS`, e
barraria exatamente quem o lead quer que escreva as macros. Também não é o mesmo tipo de
coisa — configurar canal de WhatsApp é ato de administração; escrever resposta pronta é
ferramenta de trabalho diária. Misturar as duas obrigaria a inventar permissão por aba
dentro de uma tela, que é a solução que ninguém consegue auditar depois.

- Lista em cartões: `/atalho` em destaque, título, e o conteúdo em 2 linhas truncadas.
  Fonte: `GET /quick-replies` (§9) — lista inteira, sem paginação
- [Nova resposta] abre formulário inline com `shortcut`, `title` e `content`. O campo do
  atalho mostra o `/` como prefixo fixo: a barra faz parte de como se usa, não do que se
  grava
- Editar reaproveita o mesmo formulário, preenchido. Apagar pede confirmação — é `DELETE`
  real (§9), a linha não volta
- Erro de atalho repetido chega como `VALIDATION_ERROR` com `details.fields.shortcut` e
  marca **o campo**, não um toast genérico
- Vazio: "Nenhuma resposta rápida ainda" + o que a funcionalidade faz, porque uma lista
  vazia sem explicação não ensina que existe `/` no Composer

**No trilho da Sidebar** (ícone próprio), junto com as telas de operação — não em
Configuração: quem usa isso é quem atende.

### Uso no Composer (§2)

Digitar `/` **com o campo vazio** abre a lista sobre o Composer, filtrando por atalho
conforme se digita. Escolher **substitui** o texto pelo `content`. Setas navegam, `Enter`
escolhe, `Esc` fecha.

A restrição "campo vazio" é deliberada: disparar em qualquer `/` atrapalharia quem escreve
"km/h", "24/48h" ou uma URL. Sem macro que case com o filtro, o menu fecha sozinho e a
`/` fica no campo como texto normal — o atalho nunca sequestra o que a pessoa quis digitar.

---

## Telas do LIS (Onda 10)

Seis telas novas sobre o domínio "Orçamentos do LIS" da Onda 9 (`API_CONTRACTS.md` §5c/§6b/§10-12,
`shared/types/lis.types.ts`). Nenhuma escreve em `lis_budgets` diretamente — a única entrada é a
importação (§14). Filtros de período/atendente/convênio são **globais** entre `/results`,
`/reconciliation` e `/active-search` (D-117, ver `## Estado Global` abaixo): trocar o período em
uma tela e navegar para outra preserva a escolha, porque as três respondem à mesma pergunta
operacional ("como estão os orçamentos deste período").

### 14. Resultados (`/results`) — gestor+

Home do domínio LIS — o "Dashboard" do FluxoLab, redesenhado a partir da referência visual real
da tela equivalente (validação da Onda 10 trouxe screenshots do produto em produção). Duas fontes
de dados coexistem, cada uma com um papel:

- **`GET /lis-budgets/summary`** (período + convênio, §10.2) — KPIs, gráfico de atendentes,
  distribuição por convênio e a base do "Detalhe por atendente". **Suporta filtro de convênio**
  (ao contrário do que a Fase 0 original previa — a referência real tem esse filtro).
- **`GET /reports/executive`** (só período, §5c) — usado **apenas** para "Exportar Relatório
  Executivo": o PDF é o retrato do período inteiro, sem o filtro de convênio da tela (D-116 —
  o PDF nunca pode secretamente refletir um filtro que a próxima pessoa a abrir a tela não vê
  marcado). É por isso que os dois endpoints coexistem em vez de um só fazer as duas coisas.
- **`GET /sales/summary`** (sem `attendantId`, §11) — `byAttendant` entra na tabela de comissão.
- **`GET /settings/commissions`** — percentuais para os cálculos de comissão da tabela.

#### Cabeçalho

- `PeriodFilter` (padrão: últimos 30 dias, D-117) + botão **"Limpar período"** (volta ao
  default) + `Select` de **Convênio** (`GET /lis-budgets/filters`, opção fixa "Todos os
  convênios" no topo) — os três compartilhados com Conferência/Busca Ativa via
  `useUIStore.lisFilters` (D-117).
- **"Última atualização em ...":** `GET /lis-imports/latest` — nome do arquivo + data/hora;
  `null` vira "Nenhuma importação ainda".
- Botão **"Exportar Relatório Executivo"** — PDF via `GET /reports/executive` (ver acima).

#### Grade de KPIs (4 `KpiCard`)

1. **Total Orçado** — `issued.totalValue` + `issued.count` ("N orçamentos"). Cartão com destaque
   visual (fundo escuro/accent) — é o número âncora da tela. `deltaPct`: variação vs. o período
   **imediatamente anterior de mesma duração** — calculada no CLIENTE com um segundo fetch de
   `/lis-budgets/summary` para esse período anterior (mesmo convênio, sem `attendantId`); sem
   endpoint novo. `previous.issued.totalValue === 0` → sem `deltaPct` (evita `Infinity`/`NaN`,
   mesma disciplina de `percent()`).
2. **Em Requisição** — `requisition.totalValue`/`.count` (D-125: orçamentos **convertidos em
   requisição** no período, pagos OU pendentes — **não é** a mesma pergunta de Busca Ativa, §16,
   que é só a fatia sem pagamento) + "X% do total" = `requisition.totalValue / issued.totalValue`
   (0 quando `issued.totalValue` é 0).
3. **Recebido** — `paid.totalValue`/`.count` + "X% do total" (mesma fórmula) + barra de
   `paid.conversionQty` (já capada em 100% pelo servidor — a tela nunca reaplica o cap).
4. **Atendentes** — `byAttendantDetail.length` (quantos atendentes tiveram orçamento no
   período) + rótulo "N ativo(s) no período".

#### Gráficos

- **Faturamento por atendente:** barras horizontais, `byAttendantDetail` (D-122 — TODOS os
  atendentes, não só o top 6 de `byAttendant`) ordenado por `paidValue` desc. Eixo em `MoneyDisplay`
  (variante `thousands` para caber).
- **Distribuição por convênio:** donut (`byInsurance`, top 6) + legenda com nome, valor e "%
  do total exibido" (`totalValue / soma dos 6`); quando `issued.totalValue` for maior que a soma
  dos 6 mostrados, uma linha extra "Outros" fecha a diferença (`issued.totalValue - soma`) — nunca
  inventa um valor negativo (`Math.max(0, …)`).

#### Detalhe por atendente (tabela de comissão)

Combinação, feita no CLIENTE, de `byAttendantDetail` (orçado/pago/conversão) + `salesSummary
.byAttendant` (vendas de exames/check-up) + `commissionSettings` (percentuais) — por
`attendantId`. **Nenhum endpoint novo faz esse join** (D-122): `lis_budgets` e `sales` são
domínios de leitura separados por design (D-108/D-112), e a tela é o único lugar que precisa da
visão combinada.

Colunas: Atendente · Orçado (`issuedCount`) · Recebido (`paidValue`, `MoneyDisplay`) ·
Conversão % (`paidCount / issuedCount`, capado em 100%, mesma fórmula do agregado) · Comissão
sobre orçamento (`paidValue × commissionBudgetPct / 100`) · Vendas de exames · Comissão sobre
exames (já vem calculada em `byKind.exams.commissionValue`) · Vendas de check-up · Comissão sobre
check-up · **Comissão total** (soma das três comissões da linha). Linha **TOTAL** ao final,
somando cada coluna — nunca recalculada de outro jeito que não seja a soma das linhas exibidas.
Atendente sem venda no período aparece com as colunas de venda zeradas (`0`), não ausente da
tabela — a base é `byAttendantDetail` (todo atendente com orçamento), `LEFT JOIN` com vendas.

Badge **"% Comissão: X%"** ao lado do botão de exportar mostra `commissionBudgetPct` (o percentual
usado na coluna "Comissão sobre orçamento" desta mesma tabela — os outros dois percentuais
aparecem no cabeçalho de suas próprias colunas).

**Exportar** (dois botões lado a lado, "Comissão em PDF" e "Comissão em Excel" — D-123, sem
componente de menu novo): geram no CLIENTE a partir da MESMA tabela já montada (nunca um segundo
fetch). PDF via `jspdf`/`jspdf-autotable` (mesmo padrão dos outros dois relatórios, paisagem por
ter mais colunas); Excel via `xlsx` — uma aba, mesmas colunas da tabela, linha TOTAL ao final,
nome de arquivo `comissoes-<startDate>-<endDate>.xlsx`.

- **Sem dado no período:** cartões zerados + "Nenhum orçamento importado neste período" no lugar
  dos gráficos/tabela — período sem movimento é estado normal, não falha.

#### Modal Importar (usado em `/results` e `/reconciliation`)

- `UploadDropzone` aceita **um único `.xlsx`**, convertido para base64 no cliente →
  `POST /lis-imports { fileName, contentBase64 }` (§10.1). Arquivo maior que 10 MiB é recusado
  **antes do upload** (checagem local, mesmo teto do servidor `LIS_IMPORT_MAX_BYTES`) — evita
  gastar banda com um arquivo que o servidor rejeitaria de qualquer forma.
- Enquanto processa: spinner com "Importando planilha..." (pode levar alguns segundos — chunks
  no servidor). Sem barra de progresso real: o servidor responde uma vez, no fim.
- Sucesso: resumo `rowsAccepted`/`rowsRejected` do `LisImport` retornado + toast; fecha o modal e
  invalida as queries de `lis-budgets`/`lis-imports`/`reports`.
- Erro `VALIDATION_ERROR` com `details.reason`: mensagem específica por `reason` —
  `pdf_disguised` → "este arquivo é um PDF, não uma planilha"; `missing_column` → "a planilha
  precisa ter a coluna ORÇAMENTO"; `empty` → "a planilha não tem nenhuma linha de dado". Nunca
  um "erro genérico" para esses três casos — são os três jeitos reais de uma planilha do Santé
  vir errada.
- `MEDIA_TOO_LARGE` (413): mesma mensagem do teto local, caso a checagem do cliente falhe por
  algum motivo (extensão errada no tamanho, etc.).

#### "Limpar base" (purge) — admin apenas

- Botão em `/results` (área de administração da tela, não no fluxo normal de leitura) abre
  diálogo pedindo para **digitar `LIMPAR`** num campo de texto antes de habilitar o botão de
  confirmação — mesma string exigida pelo servidor (`POST /lis-imports/purge { confirm:
  "LIMPAR" }`, §10.1). Digitar qualquer outra coisa mantém o botão desabilitado; a tela não
  chama o servidor para "adivinhar" se a confirmação está certa.
  **Motivo do dígito exato (não um checkbox):** apagar toda a base de orçamentos do LIS do
  tenant é irreversível — a barreira de UI espelha a barreira do servidor de propósito (D-109),
  para que nem um clique automatizado nem um clique apressado do próprio admin passe batido.
- Sucesso: toast + invalida todas as queries de `lis-budgets`/`reports`; a tela volta ao estado
  "Nenhum orçamento importado ainda". O `LisImport` de `kind: "purge"` aparece no histórico de
  "Última atualização" como qualquer outro evento.
- Botão **ausente do DOM** para quem não é admin (mesmo padrão de `Settings/Insurances.tsx`,
  §10) — não existe controle de escrita para desabilitar porque o papel não vê a área.

### 15. Conferência (`/reconciliation`) — gestor+

Listagem crua e paginada dos orçamentos importados — a tela de "olhar linha por linha", para
quem a home (§14) não responde. Fonte: `GET /lis-budgets` (§10.2).

- **Filtros** (compartilhados com §14/§16 via D-117): `PeriodFilter` (janela de **emissão**),
  atendente, convênio, busca por nome de paciente (`SearchInput`, debounce 300ms).
- **Tabela** (`DataTable` + `Pagination`, §Compartilhados): número, emitido em, paciente,
  convênio principal, valor total, atendente, nº requisição, valor pago, pago em. Colunas de
  data usam `DateDisplay`; valores usam `MoneyDisplay`.
- **Ordenação** por cabeçalho de coluna (`sortBy`/`order` — só `issuedOn`, `number`,
  `totalValue`, conforme o contrato); as demais colunas não ordenam pelo servidor e não fingem
  que ordenam (sem seta de ordenação nelas).
- Linha sem `paidValue`/`paidOn` (ainda não pago) mostra "—" nas duas colunas — não `R$ 0,00`,
  que sugeriria pagamento de valor zero em vez de ausência de pagamento.
- Botão **[Importar]** reaproveita o mesmo modal de §14 (mesmo componente, duas entradas).
- Vazio (filtro sem resultado): "Nenhum orçamento neste filtro" — distinto de "nenhuma
  importação ainda" (§14), que é vazio por ausência total de dado.

### 16. Busca Ativa (`/active-search`) — gestor+

Fila de cobrança: orçamentos com requisição emitida mas **sem pagamento recebido**. Fonte:
`GET /lis-budgets/pending` + `GET /lis-budgets/pending/summary` (§10.2).

- **Cartões de topo:** total (contagem + valor) e um `KpiCard` por faixa de idade
  (`byAgeBand`: `0-7`, `8-15`, `16-30`, `30+`) — as **4 chaves sempre presentes**, `0`/`0` onde
  não há linha (a tela não omite cartão de faixa vazia).
- **Filtros:** atendente + `ageBand` (clicar num cartão de faixa filtra a tabela por ela —
  atalho de UX, não substitui o seletor).
- **Tabela:** número, paciente, convênio principal, valor total, atendente, nº requisição, valor
  da requisição, emitido em, `AgeBadge` (dias em aberto + a faixa, com tom crescente de urgência
  conforme a faixa — nunca cor isolada sem o número ao lado, D5 acessibilidade).
- Ordenação fixa por `daysOpen DESC` (o mais antigo primeiro) — **sem** seletor de ordenação
  nesta tela: é uma fila de cobrança, não um relatório para reordenar à vontade.
- Vazio: "Nenhum orçamento em aberto" — estado bom (fila zerada), tela mostra com tom positivo,
  não como ausência de dado.

### 17. Vendas (`/sales`) — TENANT_ROLES, recorte por atendente (D-112)

Lançamento de vendas avulsas de exame/check-up e o cálculo de comissão. Fonte: `GET /sales`,
`POST /sales`, `DELETE /sales/:id`, `GET /sales/summary` (§11).

- **Atendente** vê e lança **só as próprias vendas** — o filtro de atendente da tela nem aparece
  para esse papel (o servidor já recorta por `attendants.user_id`, mas a tela não pede um dado
  que o próprio atendente não escolhe). Login de atendente **sem vínculo** em `attendants`
  (D-112 — vínculo é manual, feito em `/settings/attendants`, §18) recebe
  `SALE_ATTENDANT_NOT_LINKED` ao tentar lançar: mensagem explícita "seu usuário ainda não está
  ligado a um atendente — peça a um gestor para vincular em Configurações → Atendentes", nunca
  um erro genérico de formulário.
- **Gestor/admin** veem e lançam venda para qualquer atendente do tenant — campo "Atendente"
  (`Select`) aparece só para esses papéis, populado por `GET /attendants?active=true`.
- **Cartão de resumo:** `GET /sales/summary` — `byKind` (exames/check-up: contagem, valor,
  `commissionValue`) + `totalValue` + `commissionTotal`. `commissionValue` já vem calculado pelo
  servidor a partir dos percentuais de `/settings/commissions` (§19) — a tela nunca multiplica
  percentual localmente.
- **Lançar venda** (formulário/modal): data (não futura), código (opcional), valor (`> 0`),
  exames (texto livre, opcional), tipo (`exames | check-up`). Sucesso invalida a lista e o
  resumo.
- **Apagar:** confirmação simples ("apagar esta venda?") — é `DELETE` real, sem histórico
  dependente (§11); atendente só vê o botão nas próprias linhas, gestor/admin em todas.
- **Filtros:** período (`soldOn`), tipo, e atendente (só para gestor/admin).

### 18. Atendentes (`/settings/attendants`) — gestor+

Cadastro do atendente do LIS, com vínculo opcional a um login do CRM (D-112). Fonte:
`GET /attendants`, `POST /attendants`, `PATCH /attendants/:id` (§12).

- **Tabela:** nome, status (ativo/inativo), usuário vinculado (`userName` ou "— sem login —"
  quando `userId` é `null`). Busca por nome (`?search=`, sem caixa/acento).
- **Criar/editar (modal):** nome + seletor opcional de usuário. A lista de logins vem de
  `GET /settings/channels` (`team`, §6/D-066) — **não** de `GET /users`, que é admin apenas e
  bloquearia o gestor de montar o seletor (a rota desta tela é gestor+). `team` já traz id/nome/
  papel/status de todo o tenant; a tela filtra localmente por papel de laboratório
  (`attendant | manager | admin`) e ativo. Nome duplicado por `foldedName`
  (espaço/caixa não contam) → `CONFLICT`: mensagem "já existe um atendente com esse nome",
  campo marcado — nunca cria uma segunda linha silenciosamente.
- **Desvincular login:** no modal de edição, limpar o seletor de usuário e salvar envia
  `userId: null` — desliga o vínculo sem apagar o atendente (útil para desfazer vínculo errado
  da migração do Santé, D-120).
- **Sem `DELETE`** (D-004, mesmo padrão de `/catalog` e `/settings/insurances`): desativar é
  `PATCH { isActive: false }`. Atendente inativo continua aparecendo (com o vínculo histórico
  em `lis_budgets`/`sales`), só sai dos seletores de "atendente ativo" de outras telas.
- Botão "Novo Atendente" e coluna de ações **ausentes do DOM** para quem não é gestor/admin.

### 19. Comissão (`/settings/commissions`) — gestor lê, admin edita

Percentuais de comissão sobre venda de exame e de check-up (D-113 — antes viviam em
`localStorage` no FluxoLab, agora por tenant). Fonte: `GET /settings/commissions`,
`PATCH /settings/commissions` (§6b).

- **Três campos numéricos** (`commissionBudgetPct`, `commissionExamsPct`,
  `commissionCheckupPct`): 0 a 100, até 2 casas decimais. `commissionBudgetPct` fica visível
  nesta tela mas **não é usado por nenhum cálculo desta onda** (`GET /sales/summary` só aplica
  `commissionExamsPct`/`commissionCheckupPct`) — é comissão sobre orçamento conciliado, que só
  passa a valer na Onda 13 (D-119). A tela não esconde o campo (ele já existe no contrato e o
  admin pode querer configurar com antecedência), mas o rótulo indica "usado a partir da
  conciliação de orçamentos".
- Tenant sem configuração prévia recebe os defaults do servidor (2,00 / 1,50 / 1,50) sem gravar
  nada — a tela não distingue esse caso de uma configuração explícita: os três campos aparecem
  preenchidos do mesmo jeito.
- **PATCH parcial:** salvar envia só os campos alterados (o formulário rastreia dirty fields);
  campo fora de 0–100 é `VALIDATION_ERROR` com `details.fields`, marcado no campo, sem submeter.
- Gestor vê os três campos **desabilitados**, sem botão salvar (mesmo padrão de leitura de
  `/settings/insurances` para quem não edita) — o servidor recusaria o `PATCH` de qualquer
  forma (403, `details.requiredRoles: ["admin"]`).

---

## Estado Global (Zustand + TanStack Query)

```typescript
// Zustand: estado de UI e sessão
useAuthStore:    { user, tenant, theme, tokens }
useUIStore:      { sidebarCollapsed, contextPanelOpen, activeModal,
                   lisFilters: { startDate, endDate, attendantId, insuranceId } } // D-117

// TanStack Query: TODOS os dados de servidor
queryKeys: ['conversations', filters], ['conversation', id],
           ['proposals', filters], ['proposal', id],
           ['exams', filters], ['analytics', period], ['theme'],
           ['lis-budgets', filters], ['lis-budgets-summary', filters],
           ['lis-budgets-pending', filters], ['lis-imports-latest'],
           ['reports-executive', period], ['sales', filters],
           ['sales-summary', filters], ['attendants', filters],
           ['commission-settings']
```

**Regras:**
- Dados de servidor SEMPRE via TanStack Query (nunca copiar para Zustand)
- WS events → `queryClient.invalidateQueries(...)` (refetch, não patch manual)
- staleTime: conversas 10s, catálogo 1h, analytics 5min, dados do LIS 1min (importação é
  esporádica, mas a tela precisa refletir uma importação recém-feita sem exigir F5 manual — D-117)
- `lisFilters` é o ÚNICO pedaço de estado de filtro que vive em `useUIStore` em vez de na URL —
  exceção deliberada (D-117): as três telas de leitura do LIS (§14-16) compartilham o mesmo
  período/atendente/convênio, e forçar cada uma a ler da URL obrigaria a propagar query params
  em toda navegação entre elas. Persistido em `sessionStorage` (não `localStorage`): sobrevive a
  F5, mas não vaza para a sessão seguinte de outra pessoa no mesmo computador.

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
