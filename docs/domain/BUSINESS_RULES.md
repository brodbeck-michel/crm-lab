# 📋 Regras de Negócio Críticas

Regras que TODOS os serviços devem respeitar. Violação = bug crítico.

---

## 1. Proposta é a Fonte da Verdade

**Regra:** Um valor nunca é armazenado em dois lugares.

### ✅ Correto:
```
proposal.items = [
  { exam: "Hemograma", price: 89.90 },
  { exam: "Glicose", price: 89.90 }
]
proposal.discount_percent = 10

total = (89.90 + 89.90) * (1 - 0.10) = 161.82
```

O total é **sempre calculado** a partir dos itens + desconto.

### ❌ Errado:
```
proposal.items = [...]
proposal.discount_percent = 10
proposal.total_price = 161.82  // Armazenado à parte
```

**Por quê?** Se o preço de um exame muda ou o desconto é ajustado, o total fica desatualizado.

### Implementação:

**Backend (ao criar/atualizar proposta):**
```typescript
calculateProposalTotal(proposal: Proposal): number {
  const subtotal = proposal.items.reduce((sum, item) => sum + item.unitPrice, 0);
  return subtotal * (1 - proposal.discountPercent / 100);
}

// Salvar no banco
proposal.totalPrice = this.calculateProposalTotal(proposal);
```

**Frontend (ao exibir):**
```tsx
const total = useMemo(() => {
  const subtotal = proposal.items.reduce((sum, item) => sum + item.unitPrice, 0);
  return subtotal * (1 - proposal.discountPercent / 100);
}, [proposal.items, proposal.discountPercent]);
```

---

## 2. Desconto e Alçada (Limite de Aprovação)

**Regra:** Cada usuário tem um limite de desconto máximo. Acima disso, requer aprovação.

| Perfil | Limite Padrão | Pode Aprovar Até |
|--------|---------------|-----------------|
| Atendente | 15% | — (requer gestor) |
| Gestor | 30% | — (requer admin) |
| Admin | 100% | — (sem limite) |

### Fluxo de Aprovação:

**1. Atendente cria proposta com 25% de desconto (limite: 15%)**

```json
{
  "discountPercent": 25,
  "totalPrice": 150.00,
  "createdBy": "attendant_uuid",
  "approvalStatus": "pending",
  "message": "Aguardando aprovação do gestor (desconto de 25% acima do limite de 15%)"
}
```

**2. Proposta aparece no chat interno com o orçamento anexado**

- Mensagem automática: "@gestor Pedido de aprovação de desconto: João Santos - R$ 150,00"
- Admin notificado via chat
- Sistema aguarda decisão

**3. Gestor aprova/rejeita**

```typescript
// Aprovação
async approveDicount(proposalId: string, approvedBy: string) {
  proposal.approvalStatus = 'approved';
  proposal.approvedBy = approvedBy;
  proposal.approvedAt = new Date();
  
  // Notificar atendente
  await this.notificationService.send(proposal.createdBy, 
    `Sua proposta foi aprovada por ${approverName}`);
}

// Rejeição
async rejectDiscount(proposalId: string, reason: string) {
  proposal.approvalStatus = 'rejected';
  proposal.message = `Desconto rejeitado: ${reason}`;
}
```

### Validação Obrigatória

**Sempre verificar no backend:**
```typescript
@Post('/proposals')
async createProposal(body: CreateProposalDTO) {
  const user = this.getCurrentUser();  // JWT
  const discount = body.discountPercent;
  
  if (discount > user.discountLimit) {
    // Vai para aprovação
    proposal.approvalStatus = 'pending';
    proposal.approvedBy = null;
  } else {
    // Aprovado automaticamente
    proposal.approvalStatus = 'approved';
    proposal.approvedBy = user.id;  // Aprovado por si mesmo
  }
}
```

---

## 3. Estágios da Proposta (6 estados)

**Regra:** Uma proposta passa por exatamente 6 estágios. Transições devem ser lógicas.

```
novo_contato → orcamento_enviado → follow_up → negociacao → ganho/perdido
```

### Estados:

| Estado | Descrição | Próximos Estados | Quando |
|--------|-----------|------------------|--------|
| `novo_contato` | Primeira mensagem | orcamento_enviado | Imediatamente após criar |
| `orcamento_enviado` | Orçamento enviado ao paciente | follow_up, negociacao | Atendente clica "enviar" |
| `follow_up` | Seguindo prospecção | negociacao, perdido | Sem resposta há dias |
| `negociacao` | Cliente negocia preço/desconto | ganho, perdido | Cliente pediu desconto |
| `ganho` | Proposta aceita | — (fim) | Cliente confirma coleta |
| `perdido` | Proposta recusada | — (fim) | Com motivo obrigatório |

