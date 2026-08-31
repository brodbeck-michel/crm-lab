/**
 * Convenio na proposta (Onda 7, Task 4). SERVICES.md §4 + API_CONTRACTS.md §3.
 *
 * `ProposalService.create` aceita `insuranceId?` opcional, resolve preco via
 * `ExamCatalogService.resolveActiveByIds(tenantId, ids, insuranceId)` e grava
 * o snapshot com `priceSource` ('insurance' | 'private'). Fallback para
 * particular NUNCA bloqueia o orcamento (D-004 estendido). `PATCH` de
 * proposta nao aceita `insuranceId` — imutavel apos a criacao.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../src/db/types.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { createConversation, createTenant, createUser } from '../helpers/factories.js';
import { MemoryCache } from '../../src/lib/cache.js';
import { isBusinessError } from '../../src/http/errors.js';
import { ExamRepository } from '../../src/repositories/exam.repository.js';
import { ExamCatalogService } from '../../src/services/exam-catalog.service.js';
import { createAuditService } from '../../src/services/audit.service.js';
import { createInsuranceService, type InsuranceService } from '../../src/services/insurance.service.js';
import { FakeWsHub } from '../helpers/fake-ws.js';
import { buildHarness, ctxOf, type Harness } from './support.js';

describe('proposta com convenio', () => {
  let db: DbClient;
  let h: Harness;
  let examService: ExamCatalogService;
  let insuranceService: InsuranceService;

  beforeAll(async () => {
    db = await getTestDb();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    h = buildHarness(db, new FakeWsHub());
    // examService/insuranceService COM AuditService, so para o setup de precos
    // (upsertPrices recusa sem audit — correcao da Task 3). O harness da
    // proposta continua sem audit no examCatalog: caminho de proposta so LE.
    const audit = createAuditService(db);
    examService = new ExamCatalogService(new ExamRepository(db), new MemoryCache(), audit);
    insuranceService = createInsuranceService({ db, audit });
  });

  it('POST /proposals com insuranceId precifica pelo convenio quando existe preco', async () => {
    const tenant = await createTenant();
    const manager = await createUser({ tenantId: tenant.id, role: 'manager' });
    const managerCtx = ctxOf(manager);
    const attendant = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const ctx = ctxOf(attendant);

    const exam = await examService.create(managerCtx, {
      name: 'Hemograma',
      code: 'HEM01',
      pricePrivate: 40,
      priceInsurance: 40,
    });
    const insurance = await insuranceService.create(managerCtx, {
      name: 'Unimed Tubarão',
      type: 'cooperativa',
    });
    await examService.upsertPrices(managerCtx, exam.id, {
      prices: [{ insuranceId: insurance.id, price: 28 }],
    });

    const conversation = await createConversation({ tenantId: tenant.id });
    const proposal = await h.proposals.create(ctx, {
      conversationId: conversation.id,
      insuranceId: insurance.id,
      items: [{ examId: exam.id, quantity: 1 }],
      discountPercent: 0,
    });

    expect(proposal.insuranceId).toBe(insurance.id);
    expect(proposal.items[0]?.unitPrice).toBe(28);
    expect(proposal.items[0]?.priceSource).toBe('insurance');
    expect(proposal.totalPrice).toBe(28);

    const reloaded = await h.proposals.getById(ctx, proposal.id);
    expect(reloaded.insuranceId).toBe(insurance.id);
    expect(reloaded.items[0]?.priceSource).toBe('insurance');
  });

  it('exame sem preco para o convenio cai no particular, com priceSource private', async () => {
    const tenant = await createTenant();
    const manager = await createUser({ tenantId: tenant.id, role: 'manager' });
    const managerCtx = ctxOf(manager);
    const attendant = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const ctx = ctxOf(attendant);

    const exam = await examService.create(managerCtx, {
      name: 'Ferritina',
      code: 'FER01',
      pricePrivate: 55,
      priceInsurance: 55,
    });
    const insurance = await insuranceService.create(managerCtx, {
      name: 'Bradesco Saúde',
      type: 'seguradora',
    });
    // Nenhum upsertPrices para este par (exame, convenio) -- fallback esperado.

    const conversation = await createConversation({ tenantId: tenant.id });
    const proposal = await h.proposals.create(ctx, {
      conversationId: conversation.id,
      insuranceId: insurance.id,
      items: [{ examId: exam.id, quantity: 1 }],
    });

    expect(proposal.insuranceId).toBe(insurance.id);
    expect(proposal.items[0]?.unitPrice).toBe(55);
    expect(proposal.items[0]?.priceSource).toBe('private');
  });

  it('proposta sem insuranceId (particular) grava insurance_id NULL e priceSource private em todos os itens', async () => {
    const tenant = await createTenant();
    const manager = await createUser({ tenantId: tenant.id, role: 'manager' });
    const managerCtx = ctxOf(manager);
    const attendant = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const ctx = ctxOf(attendant);

    const exam = await examService.create(managerCtx, {
      name: 'Glicose',
      code: 'GLI01',
      pricePrivate: 20,
      priceInsurance: 18,
    });

    const conversation = await createConversation({ tenantId: tenant.id });
    const proposal = await h.proposals.create(ctx, {
      conversationId: conversation.id,
      items: [{ examId: exam.id, quantity: 2 }],
    });

    expect(proposal.insuranceId).toBeNull();
    expect(proposal.items[0]?.priceSource).toBe('private');
    expect(proposal.items[0]?.unitPrice).toBe(20);

    const reloaded = await h.proposals.getById(ctx, proposal.id);
    expect(reloaded.insuranceId).toBeNull();
    expect(reloaded.items.every((item) => item.priceSource === 'private')).toBe(true);
  });

  it('total continua calculado no backend e ignora qualquer unitPrice enviado pelo cliente', async () => {
    const tenant = await createTenant();
    const manager = await createUser({ tenantId: tenant.id, role: 'manager' });
    const managerCtx = ctxOf(manager);
    const attendant = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const ctx = ctxOf(attendant);

    const exam = await examService.create(managerCtx, {
      name: 'Colesterol',
      code: 'COL01',
      pricePrivate: 30,
      priceInsurance: 25,
    });

    const conversation = await createConversation({ tenantId: tenant.id });
    // `dto.items` nao tem campo de preco no tipo -- mesmo forcando um shape com
    // `unitPrice` via `as unknown as ...`, o service NUNCA le esse campo:
    // sempre recalcula pelo catalogo. Isso e o que este teste prova.
    const proposal = await h.proposals.create(ctx, {
      conversationId: conversation.id,
      items: [{ examId: exam.id, quantity: 1, unitPrice: 999999 } as unknown as {
        examId: string;
        quantity: number;
      }],
    });

    expect(proposal.items[0]?.unitPrice).toBe(30);
    expect(proposal.totalPrice).toBe(30);
  });

  it('PATCH de proposta nao aceita insuranceId — convenio e imutavel apos a criacao', async () => {
    const tenant = await createTenant();
    const manager = await createUser({ tenantId: tenant.id, role: 'manager' });
    const managerCtx = ctxOf(manager);
    const attendant = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const ctx = ctxOf(attendant);

    const exam = await examService.create(managerCtx, {
      name: 'Sódio',
      code: 'NA01',
      pricePrivate: 18,
      priceInsurance: 15,
    });
    const insuranceA = await insuranceService.create(managerCtx, { name: 'Amil', type: 'medicina_grupo' });
    const insuranceB = await insuranceService.create(managerCtx, {
      name: 'SulAmérica',
      type: 'seguradora',
    });

    const conversation = await createConversation({ tenantId: tenant.id });
    const proposal = await h.proposals.create(ctx, {
      conversationId: conversation.id,
      insuranceId: insuranceA.id,
      items: [{ examId: exam.id, quantity: 1 }],
    });

    // `updateDiscount` nao aceita `insuranceId` no tipo -- a unica forma de
    // provar a recusa e no schema Zod (rota), coberto em
    // `proposal-routes.spec.ts`/`insurance.routes.spec.ts` do dominio de rotas.
    // Aqui a garantia de servico e: nenhum metodo do ProposalService muda
    // `insuranceId` depois da criacao.
    const afterDiscount = await h.proposals.updateDiscount(ctx, proposal.id, 5);
    expect(afterDiscount.discountPercent).toBe(5);

    const reloaded = await h.proposals.getById(ctx, proposal.id);
    expect(reloaded.insuranceId).toBe(insuranceA.id);
    expect(reloaded.insuranceId).not.toBe(insuranceB.id);
  });

  it('insuranceId inexistente -> VALIDATION_ERROR, nada e gravado (API_CONTRACTS.md §3)', async () => {
    const tenant = await createTenant();
    const manager = await createUser({ tenantId: tenant.id, role: 'manager' });
    const managerCtx = ctxOf(manager);
    const attendant = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const ctx = ctxOf(attendant);

    const exam = await examService.create(managerCtx, {
      name: 'Ureia',
      code: 'URE01',
      pricePrivate: 22,
      priceInsurance: 20,
    });
    const conversation = await createConversation({ tenantId: tenant.id });
    const ghost = randomUUID();

    await expect(
      h.proposals.create(ctx, {
        conversationId: conversation.id,
        insuranceId: ghost,
        items: [{ examId: exam.id, quantity: 1 }],
      }),
    ).rejects.toSatisfy((err: unknown) => isBusinessError(err) && err.code === 'VALIDATION_ERROR');

    const list = await h.proposals.list(ctx, {});
    expect(list.proposals).toHaveLength(0);
  });

  it('insuranceId inativo -> VALIDATION_ERROR', async () => {
    const tenant = await createTenant();
    const manager = await createUser({ tenantId: tenant.id, role: 'manager' });
    const managerCtx = ctxOf(manager);
    const attendant = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const ctx = ctxOf(attendant);

    const exam = await examService.create(managerCtx, {
      name: 'Creatinina',
      code: 'CRE01',
      pricePrivate: 25,
      priceInsurance: 22,
    });
    const insurance = await insuranceService.create(managerCtx, { name: 'Amil', type: 'medicina_grupo' });
    await insuranceService.update(managerCtx, insurance.id, { isActive: false });

    const conversation = await createConversation({ tenantId: tenant.id });
    await expect(
      h.proposals.create(ctx, {
        conversationId: conversation.id,
        insuranceId: insurance.id,
        items: [{ examId: exam.id, quantity: 1 }],
      }),
    ).rejects.toSatisfy((err: unknown) => isBusinessError(err) && err.code === 'VALIDATION_ERROR');
  });

  it('insuranceId de outro tenant -> VALIDATION_ERROR, nunca vaza existencia (nao FORBIDDEN)', async () => {
    const tenantA = await createTenant();
    const tenantB = await createTenant();
    const managerB = await createUser({ tenantId: tenantB.id, role: 'manager' });
    const insuranceB = await insuranceService.create(ctxOf(managerB), {
      name: 'SulAmérica',
      type: 'seguradora',
    });

    const managerA = await createUser({ tenantId: tenantA.id, role: 'manager' });
    const examA = await examService.create(ctxOf(managerA), {
      name: 'TSH',
      code: 'TSH01',
      pricePrivate: 35,
      priceInsurance: 30,
    });
    const attendantA = await createUser({ tenantId: tenantA.id, role: 'attendant' });
    const conversationA = await createConversation({ tenantId: tenantA.id });

    await expect(
      h.proposals.create(ctxOf(attendantA), {
        conversationId: conversationA.id,
        insuranceId: insuranceB.id,
        items: [{ examId: examA.id, quantity: 1 }],
      }),
    ).rejects.toSatisfy((err: unknown) => isBusinessError(err) && err.code === 'VALIDATION_ERROR');
  });
});
