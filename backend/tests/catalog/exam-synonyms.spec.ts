/**
 * Busca por sinonimo — SERVICES.md §5 (Onda 7).
 *
 * `GET /exams?search=` casa NOME, CODIGO e SINONIMO, sem sensibilidade a caixa
 * nem a acento. `synonyms` no create/update regrava o conjunto inteiro
 * (semantica de PUT sobre a colecao filha `exam_synonyms`).
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { UserRole } from '@crm-lab/shared';
import type { DbClient } from '../../src/db/types.js';
import { MemoryCache } from '../../src/lib/cache.js';
import type { TenantContext } from '../../src/http/context.js';
import { createAuditService } from '../../src/services/audit.service.js';
import { ExamRepository } from '../../src/repositories/exam.repository.js';
import { ExamCatalogService } from '../../src/services/exam-catalog.service.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { createTenant } from '../helpers/factories.js';

function contextOf(tenantId: string, role: UserRole = 'manager'): TenantContext {
  return {
    userId: randomUUID(),
    tenantId,
    role,
    discountLimit: 100,
    ip: '127.0.0.1',
    userAgent: 'vitest',
  };
}

describe('busca por sinonimo', () => {
  let db: DbClient;
  let service: ExamCatalogService;

  beforeAll(async () => {
    db = await getTestDb();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    service = new ExamCatalogService(new ExamRepository(db), new MemoryCache(), createAuditService(db));
  });

  it('?search=acucar no sangue encontra o exame "Glicose"', async () => {
    const tenant = await createTenant();
    const ctx = contextOf(tenant.id);
    const exam = await service.create(ctx, {
      name: 'Glicose',
      code: 'GLI001',
      pricePrivate: 15,
      priceInsurance: 12,
      synonyms: ['glicemia', 'açúcar no sangue', 'glicemia de jejum'],
    });

    const result = await service.list(tenant.id, { search: 'acucar no sangue' });
    expect(result.data.map((e) => e.id)).toContain(exam.id);
  });

  it('sinonimo sem acento e sem caixa casa igual a nome/codigo', async () => {
    const tenant = await createTenant();
    const ctx = contextOf(tenant.id);
    await service.create(ctx, {
      name: 'Urina Tipo I',
      code: 'URI001',
      pricePrivate: 20,
      priceInsurance: 15,
      synonyms: ['EQU', 'sumário de urina'],
    });

    const result = await service.list(tenant.id, { search: 'SUMARIO DE URINA' });
    expect(result.data).toHaveLength(1);
  });

  it('PATCH com synonyms substitui o conjunto anterior', async () => {
    const tenant = await createTenant();
    const ctx = contextOf(tenant.id);
    const exam = await service.create(ctx, {
      name: 'TSH',
      code: 'TSH001',
      pricePrivate: 30,
      priceInsurance: 25,
      synonyms: ['tireoide'],
    });

    // Termo do NOVO sinonimo escolhido de proposito para nao conter "tireoide"
    // como substring — senao o teste provaria a coisa errada (LIKE '%...%').
    await service.update(ctx, exam.id, { synonyms: ['hormonio estimulante'] });

    const bySynonymAntigo = await service.list(tenant.id, { search: 'tireoide' });
    expect(bySynonymAntigo.data.map((e) => e.id)).not.toContain(exam.id);

    const bySynonymNovo = await service.list(tenant.id, { search: 'hormonio estimulante' });
    expect(bySynonymNovo.data.map((e) => e.id)).toContain(exam.id);
  });

  it('create sem synonyms nasce com [] — nunca undefined', async () => {
    const tenant = await createTenant();
    const exam = await service.create(contextOf(tenant.id), {
      name: 'Colesterol Total',
      code: 'COL001',
      pricePrivate: 25,
      priceInsurance: 18,
    });
    expect(exam.synonyms).toEqual([]);
  });

  it('PATCH que NAO envia synonyms preserva os atuais', async () => {
    const tenant = await createTenant();
    const ctx = contextOf(tenant.id);
    const exam = await service.create(ctx, {
      name: 'Ureia',
      code: 'URE001',
      pricePrivate: 18,
      priceInsurance: 14,
      synonyms: ['ureia sanguinea'],
    });

    await service.update(ctx, exam.id, { pricePrivate: 20 });

    const result = await service.list(tenant.id, { search: 'ureia sanguinea' });
    expect(result.data.map((e) => e.id)).toContain(exam.id);
  });

  it('getByIds tambem popula synonyms', async () => {
    const tenant = await createTenant();
    const exam = await service.create(contextOf(tenant.id), {
      name: 'Potássio',
      code: 'POT001',
      pricePrivate: 22,
      priceInsurance: 16,
      synonyms: ['K+', 'potassio serico'],
    });

    const [found] = await service.getByIds(tenant.id, [exam.id]);
    expect(found?.synonyms.sort()).toEqual(['K+', 'potassio serico'].sort());
  });
});
