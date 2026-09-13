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
| `requestingDoctor` | Nenhum médico solicitante informado (CRMLAB-9) | |
| `customFields` | Sem dados customizados | |

```typescript
// ❌ Ruim
const approved = proposal.approvedBy ? 'Sim' : 'Não';  // Confuso

// ✅ Bom
const approved = proposal.approvalStatus === 'approved';  // Claro
```

---

## 11. Regras de deduplicação e KPIs do LIS (Onda 9)

**Regra:** o domínio "Orçamentos do LIS" (`lis_budgets`, `lis_imports`, `sales` — SCHEMA.md
§24-27) importa uma planilha de terceiro sem disciplina de digitação. As regras abaixo foram
validadas em produção pelo FluxoLab (`git show HEAD:src/lib/orcamento.ts` e
`HEAD:src/lib/executiveReport.ts` no repo antigo) e **devem ser preservadas exatamente**, não
reinventadas — são o comportamento que os usuários do Santé já conhecem.

### 11.1 Dedupe por número (orçamento)
Duas linhas da planilha (ou de duas planilhas diferentes) com o mesmo `ORCAMENTO` representam o
mesmo orçamento reimportado — **a de maior `total_value` vence**. `total_value` é o valor do
**convênio principal** — mesma seleção de §11.3, coluna gerada (SCHEMA.md §26). Implementado no
`upsert ON CONFLICT (tenant_id, number) DO UPDATE ... WHERE EXCLUDED.total_value >=
lis_budgets.total_value` — um total menor na reimportação **não regride** o dado já gravado
(planilha desatualizada não apaga um valor mais completo já importado).

**Correção D-124:** `total_value` foi implementada como `value_1 + value_2 + value_3` na Onda 9
(migração 012) — **errado**, achado ao comparar com o app de referência do FluxoLab
(`orcamentos-sante-main/src/lib/orcamento.ts`). `insurance_2`/`insurance_3` são **cotações
alternativas** do mesmo orçamento (o mesmo exame precificado por outro convênio), não valores
adicionais — somar os três infla "Total Orçado" em qualquer orçamento com mais de uma cotação
preenchida. Corrigido pela migração `014_fix_lis_budgets_total_value.sql`: `total_value` passa a
ser o valor **do mesmo par (nome, valor) que `principal_insurance_name` escolhe** (§11.3) — nunca
a soma.

**Correção D-126 — a linha PERDEDORA do dedupe não pode perder requisição/pagamento:** a versão
original de `consolidateLisRows` substituía a linha inteira pela de maior `total_value` — se a
mesma REQUISIÇÃO gera mais de uma linha de planilha com o mesmo número de ORÇAMENTO (ex.: um
exame por linha) e só uma delas tem requisição/pagamento preenchidos, a linha vencedora podia
não ser essa, e o pagamento era perdido por completo. Achado comparando "Recebido" com o app de
referência na MESMA planilha real (167 pagos aqui contra 169 lá, mesmo período). Corrigido para
mesclar como a referência (`consolidateOrcamentos`): `total_value` decide quem é a base (convênio,
paciente, atendente), mas `requisition_number` cai para a outra linha se a vencedora não tiver, e
`paid_value`/`paid_on`/`requisition_value` vêm de **qual das duas linhas tiver o maior
`paid_value`** — nunca descartados junto com a perdedora do total.

### 11.2 Dedupe por requisição (KPI de pagamento)
A mesma `REQUISICAO` pode aparecer em mais de uma linha de `lis_budgets` (o LIS atualiza o valor
pago em cima de um orçamento já existente, gerando uma nova linha ou uma linha atualizada) — para
qualquer KPI de pagamento, **a linha de maior `paid_value` vence**, via
`DISTINCT ON (requisition_number) ... ORDER BY requisition_number, paid_value DESC`
(`lis-analytics.repository.ts`, SERVICES.md §20). Isso é dedupe de **leitura** (o KPI), diferente
do dedupe de **escrita** de 11.1 (a linha de `lis_budgets` em si) — as duas regras coexistem
porque perguntam coisas diferentes: "qual é o orçamento" vs. "quanto foi pago por aquela
requisição".

### 11.3 Convênio principal
De `insurance_1`/`insurance_2`/`insurance_3` (com `value_1..3` correspondentes), o convênio
principal é: **o primeiro de c1..c3 que tem nome E valor > 0**; se nenhum tiver valor > 0, **o
primeiro que tem nome**, valor ou não. Coluna gerada `principal_insurance_name` (SCHEMA.md §26,
`GENERATED … STORED`, D-111) implementa exatamente essa ordem de prioridade — nunca "o de maior
valor" nem "sempre o primeiro campo preenchido": um convênio com nome e valor zerado (erro comum
de digitação na planilha) não deve ser escolhido como principal quando um segundo campo tem nome
e valor de verdade.

### 11.4 Resolução de convênio por nome dobrado
`principal_insurance_name` é casado contra `insurances.name`, dobrado (`lower` + trim — mesma
dobra de caixa/acento do catálogo, sem remoção de acento). Convênio **inexistente** é **criado**
automaticamente com `type: 'outro'`, `source: 'lis'` (D-114) — diferente da resolução de
atendente (11.6), que nunca cria linha sozinha; convênio da planilha do LIS é informação
confiável o bastante para virar cadastro, atendente não é (nome de usuário mal digitado não deve
virar um atendente fantasma). `PARTICULAR` e variantes de grafia —
`PARTICULAR`, `Particular`, `PARTICULAR ID`, `PARTICULAR/OUTROS`, string vazia ou só espaços —
resolvem para `insurance_id: NULL` (ausência de convênio, D-082, mesma regra que já valia para
`proposals.insurance_id`) e **nunca** criam uma linha "Particular" em `insurances`.

