/**
 * AuditService + `GET /audit` — SERVICES.md §10, BUSINESS_RULES.md §9,
 * SECURITY.md "Auditoria".
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ListAuditResponse } from '@crm-lab/shared';
import type { DbClient } from '../../src/db/types.js';
import { auditModule } from '../../src/controllers/audit.routes.js';
import { userModule } from '../../src/controllers/user.routes.js';
import type { TenantContext } from '../../src/http/context.js';
import { createAuditService } from '../../src/services/audit.service.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import {
  createTenant,
  createUser,
  type TenantRecord,
  type UserRecord,
} from '../helpers/factories.js';

describe('auditoria', () => {
  let db: DbClient;
  let app: TestApp;
  let tenantA: TenantRecord;
  let tenantB: TenantRecord;
  let adminA: UserRecord;
  let attendantA: UserRecord;
  let adminB: UserRecord;

  const ctxOf = (user: UserRecord): TenantContext => ({
    userId: user.id,
    tenantId: user.tenantId,
    role: user.role,
    discountLimit: user.discountLimit,
    ip: '10.0.0.1',
    userAgent: 'vitest',
  });

  beforeAll(async () => {
    db = await getTestDb();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    app = await createTestApp({ db, modules: [userModule, auditModule] });

    tenantA = await createTenant({ name: 'Lab A' });
    tenantB = await createTenant({ name: 'Lab B' });
    adminA = await createUser({ tenantId: tenantA.id, role: 'admin', name: 'Admin A' });
    attendantA = await createUser({ tenantId: tenantA.id, role: 'attendant' });
    adminB = await createUser({ tenantId: tenantB.id, role: 'admin', name: 'Admin B' });
  });

  it('mudanca de papel gera entrada de auditoria com valores antigos e novos', async () => {
    await app.agent
      .patch(`/api/v1/users/${attendantA.id}`)
      .set(app.auth(adminA))
      .send({ role: 'manager', discountLimit: 30 })
      .expect(200);

    const response = await app.agent.get('/api/v1/audit').set(app.auth(adminA)).expect(200);
    const body = response.body as ListAuditResponse;

    expect(body.entries).toHaveLength(1);
    const entry = body.entries[0]!;
    expect(entry.action).toBe('update_user_permissions');
    expect(entry.entityType).toBe('user');
    expect(entry.entityId).toBe(attendantA.id);
    expect(entry.userId).toBe(adminA.id);
    expect(entry.userName).toBe('Admin A');
    expect(entry.oldValues).toEqual({ role: 'attendant', discountLimit: 15 });
    expect(entry.newValues).toEqual({ role: 'manager', discountLimit: 30 });
    expect(typeof entry.timestamp).toBe('string');
  });

  it('renomear alguem NAO gera entrada (nao e mudanca de permissao)', async () => {
    await app.agent
      .patch(`/api/v1/users/${attendantA.id}`)
      .set(app.auth(adminA))
      .send({ name: 'Outro Nome' })
      .expect(200);

    const response = await app.agent.get('/api/v1/audit').set(app.auth(adminA)).expect(200);
    expect((response.body as ListAuditResponse).entries).toHaveLength(0);
  });

  it('criar usuario gera entrada create_user', async () => {
    await app.agent
      .post('/api/v1/users')
      .set(app.auth(adminA))
      .send({
        email: 'auditada@lab.com',
        name: 'Auditada',
        password: 'senha-forte-123',
        role: 'attendant',
      })
      .expect(201);

    const response = await app.agent
      .get('/api/v1/audit?action=create_user')
      .set(app.auth(adminA))
      .expect(200);
    expect((response.body as ListAuditResponse).entries).toHaveLength(1);
  });

  it('GET /audit de nao-admin -> FORBIDDEN', async () => {
    const response = await app.agent.get('/api/v1/audit').set(app.auth(attendantA)).expect(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
    expect(response.body.error.details.requiredRoles).toEqual(['admin']);
  });

  it('ISOLAMENTO: entrada de outro tenant nunca aparece', async () => {
    const audit = createAuditService(db);
    await audit.log({
      tenantId: tenantB.id,
      userId: adminB.id,
      action: 'segredo_do_lab_b',
      entityType: 'user',
      entityId: adminB.id,
    });
    await audit.log({
      tenantId: tenantA.id,
      userId: adminA.id,
      action: 'acao_do_lab_a',
      entityType: 'user',
      entityId: adminA.id,
    });
    expect(audit.failures).toHaveLength(0);

    const seenByA = await app.agent.get('/api/v1/audit').set(app.auth(adminA)).expect(200);
    const actionsA = (seenByA.body as ListAuditResponse).entries.map((e) => e.action);
    expect(actionsA).toEqual(['acao_do_lab_a']);

    const seenByB = await app.agent.get('/api/v1/audit').set(app.auth(adminB)).expect(200);
    const actionsB = (seenByB.body as ListAuditResponse).entries.map((e) => e.action);
    expect(actionsB).toEqual(['segredo_do_lab_b']);
  });

  it('log() nao lanca quando a escrita falha — mas registra a falha', async () => {
    const audit = createAuditService(db);

    // tenant_id inexistente viola a FK: a escrita falha de verdade.
    await expect(
      audit.log({
        tenantId: '00000000-0000-4000-8000-000000000000',
        userId: null,
        action: 'acao_qualquer',
        entityType: 'proposal',
        entityId: '00000000-0000-4000-8000-000000000001',
      }),
    ).resolves.toBeUndefined();

    expect(audit.failures).toHaveLength(1);
    expect(audit.failures[0]?.action).toBe('acao_qualquer');
    expect(audit.failures[0]?.reason).toBeTruthy();
  });

  it('record() deriva tenant, usuario, ip e user-agent do TenantContext', async () => {
    const audit = createAuditService(db);
    await audit.record(ctxOf(adminA), {
      action: 'update_proposal_status',
      entityType: 'proposal',
      entityId: adminA.id,
      oldValues: { status: 'novo_contato' },
      newValues: { status: 'orcamento_enviado' },
    });
    expect(audit.failures).toHaveLength(0);

    const result = await audit.query(ctxOf(adminA), {});
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.ipAddress).toBe('10.0.0.1');
    expect(result.entries[0]?.userId).toBe(adminA.id);
    expect(result.pagination).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 });
  });

  it('query() recusa quem nao e admin mesmo sem passar pela rota', async () => {
    const audit = createAuditService(db);
    await expect(audit.query(ctxOf(attendantA), {})).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('nao existe rota de escrita, edicao ou remocao de audit log', async () => {
    await app.agent.post('/api/v1/audit').set(app.auth(adminA)).send({}).expect(404);
    await app.agent
      .delete('/api/v1/audit/11111111-1111-4111-8111-111111111111')
      .set(app.auth(adminA))
      .expect(404);
  });
});
