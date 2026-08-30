/**
 * Preco por convenio — SERVICES.md §5 / SCHEMA.md §19 (Onda 7).
 *
 * `listPrices`/`upsertPrices` sao donos de `exam_prices`. `list`/
 * `resolveActiveByIds` com `insuranceId` caem em `pricePrivate` (fallback,
 * `priceSource: 'private'`) quando nao ha linha cadastrada para o par
 * (exame, convenio) — o fallback NUNCA bloqueia o orcamento.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { UserRole } from '@crm-lab/shared';
import type { DbClient } from '../../src/db/types.js';
import { MemoryCache } from '../../src/lib/cache.js';
import type { TenantContext } from '../../src/http/context.js';
import { isBusinessError } from '../../src/http/errors.js';
import { createAuditService } from '../../src/services/audit.service.js';
import { ExamRepository } from '../../src/repositories/exam.repository.js';
import { ExamCatalogService } from '../../src/services/exam-catalog.service.js';
import { createInsuranceService, type InsuranceService } from '../../src/services/insurance.service.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { createTenant, createUser } from '../helpers/factories.js';

function contextOf(
  tenantId: string,
  role: UserRole = 'manager',
  userId: string = randomUUID(),
): TenantContext {
  return {
    userId,
    tenantId,
    role,
    discountLimit: 100,
    ip: '127.0.0.1',
    userAgent: 'vitest',
  };
}

describe('preco por convenio', () => {
  let db: DbClient;
  let audit: ReturnType<typeof createAuditService>;
  let examService: ExamCatalogService;
  let insuranceService: InsuranceService;

  beforeAll(async () => {
    db = await getTestDb();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    audit = createAuditService(db);
    examService = new ExamCatalogService(new ExamRepository(db), new MemoryCache(), audit);
    insuranceService = createInsuranceService({ db, audit });
  });

  it('GET /exams?insuranceId= devolve effectivePrice do convenio quando cadastrado', async () => {
    const tenant = await createTenant();
    const ctx = contextOf(tenant.id);
    const exam = await examService.create(ctx, {
      name: 'Hemograma',
      code: 'HEM001',
      pricePrivate: 40,
      priceInsurance: 40,
    });
    const insurance = await insuranceService.create(ctx, { name: 'Unimed Tubarão', type: 'cooperativa' });
    await examService.upsertPrices(ctx, exam.id, { prices: [{ insuranceId: insurance.id, price: 28 }] });

    const result = await examService.list(tenant.id, { insuranceId: insurance.id });
    const found = result.data.find((e) => e.id === exam.id);
    expect(found?.effectivePrice).toBe(28);
    expect(found?.priceSource).toBe('insurance');
  });

  it('exame SEM preco cadastrado para o convenio cai no particular (fallback) — NUNCA bloqueia', async () => {
    const tenant = await createTenant();
    const ctx = contextOf(tenant.id);
    const exam = await examService.create(ctx, {
      name: 'Ferritina',
      code: 'FER001',
      pricePrivate: 55,
      priceInsurance: 55,
    });
    const insurance = await insuranceService.create(ctx, { name: 'Bradesco Saúde', type: 'seguradora' });
    // nenhum upsertPrices para este par (exame, convenio) — este e o teste que
    // prova que o service NAO devolve sempre pricePrivate: o primeiro teste
    // (acima) prova que quando HA preco de convenio ele vence.

    const result = await examService.list(tenant.id, { insuranceId: insurance.id });
    const found = result.data.find((e) => e.id === exam.id);
    expect(found?.effectivePrice).toBe(55);
    expect(found?.priceSource).toBe('private');
  });

  it('sem ?insuranceId= o exame nao ganha effectivePrice/priceSource', async () => {
    const tenant = await createTenant();
    const exam = await examService.create(contextOf(tenant.id), {
      name: 'Sódio',
      code: 'NA001',
      pricePrivate: 18,
      priceInsurance: 15,
    });

    const result = await examService.list(tenant.id, {});
    const found = result.data.find((e) => e.id === exam.id);
    expect(found?.effectivePrice).toBeUndefined();
    expect(found?.priceSource).toBeUndefined();
  });

  it('PUT /exams/:id/prices substitui o conjunto — linha ausente do corpo e removida', async () => {
    const tenant = await createTenant();
    const ctx = contextOf(tenant.id);
    const exam = await examService.create(ctx, {
      name: 'PSA',
      code: 'PSA001',
      pricePrivate: 60,
      priceInsurance: 60,
    });
    const insA = await insuranceService.create(ctx, { name: 'Amil', type: 'medicina_grupo' });
    const insB = await insuranceService.create(ctx, { name: 'SulAmérica', type: 'seguradora' });

    await examService.upsertPrices(ctx, exam.id, {
      prices: [
        { insuranceId: insA.id, price: 45 },
        { insuranceId: insB.id, price: 50 },
      ],
    });
    await examService.upsertPrices(ctx, exam.id, { prices: [{ insuranceId: insA.id, price: 45 }] });

    const prices = await examService.listPrices(ctx, exam.id);
    expect(prices).toHaveLength(1);
    expect(prices[0]?.insuranceId).toBe(insA.id);
  });

  it('resolveActiveByIds com insuranceId devolve priceSource por exame — e o que o ProposalService consome', async () => {
    const tenant = await createTenant();
    const ctx = contextOf(tenant.id);
    const exam = await examService.create(ctx, {
      name: 'Hemograma',
      code: 'HEM002',
      pricePrivate: 40,
      priceInsurance: 40,
    });
    const insurance = await insuranceService.create(ctx, { name: 'Unimed Tubarão', type: 'cooperativa' });
    await examService.upsertPrices(ctx, exam.id, { prices: [{ insuranceId: insurance.id, price: 28 }] });

    const resolution = await examService.resolveActiveByIds(tenant.id, [exam.id], insurance.id);
    expect(resolution.byId.get(exam.id)?.effectivePrice).toBe(28);
    expect(resolution.byId.get(exam.id)?.priceSource).toBe('insurance');
  });

  it('resolveActiveByIds sem insuranceId nao ganha effectivePrice/priceSource', async () => {
    const tenant = await createTenant();
    const exam = await examService.create(contextOf(tenant.id), {
      name: 'Cálcio',
      code: 'CA001',
      pricePrivate: 20,
      priceInsurance: 18,
    });

    const resolution = await examService.resolveActiveByIds(tenant.id, [exam.id]);
    expect(resolution.byId.get(exam.id)?.effectivePrice).toBeUndefined();
  });

  it('upsertPrices com insuranceId inexistente -> VALIDATION_ERROR, nada e gravado', async () => {
    const tenant = await createTenant();
    const ctx = contextOf(tenant.id);
    const exam = await examService.create(ctx, {
      name: 'Glicose',
      code: 'GLI002',
      pricePrivate: 15,
      priceInsurance: 12,
    });
    const ghost = randomUUID();

    await expect(
      examService.upsertPrices(ctx, exam.id, { prices: [{ insuranceId: ghost, price: 10 }] }),
    ).rejects.toSatisfy((err: unknown) => isBusinessError(err) && err.code === 'VALIDATION_ERROR');

    expect(await examService.listPrices(ctx, exam.id)).toEqual([]);
  });

  it('upsertPrices com convenio inativo -> VALIDATION_ERROR', async () => {
    const tenant = await createTenant();
    const ctx = contextOf(tenant.id);
    const exam = await examService.create(ctx, {
      name: 'Triglicerideos',
      code: 'TRI001',
      pricePrivate: 30,
      priceInsurance: 24,
    });
    const insurance = await insuranceService.create(ctx, { name: 'Amil', type: 'medicina_grupo' });
    await insuranceService.update(ctx, insurance.id, { isActive: false });

    await expect(
      examService.upsertPrices(ctx, exam.id, { prices: [{ insuranceId: insurance.id, price: 10 }] }),
    ).rejects.toSatisfy((err: unknown) => isBusinessError(err) && err.code === 'VALIDATION_ERROR');
  });

  it('upsertPrices com insuranceId repetido no corpo -> VALIDATION_ERROR', async () => {
    const tenant = await createTenant();
    const ctx = contextOf(tenant.id);
    const exam = await examService.create(ctx, {
      name: 'Ácido Úrico',
      code: 'AU001',
      pricePrivate: 20,
      priceInsurance: 16,
    });
    const insurance = await insuranceService.create(ctx, { name: 'Amil', type: 'medicina_grupo' });

    await expect(
      examService.upsertPrices(ctx, exam.id, {
        prices: [
          { insuranceId: insurance.id, price: 10 },
          { insuranceId: insurance.id, price: 20 },
        ],
      }),
    ).rejects.toSatisfy((err: unknown) => isBusinessError(err) && err.code === 'VALIDATION_ERROR');
  });

  it('upsertPrices em exame de outro tenant -> NOT_FOUND, nunca vaza existencia do convenio', async () => {
    const tenantA = await createTenant();
    const tenantB = await createTenant();
    const examB = await examService.create(contextOf(tenantB.id), {
      name: 'Exame de B',
      code: 'EB001',
      pricePrivate: 10,
      priceInsurance: 8,
    });
    const insuranceA = await insuranceService.create(contextOf(tenantA.id), {
      name: 'Amil',
      type: 'medicina_grupo',
    });

    await expect(
      examService.upsertPrices(contextOf(tenantA.id), examB.id, {
        prices: [{ insuranceId: insuranceA.id, price: 5 }],
      }),
    ).rejects.toSatisfy((err: unknown) => isBusinessError(err) && err.code === 'NOT_FOUND' && err.statusCode === 404);
  });

  it('listPrices de exame de outro tenant -> NOT_FOUND', async () => {
    const tenantA = await createTenant();
    const tenantB = await createTenant();
    const examB = await examService.create(contextOf(tenantB.id), {
      name: 'Exame de B',
      code: 'EB002',
      pricePrivate: 10,
      priceInsurance: 8,
    });

    await expect(examService.listPrices(contextOf(tenantA.id), examB.id)).rejects.toSatisfy(
      (err: unknown) => isBusinessError(err) && err.code === 'NOT_FOUND',
    );
  });

  it('atendente nao grava preco -> FORBIDDEN, mas pode listar', async () => {
    const tenant = await createTenant();
    const exam = await examService.create(contextOf(tenant.id), {
      name: 'Glicose',
      code: 'GLI003',
      pricePrivate: 15,
      priceInsurance: 12,
    });

    await expect(
      examService.upsertPrices(contextOf(tenant.id, 'attendant'), exam.id, { prices: [] }),
    ).rejects.toSatisfy((err: unknown) => isBusinessError(err) && err.code === 'FORBIDDEN');

    await expect(examService.listPrices(contextOf(tenant.id, 'attendant'), exam.id)).resolves.toEqual([]);
  });

  it('upsertPrices gera audit log update_exam_prices e invalida o cache de listagem', async () => {
    const tenant = await createTenant();
    const user = await createUser({ tenantId: tenant.id, role: 'admin' });
    const ctx = contextOf(tenant.id, 'admin', user.id);
    const exam = await examService.create(ctx, {
      name: 'Vitamina B12',
      code: 'B12001',
      pricePrivate: 45,
      priceInsurance: 38,
    });
    const insurance = await insuranceService.create(ctx, { name: 'Amil', type: 'medicina_grupo' });

    // Popula o cache de listagem ANTES do upsert.
    await examService.list(tenant.id, { insuranceId: insurance.id });

    await examService.upsertPrices(ctx, exam.id, { prices: [{ insuranceId: insurance.id, price: 30 }] });

    const log = await audit.query(ctx, {});
    const entry = log.entries.find((e) => e.action === 'update_exam_prices');
    expect(entry).toBeDefined();
    expect(entry?.entityType).toBe('exam');
    expect(entry?.entityId).toBe(exam.id);

    // Cache invalidado: a leitura seguinte reflete o preco novo.
    const after = await examService.list(tenant.id, { insuranceId: insurance.id });
    expect(after.data.find((e) => e.id === exam.id)?.effectivePrice).toBe(30);
  });
});