### 11.5 Conversão capada em 100% e `MIN_ORC_RANKING`
`conversionQty = min(100, paid.count / issued.count × 100)` — **sempre capado em 100%**: duas
requisições geradas a partir de orçamentos de períodos diferentes podem ser pagas no mesmo mês,
produzindo mais pagamentos do que orçamentos emitidos naquele recorte; sem o cap, o percentual
passaria de 100% e a tela mostraria um número sem sentido de negócio. `0` (não `NaN`) quando
`issued.count` é `0` (`percent()` de `analytics.service.ts`, reaproveitada — §20/§23 de
SERVICES.md).

**`MIN_ORC_RANKING = 20`:** rankings qualitativos (`byAttendant`, `byInsurance`, top performers
do LIS) só são calculados/exibidos quando o período tem **ao menos 20 orçamentos emitidos**.
Abaixo disso, a lista vem vazia (`[]`) em vez de um "top 6" sobre uma amostra de 3 ou 4 linhas —
um ranking estatisticamente irrelevante é pior que a ausência do gráfico, porque parece
informação e não é.

### 11.6 Resolução de atendente
`attendant_name` (coluna `USUÁRIO`/`USUARIO` da planilha) é casado contra
`attendants.folded_name` (`lower` + espaços colapsados — SCHEMA.md §24). Sem casar, a linha
grava o nome cru em `attendant_name` e `attendant_id` fica `NULL` — **diferente do convênio
(11.4), aqui NÃO há criação automática**: nome de atendente sem cadastro prévio é tratado como
possível erro de digitação, não como atendente novo. Cabe a manager/admin cadastrar o atendente
em `/attendants` (API_CONTRACTS.md §12) e reimportar, ou corrigir manualmente.

### 11.7 Janelas de tempo: emissão vs. pagamento
Todo KPI do domínio do LIS responde a **duas perguntas diferentes**, sobre datas diferentes —
mesmo princípio de D-020 (`/analytics/*`), estendido ao LIS:

| Métrica | Janela | Coluna |
|---|---|---|
| Orçado, orçamentos emitidos, funil de emissão | **Emissão** | `issued_on` |
| Recebido, ticket pago, conversão, Busca Ativa | **Pagamento** | `paid_on` (Busca Ativa: ausência de pagamento) |

Um orçamento emitido em julho pode ser pago em agosto: ele entra na emissão de julho e no
pagamento de agosto — a mesma divergência de fronteira de mês que D-020 já registra para
propostas, e que o relatório de paridade da Onda 11 lista explicitamente ao migrar o Santé.

### 11.8 Datas do LIS são `DATE`, sem fuso (D-110)
`issued_on`/`paid_on` vêm do serial de data do Excel, que **não carrega fuso** — são convertidos
por componentes (ano/mês/dia), nunca por `new Date(serial)` interpretado como instante UTC.
Guardados como `DATE` (não `TIMESTAMP`), eliminam a classe de bug de UTC-3 que já exigiu D-021/
D-078 para dado que sempre teve hora.

### 11.9 Aliases de coluna da planilha
O parser (`backend/src/lib/lis-spreadsheet.ts`) aceita as seguintes variações de cabeçalho —
casamento sem caixa/acento, mesma dobra do catálogo:

| Campo interno | Aliases aceitos |
|---|---|
| `number` | `ORCAMENTO` (**obrigatória** — ausente é `VALIDATION_ERROR` com `details.reason: "missing_column"`) |
| `issued_on` | `DATA_ORÇAMENTO` |
| `patient_name` | `NM_PACIENTE` |
| `insurance_1/2/3` | `CONVENIO1`, `CONVENIO2`, `CONVENIO3` |
| `value_1/2/3` | `VL_TOTAL1`, `VL_TOTAL2`, `VL_TOTAL3` |
| `attendant_name` | `USUÁRIO`, `USUARIO` |
| `insurance_average` | `MEDIA_CONVENIO` |
| `requisition_number` | `REQUISICAO`, e mais 4 variantes de grafia (o mesmo campo, historicamente digitado de formas diferentes pelo LIS) |
| `requisition_value` | `VALOR_REQUISICAO` |
| `paid_value` | `Valor_Pago`, e mais 2 variantes |
| `paid_on` | `DATA_PAGAMENTO`, e mais 4 variantes |

Guard `%PDF`: os primeiros bytes do arquivo são checados contra a assinatura de PDF — um PDF
renomeado para `.xlsx` é recusado com `details.reason: "pdf_disguised"` antes de o parser tentar
abri-lo como planilha. Planilha sem nenhuma linha de dado (só cabeçalho, ou vazia) é recusada
com `details.reason: "empty"`. Serial de data do Excel é convertido por componentes (dia 1 =
1900-01-01, com a correção do bug de ano bissexto de 1900 que o próprio Excel carrega) —
**nunca** por aritmética de milissegundos que arraste fuso da máquina que roda o import.

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

