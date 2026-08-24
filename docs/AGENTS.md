# 🤖 Guia de Coordenação Multi-Agente

**LEIA ESTE ARQUIVO PRIMEIRO.** Este documento define como múltiplos agentes de IA trabalham em paralelo neste projeto sem conflitos, garantindo que todos os serviços sejam funcionais e completamente integrados.

---

## Regra Zero

> **A documentação em `docs/` é o contrato entre agentes.** Nenhum agente inventa endpoint, tabela, componente ou token de design que não esteja documentado. Se precisar de algo novo: documente PRIMEIRO, implemente DEPOIS.

---

## Divisão de Domínios (Ownership)

Cada agente trabalha em um domínio. Um domínio = um conjunto de pastas que só aquele agente modifica.

| Agente | Domínio | Pastas | Documentos de referência |
|--------|---------|--------|--------------------------|
| **Agent-DB** | Banco de dados | `backend/migrations/`, `backend/seeds/` | `docs/database/SCHEMA.md` |
| **Agent-API** | Backend/API | `backend/src/` | `docs/api/API_CONTRACTS.md`, `docs/backend/SERVICES.md` |
| **Agent-UI** | Frontend | `frontend/src/` | `docs/frontend/*`, `docs/design/DESIGN_TOKENS.md` |
| **Agent-Infra** | Infraestrutura | `docker-compose.yml`, `.github/`, `nginx/` | `docs/guides/DEPLOYMENT.md` |
| **Agent-QA** | Testes E2E | `e2e/`, `*.test.ts` review | `docs/guides/TESTING.md` |

**Arquivos compartilhados** (qualquer agente pode ler, mudanças exigem atualizar o doc correspondente):
- `docs/**` — atualize o doc do seu domínio quando implementar algo
- `package.json` — adicionar dependência é permitido; remover exige nota em `docs/DECISIONS.md`

---

## Contratos de Integração (Fonte da Verdade)

A integração entre os domínios acontece por 3 contratos. **Eles nunca são violados:**

### Contrato 1: API (Frontend ↔ Backend)
- **Arquivo:** `docs/api/API_CONTRACTS.md`
- Frontend consome EXATAMENTE os shapes de request/response documentados
- Backend implementa EXATAMENTE esses shapes
- Mudança de contrato: atualizar `API_CONTRACTS.md` no MESMO commit da implementação
- Campos novos são sempre opcionais (backward compatible) até ambos os lados suportarem

### Contrato 2: Schema (Backend ↔ Banco)
- **Arquivo:** `docs/database/SCHEMA.md`
- Toda migração nova reflete-se no SCHEMA.md no mesmo commit
- Nunca renomear coluna diretamente: criar nova → migrar dados → remover antiga (3 migrações)
- `tenant_id` é obrigatório em toda tabela de dados de laboratório

### Contrato 3: Design Tokens (Design ↔ Frontend)
- **Arquivo:** `docs/design/DESIGN_TOKENS.md` + `Design System CRM.dc.html`
- Nenhum componente declara hex, fonte ou raio fixo — só variáveis CSS
- Componentes novos entram em `docs/frontend/COMPONENTS.md` antes de serem usados em 2+ telas

---

## Protocolo de Trabalho

### Antes de começar qualquer tarefa:

1. **Ler** o documento do seu domínio + `docs/domain/BUSINESS_RULES.md`
2. **Verificar** `docs/STATUS.md` — o que já está pronto, o que está em andamento
3. **Reivindicar** a tarefa: adicionar linha em `docs/STATUS.md` com seu nome de agente
4. **Verificar dependências**: sua tarefa depende de algo não pronto? Implemente contra o contrato documentado usando mocks, e anote a pendência

### Durante o trabalho:

- Commits pequenos e frequentes com prefixo do domínio: `[api]`, `[ui]`, `[db]`, `[infra]`, `[qa]`
- Se descobrir que o contrato documentado está errado/incompleto: **PARE**, atualize o doc, anote em `docs/DECISIONS.md`, depois continue
- Nunca modifique arquivos fora do seu domínio — se precisar, registre um pedido em `docs/STATUS.md` na seção "Pedidos entre agentes"

### Ao terminar:

1. Rodar os testes do seu domínio (`npm run test`)
2. Atualizar `docs/STATUS.md`: marcar tarefa como ✅ com data
3. Atualizar o doc do seu domínio se a implementação divergiu do planejado
4. Se expôs nova interface (endpoint, componente, evento): confirmar que está documentada

---

## Padrão de Integração com Mocks

Quando o Agent-UI precisa de um endpoint que o Agent-API ainda não implementou:

