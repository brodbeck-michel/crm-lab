# 🧪 Estratégia de Testes

O que testar, como e quem (qual agente) é responsável.

---

## Pirâmide

```
        /  E2E  \          Agent-QA — fluxos completos (Playwright)
       /---------\
      / Integração \       Agent-API — endpoints + banco real (supertest)
     /--------------\
    /    Unitários    \    Todos — regras de negócio, componentes, utils
```

**Cobertura mínima:** regras de negócio (services) 90% · endpoints críticos 100% · componentes com lógica 70%

---

## Unitários — Regras de Negócio (OBRIGATÓRIOS)

Todo item de `docs/domain/BUSINESS_RULES.md` tem teste correspondente:

```typescript
// proposal.service.spec.ts
describe('ProposalService', () => {
  describe('cálculo de total (regra §1)', () => {
    it('deriva total de items + desconto', ...);
    it('ignora totalPrice vindo do cliente', ...);
    it('recalcula ao mudar desconto', ...);
  });

  describe('alçada de desconto (regra §2)', () => {
    it('aprova automaticamente dentro do limite', ...);
    it('marca pending acima do limite do atendente', ...);
    it('impede envio de proposta pending', ...);
    it('só gestor/admin aprovam', ...);
  });

  describe('transições de estágio (regra §3)', () => {
    it('permite novo_contato → orcamento_enviado', ...);
    it('rejeita novo_contato → ganho (pular estágio)', ...);
    it('rejeita transição a partir de ganho/perdido (terminais)', ...);
    it('exige reasonLost ao marcar perdido', ...);
    it('rejeita reasonLost inválido', ...);
  });
});
```

---

## Integração — Endpoints (Agent-API)

Banco PostgreSQL real (docker) por suíte; transação com rollback por teste.

```typescript
describe('POST /proposals', () => {
  it('cria proposta e retorna shape de API_CONTRACTS.md', ...);
  it('usa preços do catálogo, não do payload', ...);
  it('retorna 403 DISCOUNT_EXCEEDS_LIMIT com shape de erro padrão', ...);
  it('retorna 401 sem token', ...);
});
```

### Testes de Isolamento Multitenant (CRÍTICOS — bloqueiam release)

```typescript
describe('isolamento multitenant', () => {
  // Setup: tenant A e tenant B com dados
  it('GET /conversations não retorna conversas de outro tenant', ...);
  it('GET /proposals/:id de outro tenant retorna 404 (não 403 — não vazar existência)', ...);
  it('PATCH em recurso de outro tenant retorna 404', ...);
  it('busca/filtros nunca cruzam tenants', ...);
  it('operador de plataforma NÃO acessa /conversations nem /patients', ...);
});
```

---

## Componentes (Agent-UI)

Vitest + Testing Library. Testar comportamento, não implementação:

```typescript
describe('ProposalCard', () => {
  it('exibe valor formatado pt-BR derivado dos items', ...);
  it('chama onClick com id ao clicar', ...);
});

describe('DiscountSection', () => {
  it('mostra aviso de aprovação quando desconto > limite do usuário', ...);
  it('desabilita envio de proposta pending', ...);
});

describe('LostReasonForm', () => {
  it('não submete sem motivo selecionado', ...);
});
```

---

## E2E (Agent-QA) — Playwright

Cobrem os fluxos de `docs/domain/WORKFLOWS.md`:

| Fluxo | Cenário |
|-------|---------|
| Login | login → tema aplicado → redirect por perfil |
| Atendimento | nova mensagem chega (WS) → aparece na lista → responder |
| Orçamento | conversa → novo orçamento → 2 exames → 10% → criar → enviar |
| Aprovação | atendente cria 25% → pending → gestor aprova em #aprovacoes → atendente notificado |
| Pipeline | mover estágio via modal → perdido exige motivo |
| Personalização | admin troca tema → cores mudam em tempo real → persiste após relogin |
| Isolamento | usuário do tenant A não vê NADA do tenant B |

Rodam contra ambiente com seeds (`npm run seed:e2e`), em CI a cada PR para main.

---

## Comandos

```bash
# Backend
npm run test           # unitários
npm run test:int       # integração (sobe banco docker)
npm run test:cov       # cobertura

# Frontend
npm run test           # vitest
npm run test:ui        # modo interativo

# E2E (raiz)
npm run e2e            # playwright
npm run e2e:headed     # com browser visível
```

---

## Definição de Pronto (qualquer tarefa)

- [ ] Testes unitários das regras tocadas passam
- [ ] Testes de integração dos endpoints tocados passam
- [ ] Nenhum teste existente quebrou
- [ ] Se tocou em query: teste de isolamento multitenant cobre o caso
- [ ] CI verde
