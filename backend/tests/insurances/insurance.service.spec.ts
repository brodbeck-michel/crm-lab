/**
 * InsuranceService — SERVICES.md §15 (Onda 7, D-081/D-082).
 *
 * Foco: isolamento por tenant, unicidade de `name`, alcada de escrita
 * (manager/admin), o teto de `MAX_PAGE` e a auditoria de create/update.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { UserRole } from '@crm-lab/shared';
import type { DbClient } from '../../src/db/types.js';
import type { TenantContext } from '../../src/http/context.js';
import { isBusinessError } from '../../src/http/errors.js';
import { createAuditService } from '../../src/services/audit.service.js';
import { createInsuranceService, MAX_PAGE, type InsuranceService } from '../../src/services/insurance.service.js';
import { createTenant, createUser } from '../helpers/factories.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

function contextOf(tenantId: string, role: UserRole = 'admin', userId: string = randomUUID()): TenantContext {
  return {
    userId,
    tenantId,
    role,
    discountLimit: 100,
    ip: '127.0.0.1',
    userAgent: 'vitest',
  };
}

describe('InsuranceService', () => {
  let db: DbClient;
  let service: InsuranceService;
  let audit: ReturnType<typeof createAuditService>;

  beforeAll(async () => {
    db = await getTestDb();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    audit = createAuditService(db);
    service = createInsuranceService({ db, audit });
  });

  describe('list', () => {
    it('lista so os convenios do proprio tenant', async () => {
      const tenantA = await createTenant();
      const tenantB = await createTenant();

      await service.create(contextOf(tenantA.id), { name: 'Unimed Tubarão', type: 'cooperativa' });
      await service.create(contextOf(tenantB.id), { name: 'Hapvida', type: 'medicina_grupo' });

      const result = await service.list(contextOf(tenantA.id), {});
      expect(result.insurances).toHaveLength(1);
      expect(result.insurances[0]?.name).toBe('Unimed Tubarão');
      expect(result.pagination).toMatchObject({ page: 1, limit: 20, total: 1, totalPages: 1 });
    });

    it('pagina acima de MAX_PAGE nao trava — devolve lista vazia, nao erro', async () => {
      const tenant = await createTenant();
      await service.create(contextOf(tenant.id), { name: 'Bradesco Saúde', type: 'seguradora' });

      const result = await service.list(contextOf(tenant.id), { page: 999_999 });
      expect(result.insurances).toEqual([]);
      // O clamp segura em MAX_PAGE, nao no valor pedido.
      expect(result.pagination.page).toBe(MAX_PAGE);
    });

    it('filtra por active e busca por nome/razao social sem caixa nem acento', async () => {
      const tenant = await createTenant();
      await service.create(contextOf(tenant.id), {
        name: 'Unimed Tubarão',
        officialName: 'Unimed de Tubarão Cooperativa de Trabalho Médico',
        type: 'cooperativa',
      });
      const inativo = await service.create(contextOf(tenant.id), { name: 'SC Saúde', type: 'especial' });
      await service.update(contextOf(tenant.id), inativo.id, { isActive: false });

      const ativos = await service.list(contextOf(tenant.id), { active: true });
      expect(ativos.insurances.map((i) => i.name)).toEqual(['Unimed Tubarão']);

      const porBusca = await service.list(contextOf(tenant.id), { search: 'unimed tubarao' });
      expect(porBusca.insurances).toHaveLength(1);

      const porRazaoSocial = await service.list(contextOf(tenant.id), { search: 'cooperativa de trabalho medico' });
      expect(porRazaoSocial.insurances).toHaveLength(1);
    });
  });

  describe('getById', () => {
    it('convenio de outro tenant -> NOT_FOUND', async () => {
      const tenantA = await createTenant();
      const tenantB = await createTenant();
      const insuranceB = await service.create(contextOf(tenantB.id), { name: 'Amil', type: 'medicina_grupo' });

      await expect(service.getById(contextOf(tenantA.id), insuranceB.id)).rejects.toSatisfy(
        (err: unknown) => isBusinessError(err) && err.code === 'NOT_FOUND' && err.statusCode === 404,
      );
    });

    it('id inexistente -> NOT_FOUND', async () => {
      const tenant = await createTenant();
      await expect(service.getById(contextOf(tenant.id), randomUUID())).rejects.toSatisfy(
        (err: unknown) => isBusinessError(err) && err.code === 'NOT_FOUND',
      );
    });
  });

  describe('create', () => {
    it('nome duplicado no mesmo tenant -> CONFLICT', async () => {
      const tenant = await createTenant();
      const ctx = contextOf(tenant.id);
      await service.create(ctx, { name: 'Bradesco Saúde', type: 'seguradora' });

      await expect(service.create(ctx, { name: 'Bradesco Saúde', type: 'seguradora' })).rejects.toMatchObject({
        code: 'CONFLICT',
      });
    });

    it('mesmo nome em tenants diferentes e permitido', async () => {
      const tenantA = await createTenant();
      const tenantB = await createTenant();
      const dto = { name: 'Bradesco Saúde', type: 'seguradora' as const };

      const a = await service.create(contextOf(tenantA.id), dto);
      const b = await service.create(contextOf(tenantB.id), dto);
      expect(a.id).not.toBe(b.id);
    });

    it('atendente nao pode criar convenio -> FORBIDDEN', async () => {
      const tenant = await createTenant();
      await expect(
        service.create(contextOf(tenant.id, 'attendant'), { name: 'Amil', type: 'medicina_grupo' }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('manager pode criar convenio', async () => {
      const tenant = await createTenant();
      const insurance = await service.create(contextOf(tenant.id, 'manager'), {
        name: 'Amil',
        type: 'medicina_grupo',
      });
      expect(insurance.name).toBe('Amil');
    });

    it('nasce ativo, com officialName/ansCode nulos quando omitidos, e aparado', async () => {
      const tenant = await createTenant();
      const insurance = await service.create(contextOf(tenant.id), {
        name: '  Bradesco Saúde  ',
        type: 'seguradora',
      });
      expect(insurance.name).toBe('Bradesco Saúde');
      expect(insurance.officialName).toBeNull();
      expect(insurance.ansCode).toBeNull();
      expect(insurance.isActive).toBe(true);
    });

    it('gera audit log create_insurance', async () => {
      const tenant = await createTenant();
      const user = await createUser({ tenantId: tenant.id, role: 'admin' });
      const ctx = contextOf(tenant.id, 'admin', user.id);
      const insurance = await service.create(ctx, { name: 'Bradesco Saúde', type: 'seguradora' });

      const log = await audit.query(ctx, {});
      const entry = log.entries.find((e) => e.action === 'create_insurance');
      expect(entry).toBeDefined();
      expect(entry?.entityType).toBe('insurance');
      expect(entry?.entityId).toBe(insurance.id);
    });
  });

  describe('update', () => {
    it('atendente nao pode atualizar convenio -> FORBIDDEN', async () => {
      const tenant = await createTenant();
      const insurance = await service.create(contextOf(tenant.id), { name: 'Amil', type: 'medicina_grupo' });

      await expect(
        service.update(contextOf(tenant.id, 'attendant'), insurance.id, { isActive: false }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('convenio de outro tenant -> NOT_FOUND', async () => {
      const tenantA = await createTenant();
      const tenantB = await createTenant();
      const insuranceB = await service.create(contextOf(tenantB.id), { name: 'Amil', type: 'medicina_grupo' });

      await expect(
        service.update(contextOf(tenantA.id), insuranceB.id, { isActive: false }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('desativa via isActive:false — nao existe delete', async () => {
      const tenant = await createTenant();
      const ctx = contextOf(tenant.id);
      const insurance = await service.create(ctx, { name: 'Amil', type: 'medicina_grupo' });

      const updated = await service.update(ctx, insurance.id, { isActive: false });
      expect(updated.isActive).toBe(false);
    });

    it('renomear para nome ja usado no tenant -> CONFLICT', async () => {
      const tenant = await createTenant();
      const ctx = contextOf(tenant.id);
      await service.create(ctx, { name: 'Amil', type: 'medicina_grupo' });
      const bradesco = await service.create(ctx, { name: 'Bradesco Saúde', type: 'seguradora' });

      await expect(service.update(ctx, bradesco.id, { name: 'Amil' })).rejects.toMatchObject({
        code: 'CONFLICT',
      });
    });

    it('gera audit log update_insurance so com os campos que mudaram', async () => {
      const tenant = await createTenant();
      const user = await createUser({ tenantId: tenant.id, role: 'admin' });
      const ctx = contextOf(tenant.id, 'admin', user.id);
      const insurance = await service.create(ctx, { name: 'Amil', type: 'medicina_grupo' });

      await service.update(ctx, insurance.id, { isActive: false });

      const log = await audit.query(ctx, {});
      const entry = log.entries.find((e) => e.action === 'update_insurance');
      expect(entry).toBeDefined();
      expect(entry?.entityId).toBe(insurance.id);
      expect(entry?.newValues).toMatchObject({ isActive: false });
      expect(entry?.oldValues).toMatchObject({ isActive: true });
    });
  });
});
