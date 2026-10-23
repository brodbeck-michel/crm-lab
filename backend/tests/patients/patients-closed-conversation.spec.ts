/**
 * D-273 (CRMLAB-108) — a atendente abre a ficha do paciente de uma conversa
 * ENCERRADA de outra atendente (a mesma que ela ja le no atendimento).
 *
 * Fica igual: listagem/busca de pacientes e edicao seguem o recorte do D-060;
 * paciente so com conversa ATIVA de outra continua 404; outro tenant, 404.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { patientModule } from '../../src/controllers/patient.routes.js';
import { createConversation, createTenant, createUser } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { resetDatabase } from '../helpers/test-db.js';
import { createPatient, linkConversation } from './helpers.js';

const BASE = '/api/v1/patients';

describe('D-273: ficha do paciente pela conversa encerrada de outra atendente', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp({ modules: [patientModule] });
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  async function scenario() {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const bia = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const viaEncerrada = await createPatient({ tenantId: tenant.id, name: 'Paciente Encerrada' });
    const encerrada = await createConversation({
      tenantId: tenant.id,
      assignedTo: bia.id,
      status: 'closed',
    });
    await linkConversation(encerrada.id, viaEncerrada.id);
    const soAtiva = await createPatient({ tenantId: tenant.id, name: 'Paciente Ativa' });
    const ativa = await createConversation({ tenantId: tenant.id, assignedTo: bia.id });
    await linkConversation(ativa.id, soAtiva.id);
    return { tenant, ana, bia, viaEncerrada, soAtiva };
  }

  it('abre detalhe e timeline (200); a conversa encerrada conta na ficha', async () => {
    const { ana, viaEncerrada } = await scenario();

    const detalhe = await app.agent
      .get(`${BASE}/${viaEncerrada.id}`)
      .set(app.auth(ana))
      .expect(200);
    expect(detalhe.body.id).toBe(viaEncerrada.id);
    expect(detalhe.body.conversationCount).toBe(1);

    const timeline = await app.agent
      .get(`${BASE}/${viaEncerrada.id}/timeline`)
      .set(app.auth(ana))
      .expect(200);
    expect(timeline.body.entries.length).toBeGreaterThan(0);
  });

  it('canEdit: false para quem so le pela encerrada alheia; true para a dona e a gestora', async () => {
    const { tenant, ana, bia, viaEncerrada } = await scenario();
    const gestora = await createUser({ tenantId: tenant.id, role: 'manager' });

    const leitura = await app.agent.get(`${BASE}/${viaEncerrada.id}`).set(app.auth(ana)).expect(200);
    expect(leitura.body.canEdit).toBe(false);
    const dona = await app.agent.get(`${BASE}/${viaEncerrada.id}`).set(app.auth(bia)).expect(200);
    expect(dona.body.canEdit).toBe(true);
    const gestor = await app.agent
      .get(`${BASE}/${viaEncerrada.id}`)
      .set(app.auth(gestora))
      .expect(200);
    expect(gestor.body.canEdit).toBe(true);
  });

  it('paciente sem conversa visivel para ela (so ativa de outra) continua 404', async () => {
    const { ana, soAtiva } = await scenario();
    await app.agent.get(`${BASE}/${soAtiva.id}`).set(app.auth(ana)).expect(404);
    await app.agent.get(`${BASE}/${soAtiva.id}/timeline`).set(app.auth(ana)).expect(404);
  });

  it('outro tenant continua 404', async () => {
    const { viaEncerrada } = await scenario();
    const outro = await createTenant();
    const deFora = await createUser({ tenantId: outro.id, role: 'admin' });
    await app.agent.get(`${BASE}/${viaEncerrada.id}`).set(app.auth(deFora)).expect(404);
  });

  it('listagem/busca nao passa a trazer o paciente, e editar segue 404', async () => {
    const { ana, viaEncerrada } = await scenario();

    const lista = await app.agent.get(BASE).set(app.auth(ana)).expect(200);
    expect(lista.body.patients.map((p: { id: string }) => p.id)).not.toContain(viaEncerrada.id);

    await app.agent
      .patch(`${BASE}/${viaEncerrada.id}`)
      .set(app.auth(ana))
      .send({ notes: 'tentativa' })
      .expect(404);
  });
});
