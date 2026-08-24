/**
 * O cache de analytics precisa cair quando a proposta muda (SERVICES.md §9).
 *
 * ===========================================================================
 * O QUE ISSO EVITA — observado rodando a aplicacao na Onda 5
 * ===========================================================================
 * A visao do gestor mostrava R$ 622 enquanto a "parcial" do atendente mostrava
 * R$ 722: o gestor tinha lido ANTES do fechamento e ficou com a entrada
 * `escopo=all` congelada; o atendente leu DEPOIS e recebeu o numero novo. Por
 * ate 5 minutos a parcial de UMA pessoa ficava MAIOR que o total do
 * laboratorio — um estado que nao existe, e que faz o gestor desconfiar do
 * relatorio inteiro.
 *
 * A chave e `analytics:<tenant>:<escopo>:<relatorio>:<periodo>`, e o escopo
 * multiplica as entradas. Invalidar so a do autor deixaria a do gestor velha,
 * que e exatamente o bug. Entao o ProposalService derruba o PREFIXO do tenant
 * (`analytics:<tenant>:`) — todos os escopos, todos os relatorios, todos os
 * periodos. E a unica invalidacao que nao deixa combinacao para tras.
 *
 * O prefixo tem o `tenantId` dentro: fechar proposta no Lab A nao pode limpar
 * (nem tocar) o cache do Lab B. Ha teste para isso.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../src/db/types.js';
import { cachePrefix, createAnalyticsService } from '../../src/services/analytics.service.js';
import type { AnalyticsService } from '../../src/services/analytics.service.js';
import { buildHarness, ctxOf, type Harness } from '../proposals/support.js';
import { createProposal, createTenant, createUser } from '../helpers/factories.js';
import type { TenantRecord, UserRecord } from '../helpers/factories.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

let db: DbClient;
let harness: Harness;
let analytics: AnalyticsService;
let lab: TenantRecord;
let gestor: UserRecord;
let atendente: UserRecord;

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  harness = buildHarness(db);
  // MESMO cache dos services de proposta: e o cache do processo, como em prod.
  analytics = createAnalyticsService({ db, cache: harness.cache });
  lab = await createTenant({ db });
  gestor = await createUser({ tenantId: lab.id, role: 'manager', db });
  atendente = await createUser({ tenantId: lab.id, role: 'attendant', db });
});

/** Leva a proposta ate `ganho` pelo caminho valido da matriz de estagios. */
async function fechar(proposalId: string): Promise<void> {
  const ctx = ctxOf({ ...atendente, discountLimit: 15 });
  await harness.proposals.updateStatus(ctx, proposalId, 'orcamento_enviado');
  await harness.proposals.updateStatus(ctx, proposalId, 'ganho');
}

