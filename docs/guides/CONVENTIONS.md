# 📐 Convenções de Código

Padrões obrigatórios para todos os agentes/desenvolvedores. Consistência > preferência pessoal.

---

## Geral

- **Idioma:** código e identificadores em INGLÊS; textos de UI em PORTUGUÊS (pt-BR); docs em português
- **TypeScript estrito:** `strict: true`; `any` proibido (use `unknown` + narrowing)
- **Formatação:** Prettier (config na raiz) — sem debates de estilo
- **Lint:** ESLint; build falha com warning de lint no CI

---

## Nomenclatura

| Item | Padrão | Exemplo |
|------|--------|---------|
| Arquivos de componente | PascalCase | `ProposalCard.tsx` |
| Outros arquivos TS | kebab-case | `proposal.service.ts` |
| Variáveis/funções | camelCase | `totalPrice`, `calculateTotal()` |
| Tipos/Interfaces | PascalCase, sem prefixo I | `Proposal`, não `IProposal` |
| Constantes globais | UPPER_SNAKE | `MAX_DISCOUNT_PERCENT` |
| Tabelas do banco | snake_case plural | `proposal_items` |
| Colunas | snake_case | `discount_percent` |
| Endpoints | kebab-case, recursos no plural | `/internal-chat/channels` |
| Eventos WS | dot.notation | `conversation.new_message` |
| Branches | `<dominio>/<descricao>` | `api/proposal-service` |

---

## Estrutura de Tipos Compartilhados

Os shapes da API vivem em um pacote compartilhado espelhando `docs/api/API_CONTRACTS.md`:

```
shared/types/
├── auth.types.ts       # LoginResult, JwtPayload
├── conversation.types.ts
├── proposal.types.ts   # Proposal, ProposalStatus, LossReason
├── exam.types.ts
├── theme.types.ts
└── api.types.ts        # Paginated<T>, ApiError
```

```typescript
// proposal.types.ts — ÚNICO lugar que define estes tipos
export type ProposalStatus =
  | 'novo_contato' | 'orcamento_enviado' | 'follow_up'
  | 'negociacao' | 'ganho' | 'perdido';

export type LossReason = 'preco' | 'silencio' | 'exame_indisponivel' | 'prazo' | 'outro';

export interface Paginated<T> {
  data: T[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}
```

Front e back importam DO MESMO pacote — divergência de shape vira erro de compilação.

---

## Git Workflow

### Commits
```
[dominio] descrição curta no imperativo

[api] add ProposalService with discount validation
[ui] implement ConversationItem component
[db] add migration 003 for audit_logs
[docs] update API_CONTRACTS with approval endpoints
```

### Branches e PRs
- `main` protegida — só via PR com CI verde
- 1 PR = 1 tarefa do STATUS.md (pequeno e focado)
- PR description: o que + por quê + link para doc relevante
- Mudança de contrato (API/schema/tokens): doc atualizado NO MESMO PR

---

## Backend

```typescript
// Controllers: finos — validam DTO, chamam service, retornam
@Post('/proposals')
async create(@Body() dto: CreateProposalDTO, @Ctx() ctx: TenantContext) {
  return this.proposalService.create(ctx, dto);
}

// Services: toda a lógica de negócio; recebem TenantContext explícito
// Repositories: só acesso a dados; sem regra de negócio

// Erros: exceções tipadas
throw new BusinessError('DISCOUNT_EXCEEDS_LIMIT', { requestedDiscount, userLimit });
// Middleware converte para o formato de API_ERRORS.md
```

**Proibido:**
- Query sem filtro de `tenant_id`
- Lógica de negócio em controller ou repository
- `console.log` (usar logger estruturado)
- Segredos hardcoded (sempre env vars)

---

## Frontend

```tsx
// Componentes: função + hooks; props tipadas explícitas
interface ProposalCardProps {
  proposal: Proposal;
  onClick: (id: string) => void;
}

export function ProposalCard({ proposal, onClick }: ProposalCardProps) { ... }

// Dados de servidor: SEMPRE TanStack Query
const { data, isLoading } = useQuery({
  queryKey: ['proposals', filters],
  queryFn: () => api.proposals.list(filters),
});

// Derivados: useMemo, nunca estado duplicado
const total = useMemo(() => calcTotal(items, discount), [items, discount]);
```

**Proibido:**
- Hex/px de raio/nome de fonte em componente (só tokens CSS)
- Copiar dados de servidor para Zustand
- `useEffect` para sincronizar estados derivados
- Fetch fora da camada `api/`

---

## Variáveis de Ambiente

```bash
# backend/.env.example (sempre atualizado com TODAS as chaves)
DATABASE_URL=postgres://...
REDIS_URL=redis://...
JWT_SECRET=
JWT_REFRESH_SECRET=
WHATSAPP_API_URL=        # vazio em dev = driver mock
PORT=3000

# frontend/.env.example
VITE_API_URL=http://localhost:3000/api/v1
VITE_WS_URL=ws://localhost:3000/ws
```

- Nova env var → adicionar ao `.env.example` no mesmo commit
- Nunca commitar `.env`

---

## Logs

```typescript
logger.info('proposal.created', { proposalId, tenantId, userId, totalPrice });
logger.warn('proposal.approval_required', { proposalId, discount, userLimit });
logger.error('whatsapp.send_failed', { conversationId, error: err.message });
```

- Estruturado (JSON em prod), com evento em dot.notation + contexto
- NUNCA logar: senhas, tokens, conteúdo de mensagens de pacientes
