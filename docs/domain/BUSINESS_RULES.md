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

> **Exceção declarada — proposta de origem `bitlab` (CRMLAB-57, D-195).** A proposta que nasce
> sozinha do orçamento do LIS não tem itens do catálogo: o total é o `total_value` do orçamento
> no Bitlab, que é a fonte da verdade desse valor, e é regravado a cada ingestão enquanto a
> proposta não fecha. Ela não tem desconto, não passa por alçada, e nome do paciente, data e
> atendente vêm por JOIN com `lis_budgets` (nunca copiados).

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

### As travas são regra do laboratório (CRMLAB-56, D-192)
Desde o CRMLAB-56, a matriz acima e os estágios terminais são o **padrão** das travas de
**Configurações → Regras** (`manualMoves`, API_CONTRACTS.md §6c). O laboratório pode:
- **desligar "Pular etapas"** → vale `SEQUENTIAL_TRANSITIONS`: um passo para a frente, um para
  trás e `perdido`; `ganho` só a partir de `negociacao`;
- **ligar "Reabrir Ganho/Perdido"** para gestor e/ou atendente (admin sempre) → volta para
  `orcamento_enviado`, `follow_up` ou `negociacao`, limpando `closedAt` e `reasonLost`. Ganho
  conciliado pelo LIS nunca reabre;
- **desligar "Exigir motivo ao marcar Perdido"** → `perdido` sem motivo é aceito;
- **desligar "Mover card de outra atendente"** → o gestor só move os cards que criou (admin
  sempre pode; a atendente já só vê os próprios, D-042).
Front e back decidem pela mesma função, `checkTransition` (`shared/types/funnel-rules.types.ts`).
Sem nada configurado, o comportamento é exatamente o de antes (D-191).

### Motor de tempo (CRMLAB-59, D-205..D-209)
Os prazos da seção Automação das Regras movem cartões parados, cada um só se ligado:
`orcamento_enviado` há X dias → `follow_up`; `negociacao` há Y dias sem pagamento → `follow_up`;
`follow_up` há Z dias → `perdido` com motivo `silencio`. O relógio conta desde a **entrada no
estágio atual** (última linha do histórico com esse estágio): qualquer mudança de estágio o zera.
Dias corridos (múltiplos de 24 h) ou úteis (seg–sex, Brasília; **sem feriados**). **Fato vence
tempo:** cartão com pagamento não é movido pelo motor, e cartão com requisição não vai para
`follow_up`/`perdido` a partir de `orcamento_enviado`/`follow_up` (D-206). O passo precisa estar
na matriz vigente; terminais nunca se movem. "Novo orçamento" parado há N horas (corridas) só
**alerta** o responsável (ou gestores/admins, se não houver), uma vez por entrada na coluna, sem
mover (D-207). Prazo mudado vale no próximo tique, inclusive para os cartões que já passaram do
prazo novo (D-209). Quem move é o sistema: `changedBy: null`, histórico com `automation`, audit
`source: "rule"` (D-208).

### Reingajamento da conversa (CRMLAB-62, D-211..D-214)
Não mexe em proposta: é uma mensagem ao paciente, no mesmo tique do motor. Com a regra ligada
(padrão **desligada**), conversa **ativa** de WhatsApp **por QR Code** em que a última mensagem de
pessoa do laboratório (CRM ou celular) ficou sem resposta do paciente por X horas (padrão 1 h)
recebe o texto do 1º reingajamento; o 2º (opcional, só com o 1º ligado) sai Y horas depois do
envio do 1º, se continuar sem resposta. **No máximo dois por silêncio**; resposta do paciente
seguida de nova mensagem da atendente abre um silêncio novo. Respeita o horário de
funcionamento (fora dele, fica para a abertura; sem nenhum dia configurado = sempre aberto) e
**feriados** (nacionais, com Carnaval e Corpus Christi, e os cadastrados pelo laboratório): se a
hora de sair cai em feriado, **descarta**, não empurra. Mais de 2 h atrasado → descarta também.
API oficial da Meta não entra na rotina. A mensagem aparece como "Mensagem automática".
O texto aceita `{paciente}` (D-266): vira o **primeiro nome** do paciente (ficha vinculada, senão
o nome do contato), com capitalização normal; sem nome, a variável some junto com o espaço ou a
vírgula antes dela ("Olá, {paciente}." → "Olá."). Nenhuma outra variável é aceita.

