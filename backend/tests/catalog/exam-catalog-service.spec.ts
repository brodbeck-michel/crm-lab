/**
 * ExamCatalogService — SERVICES.md §5.
 *
 * Foco: `getByIds` / `resolveActiveByIds` (o contrato do qual o ProposalService
 * depende), TTL do cache e a garantia de que preco nunca sai obsoleto.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { UserRole } from '@crm-lab/shared';
import type { DbClient } from '../../src/db/types.js';
import { MemoryCache } from '../../src/lib/cache.js';
import type { TenantContext } from '../../src/http/context.js';
import { isBusinessError } from '../../src/http/errors.js';
import { ExamRepository } from '../../src/repositories/exam.repository.js';
import { createAuditService } from '../../src/services/audit.service.js';
import {
  cachePrefix,
  EXAM_CACHE_TTL_SECONDS,
  ExamCatalogService,
} from '../../src/services/exam-catalog.service.js';
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

describe('ExamCatalogService', () => {
  let db: DbClient;
  let cache: MemoryCache;
  let service: ExamCatalogService;
  /** Relogio injetado no cache — permite testar TTL sem esperar 1h. */
  let clock: number;

  beforeAll(async () => {
    db = await getTestDb();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    clock = Date.UTC(2026, 7, 23, 12, 0, 0);
    cache = new MemoryCache(() => clock);
    service = new ExamCatalogService(new ExamRepository(db), cache, createAuditService(db));
  });

  // -------------------------------------------------------------------------
  // getByIds / resolveActiveByIds — contrato consumido pelo ProposalService
  // -------------------------------------------------------------------------
  describe('getByIds', () => {
    it('devolve os exames pedidos, na ordem dos ids', async () => {
      const tenant = await createTenant();
      const a = await createExam({ tenantId: tenant.id, code: 'A' });
      const b = await createExam({ tenantId: tenant.id, code: 'B' });

      const found = await service.getByIds(tenant.id, [b.id, a.id]);
      expect(found.map((e) => e.id)).toEqual([b.id, a.id]);
    });

    it('ignora silenciosamente ids inexistentes — quem precisa saber usa resolveActiveByIds', async () => {
      const tenant = await createTenant();
      const exam = await createExam({ tenantId: tenant.id });
      const ghost = randomUUID();

      const found = await service.getByIds(tenant.id, [exam.id, ghost]);
      expect(found.map((e) => e.id)).toEqual([exam.id]);
    });

    it('exame DESATIVADO continua recuperavel — proposta historica depende disso', async () => {
      const tenant = await createTenant();
      const exam = await createExam({ tenantId: tenant.id, pricePrivate: 100 });

      await service.update(contextOf(tenant.id), exam.id, { isActive: false });

      const found = await service.getByIds(tenant.id, [exam.id]);
      expect(found).toHaveLength(1);
      expect(found[0]?.isActive).toBe(false);
      expect(found[0]?.pricePrivate).toBe(100);
    });

    it('nao enxerga exame de outro tenant', async () => {
      const tenantA = await createTenant();
      const tenantB = await createTenant();
      const examB = await createExam({ tenantId: tenantB.id });

      expect(await service.getByIds(tenantA.id, [examB.id])).toEqual([]);
    });

    it('lista vazia nao vai ao banco e devolve vazio', async () => {
      const tenant = await createTenant();
      expect(await service.getByIds(tenant.id, [])).toEqual([]);
    });

    it('nao serve preco velho do cache de listagem apos update', async () => {
      const tenant = await createTenant();
      const exam = await createExam({ tenantId: tenant.id, pricePrivate: 100 });

      // Popula o cache de listagem com o preco antigo.
      await service.list(tenant.id, {});
      expect((await service.getByIds(tenant.id, [exam.id]))[0]?.pricePrivate).toBe(100);

      await service.update(contextOf(tenant.id), exam.id, { pricePrivate: 133.33 });

      expect((await service.getByIds(tenant.id, [exam.id]))[0]?.pricePrivate).toBe(133.33);
      const resolution = await service.resolveActiveByIds(tenant.id, [exam.id]);
      expect(resolution.found[0]?.pricePrivate).toBe(133.33);
    });
  });

  describe('resolveActiveByIds', () => {
    it('separa encontrados de invalidos, distinguindo inexistente de inativo', async () => {
      const tenant = await createTenant();
      const ativo = await createExam({ tenantId: tenant.id, code: 'OK', pricePrivate: 50 });
      const inativo = await createExam({ tenantId: tenant.id, code: 'OFF', isActive: false });
      const ghost = randomUUID();

      const resolution = await service.resolveActiveByIds(tenant.id, [
        ativo.id,
        inativo.id,
        ghost,
      ]);

      expect(resolution.found.map((e) => e.id)).toEqual([ativo.id]);
      expect(resolution.byId.get(ativo.id)?.pricePrivate).toBe(50);
      expect(resolution.inactiveIds).toEqual([inativo.id]);
      expect(resolution.missingIds).toEqual([ghost]);
      // `invalidIds` vai direto em details.examIds de EXAM_NOT_FOUND_OR_INACTIVE.
      expect(resolution.invalidIds).toEqual([inativo.id, ghost]);
    });

    it('exame de outro tenant conta como inexistente (nunca vaza existencia)', async () => {
      const tenantA = await createTenant();
      const tenantB = await createTenant();
      const examB = await createExam({ tenantId: tenantB.id });

      const resolution = await service.resolveActiveByIds(tenantA.id, [examB.id]);
      expect(resolution.found).toEqual([]);
      expect(resolution.missingIds).toEqual([examB.id]);
      expect(resolution.invalidIds).toEqual([examB.id]);
    });

    it('tudo valido -> invalidIds vazio', async () => {
      const tenant = await createTenant();
      const a = await createExam({ tenantId: tenant.id, code: 'A' });
      const b = await createExam({ tenantId: tenant.id, code: 'B' });

      const resolution = await service.resolveActiveByIds(tenant.id, [a.id, b.id, a.id]);
      expect(resolution.invalidIds).toEqual([]);
      expect(resolution.found).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // Cache
  // -------------------------------------------------------------------------
  describe('cache', () => {
    it('a chave e prefixada pelo tenant', async () => {
      const tenant = await createTenant();
      await createExam({ tenantId: tenant.id });
      await service.list(tenant.id, {});

      expect(cache.size).toBe(1);
      await cache.delByPrefix(cachePrefix(tenant.id));
      expect(cache.size).toBe(0);
    });

    it('a entrada expira depois do TTL de 1h', async () => {
      const tenant = await createTenant();
      const exam = await createExam({ tenantId: tenant.id, pricePrivate: 100 });
      expect(EXAM_CACHE_TTL_SECONDS).toBe(3600);

      await service.list(tenant.id, {});
      expect(cache.size).toBe(1);

      // Escrita direta no banco, SEM passar pelo service: o cache nao e avisado.
      await db.withTenant(tenant.id, (tx) =>
        tx.query('UPDATE exam_catalog SET price_private = 999 WHERE id = $1', [exam.id]),
      );

      // Ainda dentro da 1h: serve o valor cacheado.
      clock += (EXAM_CACHE_TTL_SECONDS - 1) * 1000;
      const cached = await service.list(tenant.id, {});
      expect(cached.data[0]?.pricePrivate).toBe(100);

      // Passado o TTL, a entrada morreu e o banco volta a ser consultado.
      clock += 2000;
      expect(cache.size).toBe(0);
      const fresh = await service.list(tenant.id, {});
      expect(fresh.data[0]?.pricePrivate).toBe(999);
    });

    it('filtros diferentes geram chaves diferentes', async () => {
      const tenant = await createTenant();
      await createExam({ tenantId: tenant.id, name: 'Glicose', code: 'GLI' });

      await service.list(tenant.id, {});
      await service.list(tenant.id, { search: 'glicose' });
      await service.list(tenant.id, { active: true });

      expect(cache.size).toBe(3);
    });

    it('update invalida TODAS as combinacoes de filtro do tenant', async () => {
      const tenant = await createTenant();
      const exam = await createExam({ tenantId: tenant.id, name: 'Glicose', pricePrivate: 100 });

      await service.list(tenant.id, {});
      await service.list(tenant.id, { search: 'glicose' });
      expect(cache.size).toBe(2);

      await service.update(contextOf(tenant.id), exam.id, { pricePrivate: 250 });
      expect(cache.size).toBe(0);

      const filtered = await service.list(tenant.id, { search: 'glicose' });
      expect(filtered.data[0]?.pricePrivate).toBe(250);
    });
  });

  // -------------------------------------------------------------------------
  // Regras de escrita
  // -------------------------------------------------------------------------
  describe('create/update', () => {
    it('code duplicado no tenant -> BusinessError CONFLICT', async () => {
      const tenant = await createTenant();
      await createExam({ tenantId: tenant.id, code: 'HC' });

      const attempt = service.create(contextOf(tenant.id), {
        name: 'Hemograma',
        code: 'HC',
        pricePrivate: 10,
        priceInsurance: 5,
      });

      await expect(attempt).rejects.toSatisfy(
        (err: unknown) => isBusinessError(err) && err.code === 'CONFLICT' && err.statusCode === 409,
      );
    });

    it('mesmo code em tenants diferentes e permitido', async () => {
      const tenantA = await createTenant();
      const tenantB = await createTenant();
      const dto = { name: 'Hemograma', code: 'HC', pricePrivate: 10, priceInsurance: 5 };

      const a = await service.create(contextOf(tenantA.id), dto);
      const b = await service.create(contextOf(tenantB.id), dto);

      expect(a.code).toBe('HC');
      expect(b.code).toBe('HC');
      expect(a.id).not.toBe(b.id);
    });

    it('atendente nao escreve, nem chamando o service direto', async () => {
      const tenant = await createTenant();
      const exam = await createExam({ tenantId: tenant.id });
      const ctx = contextOf(tenant.id, 'attendant');

      await expect(
        service.create(ctx, { name: 'X', code: 'X', pricePrivate: 1, priceInsurance: 1 }),
      ).rejects.toSatisfy((err: unknown) => isBusinessError(err) && err.code === 'FORBIDDEN');

      await expect(service.update(ctx, exam.id, { pricePrivate: 1 })).rejects.toSatisfy(
        (err: unknown) => isBusinessError(err) && err.code === 'FORBIDDEN',
      );
    });

    it('update de exame de outro tenant -> NOT_FOUND', async () => {
      const tenantA = await createTenant();
      const tenantB = await createTenant();
      const examB = await createExam({ tenantId: tenantB.id });

      await expect(
        service.update(contextOf(tenantA.id), examB.id, { pricePrivate: 1 }),
      ).rejects.toSatisfy(
        (err: unknown) => isBusinessError(err) && err.code === 'NOT_FOUND' && err.statusCode === 404,
      );
    });

    it('create nasce ativo e com os campos opcionais nulos quando omitidos', async () => {
      const tenant = await createTenant();
      const exam = await service.create(contextOf(tenant.id), {
        name: '  Vitamina D  ',
        code: ' VITD ',
        pricePrivate: 120.4,
        priceInsurance: 90,
      });

      expect(exam.name).toBe('Vitamina D');
      expect(exam.code).toBe('VITD');
      expect(exam.isActive).toBe(true);
      expect(exam.description).toBeNull();
      expect(exam.preparation).toBeNull();
      expect(exam.turnaroundHours).toBeNull();
      expect(exam.category).toBeNull();
      expect(exam.pricePrivate).toBe(120.4);
    });
  });
});
