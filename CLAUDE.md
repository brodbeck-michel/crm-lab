# CRM SaaS Laboratório — Instruções para agentes

## Regra Zero
`docs/` é o contrato. Nenhum agente inventa endpoint, tabela, componente ou token que não esteja
documentado. Precisa de algo novo: documente PRIMEIRO (no doc do domínio), implemente DEPOIS.
Leia `docs/AGENTS.md` antes de qualquer tarefa.

## Stack decidida (não renegociar)
- Monorepo npm workspaces: `shared/` · `backend/` · `frontend/` · `e2e/`
- Backend: **Express 4 + TypeScript ESM** (D-007), camadas controller → service → repository
- Banco: PostgreSQL 16. Dev/prod via `docker-compose.yml`; **testes via PGlite** (D-008)
- Frontend: React 18 + Vite + TypeScript + Tailwind 3 (cores mapeadas para CSS vars) + TanStack Query + Zustand
- Testes: Vitest (back e front), Playwright (e2e)

## Tipos compartilhados — fonte única
`shared/types/` espelha `docs/api/API_CONTRACTS.md`. Backend e frontend **importam de
`@crm-lab/shared`**. Nunca redeclare um shape de API localmente. Se o tipo estiver errado,
corrija em `shared/types/` e atualize o doc no mesmo commit.

Constantes canônicas que já existem lá (use, não reimplemente):
- `ALLOWED_TRANSITIONS`, `isTransitionAllowed`, `TERMINAL_STATUSES` — matriz de estágios
- `calculateSubtotal`, `calculateTotal` — cálculo do total (regra §1)
- `DEFAULT_DISCOUNT_LIMIT` — alçada por perfil
- `ApiErrorCode` — catálogo de códigos de erro

## Módulos ESM
Tudo é ESM (`"type": "module"`). **Imports relativos no backend levam extensão `.js`**
(`import { x } from './foo.js'`), mesmo apontando para `.ts`. No frontend, use o alias `@/`.

## Regras críticas (violação = bug crítico)
1. **Multitenant:** toda query/endpoint/tela filtra por `tenant_id`. Sem exceção.
2. **Total calculado:** `totalPrice` deriva de items + desconto no backend. O cliente nunca envia.
3. **Alçada:** validada no backend SEMPRE (frontend só para UX).
4. **Estágios:** só transições de `ALLOWED_TRANSITIONS`; `perdido` exige `reasonLost` válido.
5. **Design:** zero hex, zero px de raio, zero nome de fonte em componente — só tokens CSS.
6. **TypeScript:** `any` proibido (use `unknown` + narrowing). `strict: true` já está ligado.
7. **Auditoria:** proposta, aprovação e permissão geram audit log.
8. **Erros:** backend lança `BusinessError` tipada; middleware converte para o formato de
   `docs/api/API_ERRORS.md`. Recurso de outro tenant → `NOT_FOUND` (nunca `FORBIDDEN`).
9. **Dinheiro no fio:** número decimal (`179.80`), nunca string formatada. Datas: ISO 8601 UTC.
10. **Sem `console.log`** no backend — use o logger. Sem segredos hardcoded — env vars.

## Comandos
```
npm run typecheck            # todos os workspaces
npm run test:backend         # vitest backend
npm run test:frontend        # vitest frontend
npm run migrate / npm run seed
```

## Ownership de pastas
Cada agente escreve SÓ na sua pasta. Precisou de algo de outro domínio: registre em
`docs/STATUS.md` → "Pedidos entre Agentes". Nunca edite arquivo de outro domínio.

## Ao terminar
1. Rode `npm run typecheck` e os testes do seu domínio — **têm que passar**
2. Atualize `docs/STATUS.md` (tarefa ✅ + data) e o doc do seu domínio se divergiu
3. Nunca declare pronto sem ter visto a saída verde do comando
