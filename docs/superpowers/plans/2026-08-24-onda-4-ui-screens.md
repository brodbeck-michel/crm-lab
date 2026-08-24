# Onda 4: 7 Telas de UI + Validador E2E

> **Para agentes agentic:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recomendado) ou `superpowers:dispatching-parallel-agents` para executar em paralelo. Cada agente trabalha em 1 tela de forma independente.

**Objetivo:** Implementar as 7 telas principais do frontend consumindo APIs reais (sem mocks), com testes verdes, isolamento multitenant verificado.

**Arquitetura:** 
- Cada tela é um React component com hooks (TanStack Query para servidor, Zustand para auth)
- Komponentes compartilhados (Button, Modal, DataTable, etc.) já existem
- Backend pronto: ProposalService, ApprovalService, ExamCatalogService, AnalyticsService
- E2E em Playwright cobrindo workflows críticos (orçamento → aprovação → ganho/perda)

**Stack:** React 18 + Vite + TypeScript + TanStack Query + Zustand + Tailwind (CSS vars)

**Spec:** `docs/frontend/PAGES.md` (mapa de rotas + anatomia de cada tela), `docs/backend/SERVICES.md`, `docs/domain/WORKFLOWS.md` (fluxos 1-3), `docs/domain/BUSINESS_RULES.md`

---

## Constrains Globais

- **Multitenant:** Toda query filtra `tenant_id` (via `TenantContext` no backend). Dados de outro tenant → 404
- **Dados do servidor:** SÓ via TanStack Query (hooks em `src/api/query-keys.ts`). Nunca cópia para Zustand
- **Design:** Nenhum hex/fonte/raio fixo em componentes — SÓ CSS vars de `@/styles/tokens.css`
- **TypeScript:** `strict: true`, `any` proibido (use `unknown` + narrowing)
- **Sem mocks:** RemoverHALL mocks ativos antes de concluir (Onda 3 os usava)
- **Testes:** Vitest para unitários (componentes) + Playwright para E2E
- **Commit:** Prefixo `[ui]`; tarefa pronta = testes verdes + docs atualizados

---

## Mapa de Arquivos

### Novas telas (`frontend/src/pages/`)
- `Budget/New.tsx` (+ `Budget/New.spec.tsx`) — Novo Orçamento
- `Proposals.tsx` (+ `Proposals.spec.tsx`) — Pipeline de Propostas
- `Catalog.tsx` (+ `Catalog.spec.tsx`) — Catálogo de Exames
- `Analytics.tsx` (+ `Analytics.spec.tsx`) — Conversão (Dashboard)
- `Settings/Theme.tsx` (+ `Settings/Theme.spec.tsx`) — Personalização
- `Settings/Users.tsx` (+ `Settings/Users.spec.tsx`) — Usuários & Permissões
- `Patients/Detail.tsx` (+ `Patients/Detail.spec.tsx`) — Ficha do Paciente

### Componentes novos (`frontend/src/components/proposal/`, `analytics/`, `catalog/`, etc.)
- `proposal/ProposalCard.tsx` — cartão na pipeline
- `proposal/ProposalModal.tsx` — modal com detalhes, edição de estágio, aprovação
- `proposal/StageColumn.tsx` — coluna do kanban
- `proposal/ItemsList.tsx` — lista de itens de exame dentro da proposta
- `proposal/DiscountSection.tsx` — input de desconto + validação contra alçada
- `proposal/ApprovalAlert.tsx` — aviso de pendência de aprovação
- `proposal/StageHistory.tsx` — timeline do histórico de transições
- `proposal/LostReasonForm.tsx` — form do motivo de perda (select obrigatório)
- `catalog/ExamTable.tsx` — tabela de exames
- `catalog/ExamModal.tsx` — form de criar/editar exame (gestor+)
- `analytics/ConversionChart.tsx` — funil de conversão
- `analytics/RevenueChart.tsx` — receita por período
- `analytics/MetricTile.tsx` — card de KPI (revenue, ticket médio, etc.)
- `analytics/LossReasonsChart.tsx` — gráfico de motivos de perda
- `theme/ColorPicker.tsx` — seletor de cores + preview
- `users/UserTable.tsx` — tabela de usuários
- `users/UserModal.tsx` — form de criar/editar usuário
- `patients/PatientHeader.tsx` — cadastro resumido
- `patients/PatientInteractionTimeline.tsx` — histórico de interações
- `shared/MoneyInput.tsx` — input tipado para valores monetários

### API hooks (`frontend/src/api/`)
- Adicionar em `query-keys.ts`: chaves para `proposals`, `exams`, `analytics`, `theme`, `users`, `patients`
- Adicionar em `proposals.ts`: hooks `useProposalList`, `useProposalDetail`, `useUpdateProposalStatus`, `useCreateProposal`
- Adicionar em `exams.ts`: hooks `useExamList`, `useCreateExam`, `useUpdateExam`
- Adicionar em `analytics.ts`: hooks `useAnalyticsConversion`, `useAnalyticsRevenue`, `useAnalyticsTeam`
- Adicionar em `theme.ts`: hooks `useThemeCurrent`, `useUpdateTheme`
- Adicionar em `users.ts`: hooks `useUserList`, `useCreateUser`, `useUpdateUser`
- Adicionar em `patients.ts`: hooks `usePatientDetail`, `useUpdatePatient`, `usePatientInteractions`

### Rotas (`frontend/src/routes/`)
- Atualizar `index.tsx` (RouteConfig): cada rota já tem placeholder, trocar `element:` pelo componente real

### E2E (`e2e/`)
- `workflows/flow-1-new-budget.spec.ts` — criar orçamento até envio
- `workflows/flow-2-approval.spec.ts` — desconto > alçada → aprovação → notificação
- `workflows/flow-3-win-loss.spec.ts` — marcar como ganho, marcar como perdido com motivo

---

## Tasks

### Task 1: Novo Orçamento (`/budget/new`)

**Agente:** Agent-UI-Budget

**Responsabilidade:** Tela completa de criação de orçamento com catálogo, desconto e cálculo de total.

**Files:**
- Create: `frontend/src/pages/Budget/New.tsx`, `frontend/src/pages/Budget/New.spec.tsx`
- Create: `frontend/src/components/proposal/DiscountSection.tsx`
- Create: `frontend/src/components/budget/CatalogSegments.tsx`, `frontend/src/components/budget/SummaryColumn.tsx`
- Modify: `frontend/src/routes/index.tsx` (trocar placeholder)
- Modify: `frontend/src/api/proposals.ts` (adicionar hook `useCreateProposal`)
- Modify: `frontend/src/api/exams.ts` (adicionar hook `useExamList`)

**Interfaces:**
- Consumes:
  - `GET /exams?active=true` (backend retorna `{ exams, pagination }`)
  - `POST /proposals` (backend retorna `{ id, status, approvalStatus, ... }`)
  - `useAuthStore().user.discountLimit` (Zustand)
- Produces: 
  - React component `<Budget.New />` exportado de `pages/Budget/New.tsx`
  - Query hook `useExamList(tenantId, filters)` retorna `{ data: Exam[], isLoading, error }`
  - Mutation hook `useCreateProposal()` retorna `{ mutate, isPending, data }`

**Passos:**

- [ ] **1. Escrever teste: layout renderiza 2 colunas com catálogo e resumo**

```tsx
// frontend/src/pages/Budget/New.spec.tsx
import { render, screen } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import { useAuthStore } from '@/stores/auth.store'
import Budget from './New'

vi.mock('@/api/exams')
vi.mock('@/api/proposals')

test('Budget.New renders 2 columns: catalog and summary', () => {
  useAuthStore.setState({ user: { id: 'user1', discountLimit: 10 }, tenant: { id: 'tenant1' } })
  
  render(
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Budget.New />
      </BrowserRouter>
    </QueryClientProvider>
  )
  
  expect(screen.getByRole('heading', { name: /catálogo/i })).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: /resumo/i })).toBeInTheDocument()
})
```

- [ ] **2. Rodar teste para falhar**

```bash
cd frontend
npm run test -- src/pages/Budget/New.spec.ts
```

Expected: "Budget is not exported"

- [ ] **3. Criar `Budget/New.tsx` com layout base (2 colunas, BudgetLayout)**

