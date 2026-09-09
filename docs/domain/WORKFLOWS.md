# 🔄 Fluxos de Trabalho (Workflows)

Fluxos passo-a-passo de todos os processos do sistema. Fonte da verdade para integração entre serviços.

---

## 1. Fluxo Principal: Da Mensagem à Coleta

```
┌────────────────────┐
│ Paciente envia msg │
│ via WhatsApp       │
└─────────┬──────────┘
          ▼
┌────────────────────┐     ┌───────────────────────┐
│ Webhook recebe     │────→│ ConversationService   │
│ POST /webhooks/wa  │     │ .findOrCreate()       │
└────────────────────┘     └──────────┬────────────┘
                                      ▼
                           ┌───────────────────────┐
                           │ MessageService        │
                           │ .create()             │
                           │ - salva mensagem      │
                           │ - incrementa unread   │
                           └──────────┬────────────┘
                                      ▼
                           ┌───────────────────────┐
                           │ WebSocket emite       │
                           │ conversation.         │
                           │   new_message         │
                           └──────────┬────────────┘
                                      ▼
                           ┌───────────────────────┐
                           │ Distribuição:         │
                           │ - fila não atribuída  │
                           │ - ou direto p/ agente │
                           └──────────┬────────────┘
                                      ▼
                           ┌───────────────────────┐
                           │ Atendente responde    │
                           │ POST /conversations/  │
                           │   :id/messages        │
                           └──────────┬────────────┘
                                      ▼
                           ┌───────────────────────┐
                           │ WhatsAppService       │
                           │ .sendMessage()        │
                           │ (API externa)         │
                           └──────────┬────────────┘
                                      ▼
                           ┌───────────────────────┐
                           │ Atendente cria        │
                           │ orçamento             │
                           │ (ver Fluxo 2)         │
                           └───────────────────────┘
```

---

## 2. Fluxo de Orçamento (Novo Orçamento)

### Passos:

**1. Atendente abre "Novo Orçamento" a partir da conversa**
- Frontend: navega para `/budget/new?conversationId=xxx`
- Carrega catálogo: `GET /exams?active=true`

**2. Atendente seleciona exames**
- Busca no catálogo (client-side + server-side search)
- Adiciona itens à lista
- Frontend calcula subtotal em tempo real

**3. Atendente aplica desconto**
- Slider ou input de percentual
- Frontend valida contra `user.discountLimit` (UX)
- Total recalculado: `subtotal * (1 - discount/100)`

**4. Atendente cria a proposta**
```
POST /proposals
{
  "conversationId": "uuid",
  "items": [{"examId": "uuid", "quantity": 1}, ...],
  "discountPercent": 10
}
```

**5. Backend valida e cria**
```typescript
// Pseudo-código do ProposalService.create()
1. Validar que exames existem e estão ativos
2. Buscar preços atuais do catálogo (nunca confiar no frontend)
3. Calcular totalPrice = Σ(items) * (1 - discount/100)
4. Verificar alçada:
   - discount <= user.discountLimit → approvalStatus = 'approved'
   - discount > user.discountLimit → approvalStatus = 'pending'
     → dispara Fluxo 3 (Aprovação)
5. Criar proposal com status = 'novo_contato'
6. Snapshot dos nomes/preços dos exames em proposal_items
7. Registrar auditoria
8. Retornar proposta criada
```

**6. Atendente envia orçamento ao paciente**
- Clica "Enviar orçamento"
- `PATCH /proposals/:id/status { "status": "orcamento_enviado" }`
- Sistema envia mensagem formatada no chat com os itens e total
- Mensagem de sistema aparece na conversa: "Orçamento #4776 enviado"

---

## 3. Fluxo de Aprovação de Desconto

**Disparado quando:** `discountPercent > user.discountLimit`