### Mensagem fora do horário e boas-vindas (CRMLAB-94, D-264)
Configuradas em Configurações → Canais. Só WhatsApp **por QR Code**, conversa ativa.
- **Fora do horário:** o paciente escreveu com o laboratório fechado (fora do expediente de
  `business_hours` ou em feriado nacional/do laboratório) → recebe o texto configurado **uma vez
  por período fechado** (cinco mensagens na mesma noite = uma resposta; o fim de semana inteiro é
  um período). Sem nenhum dia configurado = sempre aberto, nunca envia.
- **Boas-vindas:** primeira mensagem de uma conversa nova (primeiro contato do número), com o
  laboratório aberto → uma vez. Fechado, sai só a de fora do horário.
- Aparecem como "Mensagem automática" e **não contam como resposta da atendente** (alerta,
  relatório de tempo de resposta, âncora do reingajamento). Falha no envio fica registrada e não
  é reenviada.

### Alerta de tempo de resposta (CRMLAB-84, D-254)
O inverso do reingajamento, e **só visual**: nada é enviado ao paciente. Com a regra ligada
(padrão **desligada**, 15 min, faixa **1 a 1440**), a conversa **ativa** em que o paciente
escreveu e a atendente ainda não respondeu fica destacada em vermelho na lista do Atendimento,
para **todas** as atendentes que já a veem, a partir de X minutos de espera.
- **Resposta da atendente** = mensagem `agent` com `automation` nulo, pelo CRM ou pelo celular
  (a mesma âncora do reingajamento). Mensagem **automática** e de **sistema** NÃO tiram do
  alerta — exceto o encerramento (item abaixo).
- **A espera começa na primeira mensagem do paciente depois da última resposta** (sem resposta
  nenhuma ainda: a primeira mensagem do paciente). Paciente que manda três mensagens seguidas
  espera desde a primeira.
- **Encerrar o atendimento também zera a espera** (D-259), como no relatório de tempo de
  resposta: paciente que mandou "obrigado", teve o atendimento encerrado e voltou dias depois
  espera só desde a mensagem nova, não desde o "obrigado".
- **Só conta o horário comercial:** o expediente de `tenant_settings.business_hours` (sem
  nenhum dia configurado = sempre aberto) e **sem feriados** (nacionais e os do laboratório),
  como o reingajamento. Escreveu às 17:55 com o laboratório fechando às 18:00: às 08:05 do dia
  útil seguinte são 10 min.
- **Encerrada não entra.** Um nível só (vermelho). O destaque atualiza sozinho (relógio local a
  cada 30 s) e some quando a atendente responde (a lista é refeita pelo WebSocket).
- Chip **"Aguardando resposta N"**: conta e filtra **a página carregada** da lista (não o banco
  inteiro), e combina com "Minhas"/"Não atribuídas".

### Relatório de tempo de resposta (CRMLAB-83, D-257)
Aba **"Tempo de resposta"** do Analytics, para **gestor e admin**. Mede a mesma espera do alerta
acima, já encerrada, por período (até **93 dias**, datas no fuso do expediente).
- **Bloco** = mensagens seguidas do paciente. A espera vai da **primeira** mensagem do bloco até a
  próxima **resposta humana** (`agent` sem `automation`, CRM ou celular). Automática e de sistema
  não respondem nem encerram a espera.
