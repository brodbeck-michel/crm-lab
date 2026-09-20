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

### Sondas de saúde (CRMLAB-29)

Duas, com papéis que não se misturam:

| Sonda | Caminho | Responde por |
|---|---|---|
| Liveness | `GET /health`, `GET /health/live` | O processo. Trivial, sem tocar em dependência. É o que `HEALTHCHECK`/compose consultam. |
| Readiness | `GET /api/v1/health` | O sistema. `SELECT 1` + `PING`; **503** quando uma dependência cai, dizendo qual. É o que deploy e monitor consultam. |

- Liveness **nunca** consulta dependência: senão uma queda do Postgres
  reinicia o container do backend em loop, por um problema que não é dele.
- Readiness mora sob `/api/v1/` porque é o único prefixo que o nginx faz
  proxy — `/health` pela internet devolve o HTML da SPA com 200.
- As duas ficam **fora do rate limit** (health que responde 429 não serve de
  health) e o resultado da readiness é memoizado por 5 s, com timeout de 2 s
  por dependência e sem abrir transação.

Implementação em `backend/src/lib/health.ts`; operação, alerta e heartbeat em
[`MONITORING.md`](./MONITORING.md).

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
# Relativo (D-142) — o dev server do Vite faz proxy de /api e /ws para o
# backend (vite.config.ts), mesmo origin que a produção (D-051).
VITE_API_URL=/api/v1
VITE_WS_URL=/ws
```

- Nova env var → adicionar ao `.env.example` no mesmo commit
- Nunca commitar `.env`

---

## Política de Atualização de Dependências

Ownership de `package.json` dos workspaces, `package-lock.json` e `.github/`: um agente por
vez (ver `docs/AGENTS.md`/plano da onda), nunca dois em paralelo — os dois mexem no mesmo
lockfile.

| Tipo de update | Como chega | Merge |
|---|---|---|
| **Patch** (`x.y.Z`) | Dependabot, PR agrupado semanal (grupo `patches` em `.github/dependabot.yml`) | Auto-merge se o CI (`quality` + `security` + `build`) estiver verde. Sem revisão humana — patch não muda API pública por definição do semver |
| **Minor** (`x.Y.0`) | Dependabot, PR semanal individual | Revisão humana antes do merge — checar changelog por mudança de comportamento não coberta pelo semver |
| **Major** (`X.0.0`) | Dependabot abre o PR, mas **não mergear direto** | Vira card no Jira (projeto CRMLAB) antes de qualquer código: breaking change exige avaliar uso real no repo (ex.: CRMLAB-37 documentou por que `jspdf` foi para a 4.x em vez do `^3.0.2` pedido — advisory novo tornou a 3.x insuficiente) |

Regras que valem para as três colunas:

- **`npm audit --omit=dev --audit-level=high` verde é obrigatório** para qualquer merge de
  dependência (job `security` no CI) — moderate/low não bloqueiam, mas ficam registrados no
  log do job.
- Dependência instalada por URL/tarball fora do registry do npm (ex.: `xlsx` do frontend, via
  CDN da SheetJS) fica de fora do Dependabot (`ignore` em `dependabot.yml`) — checagem de nova
  versão é manual, e a troca de dependência crítica sem advisory automatizado é uma
  vulnerabilidade de processo em si; ver `docs/DECISIONS.md` D-135/D-136.
- Remover uma dependência (não só trocar de versão) sempre exige nota em `docs/DECISIONS.md`,
  como já dizia `docs/AGENTS.md`.
- Dependência nova (não é update) segue a regra geral de `docs/AGENTS.md`: documentar antes de
  usar, se ela expõe algo em contrato de API/schema/design.

## Logs

```typescript
logger.info('proposal.created', { proposalId, tenantId, userId, totalPrice });
logger.warn('proposal.approval_required', { proposalId, discount, userLimit });
logger.error('whatsapp.send_failed', { conversationId, error: err.message });
```

- Estruturado (JSON em prod), com evento em dot.notation + contexto
- NUNCA logar: senhas, tokens, conteúdo de mensagens de pacientes
