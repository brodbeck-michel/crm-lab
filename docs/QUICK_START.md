# 🚀 Quick Start - Guia de Início Rápido

Para quem está chegando no projeto. Leia isto antes de mergulhar na documentação técnica.

## ⚡ 5 Minutos: O que é este projeto?

**CRM SaaS para Laboratórios** = atendimento por WhatsApp + orçamentos + pipeline de propostas
para laboratórios de análises clínicas. Já está em produção (laboratório Santé).

- **Multitenant:** vários laboratórios no mesmo sistema, isolados por `tenant_id` (+ RLS no Postgres)
- **Real-time:** chat com pacientes por WebSocket
- **WhatsApp:** Cloud API oficial da Meta ou gateway por QR (Evolution); em dev, driver MOCK
- **Personalização:** cada laboratório tem tema próprio (tokens CSS)
- **Pipeline:** orçamentos passam por 6 estágios (novo orçamento → ganho/perdido)

---

## 📊 Estrutura do Projeto

Monorepo com **npm workspaces**:

```
crm-lab/
├── shared/             # @crm-lab/shared — tipos e constantes canônicas (espelham API_CONTRACTS)
├── backend/            # Express 4 + TypeScript ESM (D-007)
│   ├── src/
│   │   ├── controllers/    # Rotas HTTP (*.routes.ts)
│   │   ├── services/       # Regras de negócio
│   │   ├── repositories/   # Acesso ao banco (sempre filtrando tenant_id)
│   │   ├── http/           # Middleware, erros, montagem de módulos
│   │   ├── db/             # Driver pg/PGlite, migrator, seeds
│   │   ├── config/  lib/
│   │   └── main.ts
│   ├── migrations/         # NNN_descricao.sql (nunca editar uma já aplicada)
│   └── .env.example
├── frontend/           # React 18 + Vite + Tailwind 3 + TanStack Query + Zustand
│   ├── src/{pages,components,hooks,stores,api,routes,styles,lib}
│   └── .env.example
├── e2e/                # Playwright
├── docs/               # A documentação — é o contrato (ver docs/AGENTS.md)
├── scripts/deploy.sh   # Deploy de prod/hml (ver docs/guides/ENVIRONMENTS.md)
├── docker-compose.yml  # Dev: Postgres 16, Redis 7, Evolution (WhatsApp por QR)
└── .github/workflows/ci.yml
```

---

## 🔧 Setup Local (10 minutos)

### Pré-requisitos
```bash
node --version    # 22 recomendado (é o das imagens de prod); mínimo 18
npm --version     # 9+
docker --version  # 24+
```

### 1. Clonar e instalar (na raiz — instala todos os workspaces)
```bash
git clone https://github.com/brodbeck-michel/crm-lab.git
cd crm-lab
npm install
```

### 2. Configurar ambiente
```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```
Os defaults do `.env.example` já funcionam em dev. `WHATSAPP_API_URL` vazia = driver MOCK
(mensagens "enviadas" vão para o log e um eco simulado volta após 2s).

### 3. Subir banco e popular
```bash
docker compose up -d     # Postgres :5432, Redis :6379, Evolution :8080
npm run migrate
npm run seed
```

> ⚠️ **Volume `postgres-data` criado antes da Onda 7?** Veja a nota sobre o banco `evolution`
> em `docs/guides/DEVELOPMENT.md` → Setup.

### 4. Rodar aplicação
```bash
npm run dev     # backend (:3000) + frontend (:5173) em paralelo
```
Abra http://localhost:5173. Usuários do seed: senha `senha123` — lista completa em
`docs/guides/DEVELOPMENT.md` (o `npm run seed` também imprime as credenciais).

### 5. Conferir que está tudo verde
```bash
npm run typecheck
npm run test:backend     # roda em PGlite, não precisa do Docker
npm run test:frontend
```

---

## 🎯 Primeiros Passos

**Todos:**
1. `CLAUDE.md` (raiz) — regras críticas e stack em uma página
2. `docs/AGENTS.md` — protocolo de trabalho (docs primeiro, ownership de pastas)
3. `docs/domain/BUSINESS_RULES.md` — as regras de negócio que não podem quebrar
4. `docs/ARCHITECTURE.md` — visão geral

**Front-end:** `docs/design/DESIGN_TOKENS.md` → `docs/frontend/COMPONENTS.md` → `docs/frontend/PAGES.md`

**Back-end:** `docs/database/SCHEMA.md` → `docs/backend/SERVICES.md` → `docs/api/API_CONTRACTS.md` + `docs/api/API_ERRORS.md`

**Infra/Deploy:** `docs/guides/ENVIRONMENTS.md` (leia ANTES de tocar em prod/hml) → `docs/guides/DEPLOYMENT.md` → `docs/architecture/SECURITY.md`

---

## 📝 Primeira tarefa? Faça isso

1. **Entender:** leia o fluxo em `docs/domain/WORKFLOWS.md` e as regras em `BUSINESS_RULES.md`
2. **Conferir o contrato:** o endpoint/tabela/componente existe em `docs/`? Se não existe,
   documente PRIMEIRO no doc do domínio, implemente DEPOIS (Regra Zero)
3. **Branch** a partir da `main`: `feature/CRMLAB-NNN-descricao` (ou `fix/`, `docs/`)
4. **Codar com testes** (`*.spec.ts` / `*.spec.tsx`, ver `docs/guides/TESTING.md`)
5. **Antes do PR:** `npm run typecheck` + testes do domínio verdes, `docs/STATUS.md` atualizado
6. **PR para `main`** — ver `docs/guides/CONVENTIONS.md` → Git Workflow

---

## 🔍 Onde Encontrar Coisas

| Pergunta | Onde |
|---|---|
| Como estruturar um novo service? | `docs/backend/SERVICES.md` |
| Que cor/raio/fonte usar? | `docs/design/DESIGN_TOKENS.md` |
| Qual é o fluxo de orçamento? | `docs/domain/WORKFLOWS.md` |
| Preciso de um endpoint novo | `docs/api/API_CONTRACTS.md` + `docs/contracts/FRONTEND_BACKEND.md` |
| Como funciona a autenticação? | `docs/api/API_CONTRACTS.md` (seção Auth) + `docs/architecture/SECURITY.md` |
| Schema do banco | `docs/database/SCHEMA.md` |
| Por que foi feito assim? | `docs/DECISIONS.md` (D-NNN) |
| O que está em andamento? | `docs/STATUS.md` |

---

## ⚠️ Regras Críticas (resumo — lista completa no `CLAUDE.md`)

1. **Sempre** filtre por `tenant_id`; recurso de outro tenant → `NOT_FOUND`
2. **Nunca** confie no total do cliente — `totalPrice` é calculado no backend
3. **Nunca** crie endpoint/tabela/componente sem documentar antes em `docs/`
4. **Nunca** hex, px de raio ou nome de fonte em componente — só tokens CSS
5. **Nunca** `any` — use `unknown` + narrowing
6. **Nunca** redeclare shape de API — importe de `@crm-lab/shared`
7. **Sempre** teste para lógica de negócio

---

## ✅ Checklist: Pronto para começar?

- [ ] Node 22 instalado, Docker rodando
- [ ] `npm install` na raiz
- [ ] `backend/.env` e `frontend/.env` criados
- [ ] `npm run migrate` + `npm run seed`
- [ ] `npm run dev` e login em http://localhost:5173
- [ ] `npm run typecheck` e testes verdes
- [ ] Leu `CLAUDE.md` e `docs/AGENTS.md`

**Próximo:** `docs/ARCHITECTURE.md`.
