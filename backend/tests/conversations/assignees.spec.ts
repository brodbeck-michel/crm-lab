/**
 * GET /conversations/assignees — a lista do menu "Transferir".
 *
 * O que o teste protege: a rota existe para ATENDENTE (o `GET /users` e
 * admin-only, e era esse o motivo do endpoint), devolve so `id`/`name`/`role`
 * (sem e-mail, sem alcada) e nao vaza usuario de outro laboratorio nem
 * desativado.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { conversationModule } from '../../src/controllers/conversation.routes.js';
import { createTenant, createUser } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { resetDatabase } from '../helpers/test-db.js';

describe('GET /conversations/assignees', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp({ modules: [conversationModule] });
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  it('atendente lista as colegas ativas do proprio laboratorio, so com id/nome/papel', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Ana' });
    const bruno = await createUser({ tenantId: tenant.id, role: 'manager', name: 'Bruno' });

    const response = await app.agent
      .get('/api/v1/conversations/assignees')
      .set(app.auth(ana))
      .expect(200);

    const ids = response.body.assignees.map((a: { id: string }) => a.id).sort();
    expect(ids).toEqual([ana.id, bruno.id].sort());
    expect(Object.keys(response.body.assignees[0]).sort()).toEqual(['id', 'name', 'role']);
  });

  it('nao devolve usuario inativo nem de outro laboratorio', async () => {
    const tenant = await createTenant();
    const outro = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Ana' });
    const inativa = await createUser({
      tenantId: tenant.id,
      role: 'attendant',
      name: 'Carla',
      isActive: false,
    });
    const deOutroTenant = await createUser({ tenantId: outro.id, role: 'attendant', name: 'Dora' });

    const response = await app.agent
      .get('/api/v1/conversations/assignees')
      .set(app.auth(ana))
      .expect(200);

    const ids = response.body.assignees.map((a: { id: string }) => a.id);
    expect(ids).toContain(ana.id);
    expect(ids).not.toContain(inativa.id);
    expect(ids).not.toContain(deOutroTenant.id);
  });

  it('`assignees` nao colide com `/:id` — a rota nao vira busca de conversa', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Ana' });

    // Se `/:id` viesse antes, o uuid-parser rejeitaria "assignees" com 400.
    await app.agent.get('/api/v1/conversations/assignees').set(app.auth(ana)).expect(200);
  });
});
