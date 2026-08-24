# 🚀 Quick Start - Guia de Início Rápido

Para novos desenvolvedores que entram no projeto. Leia isso primeiro antes de mergulhar na documentação técnica.

## ⚡ 5 Minutos: O que é este projeto?

**CRM SaaS para Laboratórios** = Sistema de chat + orçamentos + propostas para laboratórios de análises clínicas.

- **Multitenant:** Múltiplos laboratórios no mesmo sistema
- **Real-time:** Chat com pacientes em tempo real
- **Personalização:** Cada laboratório tem seu próprio tema e branding
- **Pipeline:** Orçamentos passam por 6 estágios (novo contato → ganho/perdido)

---

## 📊 Estrutura do Projeto

```
crm-lab/
├── frontend/                    # React + TypeScript + Tailwind
│   ├── src/
│   │   ├── components/         # Componentes reutilizáveis
│   │   ├── pages/              # Páginas do sistema (Atendimento, Orçamento, etc)
│   │   ├── layouts/            # Layouts (Sidebar, Inbox, etc)
│   │   ├── hooks/              # Custom hooks
│   │   ├── contexts/           # React contexts
│   │   ├── stores/             # Zustand stores (estado global)
│   │   └── api/                # Chamadas de API
│   ├── .env.example
│   └── package.json
│
├── backend/                     # Node.js + Express/NestJS + PostgreSQL
│   ├── src/
│   │   ├── controllers/        # Endpoints HTTP
│   │   ├── services/           # Lógica de negócio
│   │   ├── models/             # Modelos do banco
│   │   ├── middleware/         # Auth, validação, etc
│   │   ├── workers/            # Jobs assíncronos
│   │   └── utils/              # Utilities
│   ├── migrations/             # Migrações do banco
│   ├── .env.example
│   └── package.json
│
├── docs/                        # Documentação (você está aqui!)
│   ├── README.md               # Índice
│   ├── QUICK_START.md          # Este arquivo
│   ├── architecture/           # Design técnico
│   ├── api/                    # Contratos de API
│   ├── database/               # Schema do banco
│   ├── frontend/               # Componentes e layouts
│   ├── backend/                # Serviços e models
│   ├── design/                 # Design tokens
│   ├── guides/                 # Guias de desenvolvimento
│   ├── domain/                 # Entidades do negócio
│   └── contracts/              # Contratos entre serviços
│
└── docker-compose.yml          # Desenvolvimento local
```

---

## 🔧 Setup Local (10 minutos)

### Pré-requisitos
```bash
node --version    # 18+ LTS
npm --version     # 9+
docker --version  # 24+
```

### 1. Clonar e instalar
```bash
git clone <repo>
cd crm-lab
cd frontend && npm install
cd ../backend && npm install
```

### 2. Configurar ambiente
```bash
# Backend
cd backend
cp .env.example .env

# Frontend
cd ../frontend
cp .env.example .env
```

### 3. Subir banco de dados
```bash
# Na raiz do projeto
docker-compose up -d

# Esperar alguns segundos, depois rodar migrações
cd backend
npm run migrate

# (Opcional) Seeding de dados iniciais
npm run seed
```

### 4. Rodar aplicação
```bash
# Terminal 1 - Backend (na pasta backend)
npm run dev

# Terminal 2 - Frontend (na pasta frontend)
npm run dev

# Abrir http://localhost:5173
```

---

## 🎯 Primeiros Passos

### Para Front-end
1. Leia `docs/design/DESIGN_TOKENS.md` - entenda cores, tipografia, componentes
2. Leia `docs/frontend/COMPONENTS.md` - lista de componentes disponíveis
3. Leia `docs/frontend/PAGES.md` - estrutura das 12 telas
4. Abra `frontend/src/components` e explore os componentes existentes

### Para Back-end
1. Leia `docs/database/SCHEMA.md` - entenda as tabelas e relacionamentos
2. Leia `docs/backend/SERVICES.md` - quais serviços existem
3. Leia `docs/api/API_CONTRACTS.md` - endpoints esperados
4. Explore `backend/src/models` e `backend/src/services`