```
┌───────────────────────────┐
│ Proposta criada com       │
│ approvalStatus: pending   │
└─────────┬─────────────────┘
          ▼
┌───────────────────────────┐
│ Sistema posta no chat     │
│ interno (canal #aprovacoes)│
│ com orçamento anexado     │
└─────────┬─────────────────┘
          ▼
┌───────────────────────────┐
│ Gestor recebe notificação │
│ (WebSocket + badge)       │
└─────────┬─────────────────┘
          ▼
    ┌─────┴─────┐
    ▼           ▼
┌────────┐  ┌────────┐
│ Aprova │  │ Rejeita│
└───┬────┘  └───┬────┘
    ▼           ▼
┌────────────┐ ┌──────────────────┐
│ PATCH      │ │ PATCH            │
│ /approve   │ │ /reject + motivo │
└───┬────────┘ └───┬──────────────┘
    ▼              ▼
┌────────────────────────────┐
│ Atendente é notificado     │
│ via WebSocket + chat       │
└───┬────────────────────────┘
    ▼
┌────────────────────────────┐
│ Se aprovado: pode enviar   │
│ Se rejeitado: ajusta       │
│ desconto e re-submete      │
└────────────────────────────┘
```

**Regras:**
- Proposta com `approvalStatus: pending` NÃO pode ser enviada ao paciente
- Gestor pode aprovar até seu próprio limite (30%); acima disso, só admin
- Rejeição exige motivo (texto livre)
- Todas as decisões são auditadas

---

## 4. Fluxo do Pipeline (Estágios da Proposta)

```
novo_contato ──→ orcamento_enviado ──→ follow_up ──→ negociacao ──┬─→ ganho
                        │                   │             │        │
                        └───────────────────┴─────────────┴────────┴─→ perdido
                                                              (motivo obrigatório)
```

### Transições válidas:

| De | Para | Trigger |
|----|------|---------|
| novo_contato | orcamento_enviado | Atendente envia orçamento |
| orcamento_enviado | follow_up | Sem resposta (manual ou automação) |
| orcamento_enviado | negociacao | Paciente pede desconto |
| orcamento_enviado | ganho | Paciente aceita direto |
| follow_up | negociacao | Paciente responde negociando |
| follow_up | ganho | Paciente aceita |
| follow_up | perdido | Sem resposta definitiva |
| negociacao | ganho | Acordo fechado |
| negociacao | perdido | Sem acordo |
| qualquer aberto | perdido | Com motivo |

### Ao mudar para `ganho`:
```typescript
1. proposal.status = 'ganho'
2. proposal.closedAt = now()
3. Mensagem de sistema na conversa: "Proposta #4776 ganha! 🎉"
4. Atualizar métricas do dashboard (invalidar cache)
5. Auditoria
```

### Ao mudar para `perdido`:
```typescript
1. Validar reasonLost presente e válido
2. proposal.status = 'perdido'
3. proposal.reasonLost = reason
4. proposal.closedAt = now()
5. Alimentar painel de conversão (motivos de perda)
6. Auditoria
```

---

## 5. Fluxo de Atribuição de Conversas

**Modos de distribuição (config por tenant):**

### Modo 1: Fila não atribuída (manual)
```
Nova conversa → fila "Não atribuídas" → atendente clica "Assumir" → assignedTo = user.id
```

### Modo 2: Round-robin (automático)
```
Nova conversa → sistema busca atendente online com menos conversas ativas → atribui
```

### Regras de handoff (transferência):
```
1. Atendente A clica "Transferir" na conversa
2. Seleciona atendente B (ou fila)
3. PATCH /conversations/:id { "assignedTo": "userB_uuid" }
4. Mensagem de sistema: "Conversa transferida de A para B"
5. B recebe notificação
6. Histórico completo permanece visível para B
```

**Conflito de atribuição simultânea:**
- Usar optimistic locking (version field) ou
- Primeira atribuição ganha; segunda recebe erro `CONVERSATION_ALREADY_ASSIGNED`

---

## 6. Fluxo do Chat Interno

**Estrutura:** canais (grupos) + mensagens diretas

```
1. Usuário abre chat interno
2. GET /internal-chat/channels → lista canais + DMs
3. Seleciona canal → GET /internal-chat/channels/:id/messages
4. Envia mensagem → POST + WebSocket broadcast
5. Pode anexar proposta:
   POST /internal-chat/channels/:id/messages
   { "content": "...", "attachedProposalId": "uuid" }
6. Proposta anexada renderiza como cartão clicável
7. Clicar no cartão abre modal da proposta
```

**Canais padrão criados no onboarding do tenant:**
- `#geral`
- `#aprovacoes` (sistema posta pedidos de aprovação aqui)