```tsx
// frontend/src/pages/Budget/New.tsx
import { useSearchParams } from 'react-router-dom'
import { BudgetLayout } from '@/components/layout/BudgetLayout'
import CatalogColumn from '@/components/budget/CatalogSegments'
import SummaryColumn from '@/components/budget/SummaryColumn'

export default function BudgetNew() {
  const [searchParams] = useSearchParams()
  const conversationId = searchParams.get('conversationId')

  return (
    <BudgetLayout>
      <CatalogColumn conversationId={conversationId} />
      <SummaryColumn conversationId={conversationId} />
    </BudgetLayout>
  )
}
```

- [ ] **4. Criar `CatalogSegments.tsx` com busca + lista de exames**

```tsx
// frontend/src/components/budget/CatalogSegments.tsx
import { useState } from 'react'
import { useExamList } from '@/api/exams'
import SearchInput from '@/components/ui/SearchInput'
import SegmentedControl from '@/components/ui/SegmentedControl'
import { MoneyDisplay } from '@/components/shared/MoneyDisplay'

interface CatalogSegmentsProps {
  conversationId?: string
}

export default function CatalogSegments({ conversationId }: CatalogSegmentsProps) {
  const [search, setSearch] = useState('')
  const [segment, setSegment] = useState<'catalog' | 'medical' | 'ai' | 'packages'>('catalog')
  const [pricingMode, setPricingMode] = useState<'particular' | 'insurance'>('particular')

  const { data: exams, isLoading } = useExamList({
    active: true,
    search,
    limit: 50,
  })

  return (
    <div className="p-5 flex flex-col gap-4">
      <h2 className="text-heading-32">Catálogo</h2>
      
      <SegmentedControl
        options={[
          { label: 'Catálogo', value: 'catalog' },
          { label: 'Pedido Médico', value: 'medical' },
          { label: 'IA', value: 'ai' },
          { label: 'Pacotes', value: 'packages' },
        ]}
        value={segment}
        onChange={setSegment}
      />

      <SegmentedControl
        options={[
          { label: 'Particular', value: 'particular' },
          { label: 'Convênio', value: 'insurance' },
        ]}
        value={pricingMode}
        onChange={setPricingMode}
      />

      <SearchInput
        placeholder="Buscar exame..."
        value={search}
        onChange={setSearch}
      />

      {isLoading ? (
        <div>Carregando...</div>
      ) : (
        <div className="space-y-2 overflow-y-auto flex-1">
          {exams?.map((exam) => (
            <button
              key={exam.id}
              onClick={() => {
                // Adicionar ao resumo (via context/store)
              }}
              className="w-full flex justify-between p-3 hover:bg-neutral-100 rounded-md"
            >
              <span className="text-sm">{exam.name}</span>
              <MoneyDisplay amount={pricingMode === 'particular' ? exam.priceParticular : exam.priceInsurance} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **5. Criar `SummaryColumn.tsx` com itens, desconto, total**

```tsx
// frontend/src/components/budget/SummaryColumn.tsx
import { useState } from 'react'
import { useCreateProposal } from '@/api/proposals'
import { useAuthStore } from '@/stores/auth.store'
import Button from '@/components/ui/Button'
import DiscountSection from '@/components/proposal/DiscountSection'
import { MoneyDisplay } from '@/components/shared/MoneyDisplay'
import { calculateTotal } from '@crm-lab/shared'

interface SummaryColumnProps {
  conversationId?: string
}

export default function SummaryColumn({ conversationId }: SummaryColumnProps) {
  const user = useAuthStore((s) => s.user)
  const [items, setItems] = useState<Array<{ examId: string; examName: string; price: number }>>([])
  const [discountPercent, setDiscountPercent] = useState(0)

  const createProposal = useCreateProposal()

  const subtotal = items.reduce((sum, item) => sum + item.price, 0)
  const total = calculateTotal(subtotal, discountPercent)

  const handleCreateProposal = () => {
    if (!conversationId || items.length === 0) return

    createProposal.mutate({
      conversationId,
      items: items.map((item) => ({ examId: item.examId, quantity: 1 })),
      discountPercent,
    })
  }

  return (
    <div className="p-5 flex flex-col gap-4">
      <h2 className="text-heading-32">Resumo</h2>

      <div className="flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <p className="text-neutral-600">Nenhum exame adicionado</p>
        ) : (
          <div className="space-y-2">
            {items.map((item, idx) => (
              <div key={idx} className="flex justify-between text-sm">
                <span>{item.examName}</span>
                <div className="flex gap-2">
                  <MoneyDisplay amount={item.price} />
                  <button onClick={() => setItems(items.filter((_, i) => i !== idx))}>×</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <DiscountSection
        discountPercent={discountPercent}
        discountLimit={user?.discountLimit || 0}
        onChange={setDiscountPercent}
      />

      <div className="border-t pt-3">
        <div className="flex justify-between text-heading-16 font-semibold">
          <span>Total</span>
          <MoneyDisplay amount={total} />
        </div>
      </div>

      <Button
        variant="primary"
        onClick={handleCreateProposal}
        disabled={items.length === 0 || createProposal.isPending}
        loading={createProposal.isPending}
      >
        Criar Orçamento
      </Button>
    </div>
  )
}
```

- [ ] **6. Criar `DiscountSection.tsx` com validação contra alçada**

```tsx
// frontend/src/components/proposal/DiscountSection.tsx
import Input from '@/components/ui/Input'
import Chip from '@/components/ui/Chip'

interface DiscountSectionProps {
  discountPercent: number
  discountLimit: number
  onChange: (value: number) => void
}

export default function DiscountSection({ discountPercent, discountLimit, onChange }: DiscountSectionProps) {
  const exceedsLimit = discountPercent > discountLimit

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium">
        Desconto (%)
      </label>
      <div className="flex gap-2">
        <Input
          type="number"
          min={0}
          max={100}
          value={discountPercent}
          onChange={(e) => onChange(Number(e.target.value))}
          placeholder="0"
        />
        <span className="text-sm text-neutral-600">Alçada: {discountLimit}%</span>
      </div>

      {exceedsLimit && (
        <Chip tone="attention">
          Exigirá aprovação do gestor
        </Chip>
      )}
    </div>
  )
}
```

- [ ] **7. Adicionar API hooks: `useExamList`, `useCreateProposal`**

```typescript
// frontend/src/api/exams.ts - adicionar
export function useExamList(filters: { active?: boolean; search?: string; limit?: number }) {
  return useQuery({
    queryKey: queryKeys.exams(filters),
    queryFn: async () => {
      const res = await apiClient.get('/exams', { params: filters })
      return res.data.exams
    },
  })
}

// frontend/src/api/proposals.ts - adicionar
export function useCreateProposal() {
  const queryClient = useQueryClient()
  const { tenant } = useAuthStore()

  return useMutation({
    mutationFn: async (data: CreateProposalRequest) => {
      const res = await apiClient.post('/proposals', data)
      return res.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.proposals() })
    },
  })
}
```

- [ ] **8. Atualizar `routes/index.tsx` com tela real**

```tsx
// Antes:
{ path: '/budget/new', element: <Placeholder /> }

// Depois:
{ path: '/budget/new', element: <BudgetNew />, requiredRoles: ['attendant', 'manager', 'admin'] }
```

- [ ] **9. Rodar testes: `npm run test:frontend`**

Expected: Todos verdes na tela de Budget.

- [ ] **10. Commit**

```bash
git add frontend/src/pages/Budget/ frontend/src/components/budget/ frontend/src/components/proposal/DiscountSection.tsx frontend/src/api/
git commit -m "[ui] feat: Novo Orçamento com catálogo, desconto e resumo"
```

---

### Task 2: Pipeline de Propostas (`/proposals`)

**Agente:** Agent-UI-Proposals

**Responsabilidade:** Tela kanban com 6 colunas de estágios, cartões clicáveis, filtros por período/atendente/valor.

**Files:**
- Create: `frontend/src/pages/Proposals.tsx`, `frontend/src/pages/Proposals.spec.tsx`
- Create: `frontend/src/components/proposal/ProposalCard.tsx`, `StageColumn.tsx`
- Create: `frontend/src/components/proposal/ProposalsFilters.tsx`
- Modify: `frontend/src/routes/index.tsx`
- Modify: `frontend/src/api/proposals.ts` (hook `useProposalList`)

**Interfaces:**
- Consumes:
  - `GET /proposals?status=novo_contato&startDate=&endDate=&attendantId=&minValue=&maxValue=` (retorna propostas agrupadas)
  - `useUIStore().openModal({ kind: 'proposal', id })` (Zustand)
- Produces:
  - `<Proposals />` component
  - `useProposalList(filters)` hook

**Passos:**

- [ ] **1. Escrever teste: Pipeline renderiza 6 colunas por estágio**

```tsx
// frontend/src/pages/Proposals.spec.tsx
import { render, screen } from '@testing-library/react'
import Proposals from './Proposals'