### Para DevOps/Infra
1. Leia `docs/guides/DEPLOYMENT.md` - processo de deploy
2. Leia `docs/architecture/SECURITY.md` - isolamento de dados
3. Verifique `docker-compose.yml` - stack local

---

## 📝 Primeiro Ticket? Faça isso

**Exemplo:** "Criar tela de Atendimento com lista de conversas"

1. **Entender o fluxo:**
   - Leia `docs/domain/WORKFLOWS.md` - entenda o fluxo de atendimento
   - Abra `Design System CRM.dc.html` - veja como a tela deve se parecer

2. **Verificar se tá pronto:**
   - Backend tem endpoint `/conversations/mine` em `docs/api/API_CONTRACTS.md`? ✅
   - Frontend tem componente `ConversationItem` em `docs/frontend/COMPONENTS.md`? ✅

3. **Começar a codificar:**
   - Crie a página em `frontend/src/pages/Attendance.tsx`
   - Use componentes existentes
   - Integre com a API (hook de `useConversations()`)
   - Rode testes em `npm run test`

4. **Submeter:**
   - Siga `docs/guides/GIT_WORKFLOW.md`
   - Escreva testes em `*.test.ts`
   - Faça PR descrevendo o que fez

---

## 🔍 Onde Encontrar Coisas

**"Como estruturar um novo serviço?"**  
→ `docs/backend/SERVICES.md`

**"Quais cores usar para esse botão?"**  
→ `docs/design/DESIGN_TOKENS.md`

**"Qual é o fluxo de orçamento?"**  
→ `docs/domain/WORKFLOWS.md`

**"Preciso criar um novo endpoint. Por onde começo?"**  
→ `docs/api/API_CONTRACTS.md` + `docs/backend/CONTROLLERS.md`

**"Como a autenticação funciona?"**  
→ `docs/api/AUTHENTICATION.md`

**"Qual é o schema do banco?"**  
→ `docs/database/SCHEMA.md`

---

## ⚠️ Regras Críticas (DON'T FORGET!)

1. **Nunca** hardcode valores de cor → use tokens CSS
2. **Nunca** crie endpoints sem documentar em `docs/api/API_CONTRACTS.md`
3. **Nunca** faça query no banco sem estar documentada em `docs/database/QUERIES.md`
4. **Sempre** isole dados por tenant (`tenant_id`)
5. **Sempre** use TypeScript (`any` é proibido)
6. **Sempre** valide entrada no backend
7. **Sempre** adicione teste para lógica de negócio

---

## 🎓 Leitura Recomendada (Ordem)

**Dia 1:**
- [ ] Este arquivo (QUICK_START.md)
- [ ] `docs/ARCHITECTURE.md`
- [ ] `docs/domain/ENTITIES.md`

**Dia 2:**
- [ ] `docs/database/SCHEMA.md`
- [ ] `docs/api/API_CONTRACTS.md`
- [ ] Seu domínio específico (front/back/infra)

**Dia 3+:**
- [ ] Documentação detalhada do seu domínio
- [ ] Conventions e Testing
- [ ] Comece a codificar!

---

## 🆘 Precisa de Ajuda?

1. **Dúvida técnica?** Procure na documentação relevante
2. **Documentação confusa ou desatualizada?** Abra issue ou corrija
3. **Quer saber como foi feito X?** Procure em `docs/` ou no código
4. **Encontrou um erro?** Fixe e faça PR!

---

## ✅ Checklist: Pronto para começar?

- [ ] Node 18+ instalado
- [ ] Repositório clonado
- [ ] `.env` configurado
- [ ] Docker rodando
- [ ] Migrações executadas
- [ ] Frontend + Backend rodando localmente
- [ ] Consegue acessar http://localhost:5173
- [ ] Leu QUICK_START.md (este arquivo)
- [ ] Já explorou a estrutura de pastas

**Se tudo está ✅, você está pronto!** 🎉

---

**Próximo:** Leia `docs/ARCHITECTURE.md` para entender a estrutura geral do sistema.
