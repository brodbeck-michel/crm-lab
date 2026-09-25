/**
 * POST /exams/import/preview e POST /exams/import — CRMLAB-23, D-177
 * (API_CONTRACTS.md §4, "Importação do catálogo por CSV").
 *
 * Cobre: pre-visualizacao nao grava, insercao vs atualizacao, tudo-ou-nada
 * (na validacao E no banco), isolamento entre tenants e bloqueio de nao-admin.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  ApiErrorBody,
  ExamImportPreview,
  ExamImportResult,
  ListExamsResponse,
} from '@crm-lab/shared';
import { EXAM_IMPORT_MAX_BYTES } from '@crm-lab/shared';
import type { DbClient } from '../../src/db/types.js';
import { MemoryCache } from '../../src/lib/cache.js';
import { examModule } from '../../src/controllers/exam.routes.js';
import { ExamRepository, IMPORT_BATCH_SIZE } from '../../src/repositories/exam.repository.js';
import { BusinessError } from '../../src/http/errors.js';
import type { TenantContext } from '../../src/http/context.js';
import { createAuditService } from '../../src/services/audit.service.js';
import { ExamCatalogService } from '../../src/services/exam-catalog.service.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { createExam, createTenant, createUser, type UserRecord } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

const HEADER = 'nome;codigo;categoria;descricao;preparo;prazo_horas;preco_convenio;preco_particular';

function body(text: string, fileName = 'catalogo.csv') {
  return { fileName, contentBase64: Buffer.from(text, 'utf8').toString('base64') };
}

interface CatalogRow {
  code: string;
  name: string;
  description: string | null;
  preparation: string | null;
  turnaround_hours: number | null;
  category: string | null;
  price_private: string;
  price_insurance: string;
  is_active: boolean;
  source: string;
}

describe('/api/v1/exams/import', () => {
  let db: DbClient;
  let app: TestApp;
  let tenantId: string;
  let admin: UserRecord;

  async function catalogOf(tenant: string): Promise<CatalogRow[]> {
    const result = await db.withoutTenant((tx) =>
      tx.query<CatalogRow>(
        `SELECT code, name, description, preparation, turnaround_hours, category,
                price_private::text AS price_private, price_insurance::text AS price_insurance,
                is_active, source
         FROM exam_catalog WHERE tenant_id = $1 ORDER BY code`,
        [tenant],
      ),
    );
    return result.rows;
  }

  async function auditActions(tenant: string): Promise<Array<{ action: string; new_values: unknown }>> {
    const result = await db.withoutTenant((tx) =>
      tx.query<{ action: string; new_values: unknown }>(
        'SELECT action, new_values FROM audit_logs WHERE tenant_id = $1',
        [tenant],
      ),
    );
    return result.rows;
  }

  beforeAll(async () => {
    db = await getTestDb();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    app = await createTestApp({ db, cache: new MemoryCache(), modules: [examModule] });
    const tenant = await createTenant();
    tenantId = tenant.id;
    admin = await createUser({ tenantId, role: 'admin' });
  });

  // -------------------------------------------------------------------------
  // Pre-visualizacao
  // -------------------------------------------------------------------------
  describe('POST /exams/import/preview', () => {
    it('classifica novo x atualiza x erro, no shape de ExamImportPreview, sem gravar nada', async () => {
      await createExam({ tenantId, code: 'HC', name: 'Hemograma antigo' });
      const antes = await catalogOf(tenantId);

      const text = [
        HEADER,
        'Hemograma completo;HC;Hematologia;;;24;75,00;89,90',
        'Vitamina D;VITD;;;;;95;1.234,56',
        'Quebrado;QB;;;;;abc;10',
      ].join('\n');
      const response = await app.agent
        .post('/api/v1/exams/import/preview')
        .set(app.auth(admin))
        .send(body(text))
        .expect(200);

      const preview = response.body as ExamImportPreview;
      expect(Object.keys(preview).sort()).toEqual(
        [
          'createCount',
          'errorCount',
          'errors',
          'errorsTruncated',
          'fileName',
          'rows',
          'totalRows',
          'updateCount',
        ].sort(),
      );
      expect(preview).toMatchObject({
        fileName: 'catalogo.csv',
        totalRows: 3,
        createCount: 1,
        updateCount: 1,
        errorCount: 1,
        errorsTruncated: false,
        errors: [{ line: 4, column: 'preco_convenio', message: 'Preço inválido: "abc"' }],
      });
      expect(preview.rows).toEqual([
        {
          line: 2,
          action: 'update',
          code: 'HC',
          name: 'Hemograma completo',
          category: 'Hematologia',
          turnaroundHours: 24,
          pricePrivate: 89.9,
          priceInsurance: 75,
        },
        {
          line: 3,
          action: 'create',
          code: 'VITD',
          name: 'Vitamina D',
          category: null,
          turnaroundHours: null,
          pricePrivate: 1234.56,
          priceInsurance: 95,
        },
      ]);
      // Dinheiro no fio e numero (regra 9).
      expect(typeof preview.rows[1]?.pricePrivate).toBe('number');

      expect(await catalogOf(tenantId)).toEqual(antes);
      expect(await auditActions(tenantId)).toEqual([]);
    });

    it('arquivo recusado inteiro vira VALIDATION_ERROR com details.reason', async () => {
      const response = await app.agent
        .post('/api/v1/exams/import/preview')
        .set(app.auth(admin))
        .send(body('nome;codigo\nA;B\n'))
        .expect(400);
      const error = (response.body as ApiErrorBody).error;
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.details).toEqual({
        reason: 'missing_column',
        columns: ['preco_convenio', 'preco_particular'],
      });
    });

    it('arquivo acima de 2 MiB -> 413 MEDIA_TOO_LARGE', async () => {
      const big = `${HEADER}\n${'x'.repeat(EXAM_IMPORT_MAX_BYTES)}`;
      const response = await app.agent
        .post('/api/v1/exams/import/preview')
        .set(app.auth(admin))
        .send(body(big))
        .expect(413);
      const error = (response.body as ApiErrorBody).error;
      expect(error.code).toBe('MEDIA_TOO_LARGE');
      expect(error.details).toMatchObject({ max: EXAM_IMPORT_MAX_BYTES });
    });

    it('corpo fora do shape -> VALIDATION_ERROR com details.fields', async () => {
      const response = await app.agent
        .post('/api/v1/exams/import/preview')
        .set(app.auth(admin))
        .send({ fileName: '', contentBase64: '' })
        .expect(400);
      expect((response.body as ApiErrorBody).error.details).toHaveProperty('fields');
    });
  });

  // -------------------------------------------------------------------------
  // Confirmar
  // -------------------------------------------------------------------------
  describe('POST /exams/import', () => {
    it('insere o novo, atualiza o existente preservando opcional vazio, audita e invalida o cache', async () => {
      // Existente COM descricao/preparo/categoria e INATIVO: o import nao pode
      // apagar o que veio vazio nem reativar.
      await createExam({ tenantId, code: 'HC', name: 'Antigo', isActive: false, category: 'Velha' });
      await db.withoutTenant((tx) =>
        tx.query(
          `UPDATE exam_catalog SET description = 'desc antiga', preparation = 'preparo antigo'
           WHERE tenant_id = $1 AND code = 'HC'`,
          [tenantId],
        ),
      );

      // Aquece o cache da listagem: depois do import ele precisa cair.
      await app.agent.get('/api/v1/exams').set(app.auth(admin)).expect(200);

      const text = [
        HEADER,
        'Hemograma completo;HC;;;Jejum 4h;;75,00;89,90',
        'Vitamina D;VITD;Hormônios;Dosagem;;48;95;1.234,56',
      ].join('\n');
      const response = await app.agent
        .post('/api/v1/exams/import')
        .set(app.auth(admin))
        .send(body(text))
        .expect(200);

      expect(response.body as ExamImportResult).toEqual({
        fileName: 'catalogo.csv',
        totalRows: 2,
        created: 1,
        updated: 1,
      });

      const catalog = await catalogOf(tenantId);
      expect(catalog).toEqual([
        {
          code: 'HC',
          name: 'Hemograma completo',
          description: 'desc antiga', // vazio no CSV -> preservado
          preparation: 'Jejum 4h', // preenchido -> regravado
          turnaround_hours: 24, // vazio no CSV -> preservado (factory grava 24)
          category: 'Velha', // vazio no CSV -> preservado
          price_private: '89.90',
          price_insurance: '75.00',
          is_active: false, // import nao reativa
          source: 'manual',
        },
        {
          code: 'VITD',
          name: 'Vitamina D',
          description: 'Dosagem',
          preparation: null,
          turnaround_hours: 48,
          category: 'Hormônios',
          price_private: '1234.56',
          price_insurance: '95.00',
          is_active: true,
          source: 'manual',
        },
      ]);

      const audit = await auditActions(tenantId);
      expect(audit).toHaveLength(1);
      expect(audit[0]?.action).toBe('import_exam_catalog');
      expect(audit[0]?.new_values).toMatchObject({ created: 1, updated: 1, totalRows: 2 });

      const list = await app.agent.get('/api/v1/exams').set(app.auth(admin)).expect(200);
      expect((list.body as ListExamsResponse).exams.map((e) => e.code).sort()).toEqual(['HC', 'VITD']);
    });

    it('tudo-ou-nada: uma linha com erro -> VALIDATION_ERROR invalid_rows e NADA gravado', async () => {
      await createExam({ tenantId, code: 'HC', name: 'Antigo', pricePrivate: 10, priceInsurance: 5 });
      const antes = await catalogOf(tenantId);

      const text = [
        HEADER,
        'Hemograma novo;HC;;;;;75;89,90', // valida, atualizaria
        'Vitamina D;VITD;;;;;95;100', // valida, criaria
        'Repetido;VITD;;;;;1;2', // duplicado no arquivo
      ].join('\n');
      const response = await app.agent
        .post('/api/v1/exams/import')
        .set(app.auth(admin))
        .send(body(text))
        .expect(400);

      const error = (response.body as ApiErrorBody).error;
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.details).toMatchObject({ reason: 'invalid_rows', errorCount: 2 });
      expect((error.details as { errors: unknown[] }).errors).toEqual([
        { line: 3, column: null, message: 'Código "VITD" repetido no arquivo (linhas 3, 4)' },
        { line: 4, column: null, message: 'Código "VITD" repetido no arquivo (linhas 3, 4)' },
      ]);

      expect(await catalogOf(tenantId)).toEqual(antes);
      expect(await auditActions(tenantId)).toEqual([]);
    });

    it('tudo-ou-nada no banco: falha no 2º lote desfaz o 1º (uma transacao so)', async () => {
      const repository = new ExamRepository(db);
      const ok = Array.from({ length: IMPORT_BATCH_SIZE }, (_, i) => ({
        name: `Exame ${i}`,
        code: `LOTE${i}`,
        description: null,
        preparation: null,
        turnaroundHours: null,
        pricePrivate: 10,
        priceInsurance: 5,
        category: null,
      }));
      // Nome acima do VARCHAR(255): o parser recusaria, aqui forca erro de banco.
      const ruim = { ...ok[0]!, code: 'RUIM', name: 'x'.repeat(300) };

      await expect(repository.upsertImported(tenantId, [...ok, ruim])).rejects.toThrow();
      expect(await catalogOf(tenantId)).toEqual([]);
    });

    it('mais de um lote grava tudo e conta certo', async () => {
      const total = IMPORT_BATCH_SIZE + 3;
      const lines = Array.from({ length: total }, (_, i) => `Exame ${i};L${i};;;;;1;2`);
      const response = await app.agent
        .post('/api/v1/exams/import')
        .set(app.auth(admin))
        .send(body([HEADER, ...lines].join('\n')))
        .expect(200);
      expect(response.body).toMatchObject({ created: total, updated: 0 });
      expect(await catalogOf(tenantId)).toHaveLength(total);
    });
  });

  // -------------------------------------------------------------------------
  // Isolamento e permissao
  // -------------------------------------------------------------------------
  describe('isolamento multitenant', () => {
    it('codigo igual em outro laboratorio e outro exame: preview diz create e o import nao toca em B', async () => {
      const beta = await createTenant();
      await createExam({ tenantId: beta.id, code: 'HC', name: 'Hemograma do Beta', pricePrivate: 50 });
      const betaAntes = await catalogOf(beta.id);

      const text = `${HEADER}\nHemograma Alfa;HC;;;;;75;89,90\n`;
      const preview = await app.agent
        .post('/api/v1/exams/import/preview')
        .set(app.auth(admin))
        .send(body(text))
        .expect(200);
      expect((preview.body as ExamImportPreview).rows[0]?.action).toBe('create');

      const confirm = await app.agent
        .post('/api/v1/exams/import')
        .set(app.auth(admin))
        .send(body(text))
        .expect(200);
      expect(confirm.body).toMatchObject({ created: 1, updated: 0 });

      expect(await catalogOf(beta.id)).toEqual(betaAntes);
      expect((await catalogOf(tenantId)).map((row) => row.name)).toEqual(['Hemograma Alfa']);
      expect(await auditActions(beta.id)).toEqual([]);
    });
  });

  describe('so admin', () => {
    for (const role of ['manager', 'attendant'] as const) {
      for (const path of ['/api/v1/exams/import/preview', '/api/v1/exams/import']) {
        it(`${role} em ${path} -> 403 FORBIDDEN requiredRoles [admin], nada gravado`, async () => {
          const user = await createUser({ tenantId, role });
          const response = await app.agent
            .post(path)
            .set(app.auth(user))
            .send(body(`${HEADER}\nA;A;;;;;1;2\n`))
            .expect(403);
          const error = (response.body as ApiErrorBody).error;
          expect(error.code).toBe('FORBIDDEN');
          expect(error.details).toEqual({ requiredRoles: ['admin'] });
          expect(await catalogOf(tenantId)).toEqual([]);
        });
      }
    }
  });

  it('o service recusa gestor por conta propria (defesa alem da rota)', async () => {
    const service = new ExamCatalogService(new ExamRepository(db), new MemoryCache(), createAuditService(db));
    const ctx: TenantContext = {
      userId: admin.id,
      tenantId,
      role: 'manager',
      discountLimit: 0,
      ip: '127.0.0.1',
      userAgent: 'vitest',
    };
    const dto = body(`${HEADER}\nA;A;;;;;1;2\n`);
    for (const call of [service.previewImport(ctx, dto), service.confirmImport(ctx, dto)]) {
      await expect(call).rejects.toSatisfy(
        (err: unknown) => err instanceof BusinessError && err.code === 'FORBIDDEN',
      );
    }
    expect(await catalogOf(tenantId)).toEqual([]);
  });
});
