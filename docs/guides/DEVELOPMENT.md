# 🛠️ Guia de Desenvolvimento

Setup do ambiente e ciclo de trabalho diário.

---

## Estrutura do Repositório (a criar)

```
crm-lab/
├── frontend/          # React + TS + Vite
├── backend/           # NestJS + TS
├── shared/            # Tipos compartilhados (espelham API_CONTRACTS)
├── e2e/               # Playwright
├── docs/              # Esta documentação
├── docker-compose.yml # Postgres + Redis (dev)
└── .github/workflows/ # CI
```

## Setup

```bash
# Pré-requisitos: Node 18+, Docker
docker-compose up -d              # Postgres :5432 + Redis :6379
cd backend && npm i && cp .env.example .env && npm run migrate && npm run seed
cd ../frontend && npm i && cp .env.example .env
```

## Rodando

```bash
# Terminal 1
cd backend && npm run dev          # http://localhost:3000

# Terminal 2
cd frontend && npm run dev         # http://localhost:5173
```

**Usuários do seed (senha: `dev12345`):**
| Email | Papel | Alçada |
|---|---|---|
| atendente@dev.local | attendant | 15% |
| gestor@dev.local | manager | 30% |
| admin@dev.local | admin | 100% |

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
(apaga Postgres e Redis locais).

---

## Ciclo de Trabalho (por tarefa)

1. Reivindicar tarefa em `docs/STATUS.md`
2. Ler o doc do domínio + `BUSINESS_RULES.md`
3. Branch: `<dominio>/<descricao>`
4. Implementar com testes (ver `TESTING.md`)
5. `npm run lint && npm run test` verdes
6. Atualizar STATUS.md + docs afetados
7. PR pequeno, CI verde, merge

## Comandos Úteis

```bash
# Backend
npm run migrate            # aplicar migrações
npm run migrate:create X   # criar migração
npm run seed               # dados de dev
npm run test:int           # integração

# Frontend
npm run test               # vitest
npm run build              # build de produção (checa types)

# Raiz
npm run e2e                # Playwright
```

## Solução de Problemas

| Problema | Solução |
|---|---|
| Porta 5432 ocupada | `docker-compose down` + verificar Postgres local |
| Migração falha | Verificar ordem em `migrations/`; nunca editar migração aplicada — criar nova |
| Sessão cai em `/login` em loop (dev) | Proxy do Vite (`vite.config.ts`) rodando? `VITE_API_URL`/`VITE_WS_URL` relativos (D-142)? Sem proxy o refresh via cookie httpOnly nunca volta (origins diferentes por porta) |
| CORS em dev | Conferir `VITE_API_URL` e config de CORS do backend |
| WS não conecta | Token válido? `VITE_WS_URL` correto? |
| Tema não aplica | Login response tem `tenant.theme`? `applyTheme` chamado no bootstrap? |