vi.mock('@/api/proposals')

test('Proposals renders 6 stage columns', () => {
  render(<Proposals />)

  expect(screen.getByText('Novo Contato')).toBeInTheDocument()
  expect(screen.getByText('Orçamento Enviado')).toBeInTheDocument()
  expect(screen.getByText('Follow-up')).toBeInTheDocument()
  expect(screen.getByText('Negociação')).toBeInTheDocument()
  expect(screen.getByText('Ganho')).toBeInTheDocument()
  expect(screen.getByText('Perdido')).toBeInTheDocument()
})
```

- [ ] **2. Rodar teste para falhar**

```bash
npm run test:frontend -- src/pages/Proposals.spec.ts
```

- [ ] **3. Criar `Proposals.tsx` com 6 colunas**

```tsx
// frontend/src/pages/Proposals.tsx
import { useState } from 'react'
import { useProposalList } from '@/api/proposals'
import StageColumn from '@/components/proposal/StageColumn'
import ProposalsFilters from '@/components/proposal/ProposalsFilters'
import { PROPOSAL_STATUSES, ProposalStatus } from '@crm-lab/shared'

export default function Proposals() {
  const [filters, setFilters] = useState({
    startDate: '',
    endDate: '',
    attendantId: '',
    minValue: 0,
    maxValue: undefined,
  })

  const { data: proposals = [], isLoading } = useProposalList(filters)

  const proposalsByStatus = PROPOSAL_STATUSES.reduce(
    (acc, status) => ({
      ...acc,
      [status]: proposals.filter((p) => p.status === status),
    }),
    {} as Record<ProposalStatus, Proposal[]>
  )

  return (
    <div className="p-5 flex flex-col gap-4">
      <h1 className="text-heading-32">Pipeline de Propostas</h1>
      <ProposalsFilters filters={filters} onChange={setFilters} />

      {isLoading ? (
        <div>Carregando...</div>
      ) : (
        <div className="flex gap-4 overflow-x-auto pb-4">
          {PROPOSAL_STATUSES.map((status) => (
            <StageColumn
              key={status}
              status={status}
              proposals={proposalsByStatus[status]}
            />
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **4. Criar `StageColumn.tsx`**

```tsx
// frontend/src/components/proposal/StageColumn.tsx
import { ProposalStatus } from '@crm-lab/shared'
import ProposalCard from './ProposalCard'
import { MoneyDisplay } from '@/components/shared/MoneyDisplay'

interface StageColumnProps {
  status: ProposalStatus
  proposals: Proposal[]
}

const STATUS_LABELS = {
  novo_contato: 'Novo Contato',
  orcamento_enviado: 'Orçamento Enviado',
  follow_up: 'Follow-up',
  negociacao: 'Negociação',
  ganho: 'Ganho',
  perdido: 'Perdido',
}

export default function StageColumn({ status, proposals }: StageColumnProps) {
  const total = proposals.reduce((sum, p) => sum + (p.totalPrice || 0), 0)

  return (
    <div className="flex-shrink-0 w-80 bg-neutral-50 rounded-md p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold">{STATUS_LABELS[status]}</h3>
        <div className="flex gap-2 text-sm">
          <span className="bg-neutral-200 rounded-full px-2">{proposals.length}</span>
          <MoneyDisplay amount={total} className="text-heading-14 font-semibold" />
        </div>
      </div>

      <div className="space-y-3">
        {proposals.map((proposal) => (
          <ProposalCard key={proposal.id} proposal={proposal} />
        ))}
      </div>
    </div>
  )
}
```

- [ ] **5. Criar `ProposalCard.tsx`**

```tsx
// frontend/src/components/proposal/ProposalCard.tsx
import { useUIStore } from '@/stores/ui.store'
import { Proposal } from '@crm-lab/shared'
import Chip from '@/components/ui/Chip'
import { MoneyDisplay } from '@/components/shared/MoneyDisplay'
import { formatDistanceToNow } from 'date-fns'
import { ptBR } from 'date-fns/locale'

interface ProposalCardProps {
  proposal: Proposal
}

const STATUS_TONES = {
  ganho: 'positive' as const,
  perdido: 'attention' as const,
  default: 'inactive' as const,
}

export default function ProposalCard({ proposal }: ProposalCardProps) {
  const openModal = useUIStore((s) => s.openModal)

  const statusTone =
    proposal.status === 'ganho'
      ? 'positive'
      : proposal.status === 'perdido'
        ? 'attention'
        : 'inactive'

  const daysOpen = Math.floor(
    (Date.now() - new Date(proposal.createdAt).getTime()) / (1000 * 60 * 60 * 24)
  )

  return (
    <button
      onClick={() => openModal({ kind: 'proposal', proposalId: proposal.id })}
      className="w-full text-left bg-white p-3 rounded-md shadow-sm hover:shadow-md transition-shadow"
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex-1">
          <p className="font-semibold text-sm">{proposal.patientName}</p>
          <p className="text-xs text-neutral-600">#{proposal.id.slice(0, 8)}</p>
        </div>
      </div>

      {proposal.note && (
        <p className="text-xs text-neutral-600 mb-2">{proposal.note}</p>
      )}

      <div className="flex items-end justify-between">
        <MoneyDisplay amount={proposal.totalPrice} className="text-heading-16 font-semibold" />
        <span className="text-xs text-neutral-600">{daysOpen}d</span>
      </div>

      <div className="mt-2">
        <Chip tone={statusTone}>{STATUS_LABELS[proposal.status]}</Chip>
      </div>
    </button>
  )
}
```

- [ ] **6. Criar `ProposalsFilters.tsx`**

```tsx
// frontend/src/components/proposal/ProposalsFilters.tsx
import Input from '@/components/ui/Input'

interface ProposalsFiltersProps {
  filters: {
    startDate: string
    endDate: string
    attendantId: string
    minValue: number
    maxValue?: number
  }
  onChange: (filters: any) => void
}

export default function ProposalsFilters({ filters, onChange }: ProposalsFiltersProps) {
  return (
    <div className="flex gap-4 flex-wrap">
      <Input
        type="date"
        placeholder="Data inicial"
        value={filters.startDate}
        onChange={(e) => onChange({ ...filters, startDate: e.target.value })}
      />
      <Input
        type="date"
        placeholder="Data final"
        value={filters.endDate}
        onChange={(e) => onChange({ ...filters, endDate: e.target.value })}
      />
      <Input
        type="number"
        placeholder="Valor mín."
        value={filters.minValue}
        onChange={(e) => onChange({ ...filters, minValue: Number(e.target.value) })}
      />
    </div>
  )
}
```

- [ ] **7. Adicionar hook `useProposalList`**

```typescript
// frontend/src/api/proposals.ts
export function useProposalList(filters: {
  startDate?: string
  endDate?: string
  attendantId?: string
  minValue?: number
  maxValue?: number
}) {
  return useQuery({
    queryKey: queryKeys.proposals(filters),
    queryFn: async () => {
      const res = await apiClient.get('/proposals', { params: filters })
      return res.data.proposals
    },
  })
}
```

- [ ] **8. Atualizar `routes/index.tsx`**

```tsx
{ path: '/proposals', element: <Proposals />, requiredRoles: ['attendant', 'manager', 'admin'] }
```

- [ ] **9. Rodar testes**

```bash
npm run test:frontend
```

- [ ] **10. Commit**

```bash
git add frontend/src/pages/Proposals.tsx frontend/src/components/proposal/ frontend/src/api/proposals.ts
git commit -m "[ui] feat: Pipeline de propostas com 6 colunas e filtros"
```

---

### Task 3: Modal da Proposta

**Agente:** Agent-UI-ProposalModal

**Responsabilidade:** Modal com detalhe da proposta, edição de estágio, aprovação/rejeição, histórico.

**Files:**
- Create: `frontend/src/components/proposal/ProposalModal.tsx`
- Create: `frontend/src/components/proposal/ItemsList.tsx`, `ApprovalAlert.tsx`, `StageHistory.tsx`, `LostReasonForm.tsx`, `ActionsRow.tsx`
- Modify: `frontend/src/api/proposals.ts` (hooks de update)

**Interfaces:**
- Consumes:
  - `GET /proposals/:id` (detalhe completo com histórico)
  - `PATCH /proposals/:id/status` (mudar estágio)
  - `PATCH /proposals/:id/approve` (gestor aprova desconto)
  - `PATCH /proposals/:id/reject` (gestor rejeita desconto)
- Produces:
  - `<ProposalModal />` component montado na árvore (abre/fecha via Zustand)

**Passos:**

- [ ] **1. Escrever teste: Modal renderiza itens, desconto, total, histórico**

```tsx
// frontend/src/components/proposal/ProposalModal.spec.tsx
import { render, screen } from '@testing-library/react'
import ProposalModal from './ProposalModal'

vi.mock('@/api/proposals')

test('ProposalModal renders items, discount, total, and history', () => {
  const proposal = {
    id: 'prop-1',
    status: 'orcamento_enviado',
    items: [{ examId: 'exam-1', examName: 'Hemograma', quantity: 1, price: 50 }],
    discountPercent: 10,
    totalPrice: 45,
  }

  render(<ProposalModal proposal={proposal} onClose={() => {}} />)

  expect(screen.getByText('Hemograma')).toBeInTheDocument()
  expect(screen.getByText('10%')).toBeInTheDocument() // Desconto
  expect(screen.getByText(/R\$ 45/)).toBeInTheDocument() // Total
})
```

- [ ] **2. Criar `ProposalModal.tsx`** (container principal)

```tsx
// frontend/src/components/proposal/ProposalModal.tsx
import { useState } from 'react'
import { useProposalDetail, useUpdateProposalStatus } from '@/api/proposals'
import Modal from '@/components/shared/Modal'
import ItemsList from './ItemsList'
import DiscountSection from './DiscountSection'
import ApprovalAlert from './ApprovalAlert'
import StageHistory from './StageHistory'
import ActionsRow from './ActionsRow'
import LostReasonForm from './LostReasonForm'
import Button from '@/components/ui/Button'
import { MoneyDisplay } from '@/components/shared/MoneyDisplay'

interface ProposalModalProps {
  proposalId: string
  onClose: () => void
}

export default function ProposalModal({ proposalId, onClose }: ProposalModalProps) {
  const { data: proposal, isLoading } = useProposalDetail(proposalId)
  const updateStatus = useUpdateProposalStatus()
  const [showLostForm, setShowLostForm] = useState(false)

  if (isLoading || !proposal) return null

  const handleMarkWon = () => {
    updateStatus.mutate({ proposalId, status: 'ganho' })
  }

  const handleMarkLost = (reasonLost: string) => {
    updateStatus.mutate({ proposalId, status: 'perdido', reasonLost })
    setShowLostForm(false)
  }

  return (
    <Modal onClose={onClose} maxWidth="720px">
      <div className="p-6 space-y-6">
        <div className="space-y-4">
          <h2 className="text-heading-24">{proposal.patientName}</h2>

          <ItemsList items={proposal.items} />

          <DiscountSection
            discountPercent={proposal.discountPercent}
            discountLimit={proposal.user?.discountLimit || 0}
            readOnly
          />

          <div className="border-t pt-3">
            <div className="flex justify-between text-heading-16 font-semibold">
              <span>Total</span>
              <MoneyDisplay amount={proposal.totalPrice} />
            </div>
          </div>

          {proposal.approvalStatus === 'pending' && (
            <ApprovalAlert />
          )}

          <StageHistory history={proposal.statusHistory} />
        </div>

        {showLostForm ? (
          <LostReasonForm onSubmit={handleMarkLost} />
        ) : (
          <ActionsRow
            status={proposal.status}
            onMarkWon={handleMarkWon}
            onMarkLost={() => setShowLostForm(true)}
            isPending={updateStatus.isPending}
          />
        )}
      </div>
    </Modal>
  )
}
```

- [ ] **3. Criar `ItemsList.tsx`**

```tsx
// frontend/src/components/proposal/ItemsList.tsx
import { ProposalItem } from '@crm-lab/shared'
import { MoneyDisplay } from '@/components/shared/MoneyDisplay'

interface ItemsListProps {
  items: ProposalItem[]
}

export default function ItemsList({ items }: ItemsListProps) {
  return (
    <div className="space-y-2">
      {items.map((item) => (
        <div key={item.id} className="flex justify-between text-sm">
          <span>{item.examName}</span>
          <MoneyDisplay amount={item.price} />
        </div>
      ))}
    </div>
  )
}
```

- [ ] **4. Criar `ApprovalAlert.tsx`**

```tsx
// frontend/src/components/proposal/ApprovalAlert.tsx
import Chip from '@/components/ui/Chip'

export default function ApprovalAlert() {
  return (
    <Chip tone="attention">
      Aguardando aprovação do gestor
    </Chip>
  )
}
```

- [ ] **5. Criar `StageHistory.tsx`**

```tsx
// frontend/src/components/proposal/StageHistory.tsx
import { ProposalStatusHistory } from '@crm-lab/shared'
import { formatDistanceToNow } from 'date-fns'
import { ptBR } from 'date-fns/locale'

interface StageHistoryProps {
  history: ProposalStatusHistory[]
}

const STATUS_LABELS = {
  novo_contato: 'Novo Contato',
  orcamento_enviado: 'Orçamento Enviado',
  // ... resto
}

export default function StageHistory({ history }: StageHistoryProps) {
  return (
    <div className="space-y-2">
      <h3 className="font-semibold text-sm">Histórico</h3>
      {history.map((entry) => (
        <div key={entry.id} className="flex justify-between text-xs text-neutral-600">
          <span>{STATUS_LABELS[entry.status]}</span>
          <span>
            {formatDistanceToNow(new Date(entry.transitionedAt), {
              addSuffix: true,
              locale: ptBR,
            })}
          </span>
        </div>
      ))}
    </div>
  )
}
```

- [ ] **6. Criar `LostReasonForm.tsx`**

```tsx
// frontend/src/components/proposal/LostReasonForm.tsx
import { useState } from 'react'
import Select from '@/components/ui/Select'
import Button from '@/components/ui/Button'
import { LOSS_REASONS } from '@crm-lab/shared'

interface LostReasonFormProps {
  onSubmit: (reason: string) => void
}

export default function LostReasonForm({ onSubmit }: LostReasonFormProps) {
  const [reason, setReason] = useState('')

  return (
    <div className="space-y-3">
      <Select
        label="Motivo da Perda"
        options={LOSS_REASONS.map((r) => ({ label: r, value: r }))}
        value={reason}
        onChange={setReason}
        required
      />
      <div className="flex gap-2">
        <Button variant="primary" onClick={() => onSubmit(reason)} disabled={!reason}>
          Confirmar
        </Button>
      </div>
    </div>
  )
}
```

- [ ] **7. Criar `ActionsRow.tsx`**

```tsx
// frontend/src/components/proposal/ActionsRow.tsx
import Button from '@/components/ui/Button'
import { ProposalStatus } from '@crm-lab/shared'

interface ActionsRowProps {
  status: ProposalStatus
  onMarkWon: () => void
  onMarkLost: () => void
  isPending: boolean
}

export default function ActionsRow({ status, onMarkWon, onMarkLost, isPending }: ActionsRowProps) {
  const canWin = !['ganho', 'perdido'].includes(status)
  const canLose = !['ganho', 'perdido'].includes(status)

  return (
    <div className="flex gap-2 justify-between">
      <select className="px-3 py-2 border rounded-full">
        <option>Mudar estágio ▾</option>
        <option value="novo_contato">Novo Contato</option>
        <option value="orcamento_enviado">Orçamento Enviado</option>
        {/* etc */}
      </select>

      <div className="flex gap-2">
        <Button
          variant="confirmation"
          onClick={onMarkWon}
          disabled={!canWin || isPending}
        >
          Marcar como Ganho
        </Button>
        <Button
          variant="destructive"
          onClick={onMarkLost}
          disabled={!canLose || isPending}
        >
          Marcar como Perdido
        </Button>
      </div>
    </div>
  )
}
```

- [ ] **8. Montar Modal na árvore (App.tsx ou AppShell)**

```tsx
// frontend/src/App.tsx - adicionar
import ProposalModal from '@/components/proposal/ProposalModal'
import { useUIStore } from '@/stores/ui.store'

export default function App() {
  const modal = useUIStore((s) => s.modal)
  const closeModal = useUIStore((s) => s.closeModal)

  return (
    <>
      {/* ... resto */}
      {modal?.kind === 'proposal' && modal.proposalId && (
        <ProposalModal proposalId={modal.proposalId} onClose={closeModal} />
      )}
    </>
  )
}
```

- [ ] **9. Adicionar hooks de update**

```typescript
// frontend/src/api/proposals.ts
export function useProposalDetail(proposalId: string) {
  return useQuery({
    queryKey: queryKeys.proposalDetail(proposalId),
    queryFn: async () => {
      const res = await apiClient.get(`/proposals/${proposalId}`)
      return res.data
    },
  })
}

export function useUpdateProposalStatus() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (data: {
      proposalId: string
      status: ProposalStatus
      reasonLost?: string
    }) => {
      const res = await apiClient.patch(`/proposals/${data.proposalId}/status`, {
        status: data.status,
        reasonLost: data.reasonLost,
      })
      return res.data
    },
    onSuccess: (_, { proposalId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.proposalDetail(proposalId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.proposals() })
    },
  })
}
```

- [ ] **10. Rodar testes**

```bash
npm run test:frontend
```

- [ ] **11. Commit**

```bash
git add frontend/src/components/proposal/ProposalModal.tsx frontend/src/components/proposal/{ItemsList,ApprovalAlert,StageHistory,LostReasonForm,ActionsRow}.tsx frontend/src/api/proposals.ts
git commit -m "[ui] feat: Modal de proposta com histórico, aprovação e edição de estágio"
```

---

### Task 4: Catálogo de Exames (`/catalog`)

**Agente:** Agent-UI-Catalog

**Responsabilidade:** Tabela de exames com busca, atendente (leitura), gestor (criar/editar).

**Files:**
- Create: `frontend/src/pages/Catalog.tsx`, `frontend/src/pages/Catalog.spec.tsx`
- Create: `frontend/src/components/catalog/ExamTable.tsx`, `ExamModal.tsx`
- Modify: `frontend/src/routes/index.tsx`

**Interfaces:**
- Consumes:
  - `GET /exams?page=&limit=&search=&sortBy=&order=`
  - `POST /exams`, `PATCH /exams/:id` (gestor+)
- Produces:
  - `<Catalog />` component

**Passos:**

- [ ] **1. Escrever teste: Tabela renderiza exames, gestor tem botão de criar**

```tsx
test('Catalog shows exam table, admin sees create button', () => {
  const user = { role: 'admin' }
  useAuthStore.setState({ user })

  render(<Catalog />)

  expect(screen.getByRole('columnheader', { name: /nome/i })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /novo exame/i })).toBeInTheDocument()
})
```

- [ ] **2. Criar `Catalog.tsx` com tabela**

```tsx
// frontend/src/pages/Catalog.tsx
import { useState } from 'react'
import { useExamList } from '@/api/exams'
import { useAuthStore } from '@/stores/auth.store'
import ExamTable from '@/components/catalog/ExamTable'
import ExamModal from '@/components/catalog/ExamModal'
import Button from '@/components/ui/Button'
import SearchInput from '@/components/ui/SearchInput'

export default function Catalog() {
  const user = useAuthStore((s) => s.user)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [showModal, setShowModal] = useState(false)

  const { data, isLoading } = useExamList({ page, limit: 20, search, active: undefined })

  const canEdit = user?.role !== 'attendant'

  return (
    <div className="p-5 space-y-4">
      <div className="flex justify-between items-center">
        <h1 className="text-heading-32">Catálogo de Exames</h1>
        {canEdit && (
          <Button variant="primary" onClick={() => setShowModal(true)}>
            + Novo Exame
          </Button>
        )}
      </div>

      <SearchInput value={search} onChange={setSearch} placeholder="Buscar exame..." />

      {isLoading ? (
        <div>Carregando...</div>
      ) : (
        <>
          <ExamTable exams={data?.exams || []} canEdit={canEdit} />
          {/* Paginação */}
        </>
      )}

      {showModal && <ExamModal onClose={() => setShowModal(false)} />}
    </div>
  )
}
```

- [ ] **3. Criar `ExamTable.tsx`**

```tsx
// frontend/src/components/catalog/ExamTable.tsx
import { Exam } from '@crm-lab/shared'
import DataTable from '@/components/shared/DataTable'
import { MoneyDisplay } from '@/components/shared/MoneyDisplay'
import Button from '@/components/ui/Button'

interface ExamTableProps {
  exams: Exam[]
  canEdit: boolean
}

export default function ExamTable({ exams, canEdit }: ExamTableProps) {
  return (
    <DataTable
      columns={[
        { header: 'Nome', accessor: 'name' },
        { header: 'Código', accessor: 'code' },
        { header: 'Preparo', accessor: 'preparation' },
        { header: 'Prazo', accessor: 'deadline' },
        {
          header: 'Preço Particular',
          accessor: (exam: Exam) => <MoneyDisplay amount={exam.priceParticular} />,
        },
        {
          header: 'Preço Convênio',
          accessor: (exam: Exam) => <MoneyDisplay amount={exam.priceInsurance} />,
        },
        {
          header: 'Status',
          accessor: (exam: Exam) => (exam.isActive ? 'Ativo' : 'Inativo'),
        },
        ...(canEdit
          ? [
              {
                header: 'Ações',
                accessor: (exam: Exam) => (
                  <Button variant="secondary" size="sm" onClick={() => {/* edit */}}>
                    Editar
                  </Button>
                ),
              },
            ]
          : []),
      ]}
      data={exams}
    />
  )
}
```

- [ ] **4. Criar `ExamModal.tsx` (criar/editar)**

```tsx
// frontend/src/components/catalog/ExamModal.tsx
import { useState } from 'react'
import { useCreateExam } from '@/api/exams'
import Modal from '@/components/shared/Modal'
import Input from '@/components/ui/Input'
import Button from '@/components/ui/Button'

interface ExamModalProps {
  onClose: () => void
  examId?: string
}

export default function ExamModal({ onClose, examId }: ExamModalProps) {
  const [form, setForm] = useState({
    name: '',
    code: '',
    preparation: '',
    deadline: '',
    priceParticular: 0,
    priceInsurance: 0,
    isActive: true,
  })

  const createExam = useCreateExam()

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    createExam.mutate(form)
    onClose()
  }

  return (
    <Modal onClose={onClose}>
      <form onSubmit={handleSubmit} className="p-6 space-y-4">
        <h2 className="text-heading-24">Novo Exame</h2>

        <Input
          label="Nome"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          required
        />
        <Input
          label="Código"
          value={form.code}
          onChange={(e) => setForm({ ...form, code: e.target.value })}
        />
        <Input
          label="Preço Particular"
          type="number"
          step="0.01"
          value={form.priceParticular}
          onChange={(e) => setForm({ ...form, priceParticular: Number(e.target.value) })}
          required
        />
        <Input
          label="Preço Convênio"
          type="number"
          step="0.01"
          value={form.priceInsurance}
          onChange={(e) => setForm({ ...form, priceInsurance: Number(e.target.value) })}
          required
        />

        <div className="flex gap-2 pt-4">
          <Button variant="primary" type="submit" disabled={createExam.isPending}>
            Salvar
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
        </div>
      </form>
    </Modal>
  )
}
```

- [ ] **5. Adicionar hooks**

```typescript
// frontend/src/api/exams.ts
export function useCreateExam() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (data: CreateExamRequest) => {
      const res = await apiClient.post('/exams', data)
      return res.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.exams() })
    },
  })
}
```

- [ ] **6. Atualizar routes**

```tsx
{ path: '/catalog', element: <Catalog />, requiredRoles: ['attendant', 'manager', 'admin'] }
```

- [ ] **7. Rodar testes**

```bash
npm run test:frontend
```

- [ ] **8. Commit**

```bash
git add frontend/src/pages/Catalog.tsx frontend/src/components/catalog/
git commit -m "[ui] feat: Catálogo de exames com tabela e edição (gestor+)"
```

---

### Task 5: Conversão (`/analytics`)

**Agente:** Agent-UI-Analytics

**Responsabilidade:** Dashboard com gráficos: funil, receita, motivos de perda, top performers.

**Files:**
- Create: `frontend/src/pages/Analytics.tsx`
- Create: `frontend/src/components/analytics/{ConversionChart,RevenueChart,MetricTile,LossReasonsChart}.tsx`
- Modify: `frontend/src/routes/index.tsx`

**Interfaces:**
- Consumes:
  - `GET /analytics/conversion?startDate=&endDate=` (funil)
  - `GET /analytics/pipeline?startDate=&endDate=` (byStatus + contagem)
  - `GET /analytics/team?startDate=&endDate=` (top performers, só gestor/admin)
  - `GET /analytics` (receita derivada de propostas ganhas)
- Produces:
  - `<Analytics />` component com 4 seções de gráficos

**Passos:**

- [ ] **1. Escrever teste: Dashboard renderiza 4 seções**

```tsx
test('Analytics renders conversion, revenue, loss reasons, and top performers', () => {
  render(<Analytics />)

  expect(screen.getByText(/funil de conversão/i)).toBeInTheDocument()
  expect(screen.getByText(/receita/i)).toBeInTheDocument()
  expect(screen.getByText(/motivos de perda/i)).toBeInTheDocument()
})
```

- [ ] **2. Criar `Analytics.tsx`**

```tsx
// frontend/src/pages/Analytics.tsx
import { useState } from 'react'
import { useAnalyticsConversion, useAnalyticsRevenue } from '@/api/analytics'
import ConversionChart from '@/components/analytics/ConversionChart'
import RevenueChart from '@/components/analytics/RevenueChart'
import MetricTile from '@/components/analytics/MetricTile'
import LossReasonsChart from '@/components/analytics/LossReasonsChart'
import Input from '@/components/ui/Input'

export default function Analytics() {
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')

  const { data: conversion } = useAnalyticsConversion({ startDate, endDate })
  const { data: revenue } = useAnalyticsRevenue({ startDate, endDate })

  return (
    <div className="p-5 space-y-6">
      <h1 className="text-heading-32">Conversão</h1>

      <div className="flex gap-4">
        <Input
          type="date"
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
          placeholder="Data inicial"
        />
        <Input
          type="date"
          value={endDate}
          onChange={(e) => setEndDate(e.target.value)}
          placeholder="Data final"
        />
      </div>

      <div className="grid grid-cols-4 gap-4">
        <MetricTile label="Receita" value={revenue?.totalRevenue} />
        <MetricTile label="Ticket Médio" value={revenue?.averageTicket} />
        <MetricTile label="Taxa de Conversão" value={conversion?.conversionRate} percent />
        <MetricTile label="Propostas Criadas" value={conversion?.proposalsCreated} />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <ConversionChart data={conversion?.funnel} />
        <RevenueChart data={revenue?.byMonth} />
      </div>

      <LossReasonsChart data={conversion?.lossReasons} />
    </div>
  )
}
```

- [ ] **3. Criar `MetricTile.tsx`**

```tsx
// frontend/src/components/analytics/MetricTile.tsx
import { MoneyDisplay } from '@/components/shared/MoneyDisplay'

interface MetricTileProps {
  label: string
  value?: number
  percent?: boolean
}

export default function MetricTile({ label, value, percent }: MetricTileProps) {
  return (
    <div className="bg-white p-4 rounded-md shadow-sm">
      <p className="text-xs text-neutral-600">{label}</p>
      <p className="text-heading-24 font-semibold mt-2">
        {percent ? `${value}%` : <MoneyDisplay amount={value || 0} />}
      </p>
    </div>
  )
}
```

- [ ] **4. Criar gráficos (ConversionChart, RevenueChart, LossReasonsChart)**

Use Recharts (já instalado) para visualizações. Exemplo:

```tsx
// frontend/src/components/analytics/ConversionChart.tsx
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts'

interface ConversionChartProps {
  data?: Array<{ stage: string; count: number }>
}

export default function ConversionChart({ data = [] }: ConversionChartProps) {
  return (
    <div>
      <h3 className="font-semibold mb-4">Funil de Conversão</h3>
      <BarChart width={400} height={300} data={data}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="stage" />
        <YAxis />
        <Tooltip />
        <Bar dataKey="count" fill="var(--color-accent)" />
      </BarChart>
    </div>
  )
}
```

- [ ] **5. Adicionar hooks `useAnalyticsConversion`, `useAnalyticsRevenue`**

```typescript
// frontend/src/api/analytics.ts
export function useAnalyticsConversion(filters: { startDate?: string; endDate?: string }) {
  return useQuery({
    queryKey: queryKeys.analyticsConversion(filters),
    queryFn: async () => {
      const res = await apiClient.get('/analytics/conversion', { params: filters })
      return res.data
    },
  })
}

export function useAnalyticsRevenue(filters: { startDate?: string; endDate?: string }) {
  return useQuery({
    queryKey: queryKeys.analyticsRevenue(filters),
    queryFn: async () => {
      const res = await apiClient.get('/analytics/revenue', { params: filters })
      return res.data
    },
  })
}
```

- [ ] **6. Atualizar routes**

```tsx
{ path: '/analytics', element: <Analytics />, requiredRoles: ['attendant', 'manager', 'admin'] }
```

- [ ] **7. Rodar testes**

```bash
npm run test:frontend
```

- [ ] **8. Commit**

```bash
git add frontend/src/pages/Analytics.tsx frontend/src/components/analytics/ frontend/src/api/analytics.ts
git commit -m "[ui] feat: Dashboard de conversão com gráficos de funil, receita e motivos"
```

---

### Task 6: Personalização (`/settings/theme`)

**Agente:** Agent-UI-Theme

**Responsabilidade:** Selector de cores (5 presets + custom), preview em tempo real.

**Files:**
- Create: `frontend/src/pages/Settings/Theme.tsx`
- Create: `frontend/src/components/theme/ColorPicker.tsx`, `ThemePreview.tsx`
- Modify: `frontend/src/routes/index.tsx`

**Interfaces:**
- Consumes:
  - `GET /themes/current` (tema atual do tenant)
  - `GET /themes/presets` (5 presets estáticos)
  - `PATCH /themes/current` (salvar cor base)
- Produces:
  - `<Theme />` settings page

**Passos:**

- [ ] **1. Escrever teste: Selector renderiza 5 presets**

```tsx
test('Theme page renders 5 color presets', () => {
  render(<Theme />)

  expect(screen.getByText(/Terracota/)).toBeInTheDocument()
  expect(screen.getByText(/Azul Jaleco/)).toBeInTheDocument()
  // ... 3 mais
})
```

- [ ] **2. Criar `Settings/Theme.tsx`**

```tsx
// frontend/src/pages/Settings/Theme.tsx
import { useThemeCurrent, useUpdateTheme, useThemePresets } from '@/api/theme'
import ColorPicker from '@/components/theme/ColorPicker'
import ThemePreview from '@/components/theme/ThemePreview'

export default function Theme() {
  const { data: currentTheme } = useThemeCurrent()
  const { data: presets } = useThemePresets()
  const updateTheme = useUpdateTheme()

  return (
    <div className="max-w-1180px p-12 space-y-6">
      <h1 className="text-heading-32">Personalização</h1>

      <div className="grid grid-cols-2 gap-6">
        <div>
          <h3 className="font-semibold mb-4">Cores Predefinidas</h3>
          {presets?.map((preset) => (
            <button
              key={preset.id}
              onClick={() => updateTheme.mutate({ baseColor: preset.baseColor })}
              className="block p-3 mb-2 border rounded-md hover:bg-neutral-100"
            >
              <div className="flex items-center gap-2">
                <div
                  className="w-6 h-6 rounded-full"
                  style={{ backgroundColor: preset.baseColor }}
                />
                {preset.name}
              </div>
            </button>
          ))}

          <h3 className="font-semibold mt-6 mb-4">Cor Personalizada</h3>
          <ColorPicker
            color={currentTheme?.baseColor}
            onChange={(color) => updateTheme.mutate({ baseColor: color })}
          />
        </div>

        <div>
          <h3 className="font-semibold mb-4">Preview</h3>
          <ThemePreview color={currentTheme?.baseColor} />
        </div>
      </div>
    </div>
  )
}
```

- [ ] **3. Criar `ColorPicker.tsx`**

```tsx
// frontend/src/components/theme/ColorPicker.tsx
import Input from '@/components/ui/Input'

interface ColorPickerProps {
  color?: string
  onChange: (color: string) => void
}

export default function ColorPicker({ color, onChange }: ColorPickerProps) {
  return (
    <div className="space-y-2">
      <Input
        type="color"
        value={color || '#000000'}
        onChange={(e) => onChange(e.target.value)}
      />
      <p className="text-xs text-neutral-600">{color || 'Nenhuma cor selecionada'}</p>
    </div>
  )
}
```

- [ ] **4. Criar `ThemePreview.tsx`** (amostra de componentes com cor)

```tsx
// frontend/src/components/theme/ThemePreview.tsx
import Button from '@/components/ui/Button'
import Chip from '@/components/ui/Chip'

interface ThemePreviewProps {
  color?: string
}

export default function ThemePreview({ color }: ThemePreviewProps) {
  return (
    <div
      className="p-6 rounded-md space-y-4"
      style={{
        backgroundColor: color ? `${color}20` : '#f0f0f0',
      }}
    >
      <h3 className="font-semibold">Preview</h3>
      <Button variant="primary">Botão Primário</Button>
      <Chip tone="positive">Chip Positivo</Chip>
      <Chip tone="attention">Chip Atenção</Chip>
    </div>
  )
}
```

- [ ] **5. Adicionar hooks**

```typescript
// frontend/src/api/theme.ts
export function useThemeCurrent() {
  return useQuery({
    queryKey: queryKeys.themeCurrent(),
    queryFn: async () => {
      const res = await apiClient.get('/themes/current')
      return res.data
    },
  })
}

export function useThemePresets() {
  return useQuery({
    queryKey: queryKeys.themePresets(),
    queryFn: async () => {
      const res = await apiClient.get('/themes/presets')
      return res.data.presets
    },
  })
}

export function useUpdateTheme() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (data: { baseColor: string }) => {
      const res = await apiClient.patch('/themes/current', data)
      return res.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.themeCurrent() })
    },
  })
}
```

- [ ] **6. Atualizar routes**

```tsx
{ path: '/settings/theme', element: <Theme />, requiredRoles: ['admin'] }
```

- [ ] **7. Rodar testes**

```bash
npm run test:frontend
```

- [ ] **8. Commit**

```bash
git add frontend/src/pages/Settings/Theme.tsx frontend/src/components/theme/ frontend/src/api/theme.ts
git commit -m "[ui] feat: Tela de personalização com selector de cores e preview"
```

---

### Task 7: Usuários & Permissões (`/settings/users`)

**Agente:** Agent-UI-Users

**Responsabilidade:** Tabela de usuários, criar/editar, atribuir papéis e alçada.

**Files:**
- Create: `frontend/src/pages/Settings/Users.tsx`
- Create: `frontend/src/components/users/{UserTable,UserModal,PermissionGrid}.tsx`
- Modify: `frontend/src/routes/index.tsx`

**Interfaces:**
- Consumes:
  - `GET /users` (lista de usuários)
  - `POST /users`, `PATCH /users/:id` (criar/editar)
- Produces:
  - `<Users />` settings page

**Passos:**

- [ ] **1. Escrever teste: UserTable renderiza lista, admin pode criar**

```tsx
test('Users page shows user table with create button for admin', () => {
  useAuthStore.setState({ user: { role: 'admin' } })

  render(<Users />)

  expect(screen.getByRole('columnheader', { name: /email/i })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /novo usuário/i })).toBeInTheDocument()
})
```

- [ ] **2. Criar `Settings/Users.tsx`**

```tsx
// frontend/src/pages/Settings/Users.tsx
import { useState } from 'react'
import { useUserList } from '@/api/users'
import UserTable from '@/components/users/UserTable'
import UserModal from '@/components/users/UserModal'
import Button from '@/components/ui/Button'

export default function Users() {
  const [showModal, setShowModal] = useState(false)
  const { data: users, isLoading } = useUserList()

  return (
    <div className="max-w-1180px p-12 space-y-4">
      <div className="flex justify-between items-center">
        <h1 className="text-heading-32">Usuários & Permissões</h1>
        <Button variant="primary" onClick={() => setShowModal(true)}>
          + Novo Usuário
        </Button>
      </div>

      {isLoading ? (
        <div>Carregando...</div>
      ) : (
        <UserTable users={users || []} />
      )}

      {showModal && <UserModal onClose={() => setShowModal(false)} />}
    </div>
  )
}
```

- [ ] **3. Criar `UserTable.tsx`**

```tsx
// frontend/src/components/users/UserTable.tsx
import { ManagedUser } from '@crm-lab/shared'
import DataTable from '@/components/shared/DataTable'
import Button from '@/components/ui/Button'

interface UserTableProps {
  users: ManagedUser[]
}

export default function UserTable({ users }: UserTableProps) {
  return (
    <DataTable
      columns={[
        { header: 'Email', accessor: 'email' },
        { header: 'Nome', accessor: 'name' },
        { header: 'Papel', accessor: 'role' },
        { header: 'Alçada de Desconto', accessor: 'discountLimit' },
        { header: 'Ativo', accessor: (user: ManagedUser) => (user.isActive ? 'Sim' : 'Não') },
        {
          header: 'Ações',
          accessor: (user: ManagedUser) => (
            <Button variant="secondary" size="sm" onClick={() => {/* edit */}}>
              Editar
            </Button>
          ),
        },
      ]}
      data={users}
    />
  )
}
```

- [ ] **4. Criar `UserModal.tsx` (criar/editar)**

```tsx
// frontend/src/components/users/UserModal.tsx
import { useState } from 'react'
import { useCreateUser } from '@/api/users'
import Modal from '@/components/shared/Modal'
import Input from '@/components/ui/Input'
import Select from '@/components/ui/Select'
import Button from '@/components/ui/Button'

interface UserModalProps {
  onClose: () => void
  userId?: string
}

export default function UserModal({ onClose, userId }: UserModalProps) {
  const [form, setForm] = useState({
    email: '',
    name: '',
    password: '',
    role: 'attendant' as const,
    discountLimit: 0,
    isActive: true,
  })

  const createUser = useCreateUser()

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    createUser.mutate(form)
    onClose()
  }

  return (
    <Modal onClose={onClose}>
      <form onSubmit={handleSubmit} className="p-6 space-y-4">
        <h2 className="text-heading-24">{userId ? 'Editar' : 'Novo'} Usuário</h2>

        <Input
          label="Email"
          type="email"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
          required
        />
        <Input
          label="Nome"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          required
        />
        <Input
          label="Senha"
          type="password"
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
          required={!userId}
        />
        <Select
          label="Papel"
          options={[
            { label: 'Atendente', value: 'attendant' },
            { label: 'Gestor', value: 'manager' },
            { label: 'Admin', value: 'admin' },
          ]}
          value={form.role}
          onChange={(value) => setForm({ ...form, role: value as any })}
        />
        <Input
          label="Alçada de Desconto (%)"
          type="number"
          value={form.discountLimit}
          onChange={(e) => setForm({ ...form, discountLimit: Number(e.target.value) })}
        />

        <div className="flex gap-2 pt-4">
          <Button variant="primary" type="submit" disabled={createUser.isPending}>
            Salvar
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
        </div>
      </form>
    </Modal>
  )
}
```

- [ ] **5. Adicionar hooks**

```typescript
// frontend/src/api/users.ts
export function useUserList() {
  return useQuery({
    queryKey: queryKeys.users(),
    queryFn: async () => {
      const res = await apiClient.get('/users')
      return res.data.users
    },
  })
}

export function useCreateUser() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (data: CreateUserRequest) => {
      const res = await apiClient.post('/users', data)
      return res.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.users() })
    },
  })
}
```

- [ ] **6. Atualizar routes**

```tsx
{ path: '/settings/users', element: <Users />, requiredRoles: ['admin'] }
```

- [ ] **7. Rodar testes**

```bash
npm run test:frontend
```

- [ ] **8. Commit**

```bash
git add frontend/src/pages/Settings/Users.tsx frontend/src/components/users/ frontend/src/api/users.ts
git commit -m "[ui] feat: Gestão de usuários com criação, edição e atribuição de papéis"
```

---

### Task 8: Ficha do Paciente (`/patients/:id`) *(bônus/flex)*

**Agente:** Agent-UI-Patients

**Responsabilidade:** Página de leitura com cadastro, histórico, propostas, LGPD.

**Files:**
- Create: `frontend/src/pages/Patients/Detail.tsx`
- Create: `frontend/src/components/patients/{PatientHeader,PatientInteractionTimeline,PatientProposals,LgpdSection}.tsx`
- Modify: `frontend/src/routes/index.tsx`

**Interfaces:**
- Consumes:
  - `GET /patients/:id` (detalhe)
  - `GET /patients/:id/interactions` (timeline)
  - `GET /patients/:id/proposals` (propostas)
- Produces:
  - `<PatientDetail />` component

**Passos:**

- [ ] **1-8:** Similar às tasks anteriores — tela de leitura com 4 seções, sem modal de edição

---

### Task 9: Validador E2E (Workflows 1-3)

**Agente:** Agent-QA-E2E

**Responsabilidade:** Testes Playwright cobrindo 3 fluxos críticos: orçamento, aprovação, ganho/perda.

**Files:**
- Create: `e2e/workflows/flow-1-new-budget.spec.ts`
- Create: `e2e/workflows/flow-2-approval.spec.ts`
- Create: `e2e/workflows/flow-3-win-loss.spec.ts`

**Interfaces:**
- Runs against: `http://localhost:5173` (dev server) + backend real
- Uses fixtures: `E2E_TENANTS`, `E2E_USERS`, `E2E_PASSWORD` de `backend/src/db/seeds/e2e-fixtures.ts`

**Passos:**

- [ ] **1. Escrever `flow-1-new-budget.spec.ts` — Criar orçamento**

```typescript
// e2e/workflows/flow-1-new-budget.spec.ts
import { test, expect } from '@playwright/test'
import { E2E_USERS, E2E_PASSWORD, E2E_EXAMS } from '../../backend/src/db/seeds/e2e-fixtures.js'

test.describe('Flow 1: Create Budget', () => {
  test('Attendant creates budget and sends to patient', async ({ page }) => {
    // 1. Login como attendant
    await page.goto('/login')
    await page.fill('input[type="email"]', E2E_USERS.attendant.email)
    await page.fill('input[type="password"]', E2E_PASSWORD)
    await page.click('button[type="submit"]')
    await page.waitForURL('/attendance')

    // 2. Abrir conversa
    await page.click('[data-testid="conversation-1"]')
    await page.click('button:has-text("Novo Orçamento")')
    await page.waitForURL('/budget/new')

    // 3. Buscar e adicionar exames
    await page.fill('input[placeholder*="Buscar"]', E2E_EXAMS[0].name)
    await page.click(`button:has-text("${E2E_EXAMS[0].name}")`)
    await expect(page.locator('[data-testid="summary-items"]')).toContainText(E2E_EXAMS[0].name)

    // 4. Aplicar desconto (dentro da alçada)
    await page.fill('input[type="number"][placeholder*="Desconto"]', '5')
    await page.click('button:has-text("Criar Orçamento")')

    // 5. Verificar que proposta foi criada
    await page.waitForURL('/attendance')
    await expect(page.locator('[data-testid="proposal-card"]')).toBeVisible()

    // 6. Clique na proposta, marque como "orcamento_enviado"
    await page.click('[data-testid="proposal-card"]')
    await page.click('button:has-text("Mudar estágio")')
    await page.click('option:has-text("Orçamento Enviado")')
    await page.click('button:has-text("Confirmar")')

    // 7. Verificar que mensagem de sistema apareceu na conversa
    await expect(page.locator('[data-testid="system-message"]')).toContainText('Orçamento')
  })
})
```

- [ ] **2. Escrever `flow-2-approval.spec.ts` — Desconto > alçada**

```typescript
// e2e/workflows/flow-2-approval.spec.ts
test.describe('Flow 2: Approval Flow', () => {
  test('Attendant submits budget with high discount, manager approves', async ({ page }) => {
    // 1. Attendant login + novo orçamento
    await page.goto('/login')
    await page.fill('input[type="email"]', E2E_USERS.attendant.email)
    await page.fill('input[type="password"]', E2E_PASSWORD)
    await page.click('button')
    await page.goto('/budget/new')

    // 2. Adicionar exame + DESCONTO ALTO (20%, acima alçada de 10%)
    await page.fill('input[placeholder*="Buscar"]', E2E_EXAMS[0].name)
    await page.click(`button:has-text("${E2E_EXAMS[0].name}")`)
    await page.fill('input[type="number"][placeholder*="Desconto"]', '20')

    // 3. Verificar aviso "Exigirá aprovação"
    await expect(page.locator('[data-testid="chip-attention"]')).toContainText('aprovação')

    // 4. Criar orçamento
    await page.click('button:has-text("Criar")')

    // 5. Manager login + check #aprovacoes channel
    await page.context().addCookies([
      {
        name: 'token',
        value: '', // Logaria como manager
      },
    ])
    await page.goto('/internal-chat')
    await page.click('[data-testid="channel-aprovacoes"]')

    // 6. Ver post de aprovação com orçamento anexado
    await expect(page.locator('[data-testid="approval-post"]')).toBeVisible()

    // 7. Clicar "Aprovar"
    await page.click('button:has-text("Aprovar")')

    // 8. Voltar para attendant, verificar que proposta agora tem approvalStatus: approved
    await page.goto('/proposals')
    const card = page.locator('[data-testid="proposal-card"]').first()
    await expect(card).not.toContainText('aguardando aprovação')
  })
})
```

- [ ] **3. Escrever `flow-3-win-loss.spec.ts` — Marcar ganho/perdido**

```typescript
// e2e/workflows/flow-3-win-loss.spec.ts
test.describe('Flow 3: Win/Loss', () => {
  test('Attendant marks proposal as won', async ({ page }) => {
    await page.goto('/login')
    // Login + navegar para proposta

    // Abrir modal
    await page.click('[data-testid="proposal-card"]')

    // Marcar como ganho
    await page.click('button:has-text("Marcar como Ganho")')
    await expect(page.locator('[data-testid="status-ganho"]')).toBeVisible()
  })

  test('Attendant marks proposal as lost with reason', async ({ page }) => {
    // Similar, mas clicar "Marcar como Perdido"
    // Preencher motivo obrigatório
    // Verificar que chip muda para "Perdido"
  })
})
```

- [ ] **4. Rodar E2E contra ambiente local**

```bash
npm run seed:e2e  # Preparar dados
npm run dev       # Backend + Frontend
npx playwright test e2e/workflows/  # Rodar testes
```

Expected: 3 suites passando, workflows funcionando ponta-a-ponta.

- [ ] **5. Commit E2E**

```bash
git add e2e/workflows/
git commit -m "[qa] feat: E2E workflows 1-3 (orçamento, aprovação, ganho/perda)"
```

---

## Resumo de Checkpoints

1. ✅ **Após Tasks 1-7:** Todas as 7 telas implementadas, consumindo APIs reais, testes verdes
2. ✅ **Após Task 8:** Ficha do paciente (bônus)
3. ✅ **Após Task 9:** E2E validador cobrindo workflows críticos
4. ✅ **Antes de marcar pronto:**
   - `npm run typecheck` (frontend + backend) → verde
   - `npm run test:frontend` → verde
   - `npm run test:backend` → verde (não mudou)
   - `npx playwright test e2e/` → verde
   - `docs/STATUS.md` atualizado: Onda 4 **✅ 2026-08-24**
   - Zero mocks ativos (remover fixtures de Onda 3)