```typescript
// frontend/src/api/mocks/proposals.mock.ts
// MOCK: remove quando GET /proposals estiver implementado (ver docs/STATUS.md)
export const mockProposals = {
  proposals: [ /* shape EXATO de docs/api/API_CONTRACTS.md */ ],
  pagination: { page: 1, limit: 20, total: 45 }
};
```

**Regras:**
- Mock segue o shape EXATO do contrato — assim a troca por API real é só remover o mock
- Todo mock leva comentário `// MOCK:` com referência de quando remover
- `docs/STATUS.md` lista todos os mocks ativos

---

## Sequência de Implementação (Dependências)

A ordem abaixo minimiza bloqueios entre agentes:

```
Onda 1 (paralela, sem dependências):
├── Agent-Infra: docker-compose (Postgres + Redis), estrutura de pastas
├── Agent-DB: migração 001 (schema inicial completo)
└── Agent-UI: design tokens CSS, componentes base (Button, Chip, Input, Card)

Onda 2 (após Onda 1):
├── Agent-API: AuthService + middleware multitenant (precisa: schema)
├── Agent-UI: layouts (Sidebar, Inbox shell) — usa componentes da Onda 1
└── Agent-DB: seeds de desenvolvimento

Onda 3 (após Onda 2):
├── Agent-API: ConversationService + MessageService + WebSocket
├── Agent-API: ExamCatalogService
└── Agent-UI: tela Login + Atendimento (com mocks se API não pronta)

Onda 4:
├── Agent-API: ProposalService (regras de alçada!) + ApprovalService
├── Agent-UI: Novo Orçamento + Pipeline de Propostas + Modal
└── Agent-QA: E2E dos fluxos 1-3 (docs/domain/WORKFLOWS.md)

Onda 5:
├── Agent-API: AnalyticsService + ThemeService + AuditService
├── Agent-UI: Conversão + Personalização + Usuários & Permissões
├── Agent-Infra: CI/CD pipeline
└── Agent-QA: E2E completo + testes de isolamento multitenant
```

**Critério de "pronto" de cada onda:** todos os testes passam + docs atualizados + integração real (mocks da onda anterior removidos).

---

## Regras Críticas Compartilhadas (TODOS os agentes)

Estas regras vêm de `docs/domain/BUSINESS_RULES.md` e se aplicam a qualquer código:

1. **Multitenant:** toda query/endpoint/tela filtra por `tenant_id` — sem exceção
2. **Proposta é fonte da verdade:** `totalPrice` é sempre calculado de items + desconto, nunca digitado
3. **Alçada de desconto:** validada no backend SEMPRE (frontend só para UX)
4. **Estágios:** apenas transições válidas (ver WORKFLOWS.md §4); perdido exige motivo
5. **Design:** nenhum hex/fonte/raio hardcoded — só tokens CSS
6. **TypeScript:** `any` proibido; tipos compartilhados espelham os contratos de API
7. **Auditoria:** ações críticas (proposta, aprovação, permissão) geram audit log

---

## Resolução de Conflitos

| Situação | Resolução |
|----------|-----------|
| Dois agentes precisam do mesmo arquivo | O dono do domínio faz a mudança; o outro registra pedido em STATUS.md |
| Contrato documentado está ambíguo | Interpretação mais restritiva + nota em DECISIONS.md |
| Implementação existente viola BUSINESS_RULES.md | A regra vence — refatorar o código, anotar em DECISIONS.md |
| Doc e código divergem | O doc é a intenção; verificar DECISIONS.md; se não houver decisão registrada, o doc vence |
| Dependência de outra onda não pronta | Mock com shape do contrato + registrar em STATUS.md |

---

## Arquivos de Coordenação

| Arquivo | Propósito | Quem escreve |
|---------|-----------|--------------|
| `docs/STATUS.md` | Estado de cada tarefa, mocks ativos, pedidos entre agentes | Todos |
| `docs/DECISIONS.md` | Log de decisões técnicas com justificativa | Quem decide |
| `docs/AGENTS.md` | Este arquivo — protocolo de coordenação | Só com aprovação humana |

---

## Definição de "Serviço Funcional e Integrado"

Um serviço só é considerado pronto quando:

- [ ] Implementa 100% do contrato documentado (endpoints/shapes)
- [ ] Testes unitários das regras de negócio passam
- [ ] Integração real com os serviços dos quais depende (sem mocks)
- [ ] Isolamento multitenant verificado (teste com 2 tenants)
- [ ] Erros seguem o formato padrão de `docs/api/API_ERRORS.md`
- [ ] Ações críticas geram auditoria
- [ ] Doc do domínio atualizado
- [ ] Consumidor real funciona (ex.: tela do frontend usa o endpoint com sucesso)
