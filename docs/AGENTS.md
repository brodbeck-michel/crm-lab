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
| **Agent-DB** | Banco de dados | `backend/migrations/`, `backend/src/db/seeds/` | `docs/database/SCHEMA.md` |
| **Agent-Kernel** | Kernel do backend | `backend/src/{config,db,http,lib}`, `app.ts`, `main.ts`, `tests/helpers` | `docs/guides/CONVENTIONS.md` |
| **Agent-API** | Backend/API | `backend/src/{controllers,services,repositories}` | `docs/api/API_CONTRACTS.md`, `docs/backend/SERVICES.md` |
| **Agent-UI** | Frontend | `frontend/src/` | `docs/frontend/*`, `docs/design/DESIGN_TOKENS.md` |
| **Agent-Infra** | Infraestrutura | `docker-compose*.yml`, `.github/`, `nginx/`, `*/Dockerfile` | `docs/guides/DEPLOYMENT.md` |
| **Agent-QA** | Testes E2E | `e2e/`, review de `*.spec.ts` | `docs/guides/TESTING.md` |
| **Agent-Docs** | Documentação | `docs/**` (fora dos docs de domínio de outro agente) | este arquivo, `docs/DECISIONS.md` |

**Sufixo de onda e de recorte.** A partir da Onda 4 os agentes recebem sufixo pelo recorte real do
trabalho, dentro do mesmo domínio: `Agent-API-Patients`, `Agent-API-Operation`, `Agent-API-Fixes`,
`Agent-API-Link`, `Agent-UI-Patient`, `Agent-UI-Operation`, `Agent-UI-Cleanup`,
`Agent-UI-Fixes-Onda6`, `Agent-DB-Onda6`, `Agent-QA-Onda6`, `Agent-Docs-Onda6`, `Agent-Fix-*`.
O sufixo não cria domínio novo — o ownership de pastas continua sendo o da tabela acima.

**Validadores (desde a Onda 5, obrigatório ao fim de cada onda).** `Validador-Contratos`,
`Validador-Segurança` e `Validador-Verificação` são agentes **sem participação na implementação**
daquela onda. Eles **não escrevem código nem docs**: produzem achados classificados
(crítico/alto/médio), que viram tarefas de correção para agentes `Agent-Fix-*`. Na Onda 6 foram
2 críticos, 3 altos e ~12 médios, todos corrigidos antes do fechamento.

**Arquivos compartilhados** (qualquer agente pode ler, mudanças exigem atualizar o doc correspondente):
- `docs/**` — atualize o doc do seu domínio quando implementar algo
- `shared/types/` — **fonte única** dos shapes de API. Corrigir um tipo errado é permitido, desde
  que `docs/api/API_CONTRACTS.md` seja atualizado no MESMO commit. Nunca redeclare um shape de API
  localmente no backend ou no frontend
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

1. Rodar `npm run typecheck` (todos os workspaces) e os testes do seu domínio
   (`npm run test:backend` / `npm run test:frontend`) — **têm que passar**. Nunca declare pronto
   sem ter visto a saída verde do comando
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
├── Agent-API: AnalyticsService + ThemeService + AuditService + PlatformService
├── Agent-UI: Conversão + Personalização + Usuários & Permissões + Console + Chat interno
├── Agent-Infra: CI/CD pipeline + imagens de produção
└── Agent-QA: E2E completo + testes de isolamento multitenant