**Voltar um passo (D-105):** além do avanço, `orcamento_enviado`, `follow_up` e `negociacao`
também aceitam voltar UM estágio (`orcamento_enviado → novo_contato`,
`follow_up → orcamento_enviado`, `negociacao → follow_up`) — atendente clicou "Enviar orçamento"
por engano, ou a negociação esfriou e precisa voltar para follow-up. `ganho`/`perdido` continuam
terminais: nenhuma transição sai deles, nem para trás. A lista exata e definitiva de transições
válidas é sempre `ALLOWED_TRANSITIONS` em `shared/types/proposal.types.ts` — esta tabela é
ilustrativa.

### Transições Proibidas:

```typescript
// ❌ Não permitir
if (currentStatus === 'ganho') {
  throw new Error('Proposta já finalizada. Não pode mudar de novo_contato');
}

// ❌ Não permitir pular estágios
if (currentStatus === 'novo_contato' && newStatus === 'ganho') {
  throw new Error('Não é permitido passar direto de novo_contato para ganho');
}

// ✅ Permitir
if (allowedTransitions[currentStatus].includes(newStatus)) {
  proposal.status = newStatus;
}
```

### Motivo de Perda (Obrigatório)

**Regra:** Ao passar para "perdido", motivo é obrigatório.

```typescript
@Patch('/proposals/:id/status')
async updateStatus(id: string, { status, reasonLost }: UpdateStatusDTO) {
  if (status === 'perdido' && !reasonLost) {
    throw new BadRequestException('Motivo de perda é obrigatório');
  }
  
  if (!['preco', 'silencio', 'exame_indisponivel', 'prazo', 'outro'].includes(reasonLost)) {
    throw new BadRequestException('Motivo inválido');
  }
}
```

---

## 4. Isolamento Multitenant (CRÍTICO!)

**Regra:** Dados de um laboratório NUNCA são acessíveis por outro.

### Validação em 3 níveis:

**Nível 1: JWT contém tenant_id**
```typescript
const token = req.headers.authorization;
const decoded = jwt.verify(token, SECRET);
const tenantId = decoded.tenantId;  // ← Obrigatório
const userId = decoded.userId;
const role = decoded.role;
```

**Nível 2: Filtrar todas as queries**
```sql
-- ❌ Errado
SELECT * FROM proposals WHERE conversation_id = 'abc123';

-- ✅ Correto
SELECT * FROM proposals 
WHERE conversation_id = 'abc123' 
AND tenant_id = $1;  -- ← Sempre filtrar por tenant
```

**Nível 3: Row-Level Security (PostgreSQL)**
```sql
CREATE POLICY tenant_isolation ON proposals
  FOR ALL USING (tenant_id = current_setting('app.tenant_id')::uuid);
```

### Checklist Antes de Mergear:

- [ ] Toda query SELECT filtra por `tenant_id`?
- [ ] Toda query DELETE filtra por `tenant_id`?
- [ ] Não há endpoints públicos (sem autenticação)?
- [ ] Não há hardcoding de IDs?

---

## 5. Um Número, Uma Origem (Integridade)

**Regra:** Se um número aparece em mais de um lugar, ele derivará do mesmo cálculo.

### Exemplo: Receita

```
Receita total = Σ(proposals com status='ganho').totalPrice
```

Não pode haver:
- Um campo `revenue` armazenado à parte
- Contagem manual de ganhos
- Valores duplicados em diferentes tabelas

### Implementação:

```typescript
// Calcular receita dinamicamente
async getTotalRevenue(tenantId: string, period: DateRange) {
  return this.db.proposals.findAll({
    where: { 
      tenantId, 
      status: 'ganho',
      closedAt: { $gte: period.start, $lte: period.end }
    }
  }).reduce((sum, p) => sum + p.totalPrice, 0);
}
```

---

## 6. Conversão Coerente (~400 conv/dia)

**Regra:** Conversas → Propostas → Ganhos devem fechar matematicamente.

```
Se ~400 conversas/dia
→ ~12.000 conversas/mês
→ ~4.000 propostas enviadas (33% conversão)
→ ~400 ganhos (10% do total)
→ ~R$ 720.000 MRR (@ R$ 1.800 ticket médio)
```

**Validação (Analytics):**
```typescript
async validateFunnelMath(tenantId: string) {
  const conversations = await this.countConversations(tenantId);
  const proposals = await this.countProposals(tenantId);
  const won = await this.countWonProposals(tenantId);
  
  // Verificar se números fazem sentido
  if (proposals / conversations > 1) {
    console.warn('Alerta: Mais propostas que conversas!');
  }
  
  if (won / proposals > 0.5) {
    console.warn('Alerta: Taxa de ganho anormalmente alta!');
  }
}
```

