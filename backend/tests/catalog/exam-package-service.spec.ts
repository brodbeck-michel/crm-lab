/**
 * ExamPackageService — CRMLAB-10 (Cadastro de pacotes de exames).
 *
 * Foco: calculo do preco particular (soma dos exames - desconto%), fallback
 * de preco por convenio (D-004, "fallback nunca bloqueia") e isolamento
 * multitenant.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { UserRole } from '@crm-lab/shared';
import type { DbClient } from '../../src/db/types.js';
import { MemoryCache } from '../../src/lib/cache.js';
import type { TenantContext } from '../../src/http/context.js';
import { isBusinessError } from '../../src/http/errors.js';
import { ExamPackageRepository } from '../../src/repositories/exam-package.repository.js';
import { createAuditService } from '../../src/services/audit.service.js';
import { ExamPackageService } from '../../src/services/exam-package.service.js';
import { createInsuranceService } from '../../src/services/insurance.service.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { createExam, createTenant } from '../helpers/factories.js';

function contextOf(tenantId: string, role: UserRole = 'admin'): TenantContext {
  return {
    userId: randomUUID(),
    tenantId,
    role,
    discountLimit: 100,
    ip: '127.0.0.1',
    userAgent: 'vitest',
  };
}

describe('ExamPackageService', () => {
  let db: DbClient;
  let cache: MemoryCache;
  let service: ExamPackageService;

  beforeAll(async () => {
    db = await getTestDb();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    cache = new MemoryCache();
    service = new ExamPackageService(new ExamPackageRepository(db), cache, createAuditService(db));
  });

  describe('create', () => {
    it('calcula pricePrivate como soma dos exames menos o desconto%', async () => {
      const tenant = await createTenant();
      const examA = await createExam({ tenantId: tenant.id, pricePrivate: 100 });
      const examB = await createExam({ tenantId: tenant.id, pricePrivate: 50 });

      const pkg = await service.create(contextOf(tenant.id), {
        name: 'Check-up Básico',
        examIds: [examA.id, examB.id],
        discountPercent: 10,
      });

      // (100 + 50) * (1 - 10%) = 135
      expect(pkg.pricePrivate).toBe(135);
      expect(pkg.items.map((i) => i.examId).sort()).toEqual([examA.id, examB.id].sort());
    });

    it('preco do pacote acompanha o preco CORRENTE do exame — nunca e snapshot', async () => {
      const tenant = await createTenant();
      const exam = await createExam({ tenantId: tenant.id, pricePrivate: 100 });

      const pkg = await service.create(contextOf(tenant.id), {
        name: 'Pacote Simples',
        examIds: [exam.id],
        discountPercent: 0,
      });
      expect(pkg.pricePrivate).toBe(100);

      // Preco do exame muda no catalogo...
      const { ExamRepository } = await import('../../src/repositories/exam.repository.js');
      const examRepo = new ExamRepository(db);
      await examRepo.update(tenant.id, exam.id, { pricePrivate: 200 });

      // ... e o pacote reflete o novo preco na proxima leitura (nunca cache de preco velho).
      const found = await service.getByIds(tenant.id, [pkg.id]);
      expect(found[0]?.pricePrivate).toBe(200);
    });

    it('name unico por tenant -> CONFLICT', async () => {
      const tenant = await createTenant();
      const exam = await createExam({ tenantId: tenant.id });
      await service.create(contextOf(tenant.id), {
        name: 'Duplicado',
        examIds: [exam.id],
        discountPercent: 0,
      });

      await expect(
        service.create(contextOf(tenant.id), {
          name: 'Duplicado',
          examIds: [exam.id],
          discountPercent: 0,
        }),
      ).rejects.toSatisfy((err: unknown) => isBusinessError(err) && err.code === 'CONFLICT');
    });

    it('examId inexistente ou inativo -> VALIDATION_ERROR', async () => {
      const tenant = await createTenant();
      const inactive = await createExam({ tenantId: tenant.id, isActive: false });
      const ghost = randomUUID();

      await expect(
        service.create(contextOf(tenant.id), {
          name: 'Pacote Invalido',
          examIds: [inactive.id, ghost],
          discountPercent: 0,
        }),
      ).rejects.toSatisfy((err: unknown) => isBusinessError(err) && err.code === 'VALIDATION_ERROR');
    });

    it('atendente nao cria: FORBIDDEN', async () => {
      const tenant = await createTenant();
      const exam = await createExam({ tenantId: tenant.id });

      await expect(
        service.create(contextOf(tenant.id, 'attendant'), {
          name: 'Pacote X',
          examIds: [exam.id],
          discountPercent: 0,
        }),
      ).rejects.toSatisfy((err: unknown) => isBusinessError(err) && err.code === 'FORBIDDEN');
    });
  });

  describe('update — ativo/inativo', () => {
    it('isActive:false desativa sem apagar a linha (mesmo padrao do catalogo, D-004)', async () => {
      const tenant = await createTenant();
      const exam = await createExam({ tenantId: tenant.id });
      const pkg = await service.create(contextOf(tenant.id), {
        name: 'Pacote Y',
        examIds: [exam.id],
        discountPercent: 0,
      });

      const updated = await service.update(contextOf(tenant.id), pkg.id, { isActive: false });
      expect(updated.isActive).toBe(false);

      const stillThere = await service.getByIds(tenant.id, [pkg.id]);
      expect(stillThere).toHaveLength(1);
    });

    it('id de outro tenant -> NOT_FOUND (nunca FORBIDDEN)', async () => {
      const tenantA = await createTenant();
      const tenantB = await createTenant();
      const examB = await createExam({ tenantId: tenantB.id });
      const pkgB = await service.create(contextOf(tenantB.id), {
        name: 'Pacote de B',
        examIds: [examB.id],
        discountPercent: 0,
      });

      await expect(
        service.update(contextOf(tenantA.id), pkgB.id, { isActive: false }),
      ).rejects.toSatisfy((err: unknown) => isBusinessError(err) && err.code === 'NOT_FOUND');
    });
  });

  describe('preco por convenio — effectivePrice/priceSource (fallback nunca bloqueia)', () => {
    it('sem override o pacote cai no pricePrivate calculado, priceSource "private"', async () => {
      const tenant = await createTenant();
      const exam = await createExam({ tenantId: tenant.id, pricePrivate: 100 });
      const pkg = await service.create(contextOf(tenant.id), {
        name: 'Pacote Convenio',
        examIds: [exam.id],
        discountPercent: 20,
      });

      const audit = createAuditService(db);
      const insuranceService = createInsuranceService({ db, audit });
      const insurance = await insuranceService.create(contextOf(tenant.id), {
        name: 'Unimed Tubarão',
        type: 'cooperativa',
      });

      const resolution = await service.resolveActiveByIds(tenant.id, [pkg.id], insurance.id);
      expect(resolution.found[0]?.effectivePrice).toBe(80); // 100 * (1 - 20%)
      expect(resolution.found[0]?.priceSource).toBe('private');
    });

    it('com override o pacote usa o preco do convenio, priceSource "insurance"', async () => {
      const tenant = await createTenant();
      const exam = await createExam({ tenantId: tenant.id, pricePrivate: 100 });
      const pkg = await service.create(contextOf(tenant.id), {
        name: 'Pacote Convenio 2',
        examIds: [exam.id],
        discountPercent: 0,
      });

      const audit = createAuditService(db);
      const insuranceService = createInsuranceService({ db, audit });
      const insurance = await insuranceService.create(contextOf(tenant.id), {
        name: 'Bradesco Saúde',
        type: 'seguradora',
      });

      await service.upsertPrices(contextOf(tenant.id), pkg.id, {
        prices: [{ insuranceId: insurance.id, price: 55 }],
      });

      const resolution = await service.resolveActiveByIds(tenant.id, [pkg.id], insurance.id);
      expect(resolution.found[0]?.effectivePrice).toBe(55);
      expect(resolution.found[0]?.priceSource).toBe('insurance');
    });
  });

  describe('isolamento multitenant', () => {
    it('nao enxerga pacote de outro tenant', async () => {
      const tenantA = await createTenant();
      const tenantB = await createTenant();
      const examB = await createExam({ tenantId: tenantB.id });
      const pkgB = await service.create(contextOf(tenantB.id), {
        name: 'Pacote de B',
        examIds: [examB.id],
        discountPercent: 0,
      });

      expect(await service.getByIds(tenantA.id, [pkgB.id])).toEqual([]);
    });
  });
});