Onda 6 (Paciente, Operação e fechamento de pendências) — FASE 0 BLOQUEANTE:
├── Fase 0 · Agent-Docs: contratos da onda ANTES de qualquer implementação (Regra Zero)
│     API_CONTRACTS §2c/§6/§7 · SERVICES §12-§14 · SCHEMA §14-§17
│     shared/types/{patient,settings,operation}.types.ts · D-059→D-071
├── Agent-DB: migrações 003 (patients, tenant_channels, tenant_settings, channel_reads,
│     conversations.patient_id, proposal_items.position) + 004 (RLS das 4 novas) + backfill + seeds
├── Agent-API: PatientService (timeline, export e anonimização LGPD) ·
│     ChannelSettingsService + OperationService · leitura de canal, paginação do chat,
│     regra de envelope, `?patientId=` · vínculo paciente↔conversa e credenciais por tenant
├── Agent-UI: Ficha do Paciente · Canais & Equipe · Gestão da Operação ·
│     paginação, escala de espaçamento e mocks tipados
├── Agent-QA: fluxos E2E 8-12 + inventário de isolamento de rota (30 → 39 rotas)
└── Validadores (Contratos · Segurança · Verificação) → Agent-Fix-* (D-074→D-080)
```

**Critério de "pronto" de cada onda:** todos os testes passam + docs atualizados + integração real (mocks da onda anterior removidos).

**Duas regras de fechamento que a Onda 6 tornou obrigatórias:**

1. **Quem coordena roda a suíte INTEIRA antes de declarar a onda fechada — verde por escopo não
   compõe.** Na Onda 6, nove agentes e três validadores viram verde cada um no seu recorte,
   e a suíte E2E completa estava vermelha: um spec criava 25 exames por execução sem limpá-los e
   empurrava para fora da primeira página o exame que outros dois specs clicavam. Ninguém tinha
   como ver isso olhando só o próprio escopo. Debaixo da poluição havia um defeito de produto real.
2. **Pendência se escreve pelo COMPORTAMENTO, não pela tela onde foi vista.** "Listagem sem
   paginação", não "paginação de /proposals" — senão o fechamento para na primeira ocorrência
   conhecida e a terceira tela com o mesmo defeito passa batida.

**E uma que já valia e reapareceu:** comentário no código **não é contrato**. Divergência
documentada só em comentário e nunca registrada em `docs/` apareceu duas vezes na Onda 6
(um repositório afirmando que `proposal_items` não tinha coluna de posição — falso desde a
migração do mesmo commit; um spec afirmando que a tela não chamava `POST /read` — falso desde a
correção pós-QA). Se o comentário descreve o contrato, o contrato está no doc.

---

## Regras Críticas Compartilhadas (TODOS os agentes)

Estas regras vêm de `docs/domain/BUSINESS_RULES.md` e do `CLAUDE.md` da raiz, e se aplicam a
qualquer código. **A lista abaixo é a mesma do `CLAUDE.md` — se divergirem, o `CLAUDE.md` vence
e este arquivo é que precisa ser corrigido.**

1. **Multitenant:** toda query/endpoint/tela filtra por `tenant_id` — sem exceção. Tabela nova
   entra com policy de RLS na MESMA leva de migrações: tabela sem policy não trava, **vaza**
   (o `ALTER DEFAULT PRIVILEGES` da 002 já concedeu escrita a `crm_app` no `CREATE TABLE`)
2. **Proposta é fonte da verdade:** `totalPrice` é sempre calculado no backend de items +
   desconto, nunca digitado nem enviado pelo cliente
3. **Alçada de desconto:** validada no backend SEMPRE (frontend só para UX)
4. **Estágios:** apenas transições de `ALLOWED_TRANSITIONS` (WORKFLOWS.md §4); `perdido` exige
   `reasonLost` válido
5. **Design:** nenhum hex, raio em px, nome de fonte **ou espaçamento cru** em componente — só
   tokens CSS. Desde a Onda 6 o espaçamento também é verificado por
   `no-hardcoded-tokens.spec.ts`, que varre `src/components/` e `src/pages/`
6. **TypeScript:** `any` proibido (use `unknown` + narrowing); os tipos de API vêm de
   `@crm-lab/shared`, nunca redeclarados localmente
7. **Auditoria:** ações críticas (proposta, aprovação, permissão) geram audit log
8. **Erros:** backend lança `BusinessError` tipada; o middleware converte para o formato de
   `docs/api/API_ERRORS.md`. **Recurso de outro tenant → `NOT_FOUND`, nunca `FORBIDDEN`**
9. **Dinheiro no fio:** número decimal (`179.80`), nunca string formatada. Datas: ISO 8601 UTC
10. **Sem `console.log` no backend** — use o logger. **Sem segredo hardcoded** — env var
11. **Módulos ESM:** import relativo no backend leva extensão `.js` mesmo apontando para `.ts`;
    no frontend, alias `@/`

### Nuances que a Onda 6 acrescentou

- **Envelope de resposta (D-070) — três formas, sem quarta.** Listagem: chave nomeada no plural
  + `pagination`. Recurso único (GET, POST ou PATCH): objeto **cru**. Resposta composta: uma
  chave por parte. Sem corpo: `204`. As exceções são explícitas e estão listadas em
  `API_CONTRACTS.md`; fora delas, envelope de recurso único é **bug de contrato**. Na mesma
  varredura o campo `message` em pt-BR saiu de `/approve` e `/reject`: **texto de interface é do
  frontend (i18n)** — não devolva string de UI em resposta de API.
- **LGPD (D-063, emendada por D-075).** Apagamento de paciente é **anonimização, não `DELETE`**.
  O efeito precisa alcançar as cópias denormalizadas (`conversations`),
  `messages.attachment_url` e os **valores** gravados no audit log (substituídos por
  `"[ERASED]"`, preservando linha, ação, autor, timestamp e chaves) — senão o direito ao
  esquecimento fica reversível por uma rota suportada. Limitação declarada: o **texto** das
  mensagens não é reescrito.
- **Segredo de terceiro é write-only e cifrado em repouso (D-064/D-076).** Credencial de canal
  nunca volta em claro por API (só máscara, montada no SQL); em repouso vai cifrada com
  AES-256-GCM e a chave mora em `CHANNEL_SECRET_KEY`, **fora do banco** — é isso que faz um dump
  de backup não bastar. `''` é sentinela de revogação, `null` é "nunca configurado": nenhum dos
  dois é cifrado.
- **Dado de paciente não é dado de plataforma.** Todo router que sirva dado de laboratório usa
  `denyPlatformOperator()`. Rota nova entra no inventário de isolamento do QA — há meta-teste que
  reprova rota nova sem declaração.
- **Tempo é UTC explícito (D-078/D-021).** `TIMESTAMP` sem timezone volta do driver no fuso da
  máquina. Onde uma data vira número na resposta, formate como UTC no próprio SQL ou compare
  dentro do banco.

---

## Resolução de Conflitos

| Situação | Resolução |
|----------|-----------|
| Dois agentes precisam do mesmo arquivo | O dono do domínio faz a mudança; o outro registra pedido em STATUS.md |
| Contrato documentado está ambíguo | Interpretação mais restritiva + nota em DECISIONS.md |
| Implementação existente viola BUSINESS_RULES.md | A regra vence — refatorar o código, anotar em DECISIONS.md |
| Doc e código divergem | O doc é a intenção; verificar DECISIONS.md; se não houver decisão registrada, o doc vence — **exceto** no caso abaixo |
| Doc **descritivo de raiz** (ARCHITECTURE.md) divergindo do código | Aqui o código vence: esses docs descrevem o que existe, não o que se pretende. Corrigir por **engenharia reversa do código**, e marcar o que for intenção ainda não implementada com `⚠️ NÃO IMPLEMENTADO` em vez de deixar ambíguo |
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