**Iniciar uma conversa direta (DM), D-101:**
```
1. GET /internal-chat/users → diretório do tenant (exclui o próprio, inativos), carregado
   uma vez; a tela filtra em memória no campo de busca do topo da barra lateral
2. Usuário digita e clica num resultado da busca
3. POST /internal-chat/dms { "userId": "uuid" } → 200, get-or-create idempotente
   (mesmo par de usuários sempre devolve o MESMO canal — clicar de novo não duplica)
4. Tela seleciona o canal devolvido e segue o fluxo normal (passos 3-4 acima); a busca
   é limpa e a conversa passa a aparecer no grupo "Mensagens diretas"
```
Uma DM só é visível para os dois participantes — outro usuário do mesmo tenant não a vê em
`GET /internal-chat/channels` nem consegue acessá-la por id.

---

## 7. Fluxo de Onboarding de Tenant (Plataforma)

```
1. Operador da plataforma cria tenant
   POST /platform/tenants { name, slug, plan }
2. Sistema cria:
   - Tenant record
   - Theme padrão (terracota)
   - Canais internos padrão
   - Usuário admin inicial (convite por email)
3. Admin recebe email com link de ativação
4. Admin define senha e faz primeiro login
5. Admin configura:
   - Personalização (tema, logo, nome)
   - Catálogo de exames (import CSV ou manual)
   - Usuários da equipe (convites)
   - Canal WhatsApp (conecta API)
6. Tenant operacional
```

---

## 8. Fluxo de Autenticação

```
1. POST /auth/login { email, password }
2. Backend:
   - Busca user por email (em todos os tenants ou por slug)
   - Verifica password_hash (bcrypt)
   - Verifica user.isActive e tenant.isActive
   - Gera accessToken (15 min) + refreshToken (7 dias)
3. Frontend armazena tokens
4. Toda request: Authorization: Bearer <accessToken>
5. Access token expira → POST /auth/refresh com refreshToken
6. Refresh token expira → redirect para login
```

---

## 9. Fluxo de Personalização de Tema

```
1. Admin abre tela Personalização
2. GET /themes/current → tema atual
3. Admin escolhe:
   a. Tema pronto (5 opções) → aplica preset
   b. Tema livre → define 5 cores (accent, accent2, bg, surface, text)
   + radiusId (reto/suave/redondo) + fontId + brand name
4. Preview em tempo real (frontend aplica CSS vars localmente)
5. Salvar → PATCH /themes/current
6. Backend valida cores (hex válido) e salva
7. Próximo login de qualquer usuário do tenant carrega o novo tema
8. Frontend na inicialização:
   - Lê theme do login response
   - Deriva as 27 variações via color-mix
   - Escreve CSS vars em document.documentElement
```

---

## 10. Fluxo de Métricas (Dashboard de Conversão)

```
1. Gestor abre tela Conversão
2. GET /analytics/conversion?startDate=X&endDate=Y
3. Backend calcula (com cache Redis de 5 min):
   - Funil: contagem por estágio no período
   - Taxa de conversão: ganhos / total criadas
   - Motivos de perda: agrupamento de reasonLost
   - Desempenho por atendente
   - Ticket médio: Σ(ganhos.totalPrice) / count(ganhos)
4. Todos os números derivam da tabela proposals
   (nunca de contadores separados)
```

---

## Matriz de Integração entre Serviços

| Serviço | Depende de | Fornece para |
|---------|-----------|--------------|
| AuthService | UserRepo, TenantRepo | Todos (JWT context) |
| ConversationService | AuthService, MessageRepo | Frontend, ProposalService |
| MessageService | ConversationService, WhatsAppService | WebSocket, Frontend |
| ProposalService | ExamCatalogService, UserService (alçada) | Analytics, ChatInterno |
| ExamCatalogService | AuthService | ProposalService, Frontend |
| ApprovalService | ProposalService, InternalChatService | Notificações |
| ThemeService | TenantRepo | Frontend (login response) |
| AnalyticsService | ProposalRepo (read-only) | Frontend dashboards |
| WhatsAppService | (API externa) | MessageService |
| AuditService | Todos (write-only) | Admin (leitura) |

**Regra de ouro:** Serviços se comunicam via interfaces claras. Nenhum serviço acessa tabela de outro domínio diretamente — sempre via serviço dono da entidade.

---

## Próximas Leituras

- `docs/domain/BUSINESS_RULES.md` - Regras que estes fluxos devem respeitar
- `docs/api/API_CONTRACTS.md` - Endpoints citados nos fluxos
- `docs/backend/SERVICES.md` - Detalhamento de cada serviço