describe('fechamento de proposta invalida o cache de analytics', () => {
  it('o gestor que leu ANTES nao fica com o numero velho', async () => {
    const proposta = await createProposal({
      tenantId: lab.id,
      createdBy: atendente.id,
      status: 'novo_contato',
      totalPrice: 622,
      db,
    });

    const ctxGestor = ctxOf({ ...gestor, discountLimit: 30 });
    const antes = await analytics.getConversionFunnel(ctxGestor, {});
    expect(antes.funnel.ganho).toBe(0);
    expect(antes.revenue).toBe(0);

    await fechar(proposta.id);

    const depois = await analytics.getConversionFunnel(ctxGestor, {});
    expect(depois.funnel.ganho).toBe(1);
    expect(depois.revenue).toBe(622);
  });

  it('a parcial do atendente nunca fica maior que o total do laboratorio', async () => {
    const proposta = await createProposal({
      tenantId: lab.id,
      createdBy: atendente.id,
      status: 'novo_contato',
      totalPrice: 722,
      db,
    });

    const ctxGestor = ctxOf({ ...gestor, discountLimit: 30 });
    const ctxAtendente = ctxOf({ ...atendente, discountLimit: 15 });

    // Gestor le primeiro (é o que aquecia a entrada `escopo=all` errada).
    await analytics.getConversionFunnel(ctxGestor, {});

    await fechar(proposta.id);

    const parcial = await analytics.getConversionFunnel(ctxAtendente, {});
    const total = await analytics.getConversionFunnel(ctxGestor, {});

    expect(parcial.partial).toBe(true);
    expect(total.partial).toBe(false);
    expect(parcial.revenue).toBe(722);
    expect(total.revenue).toBeGreaterThanOrEqual(parcial.revenue);
  });

  it('o pipeline tambem cai (nao tem periodo na chave, so o TTL)', async () => {
    const proposta = await createProposal({
      tenantId: lab.id,
      createdBy: atendente.id,
      status: 'novo_contato',
      totalPrice: 300,
      db,
    });

    const ctxGestor = ctxOf({ ...gestor, discountLimit: 30 });
    const antes = await analytics.getPipelineSnapshot(ctxGestor);
    expect(antes.openCount).toBe(1);

    await fechar(proposta.id);

    const depois = await analytics.getPipelineSnapshot(ctxGestor);
    // Ganho e terminal: sai do "em aberto".
    expect(depois.openCount).toBe(0);
    expect(depois.byStatus.ganho.count).toBe(1);
  });

  it('a invalidacao respeita o tenant: fechar no Lab A nao toca no cache do Lab B', async () => {
    const labB = await createTenant({ slug: 'lab-b', name: 'Lab B', db });
    const gestorB = await createUser({ tenantId: labB.id, role: 'manager', db });

    const proposta = await createProposal({
      tenantId: lab.id,
      createdBy: atendente.id,
      status: 'novo_contato',
      totalPrice: 100,
      db,
    });

    // Aquece o cache do Lab B.
    await analytics.getConversionFunnel(ctxOf({ ...gestorB, discountLimit: 30 }), {});
    const chaveB = await harness.cache.get(`${cachePrefix(labB.id)}all:pipeline:now`);
    await analytics.getPipelineSnapshot(ctxOf({ ...gestorB, discountLimit: 30 }));
    expect(chaveB).toBeNull();

    const antesDeFechar = await harness.cache.get(`${cachePrefix(labB.id)}all:pipeline:now`);
    expect(antesDeFechar).not.toBeNull();

    await fechar(proposta.id);

    // A entrada do Lab B continua exatamente onde estava.
    const depoisDeFechar = await harness.cache.get(`${cachePrefix(labB.id)}all:pipeline:now`);
    expect(depoisDeFechar).toEqual(antesDeFechar);
  });
});

describe('as outras mutacoes de proposta tambem invalidam', () => {
  it('criar proposta muda o funil e o pipeline na hora', async () => {
    const ctxGestor = ctxOf({ ...gestor, discountLimit: 30 });
    const vazio = await analytics.getPipelineSnapshot(ctxGestor);
    expect(vazio.openCount).toBe(0);

    const exame = await harness.examCatalog.create(ctxGestor, {
      name: 'Hemograma',
      code: 'HEM-001',
      description: null,
      preparation: null,
      turnaroundHours: null,
      pricePrivate: 80,
      priceInsurance: 40,
      category: null,
    });
    const conversa = await createProposal({
      tenantId: lab.id,
      createdBy: atendente.id,
      status: 'novo_contato',
      totalPrice: 1,
      db,
    });

    await harness.proposals.create(ctxOf({ ...atendente, discountLimit: 15 }), {
      conversationId: conversa.conversationId,
      items: [{ examId: exame.id, quantity: 1 }],
    });

    const depois = await analytics.getPipelineSnapshot(ctxGestor);
    expect(depois.openCount).toBe(2);
  });

  it('mudar o desconto muda o valor do pipeline na hora', async () => {
    const ctxGestor = ctxOf({ ...gestor, discountLimit: 30 });
    const ctxAtendente = ctxOf({ ...atendente, discountLimit: 15 });

    const exame = await harness.examCatalog.create(ctxGestor, {
      name: 'Glicemia',
      code: 'GLI-001',
      description: null,
      preparation: null,
      turnaroundHours: null,
      pricePrivate: 100,
      priceInsurance: 50,
      category: null,
    });
    const seed = await createProposal({
      tenantId: lab.id,
      createdBy: atendente.id,
      status: 'novo_contato',
      totalPrice: 1,
      db,
    });
    const criada = await harness.proposals.create(ctxAtendente, {
      conversationId: seed.conversationId,
      items: [{ examId: exame.id, quantity: 1 }],
    });

    const antes = await analytics.getPipelineSnapshot(ctxGestor);

    await harness.proposals.updateDiscount(ctxAtendente, criada.id, 10);

    const depois = await analytics.getPipelineSnapshot(ctxGestor);
    expect(depois.totalValue).toBe(antes.totalValue - 10);
  });
});
