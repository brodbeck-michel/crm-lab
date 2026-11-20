# CRM Lab

CRM SaaS multitenant para laboratórios de análises clínicas: atendimento por WhatsApp,
orçamentos e pipeline de propostas.

**Stack:** monorepo npm workspaces · Express 4 + TypeScript ESM · React 18 + Vite + Tailwind ·
PostgreSQL 16 · Vitest + Playwright.

## Começando

```bash
npm install
cp backend/.env.example backend/.env && cp frontend/.env.example frontend/.env
docker compose up -d
npm run migrate && npm run seed
npm run dev        # http://localhost:5173 — usuários do seed com senha senha123
```

## Documentação

`docs/` é o contrato do projeto — leia antes de codar:

1. [`docs/QUICK_START.md`](docs/QUICK_START.md) — setup e primeiros passos
2. [`CLAUDE.md`](CLAUDE.md) — stack e regras críticas em uma página
3. [`docs/AGENTS.md`](docs/AGENTS.md) — protocolo de trabalho
4. [`docs/README.md`](docs/README.md) — índice completo

Repositório privado.
