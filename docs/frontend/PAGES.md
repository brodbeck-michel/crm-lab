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
/settings/channels            → Canais & Equipe          (admin; gestor lê)
/settings/operation           → Gestão da Operação        (gestor+)
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
| `/settings/channels` | manager · admin | sim |
| `/settings/operation` | manager · admin | sim |
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

---

## 3. Ficha do Paciente (`/patients/:id`)

- Cadastro completo (editável), histórico de interações (timeline), propostas, seção LGPD (exportação de dados — checada também no servidor)
- Página de leitura: max-width 1180px, padding 30px 36px 48px

---

## 4. Novo Orçamento (`/budget/new`)

**Layout:** 2 colunas (catálogo flex min 520px | resumo 372px fixo)

### Coluna esquerda — Catálogo
- Segmentado de 4 modos: [Catálogo | Pedido médico | IA | Pacotes]
- Busca + lista de exames com preço (toggle Particular/Convênio — segmentado)
- Clique adiciona ao resumo
- Dados: `GET /exams?active=true`

### Coluna direita — Resumo
- Itens adicionados (nome, preço, remover)
- Desconto: input % com validação visual contra `user.discountLimit`
  - Acima da alçada: aviso "Exigirá aprovação do gestor" (chip terracota)
- **Total: rodapé fixo da coluna**, sempre derivado (nunca digitado)
- Botão [Criar orçamento] → `POST /proposals` → redirect para conversa

---

## 5. Pipeline de Propostas (`/proposals`)

- Colunas por estágio: novo contato → orçamento enviado → follow-up → negociação | ganho | perdido
- Header de coluna: nome + contagem + soma (derivada)
- `ProposalCard`: nome, #id, nota, valor (heading nowrap), dias, chip status
- Todo cartão clicável → Modal da Proposta
- Filtros: período, atendente (gestor+), valor
- Dados: `GET /proposals` agrupado por status
- *(v1: mover estágio via modal; drag-and-drop é pendência conhecida)*

---

## 6. Modal da Proposta

**Aberto de:** pipeline, conversa, chat interno (anexo), ficha do paciente

- Máx 720px, radius-lg, shadow-lg, backdrop escuro, rolagem interna, fecha por × e clique-fora (stopPropagation no cartão)
- Conteúdo: itens + preços, desconto, total derivado, alerta de aprovação (se pending), histórico de estágios, ações
- Ações (uma linha): [Mudar estágio ▾] à esquerda, [Marcar como ganho] (accent-2) à direita, [Marcar como perdido] fantasma ao fim
- "Perdido" abre sub-form com motivo OBRIGATÓRIO (select: preço, silêncio, exame indisponível, prazo, outro)
- Dados: `GET /proposals/:id`, `PATCH /proposals/:id/status`

---

## 7. Catálogo de Exames (`/catalog`)

- Tabela: nome, código, preparo, prazo, preço particular, preço convênio, status
- Regras de tabela: container com min-width + overflow-x, cabeçalho 11px caixa alta, valores à direita
- Atendente: somente leitura. Gestor/Admin: criar/editar (modal)
- Dados: `GET /exams`, `POST/PATCH /exams` (gestor+)

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

---

## 10. Telas de Configuração

### Canais & Equipe (`/settings/channels`) — admin edita, gestor lê
- Conexão WhatsApp, modo de distribuição (manual/round-robin), mensagens automáticas

### Gestão da Operação (`/settings/operation`) — gestor+
- Fila agora (tempo real), carga por atendente, decisões pendentes

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