- **Minutos úteis:** só o expediente, sem feriados (nacionais e do laboratório) — a mesma conta do
  alerta. Paciente às 20:00, resposta às 08:07 do dia útil seguinte = **7 min**.
- **Quem respondeu leva o tempo** (`sender_id`), não a dona da conversa. Resposta pelo celular do
  laboratório aparece numa linha à parte, **"Celular"**.
- **Encerrar sem responder** fecha o bloco **sem resposta** (ex.: o "obrigado" antes de encerrar).
  Sem resposta não tem atendente: aparece só no total, como "aguardando" ou "encerrado".
- **Primeira resposta** = blocos que abrem o atendimento: primeiro da conversa ou primeiro depois
  de um encerramento.
- Indicadores: média, mediana, faixas **até 5 / 5–15 / 15–60 / mais de 1 h**, ranking por
  atendente (mediana menor primeiro) + total do laboratório, mediana por dia. Exporta Excel.

### Exceção: régua de fatos do LIS (CRMLAB-60, D-252 — substitui D-119 item 4 e D-204)
A matriz acima vale para **pessoas**. O orçamento do LIS vinculado à proposta
(`lis_budget_number`) move a proposta pelo sistema, **em qualquer origem** (`crm` ou `bitlab`),
cada fato só com a regra correspondente ligada nas Regras:
- **Pagamento** (`lis_budgets.paid_on`, derivado do extrato de pagamentos, D-188; qualquer valor)
  em **qualquer** estágio não terminal, inclusive `novo_contato` → `ganho` (audit
  `source: "lis_payment"`, selo "Conciliado"). Regra "Pagamento → Ganho".
- **Requisição** em `orcamento_enviado`/`follow_up` → `negociacao` (audit
  `source: "lis_requisition"`). Regra "Requisição → Negociação". Em `novo_contato` a requisição só
  é espelhada e vira o selo "Pré-cadastro feito" (D-197); em `negociacao` a proposta fica onde
  está. **Requisição sozinha nunca leva a `ganho`.**
Quem move é o sistema (`changedBy: null`), fora de `isTransitionAllowed`, sempre por
`applySystemTransition`. `perdido` **nunca** reabre por esse caminho: requisição ou pagamento
novo numa proposta perdida é auditado (`lis_reconcile_conflict`), a proposta mostra o aviso
"Conflito com o LIS" e a atendente decide.

**Enviar pelo cartão (CRMLAB-58, D-200):** o cartão `bitlab` em `novo_contato` enviado com
requisição (pré-cadastro) vai direto a `negociacao` se a regra "Requisição → Negociação" estiver
ligada — transição de sistema que a matriz manual não tem. Sem requisição, `orcamento_enviado`.
Quem envia vira a responsável (`created_by`).

**Nascer do orçamento (CRMLAB-57, D-196):** com a regra ligada, todo orçamento do LIS emitido a
partir da data de ativação (`tenant_settings.bitlab_proposals_since`) e sem proposta vira uma
proposta de origem `bitlab` em `novo_contato` ("Novo orçamento"), sem conversa. Histórico
anterior à ativação nunca vira cartão.

**Integração só para a gestão (CRMLAB-76, D-246):** para usar Resultados, Busca Ativa e
indicadores sem começar o funil, deixe a sincronia do LIS ligada e **desligue** "Nascer do
orçamento do Bitlab", mantendo "Criar proposta manualmente no CRM" ligada (ao menos uma origem é obrigatória). A
sincronia continua gravando os dados do LIS, não cria cartão e **não grava**
`bitlab_proposals_since`. Ao religar a regra, a data de ativação passa a ser esse dia: nada do
período desligado vira cartão. A conciliação (D-119/D-204) continua movendo cartões que **já
existem**; com o funil vazio, não tem efeito.

### Motivo de Perda (Obrigatório)

