# 🏗️ Arquitetura do Sistema

Visão geral técnica de como o CRM SaaS é estruturado.

---

## Diagrama de Alto Nível

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLIENTE (Browser)                         │
│                     React 18 + TypeScript                        │
└────────────────────────────────┬────────────────────────────────┘
                                 │ HTTP/WebSocket
                                 │
┌─────────────────────────────────────────────────────────────────┐
│                      API GATEWAY / REVERSE PROXY                 │
│                     (NGINX em produção)                          │
└────────────────────────────────┬────────────────────────────────┘
                                 │ REST + WebSocket
                                 │
┌─────────────────────────────────────────────────────────────────┐
│                         BACKEND LAYER                            │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Node.js + Express/NestJS                                │   │
│  │ - Auth Controller (JWT, OAuth)                          │   │
│  │ - Conversation Controller                               │   │
│  │ - Proposal Controller                                   │   │
│  │ - Exam Catalog Controller                               │   │
│  │ - Conversion Analytics Controller                       │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ BUSINESS LOGIC LAYER (Services)                         │   │
│  │ - AuthService (multitenant JWT)                         │   │
│  │ - ConversationService                                   │   │
│  │ - ProposalService (cálculos, validações)                │   │
│  │ - ExamCatalogService                                    │   │
│  │ - UserService (permissões, alçadas)                     │   │
│  │ - ThemeService (derivação de cores)                     │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ DATA LAYER                                               │   │
│  │ - ORM (Sequelize/TypeORM)                               │   │
│  │ - Query optimization (prepared statements)              │   │
│  │ - Row-Level Security (multitenant isolation)            │   │
│  └──────────────────────────────────────────────────────────┘   │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                ┌────────────────┼────────────────┐
                │                │                │
                ▼                ▼                ▼
        ┌──────────────┐  ┌────────────┐  ┌──────────────┐
        │ PostgreSQL   │  │   Redis    │  │    Bull      │
        │ (Multitenant)│  │   (Cache)  │  │  (Queues)    │
        └──────────────┘  └────────────┘  └──────────────┘
                │
                ▼
        ┌──────────────────┐
        │ External APIs    │
        │ - WhatsApp       │
        │ - Stripe         │
        │ - SendGrid       │
        └──────────────────┘
```

---

## Padrão de Camadas

### 1. **Presentation Layer (Frontend)**
- Componentes React reutilizáveis
- Layouts: Sidebar, Inbox (3 colunas), Orçamento (2 colunas)
- State management: Zustand + TanStack Query
- Roteamento: React Router v6

### 2. **API Layer (Backend)**
- Express.js ou NestJS
- Rotas estruturadas por domínio
- Middleware de auth, validação, erro
- WebSocket para real-time (conversas)

### 3. **Business Logic Layer**
- Services com lógica de negócio
- Validações de regras críticas
- Cálculos de proposta
- Derivação de temas

### 4. **Data Access Layer**
- ORM (TypeORM/Sequelize)
- Repositórios por entidade
- Queries otimizadas
- Migrations

### 5. **Infrastructure**
- Banco de dados (PostgreSQL)
- Cache (Redis)
- Filas (Bull/Redis)
- Autenticação (JWT)

---

## Estratégia Multitenant

### Isolamento por Tenant

**Nível 1: Identificação**
```
JWT inclui: { userId, tenantId, role }
```

**Nível 2: Query Filtering**
```sql
SELECT * FROM conversations 
WHERE tenant_id = $1 AND user_id = $2
```

**Nível 3: Row-Level Security (PostgreSQL)**
```sql
CREATE POLICY tenant_isolation ON conversations
  FOR SELECT USING (tenant_id = current_setting('app.tenant_id')::uuid);
```

### Dados Isolados por Tenant
- `tenants` (base de laboratórios)
- `users` (usuários do laboratório)
- `conversations` (chats do laboratório)
- `proposals` (orçamentos do laboratório)
- `exams` (catálogo personalizado)
- `themes` (personalização visual)
- Tudo tem `tenant_id` como coluna

### Dados Compartilhados (Plataforma)
- `audit_logs` (logs de todos os tenants)
- `subscriptions` (planos e faturas)
- `feature_flags` (toggles globais)

---

## Fluxo de Autenticação

```
┌────────────┐
│  Login UI  │
└─────┬──────┘
      │ email + password
      ▼
┌──────────────────────────────┐
│ POST /auth/login             │
├──────────────────────────────┤
│ 1. Validar credenciais       │
│ 2. Buscar tenant do usuário  │
│ 3. Gerar JWT com tenant_id   │
│ 4. Retornar token + user     │
└─────┬──────────────────────────┘
      │ { accessToken, refreshToken, user, tenant }
      ▼
