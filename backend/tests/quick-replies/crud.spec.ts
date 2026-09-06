/**
 * CRUD de respostas rapidas — API_CONTRACTS.md §9 (Onda 8 §3).
 *
 * O que estes testes protegem:
 *   1. qualquer papel de tenant escreve (a atendente e quem mais usa macro);
 *   2. atalho duplicado no tenant e VALIDATION_ERROR com o CAMPO, nao CONFLICT
 *      generico nem erro cru de banco;
 *   3. o mesmo atalho em dois laboratorios convive;
 *   4. macro de outro tenant e NOT_FOUND, nunca FORBIDDEN;
 *   5. criar, editar e apagar geram audit log (CLAUDE.md regra 7).
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ApiErrorBody, ListQuickRepliesResponse, QuickReply } from '@crm-lab/shared';
import { quickReplyModule } from '../../src/controllers/quick-reply.routes.js';
import { createTenant, createUser } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

const MACRO = {
  shortcut: 'horariocoleta',
  title: 'Horário de coleta',
  content: 'Nossa coleta é de segunda a sexta, das 6h30 às 11h, sem agendamento.',
};

describe('quick replies', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp({ modules: [quickReplyModule] });
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  it('a atendente cria a macro e ela aparece na listagem', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Ana' });

    const created = await app.agent
      .post('/api/v1/quick-replies')
      .set(app.auth(ana))
      .send(MACRO)
      .expect(201);

    const body = created.body as QuickReply;
    expect(body.shortcut).toBe('horariocoleta');
    expect(body.content).toBe(MACRO.content);
    expect(body.createdBy).toBe(ana.id);

    const listed = await app.agent.get('/api/v1/quick-replies').set(app.auth(ana)).expect(200);
    const list = listed.body as ListQuickRepliesResponse;
    expect(list.quickReplies.map((r) => r.shortcut)).toEqual(['horariocoleta']);
  });

  it('o atalho vem normalizado para caixa baixa e sem espaco em volta', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });

    const created = await app.agent
      .post('/api/v1/quick-replies')
      .set(app.auth(ana))
      .send({ ...MACRO, shortcut: '  Coleta  ' })
      .expect(201);

    expect((created.body as QuickReply).shortcut).toBe('coleta');
  });

  it('atalho fora do formato e VALIDATION_ERROR no campo shortcut', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });

    const rejected = await app.agent
      .post('/api/v1/quick-replies')
      .set(app.auth(ana))
      .send({ ...MACRO, shortcut: 'horário coleta' })
      .expect(400);

    const error = (rejected.body as ApiErrorBody).error;
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(error.details)).toContain('shortcut');
  });

  it('atalho repetido no MESMO tenant e VALIDATION_ERROR com o campo, nao CONFLICT', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });

    await app.agent.post('/api/v1/quick-replies').set(app.auth(ana)).send(MACRO).expect(201);

    const repeated = await app.agent
      .post('/api/v1/quick-replies')
      .set(app.auth(ana))
      .send({ ...MACRO, title: 'Outro título' })
      .expect(400);

    const error = (repeated.body as ApiErrorBody).error;
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(error.details)).toContain('shortcut');
  });

  it('o mesmo atalho convive em dois laboratorios', async () => {
    const alfa = await createTenant({ name: 'Lab Alfa' });
    const beta = await createTenant({ name: 'Lab Beta' });
    const anaAlfa = await createUser({ tenantId: alfa.id, role: 'attendant' });
    const anaBeta = await createUser({ tenantId: beta.id, role: 'attendant' });

    await app.agent.post('/api/v1/quick-replies').set(app.auth(anaAlfa)).send(MACRO).expect(201);
    await app.agent.post('/api/v1/quick-replies').set(app.auth(anaBeta)).send(MACRO).expect(201);

    const listaAlfa = await app.agent
      .get('/api/v1/quick-replies')
      .set(app.auth(anaAlfa))
      .expect(200);
    expect((listaAlfa.body as ListQuickRepliesResponse).quickReplies).toHaveLength(1);
  });

  it('PATCH altera o conteudo e mantem o atalho', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });

    const created = await app.agent
      .post('/api/v1/quick-replies')
      .set(app.auth(ana))
      .send(MACRO)
      .expect(201);
    const macro = created.body as QuickReply;

    const updated = await app.agent
      .patch(`/api/v1/quick-replies/${macro.id}`)
      .set(app.auth(ana))
      .send({ content: 'Coleta de segunda a sexta, das 6h30 às 11h.' })
      .expect(200);

    const body = updated.body as QuickReply;
    expect(body.content).toBe('Coleta de segunda a sexta, das 6h30 às 11h.');
    expect(body.shortcut).toBe('horariocoleta');
  });

  it('DELETE tira a macro da listagem', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });

    const created = await app.agent
      .post('/api/v1/quick-replies')
      .set(app.auth(ana))
      .send(MACRO)
      .expect(201);

    await app.agent
      .delete(`/api/v1/quick-replies/${(created.body as QuickReply).id}`)
      .set(app.auth(ana))
      .expect(204);

    const listed = await app.agent.get('/api/v1/quick-replies').set(app.auth(ana)).expect(200);
    expect((listed.body as ListQuickRepliesResponse).quickReplies).toHaveLength(0);
  });

  it('macro de outro tenant e NOT_FOUND — nunca FORBIDDEN', async () => {
    const alfa = await createTenant({ name: 'Lab Alfa' });
    const beta = await createTenant({ name: 'Lab Beta' });
    const anaAlfa = await createUser({ tenantId: alfa.id, role: 'attendant' });
    const anaBeta = await createUser({ tenantId: beta.id, role: 'admin' });

    const created = await app.agent
      .post('/api/v1/quick-replies')
      .set(app.auth(anaBeta))
      .send(MACRO)
      .expect(201);
    const alheia = (created.body as QuickReply).id;

    const patched = await app.agent
      .patch(`/api/v1/quick-replies/${alheia}`)
      .set(app.auth(anaAlfa))
      .send({ title: 'invadido' })
      .expect(404);
    expect((patched.body as ApiErrorBody).error.code).toBe('NOT_FOUND');

    await app.agent
      .delete(`/api/v1/quick-replies/${alheia}`)
      .set(app.auth(anaAlfa))
      .expect(404);
  });

  it('criar, editar e apagar geram audit log (regra 7)', async () => {
    const db = await getTestDb();
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });

    const created = await app.agent
      .post('/api/v1/quick-replies')
      .set(app.auth(ana))
      .send(MACRO)
      .expect(201);
    const id = (created.body as QuickReply).id;

    await app.agent
      .patch(`/api/v1/quick-replies/${id}`)
      .set(app.auth(ana))
      .send({ title: 'Coleta' })
      .expect(200);
    await app.agent.delete(`/api/v1/quick-replies/${id}`).set(app.auth(ana)).expect(204);

    const log = await db.withoutTenant((tx) =>
      tx.query<{ action: string; old_values: Record<string, unknown> | null }>(
        `SELECT action, old_values FROM audit_logs WHERE entity_type = 'quick_reply'
         ORDER BY timestamp`,
      ),
    );
    expect(log.rows.map((r) => r.action)).toEqual([
      'create_quick_reply',
      'update_quick_reply',
      'delete_quick_reply',
    ]);
    // O DELETE e real: sem o conteudo no audit log, o texto apagado some do mundo.
    expect(JSON.stringify(log.rows[2]?.old_values)).toContain(MACRO.content);
  });
});