---

## 7. Dados de Paciente vs Interno

**Regra:** Marcar claramente o que é cliente-facing vs interno.

### Cliente-facing:
- Mensagens do paciente
- Propostas (resumo)
- Status de coleta

### Interno (nunca mostrar ao paciente):
- Notas internas (`internal_notes`)
- Motivo de desconto
- Chat interno com equipe
- Limites de desconto do atendente
- Dados de outros pacientes

### Implementação:

```typescript
// API para paciente (web/app)
@Get('/patient/proposals/:id')
async getProposalForPatient(id: string) {
  const proposal = await this.proposals.findOne(id);
  
  // Remover dados internos
  return {
    id: proposal.id,
    items: proposal.items,
    totalPrice: proposal.totalPrice,
    createdAt: proposal.createdAt,
    status: proposal.status,
    // ✅ Sem: discountPercent, approvalStatus, reasonLost, etc
  };
}

// API para atendente (interno)
@Get('/proposals/:id')
async getProposal(id: string) {
  // Retorna tudo
  return await this.proposals.findOne(id);
}
```

---

## 8. Validação em Dois Lugares

**Regra:** Frontend valida para UX, backend valida para segurança.

### Frontend (UX)
```tsx
// Validação instantânea
if (discount > userLimit) {
  return <ErrorMessage>Desconto acima de sua alçada</ErrorMessage>;
}

// Desabilitar botão
<button disabled={discount > userLimit}>Criar</button>
```

### Backend (Segurança - CRÍTICO!)
```typescript
@Post('/proposals')
async createProposal(body: CreateProposalDTO) {
  // NUNCA confiar no frontend
  const user = await this.users.findOne(body.createdBy);
  
  if (body.discountPercent > user.discountLimit) {
    throw new ForbiddenException('Desconto acima da alçada');
  }
  
  // ... continuar
}
```

---

## 9. Auditoria Completa

**Regra:** Toda ação crítica gera log de auditoria.

### Ações auditadas:
- Criar/atualizar proposta
- Aprovar/rejeitar desconto
- Mudar estágio
- Deletar conversa
- Mudar permissões de usuário
- Login/logout

### Implementação:

```typescript
async updateProposalStatus(proposalId: string, newStatus: string) {
  const proposal = await this.proposals.findOne(proposalId);
  const oldStatus = proposal.status;
  
  proposal.status = newStatus;
  await proposal.save();
  
  // Registrar auditoria
  await this.auditLog.create({
    tenantId: this.getCurrentTenant(),
    userId: this.getCurrentUser().id,
    action: 'update_proposal_status',
    entityType: 'proposal',
    entityId: proposalId,
    oldValues: { status: oldStatus },
    newValues: { status: newStatus },
    timestamp: new Date(),
    ipAddress: req.ip,
    userAgent: req.headers['user-agent']
  });
}
```

---

## 10. Sem Valores Nulos Impensados

**Regra:** Null sempre tem significado claro.

| Campo | Null significa | Não pode ser null |
|-------|---|---|
| `approvedBy` | Não foi aprovado ainda | proposal.id, proposal.totalPrice |
| `assignedTo` | Conversa não atribuída | conversation.tenantId |
| `reasonLost` | Proposta não foi perdida | proposal.tenantId |
| `customFields` | Sem dados customizados | |

```typescript
// ❌ Ruim
const approved = proposal.approvedBy ? 'Sim' : 'Não';  // Confuso

// ✅ Bom
const approved = proposal.approvalStatus === 'approved';  // Claro
```

---

## Resumo: Checklist de Implementação

Antes de commitar, verifique:

- [ ] Valor nunca é armazenado em dois lugares (proposta = fonte da verdade)
- [ ] Desconto é validado contra alçada (backend obrigatório)
- [ ] Estágios são passados em ordem lógica
- [ ] Motivo de perda é obrigatório ao encerrar
- [ ] Toda query filtra por `tenant_id`
- [ ] Números fazem sentido no contexto de ~400 conv/dia
- [ ] Dados internos nunca são expostos ao paciente
- [ ] Validação no backend (não confiar no frontend)
- [ ] Auditoria registra ações críticas
- [ ] Null sempre tem significado claro

---

## Próximas Leituras

- `docs/domain/WORKFLOWS.md` - Fluxos de trabalho passo-a-passo
- `docs/domain/VALIDATIONS.md` - Validações de cada entidade
- `docs/api/API_ERRORS.md` - Códigos de erro padronizados