┌──────────────────────────────┐
│ localStorage.setItem(token)  │
└─────┬──────────────────────────┘
      │ Authorization: Bearer <token>
      ▼
┌──────────────────────────────┐
│ API Middleware               │
├──────────────────────────────┤
│ 1. Verificar JWT             │
│ 2. Extrair tenant_id         │
│ 3. Setar context: tenant_id  │
│ 4. Validar permissões        │
└──────────────────────────────┘
```

---

## Fluxo de Dados: Conversa → Proposta

```
1. Paciente envia mensagem WhatsApp
   ↓
2. Webhook recebe mensagem
   ↓
3. ConversationService.createMessage()
   - Cria message record
   - Emite WebSocket event
   ↓
4. Frontend recebe em tempo real
   ↓
5. Atendente clica "Novo Orçamento"
   ↓
6. ProposalService.create()
   - Valida desconto (alçada)
   - Calcula valor (itens + desconto)
   - Cria proposal com status "novo_contato"
   ↓
7. Conversa passa para estágio "orcamento_enviado"
   ↓
8. Se desconto > alçada:
   - Cria approval request
   - Notifica gestor via chat interno
   - Aguarda aprovação
   ↓
9. Proposta pode passar por: follow_up, negociacao, ganho/perdido
```

---

## Contrato Frontend ↔ Backend

Ver `docs/contracts/FRONTEND_BACKEND.md` para detalhes.

**Exemplo de fluxo:**

Frontend precisa:
1. Listar conversas do usuário
2. Buscar proposta específica
3. Atualizar status da proposta

Backend fornece:
1. `GET /conversations` → `{ conversations[], totalCount, unreadCount }`
2. `GET /proposals/:id` → `{ proposal, history[], approvals[] }`
3. `PATCH /proposals/:id/status` → `{ proposal, message }`

---

## Padrão de Erro Padronizado

Todos os erros seguem este formato:

```json
{
  "error": {
    "code": "PROPOSAL_EXCEEDS_DISCOUNT_LIMIT",
    "message": "Desconto solicitado excede alçada do usuário",
    "statusCode": 403,
    "details": {
      "requestedDiscount": 25,
      "userLimit": 15,
      "approvalRequired": true
    }
  }
}
```

Ver `docs/api/API_ERRORS.md` para códigos definidos.

---

## Performance & Escalabilidade

### Caching Strategy
```
- User profile → Redis (5 min)
- Exam catalog → Redis (1 hour)
- Proposal calculations → In-memory
- Conversation list → TanStack Query (10 sec)
```

### Database Optimization
```
- Índices em: tenant_id, user_id, proposal_id, created_at
- Particionamento por tenant (futuro)
- Query timeouts: 5s (leitura), 10s (escrita)
```

### WebSocket Events (Real-time)
```
- conversation.new_message
- proposal.status_changed
- approval.requested
- user.came_online
```

---

## Segurança

### Camadas de Proteção
1. **HTTPS obrigatório** em produção
2. **JWT com expiração** (15 min access, 7d refresh)
3. **CORS configurado** por tenant (opcional)
4. **SQL Injection prevention** via ORM + prepared statements
5. **XSS prevention** via React sanitization
6. **CSRF protection** via SameSite cookies
7. **Rate limiting** por IP + user
8. **Data encryption** em repouso (senhas, tokens)

Ver `docs/architecture/SECURITY.md` para detalhes.

---

## Deployment Architecture

```
┌─────────────────────┐
│   Git Commit        │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  GitHub Actions CI  │
│ - Lint + Format     │
│ - Testes            │
│ - Build             │
└──────────┬──────────┘
           │ (se passou)
           ▼
┌─────────────────────┐
│  Docker Build       │
│ - Frontend image    │
│ - Backend image     │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  Deploy to Staging  │
│ - Run smoke tests   │
│ - Health checks     │
└──────────┬──────────┘
           │ (se passou)
           ▼
┌─────────────────────┐
│  Manual Approval    │
│ (lead técnico)      │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  Deploy to Prod     │
│ - Blue-green        │
│ - Health checks     │
└─────────────────────┘
```

Ver `docs/guides/DEPLOYMENT.md` para instruções.

---

## Próximas Leituras

- `docs/database/SCHEMA.md` - Entender o banco
- `docs/api/API_CONTRACTS.md` - Endpoints do sistema
- `docs/architecture/SECURITY.md` - Segurança em detalhes
- `docs/architecture/MULTITENANT.md` - Isolamento multitenant

