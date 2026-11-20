# 🛠️ Guia de Desenvolvimento

Setup do ambiente e ciclo de trabalho diário.

---

## Estrutura do Repositório

```
crm-lab/                # monorepo npm workspaces
├── shared/             # @crm-lab/shared — tipos e constantes (espelham API_CONTRACTS)
├── backend/            # Express 4 + TypeScript ESM (D-007)
├── frontend/           # React 18 + Vite + TS + Tailwind 3
├── e2e/                # Playwright
├── docs/               # Esta documentação
├── scripts/deploy.sh   # Deploy prod/hml (ENVIRONMENTS.md)
├── docker-compose.yml  # Dev: Postgres 16 + Redis 7 + Evolution
└── .github/workflows/  # CI
```

## Setup

```bash
# Pré-requisitos: Node 22 (mínimo 18), Docker
npm install                                  # na raiz, instala todos os workspaces
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
docker compose up -d                         # Postgres :5432 + Redis :6379 + Evolution :8080
npm run migrate && npm run seed
```

## Rodando

```bash
npm run dev     # backend http://localhost:3000 + frontend http://localhost:5173 em paralelo
# ou separado: npm run dev:backend / npm run dev:frontend
```

**Usuários do seed** (senha `senha123` para todos — `DEV_PASSWORD` em
`backend/src/db/seeds/dev.ts`; o `npm run seed` imprime a lista):

| Email | Laboratório | Papel | Alçada |
|---|---|---|---|
| admin@labvida.com.br | Laboratório Vida | admin | 100% |
| gestor@labvida.com.br | Laboratório Vida | manager | 30% |
| maria@labvida.com.br | Laboratório Vida | attendant | 15% |
| joao@labvida.com.br | Laboratório Vida | attendant | 15% |
| admin@labcentral.com.br | Laboratório Central | admin | 100% |
| gestor@labcentral.com.br | Laboratório Central | manager | 30% |
| carla@labcentral.com.br | Laboratório Central | attendant | 15% |
| operador@crmlab.com.br | — (plataforma) | platform_operator | — |

Dois tenants no seed de propósito: dá para testar isolamento multitenant à mão.

Em dev, o WhatsAppService usa driver MOCK (env `WHATSAPP_API_URL` vazia) — mensagens "enviadas" aparecem no log e um eco simulado retorna após 2s.

⚠️ **Volume `postgres-data` de antes da Onda 7?** O gateway `evolution`
(WhatsApp por QR, D-083) precisa do banco `evolution`, criado por
`postgres-init/` — que só roda na primeira inicialização de um volume
**vazio**. Volume já existente de uma versão anterior = script não roda de
novo. O próprio gateway costuma criar o banco sozinho no boot (Prisma migrate,
usando o `crm`, que é superusuário do cluster) — verificado ao vivo contra um
volume pré-existente sem o banco `evolution`. Se `crm-lab-evolution` ainda
assim ficar reiniciando: `docker compose exec -T postgres createdb -U crm
evolution` (sem apagar nada) ou `docker compose down -v` + subir de novo
(apaga Postgres e Redis locais — só no SEU ambiente de dev; em prod/hml `down -v` é proibido).

---

## Ciclo de Trabalho (por tarefa)

1. Card no Jira (projeto CRMLAB) e tarefa em `docs/STATUS.md`
2. Ler o doc do domínio + `docs/domain/BUSINESS_RULES.md`
3. Branch a partir da `main`: `feature/CRMLAB-NNN-descricao` (ou `fix/…`, `docs/…`)
4. Implementar com testes (ver `TESTING.md`)
5. `npm run typecheck` + testes do domínio verdes
6. Atualizar `docs/STATUS.md` + docs afetados
7. PR pequeno para `main`, CI verde, merge (detalhes em `CONVENTIONS.md` → Git Workflow)

## Comandos Úteis

```bash
# Raiz
npm run typecheck          # todos os workspaces
npm run test               # backend + frontend
npm run test:backend       # vitest backend (PGlite, sem Docker)
npm run test:frontend      # vitest frontend
npm run lint
npm run migrate            # aplicar migrações (backend/migrations/NNN_*.sql)
npm run seed               # dados de dev
npm run e2e                # Playwright (antes: npm run seed:e2e)

# Backend (npm run <x> --workspace backend)
test:cov                   # cobertura
```

Migração nova: crie `backend/migrations/NNN_descricao.sql` com o próximo número. Nunca edite
uma migração já aplicada — crie outra.

## Solução de Problemas

| Problema | Solução |
|---|---|
| Porta 5432 ocupada | `docker-compose down` + verificar Postgres local |
| Migração falha | Verificar ordem em `migrations/`; nunca editar migração aplicada — criar nova |
| Sessão cai em `/login` em loop (dev) | Proxy do Vite (`vite.config.ts`) rodando? `VITE_API_URL`/`VITE_WS_URL` relativos (D-142)? Sem proxy o refresh via cookie httpOnly nunca volta (origins diferentes por porta) |
| CORS em dev | Conferir `VITE_API_URL` e config de CORS do backend |
| WS não conecta | Token válido? `VITE_WS_URL` correto? |
| Tema não aplica | Login response tem `tenant.theme`? `applyTheme` chamado no bootstrap? |