**Regra:** Ao passar para "perdido", motivo é obrigatório — é o padrão da trava
`manualMoves.requireLossReason` (D-192). Motivo enviado sempre tem que ser do enum.

```typescript
@Patch('/proposals/:id/status')
async updateStatus(id: string, { status, reasonLost }: UpdateStatusDTO) {
  if (status === 'perdido' && !reasonLost) {
    throw new BadRequestException('Motivo de perda é obrigatório');
  }
  
  if (!['preco', 'silencio', 'exame_indisponivel', 'prazo', 'horario_atendimento', 'outro'].includes(reasonLost)) {
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

**Substituída pela D-188 (CRMLAB-53) na parte do pagamento:** `consolidateLisRows` continua
mesclando `requisition_number` e ficando com o **maior** `requisition_value`, mas **não decide
mais o pagamento**. Cada linha com `Valor_Pago` é um pagamento, e todos vão para o extrato
(`lis_budget_payments`, §11.11). O upsert de `lis_budgets` não grava `paid_value`/`paid_on`, que
passam a ser derivados do extrato.

### 11.2 Dedupe por requisição (KPI de pagamento)
A mesma `REQUISICAO` pode aparecer em mais de uma linha de `lis_budgets` (o LIS atualiza o valor
pago em cima de um orçamento já existente, gerando uma nova linha ou uma linha atualizada) — para
qualquer KPI de pagamento, **a linha de maior `paid_value` vence**, via
`DISTINCT ON (requisition_number) ... ORDER BY requisition_number, paid_value DESC`
(`lis-analytics.repository.ts`, SERVICES.md §20). Isso é dedupe de **leitura** (o KPI), diferente
do dedupe de **escrita** de 11.1 (a linha de `lis_budgets` em si) — as duas regras coexistem
porque perguntam coisas diferentes: "qual é o orçamento" vs. "quanto foi pago por aquela
requisição".

**Depois da D-188 (CRMLAB-53):** o `DISTINCT ON` **continua**. Ele não escolhe mais entre
pagamentos (isso agora é a soma do extrato, §11.11): escolhe entre **orçamentos diferentes com a
mesma requisição**, cada um com o seu `paid_value` já derivado. Sem ele, dois orçamentos da mesma
requisição contariam o mesmo recebido duas vezes.

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

### 11.10 Orçamentos pela API do Bitlab (CRMLAB-52, D-185/D-187)
Cada item de `orcamentos[]` da API de Orçamentos v1 vira a **mesma** linha interna que a
planilha produz (`LisSpreadsheetRow`) e segue §11.1–§11.6 sem diferença:

| Campo da API | Campo interno | Conversão |
|---|---|---|
| `ORCAMENTO` | `number` | `String(n)`. Inteiro, sem zeros à esquerda (D-119 item 1) |
| `DATA_ORÇAMENTO` | `issued_on` | `dd/mm/yyyy hh:mm:ss` (Brasília) → `YYYY-MM-DD` pelos componentes (D-187) |
| `NM_PACIENTE` | `patient_name` | cru |
| `CONVENIO1..3` / `VL_TOTAL1..3` | `insurance_1..3` / `value_1..3` | crus. `null` continua `null` |
| `MEDIA_CONVENIO` | `insurance_average` | cru |
| `USUÁRIO` | `attendant_name` | cru (resolução §11.6) |
| `REQUISICAO` | `requisition_number` | cru (`"001-0009876"`). `""` vira `null` |
| `VALOR_REQUISICAO` | `requisition_value` | cru |
| `Valor_Pago` | `paid_value` | cru |
| `Data_Pagamento` | `paid_on` | mesma conversão de `DATA_ORÇAMENTO` (D-187). `null` continua `null` |
| `ID_CPF`, `DT_NASCIMENTO` | — | **descartados na borda**, nunca gravados nem logados (D-185 item 7) |
| `QTD_EXAMES`, `CONVENIO_REQUISICAO`, `CONTA_NULO` | — | ignorados (sem uso no CRM) |

A regra do maior total (§11.1) continua valendo entre as fontes: um orçamento que veio primeiro
pela planilha e depois pela API (ou o contrário) é a mesma linha `(tenant_id, number)`. A API
traz o pagamento no mesmo orçamento, com o mesmo total. Desde a D-188 o pagamento não passa pelo
upsert do orçamento: vai para o extrato (§11.11).

**Campos do pagamento (v1, aditivos, CRMLAB-53, D-188):** a API devolve **uma linha por
pagamento** (o mesmo orçamento repete em várias linhas).

| Campo da API | Campo interno | Conversão |
|---|---|---|
| `Data_Pagamento` | `paidAt` | `YYYY-MM-DD HH:mm:ss` com os segundos (D-187); `paid_on` segue sendo o dia |
| `ID_PAGAMENTO` | `paymentId` → `payment_key` | `String(n)`. Único por pagamento. Ausente = linha sem pagamento |
| `SITUACAO_PAGAMENTO` | `paymentStatus` | `ESTORNADO` → `estornado`; qualquer outro valor → `ativo` |
| `DATA_ESTORNO` | `reversedAt` | mesma conversão (D-187) |
| `FORMA_PAGAMENTO` / `BANDEIRA_CARTAO` | `paymentMethod` / `cardBrand` | crus. Só guardados (sem tela ainda) |

**O filtro `tipoData=alteracao` considera a `DATA_ESTORNO` desde 30/09/2026** (resposta do
Bitlab, validada em hml no mesmo dia com o OR66760): um pagamento estornado depois da leitura
**volta** na consulta incremental, na janela do estorno. Por isso a sincronização é sempre
incremental, sem releitura diária (D-253, que substitui a releitura de 90 dias da D-189;
SERVICES.md §24).

### 11.11 Extrato de pagamentos e recebido (CRMLAB-53, D-188/D-189)
- **Extrato:** `lis_budget_payments` (SCHEMA.md §26a), uma linha por pagamento, chave
  `(tenant_id, budget_number, payment_key)`. `payment_key` = `ID_PAGAMENTO`; na planilha, que não
  tem ID, `planilha:<paidAt>:<valor com 2 casas>`. Rodar a mesma carga duas vezes não soma nada. O
  estorno **atualiza a mesma linha** (`ativo` → `estornado`); valor e data não mudam depois de
  gravados, e a carga nunca apaga pagamento.
- **Origem:** o que chega pela sincronização é `api`; pela planilha, `planilha`.
- **Recebido** (`lis_budgets.paid_value`), recalculado no mesmo chunk da gravação:
  - orçamento com **algum pagamento da API** → soma dos pagamentos **ativos da API** (os da
    planilha desse orçamento são ignorados, para não contar o mesmo pagamento duas vezes);
  - só pagamentos da **planilha** → soma de todos (a planilha não diz o que foi estornado);
  - **teto** em `requisition_value` quando ele é > 0.
- **`paid_on`** = dia do último pagamento considerado, **de qualquer valor** (a régua de fatos da
  D-204 conta pagamento de R$ 0 como pagamento). Só estornos → `paid_value = 0`, `paid_on = NULL`.
- Orçamento **sem nenhuma linha no extrato** (carga anterior ao card) não é tocado.
- **Estorno depois de `ganho`:** a proposta não reabre (D-192 item 2); `lis_paid_value`/
  `lis_paid_on` são atualizados pela conciliação (D-119 item 6).
- **Planilha é plano B:** só importa com `lisSource.spreadsheetImport.enabled` ligado nas Regras
  (padrão desligado, D-189 item 4).

---

## 12. Visitação Médica — cadastro de médicos (CRMLAB-86, D-255)

Primeiro card do épico CRMLAB-85. O médico solicitante vira cadastro do laboratório, base da
agenda de visitas que vem depois.

- **Quem mexe:** todos os usuários do laboratório (atendente, gestor, admin) veem, cadastram,
  editam e inativam. Não há perfil novo. O operador da plataforma não entra (PAGES.md §11).
- **Obrigatório:** só o **nome**. O resto é opcional: CRM + UF, especialidade, clínica/consultório,
  endereço, telefone/WhatsApp, e-mail, secretária/contato, melhor dia e horário para visita (texto
  livre), observações e responsável pela carteira.
- **CRM:** guardado só com dígitos (`"CRM 12.345"` → `12345`, até 10 dígitos). **Com CRM, a UF é
  obrigatória** e tem de ser uma das 27 (maiúscula). Normalização única em
  `shared/types/doctor.types.ts` (`normalizeCrm`, `normalizeUf`, `BRAZIL_UFS`): tela e servidor usam
  a mesma.
- **Unicidade:** quando preenchido, **(laboratório, CRM, UF) é único**, contando médico ativo e
  inativo. Duplicidade → `409 DOCTOR_CRM_ALREADY_EXISTS` com o médico que já usa o número (a tela
  diz o nome e, se estiver inativo, manda reativar). Mesmo CRM em outra UF ou em outro laboratório
  pode. Vários médicos sem CRM podem.
- **Responsável pela carteira:** usuário **ativo** do **mesmo** laboratório, qualquer papel. Usuário
  de outro laboratório, inativo ou inexistente → `VALIDATION_ERROR` em `responsibleId`. Se o
  responsável for desativado depois, a carteira fica como está e o médico continua editável; a
  checagem só roda quando o responsável **muda**.
- **Inativar, nunca apagar.** Inativar/reativar é idempotente (repetir não grava outro audit).
- **Auditoria:** `create_doctor`, `update_doctor` (só os campos que mudaram, com antes e depois),
  `inactivate_doctor`, `reactivate_doctor` — `entityType: "doctor"`.
- **Proposta não muda:** `proposals.requestingDoctor` continua texto livre. Ligar a proposta ao
  cadastro fica para outro card, se for pedido.

---

## 13. Visitação Médica — agenda de visitas (CRMLAB-87, D-256)

Segundo card do épico CRMLAB-85. A equipe agenda visitas aos médicos do cadastro (§12).

- **Quem mexe:** todos os usuários do laboratório veem e mexem em **todas** as visitas, de
  qualquer responsável. Não há perfil novo.
- **A visita:** médico **ativo** do cadastro, responsável (usuário **ativo** do laboratório,
  qualquer papel), data/hora prevista, tipo (presencial, online, telefone, evento) e
  objetivo/pauta (opcional). Data no passado pode (lançar depois).
- **Status:** `agendada → realizada | cancelada | nao_recebeu`. `realizada` vem do check-out
  (§14, CRMLAB-88); fora isso a visita só sai de `agendada` cancelando ou marcando "médico não
  recebeu".
- **Reagendar** muda a data/hora da **mesma** visita e registra no histórico (data antiga, nova,
  motivo opcional, quem e quando). Não existe status "reagendada".
- **Cancelar e "médico não recebeu" exigem motivo.**
- **Visita encerrada** (cancelada, não recebeu) não edita, não reagenda e não muda de status
  (`409 VISIT_ALREADY_CLOSED`).
- **Médico ou responsável inativado depois** não trava a visita: ela continua editável; a checagem
  só roda quando o médico/responsável **muda**.
- **Auditoria:** `create_visit`, `update_visit` (só o que mudou), `reschedule_visit`,
  `cancel_visit`, `visit_not_received` — `entityType: "visit"`.

---

## 14. Visitação Médica — registro da visita (CRMLAB-88, D-258)

Terceiro card do épico CRMLAB-85. Registra o que aconteceu na visita da agenda (§13).

- **"Cheguei" (check-in) e "Saí" (check-out)** gravam a hora real do servidor e quem tocou. A
  visita mostra a **duração** (minutos entre os dois). **Sem GPS** (resposta 4A do épico).
- **O check-out marca a visita como `realizada`.** Check-out exige check-in antes. Não há check-in
  em visita cancelada ou "médico não recebeu".
- **Toque duplo não estraga nada:** repetir o check-in ou o check-out mantém a hora original.
- **Depois do check-in a visita não reagenda** (a data prevista vira histórico do que aconteceu).
  Ainda dá para cancelar ou marcar "médico não recebeu": cheguei e o médico não atendeu.
- **Relato:** o que foi apresentado, feedback do médico e objeções (três textos opcionais).
- **Próximo passo:** uma data de retorno. Ela só **sugere** a próxima visita: o botão "Agendar
  retorno" abre uma visita nova já preenchida, e nada é criado sozinho.
- **Anexos:** imagem e PDF, até 15 MiB cada e 20 por visita, com os mesmos cuidados de mídia do
  CRMLAB-31 (allow-list, conferência do conteúdo, `nosniff`, `Content-Disposition`). **Qualquer
  usuário** do laboratório anexa, baixa e **exclui**.
- **Relato, próximo passo e anexos** podem ser editados com a visita `agendada` ou `realizada`.
  Visita cancelada ou "não recebeu" fica só para leitura (os anexos ainda baixam).
- **Auditoria:** `check_in_visit`, `check_out_visit`, `update_visit_report` (só o que mudou),
  `add_visit_attachment`, `delete_visit_attachment` — `entityType: "visit"`.

---

## 15. Visitação Médica — linha do tempo do médico (CRMLAB-89, D-261)

Quarto e último card do épico CRMLAB-85. A ficha do médico mostra o histórico de todas as
interações com ele, com autor e data.

- **O que entra:** as **visitas** do médico (qualquer status, inclusive as agendadas no futuro) e
  os **registros lançados à mão**: ligação, e-mail ou WhatsApp, com data/hora, autor e descrição.
  **Não** puxa as conversas do WhatsApp do CRM: não existe ligação conversa ↔ médico (resposta 8).
- **Ordem:** do mais novo para o mais antigo, carregando mais sob demanda. A visita entra pela hora
  do check-in (o que aconteceu) ou, sem check-in, pela data prevista.
- **Quem mexe:** todos os usuários do laboratório veem, lançam, editam e excluem qualquer
  registro (resposta 2A). Médico inativo também recebe registro: o contato aconteceu.
- **Registro manual:** tipo, data/hora e descrição são obrigatórios. A data **não pode ficar no
  futuro** (folga de 5 min para o relógio do celular). Descrição até 2000 caracteres.
- **Excluir apaga de verdade:** o registro some da linha do tempo; o que foi apagado fica no audit
  log.
- **Auditoria:** `create_doctor_interaction`, `update_doctor_interaction` (só o que mudou),
  `delete_doctor_interaction` — `entityType: "doctor_interaction"` (resposta 9).

---

## 16. Participantes da conversa (CRMLAB-93, D-263)

- A conversa tem **uma dona** (`assigned_to`) e **zero ou mais participantes**. Participante vê e
  responde a conversa sem virar dona; responder não transfere.
- Adicionar e remover: dona, gestor ou admin. A participante pode sair sozinha. Conversa da fila
  livre ou encerrada não aceita participante.
- **Com participante, não se encerra nem se devolve para a fila**: a dona transfere para a
  participante, que vira a dona e sai da lista. A antiga dona sai da conversa.
- Mensagem de participante chega ao paciente com `*Nome*` na primeira linha (não em áudio e
  figurinha); no CRM a bolha fica sem o prefixo.
- No tempo de resposta (D-257), a resposta de participante conta para a dona do momento
  (`messages.attributed_to`).
- Entrada, remoção e saída geram mensagem de sistema e audit log.

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

