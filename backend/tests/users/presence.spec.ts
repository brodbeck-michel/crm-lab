/**
 * Status da atendente — `GET /users/presence` e `PATCH /users/me/presence`
 * (CRMLAB-120, D-286). O "conectado" vem do hub falso (`wsHub.connect`).
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { UserPresenceResponse } from '@crm-lab/shared';
import { effectiveUserPresence } from '@crm-lab/shared';
import type { DbClient } from '../../src/db/types.js';
import { userModule } from '../../src/controllers/user.routes.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { createTenant, createUser, type TenantRecord, type UserRecord } from '../helpers/factories.js';

describe('status da atendente (CRMLAB-120)', () => {
  let db: DbClient;
  let app: TestApp;
  let tenantA: TenantRecord;
  let tenantB: TenantRecord;
  let ana: UserRecord;
  let bia: UserRecord;
  let inativa: UserRecord;
  let outroLab: UserRecord;

  beforeAll(async () => {
    db = await getTestDb();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    app = await createTestApp({ db, modules: [userModule] });
    tenantA = await createTenant({ name: 'Lab A' });
    tenantB = await createTenant({ name: 'Lab B' });
    ana = await createUser({ tenantId: tenantA.id, role: 'attendant', name: 'Ana' });
    bia = await createUser({ tenantId: tenantA.id, role: 'manager', name: 'Bia' });
    inativa = await createUser({ tenantId: tenantA.id, name: 'Cida', isActive: false });
    outroLab = await createUser({ tenantId: tenantB.id, role: 'attendant', name: 'Dora' });
  });

  const getPresence = async (user: UserRecord): Promise<UserPresenceResponse> =>
    (await app.agent.get('/api/v1/users/presence').set(app.auth(user)).expect(200))
      .body as UserPresenceResponse;

  const statusOf = (body: UserPresenceResponse, userId: string) =>
    body.items.find((i) => i.userId === userId)?.status;

  it('sem aba aberta todo mundo e offline; o escolhido inicial e online', async () => {
    const body = await getPresence(ana);
    expect(statusOf(body, ana.id)).toBe('offline');
    expect(statusOf(body, bia.id)).toBe('offline');
    expect(body.myStatus).toBe('online');
  });

  it('lista so os ativos do proprio tenant', async () => {
    const body = await getPresence(ana);
    const ids = body.items.map((i) => i.userId);
    expect(ids).toContain(bia.id);
    expect(ids).not.toContain(inativa.id);
    expect(ids).not.toContain(outroLab.id);
  });

  it('conectada mostra o escolhido; qualquer papel ve', async () => {
    app.wsHub.connect(tenantA.id, ana.id);
    await app.agent
      .patch('/api/v1/users/me/presence')
      .set(app.auth(ana))
      .send({ status: 'busy' })
      .expect(200);

    const body = await getPresence(bia);
    expect(statusOf(body, ana.id)).toBe('busy');
    expect(body.myStatus).toBe('online');
  });

  it('troca de status grava, avisa o tenant e volta no proximo acesso', async () => {
    const response = await app.agent
      .patch('/api/v1/users/me/presence')
      .set(app.auth(ana))
      .send({ status: 'away' })
      .expect(200);
    expect((response.body as UserPresenceResponse).myStatus).toBe('away');
    expect(app.wsHub.eventsFor(tenantA.id, 'user.presence_changed')).toEqual([
      expect.objectContaining({ userId: null, data: { userId: ana.id } }),
    ]);
    expect(app.wsHub.eventsFor(tenantB.id)).toHaveLength(0);

    // "Ao entrar, volta o ultimo escolhido": fica no banco, nao na conexao.
    app.wsHub.connect(tenantA.id, ana.id);
    expect(statusOf(await getPresence(ana), ana.id)).toBe('away');
  });

  it('offline nao pode ser escolhido', async () => {
    const response = await app.agent
      .patch('/api/v1/users/me/presence')
      .set(app.auth(ana))
      .send({ status: 'offline' })
      .expect(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('corpo vazio ou campo desconhecido -> 400', async () => {
    await app.agent.patch('/api/v1/users/me/presence').set(app.auth(ana)).send({}).expect(400);
    await app.agent
      .patch('/api/v1/users/me/presence')
      .set(app.auth(ana))
      .send({ status: 'online', userId: bia.id })
      .expect(400);
  });

  it('parada vira ausente e volta ao escolhido quando mexe de novo', async () => {
    app.wsHub.connect(tenantA.id, ana.id);
    await app.agent
      .patch('/api/v1/users/me/presence')
      .set(app.auth(ana))
      .send({ status: 'busy' })
      .expect(200);

    const idle = await app.agent
      .patch('/api/v1/users/me/presence')
      .set(app.auth(ana))
      .send({ idle: true })
      .expect(200);
    expect(statusOf(idle.body as UserPresenceResponse, ana.id)).toBe('away');
    // O escolhido nao muda com a inatividade.
    expect((idle.body as UserPresenceResponse).myStatus).toBe('busy');

    const back = await app.agent
      .patch('/api/v1/users/me/presence')
      .set(app.auth(ana))
      .send({ idle: false })
      .expect(200);
    expect(statusOf(back.body as UserPresenceResponse, ana.id)).toBe('busy');
  });

  it('platform_operator nao tem caminho', async () => {
    const plataforma = await createTenant({ name: 'Plataforma' });
    const operator = await createUser({ tenantId: plataforma.id, role: 'platform_operator' });
    await app.agent.get('/api/v1/users/presence').set(app.auth(operator)).expect(403);
  });
});

describe('effectiveUserPresence (D-286 item 5)', () => {
  it('sem conexao e offline, qualquer que seja a escolha', () => {
    expect(effectiveUserPresence({ connected: false, chosen: 'busy', idle: false })).toBe('offline');
  });
  it('escolheu ausente fica ausente mesmo ativa', () => {
    expect(effectiveUserPresence({ connected: true, chosen: 'away', idle: false })).toBe('away');
  });
  it('parada vira ausente; ativa mostra o escolhido', () => {
    expect(effectiveUserPresence({ connected: true, chosen: 'online', idle: true })).toBe('away');
    expect(effectiveUserPresence({ connected: true, chosen: 'busy', idle: false })).toBe('busy');
  });
});
