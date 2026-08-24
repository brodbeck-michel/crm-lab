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
| CORS em dev | Conferir `VITE_API_URL` e config de CORS do backend |
| WS não conecta | Token válido? `VITE_WS_URL` correto? |
| Tema não aplica | Login response tem `tenant.theme`? `applyTheme` chamado no bootstrap? |
