/**
 * Linha do tempo do medico — API_CONTRACTS.md §13 (CRMLAB-89, D-261).
 *
 * Foco: a linha do tempo junta visitas e registros manuais do mais novo para
 * o mais antigo, pagina por cursor sem repetir nem pular item, mostra o
 * trecho do relato; registro manual com validacao (tipo, data nao futura,
 * descricao), edicao parcial, exclusao, isolamento (medico de outro tenant ou
 * registro de outro medico -> 404) e audit log de criar/editar/excluir.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  ApiErrorBody,
  DoctorInteraction,
  DoctorTimelineResponse,
  DoctorTimelineVisit,
} from '@crm-lab/shared';
import { DOCTOR_TIMELINE_EXCERPT_MAX_LENGTH } from '@crm-lab/shared';
import { doctorModule } from '../../src/controllers/doctor.routes.js';
import type { DbClient } from '../../src/db/types.js';
import { decodeTimelineCursor, encodeTimelineCursor, reportExcerpt } from '../../src/services/doctor-interaction.service.js';
import { createTenant, createUser, type TenantRecord, type UserRecord } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000001';

let db: DbClient;
let app: TestApp;
let tenantA: TenantRecord;
let tenantB: TenantRecord;
let attendantA: UserRecord;
let managerA: UserRecord;
let attendantB: UserRecord;
let doctorA: string;
let otherDoctorA: string;
let doctorB: string;

beforeAll(async () => {
  db = await getTestDb();
});

async function insertDoctor(tenantId: string, name: string, isActive = true): Promise<string> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ id: string }>(
      'INSERT INTO doctors (tenant_id, name, is_active) VALUES ($1, $2, $3) RETURNING id',
      [tenantId, name, isActive],
    ),
  );
  return result.rows[0]?.id as string;
}

interface VisitSeed {
  scheduledAt: string;
  checkInAt?: string;
  checkOutAt?: string;
  status?: string;
  statusReason?: string;
  presented?: string;
  feedback?: string;
}

async function insertVisit(doctorId: string, seed: VisitSeed): Promise<string> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ id: string }>(
      `INSERT INTO doctor_visits (tenant_id, doctor_id, responsible_user_id, scheduled_at, type,
                                  status, status_reason, check_in_at, check_out_at,
                                  report_presented, report_feedback)
       VALUES ($1, $2, $3, $4, 'presencial', $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        tenantA.id,
        doctorId,
        attendantA.id,
        seed.scheduledAt,
        seed.status ?? 'agendada',
        seed.statusReason ?? null,
        seed.checkInAt ?? null,
        seed.checkOutAt ?? null,
        seed.presented ?? null,
        seed.feedback ?? null,
      ],
    ),
  );
  return result.rows[0]?.id as string;
}

beforeEach(async () => {
  await resetDatabase(db);
  app = await createTestApp({ db, modules: [doctorModule] });
  tenantA = await createTenant({ name: 'Lab A', slug: 'lab-a', db });
  tenantB = await createTenant({ name: 'Lab B', slug: 'lab-b', db });
  attendantA = await createUser({ tenantId: tenantA.id, role: 'attendant', name: 'Atendente Bia', db });
  managerA = await createUser({ tenantId: tenantA.id, role: 'manager', name: 'Gestora Ana', db });
  attendantB = await createUser({ tenantId: tenantB.id, role: 'attendant', db });
  doctorA = await insertDoctor(tenantA.id, 'Dra. Helena');
  otherDoctorA = await insertDoctor(tenantA.id, 'Dr. Paulo');
  doctorB = await insertDoctor(tenantB.id, 'Dr. Segredo B');
});

const timelinePath = (doctorId: string, query = '') => `/api/v1/doctors/${doctorId}/timeline${query}`;
const interactionsPath = (doctorId: string) => `/api/v1/doctors/${doctorId}/interactions`;
const interactionPath = (doctorId: string, id: string) => `/api/v1/doctors/${doctorId}/interactions/${id}`;

async function timeline(user: UserRecord, doctorId: string, query = ''): Promise<DoctorTimelineResponse> {
  const response = await app.agent.get(timelinePath(doctorId, query)).set(app.auth(user));
  expect(response.status).toBe(200);
  return response.body as DoctorTimelineResponse;
}

async function createInteraction(
  user: UserRecord,
  doctorId: string,
  body: Record<string, unknown>,
): Promise<DoctorInteraction> {
  const response = await app.agent.post(interactionsPath(doctorId)).set(app.auth(user)).send(body);
  expect(response.status).toBe(201);
  return response.body as DoctorInteraction;
}

async function auditOf(entityId: string) {
  const result = await db.withoutTenant((tx) =>
    tx.query<{
      action: string;
      tenant_id: string;
      user_id: string;
      old_values: Record<string, unknown> | null;
      new_values: Record<string, unknown> | null;
    }>(
      `SELECT action, tenant_id, user_id, old_values, new_values FROM audit_logs
       WHERE entity_type = 'doctor_interaction' AND entity_id = $1 ORDER BY timestamp, action`,
      [entityId],
    ),
  );
  return result.rows;
}

function errorOf(response: { body: unknown }) {
  return (response.body as ApiErrorBody).error;
}

describe('guardas de acesso', () => {
  it('sem token: 401 em todas as rotas', async () => {
    await app.agent.get(timelinePath(doctorA)).expect(401);
    await app.agent.post(interactionsPath(doctorA)).send({}).expect(401);
    await app.agent.patch(interactionPath(doctorA, UNKNOWN_ID)).send({}).expect(401);
    await app.agent.delete(interactionPath(doctorA, UNKNOWN_ID)).expect(401);
  });

  it('medico de outro laboratorio ou inexistente: 404 NOT_FOUND (nunca 403)', async () => {
    for (const id of [doctorB, UNKNOWN_ID]) {
      const lista = await app.agent.get(timelinePath(id)).set(app.auth(attendantA));
      expect(lista.status).toBe(404);
      expect(errorOf(lista).code).toBe('NOT_FOUND');

      const lanca = await app.agent
        .post(interactionsPath(id))
        .set(app.auth(attendantA))
        .send({ type: 'ligacao', occurredAt: '2026-10-01T12:00:00.000Z', description: 'Sonda' });
      expect(lanca.status).toBe(404);
    }
  });
});

describe('linha do tempo', () => {
  it('medico sem nada: lista vazia e sem cursor', async () => {
    expect(await timeline(attendantA, doctorA)).toEqual({ items: [], nextCursor: null });
  });

  it('junta visitas e registros manuais do mais novo para o mais antigo', async () => {
    const realizada = await insertVisit(doctorA, {
      scheduledAt: '2026-09-10T13:00:00Z',
      checkInAt: '2026-09-10T13:20:00Z',
      checkOutAt: '2026-09-10T13:55:00Z',
      status: 'realizada',
      presented: 'Painel de tireoide',
    });
    const futura = await insertVisit(doctorA, { scheduledAt: '2026-10-20T14:00:00Z' });
    const cancelada = await insertVisit(doctorA, {
      scheduledAt: '2026-09-05T13:00:00Z',
      status: 'cancelada',
      statusReason: 'Médico de férias',
    });
    // Visita de OUTRO medico nao aparece.
    await insertVisit(otherDoctorA, { scheduledAt: '2026-09-15T13:00:00Z' });

    const ligacao = await createInteraction(attendantA, doctorA, {
      type: 'ligacao',
      occurredAt: '2026-09-12T18:00:00.000Z',
      description: '  Confirmou interesse no convênio  ',
    });

    const body = await timeline(managerA, doctorA);
    expect(body.items.map((item) => [item.kind, item.id])).toEqual([
      ['visit', futura],
      ['interaction', ligacao.id],
      ['visit', realizada],
      ['visit', cancelada],
    ]);
    expect(body.nextCursor).toBeNull();

    const visita = body.items[2] as DoctorTimelineVisit;
    expect(visita).toMatchObject({
      kind: 'visit',
      status: 'realizada',
      type: 'presencial',
      // Posicao = check-in, nao a data prevista.
      occurredAt: '2026-09-10T13:20:00.000Z',
      scheduledAt: '2026-09-10T13:00:00.000Z',
      checkInAt: '2026-09-10T13:20:00.000Z',
      checkOutAt: '2026-09-10T13:55:00.000Z',
      responsible: { id: attendantA.id, name: 'Atendente Bia' },
      reportExcerpt: 'Painel de tireoide',
      attachmentCount: 0,
    });
    expect(body.items[3]).toMatchObject({ statusReason: 'Médico de férias', reportExcerpt: null });
    expect(body.items[1]).toMatchObject({
      kind: 'interaction',
      type: 'ligacao',
      description: 'Confirmou interesse no convênio',
      createdBy: { id: attendantA.id, name: 'Atendente Bia' },
      updatedBy: null,
    });
  });

  it('pagina por cursor sem repetir nem pular — inclusive com horarios iguais', async () => {
    const ids: string[] = [];
    // 5 registros no MESMO instante + 3 visitas: o desempate e o id.
    for (let i = 0; i < 5; i += 1) {
      const created = await createInteraction(attendantA, doctorA, {
        type: 'email',
        occurredAt: '2026-09-20T12:00:00.000Z',
        description: `E-mail ${i}`,
      });
      ids.push(created.id);
    }
    for (const day of ['01', '02', '03']) {
      ids.push(await insertVisit(doctorA, { scheduledAt: `2026-09-${day}T12:00:00.123456Z` }));
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = cursor ? `?limit=3&cursor=${cursor}` : '?limit=3';
      const page = await timeline(attendantA, doctorA, query);
      expect(page.items.length).toBeLessThanOrEqual(3);
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);

    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(8);
    expect([...seen].sort()).toEqual([...ids].sort());
  });

  it('trecho do relato: primeiro campo preenchido, cortado com reticencias', async () => {
    const longo = 'x'.repeat(DOCTOR_TIMELINE_EXCERPT_MAX_LENGTH + 50);
    await insertVisit(doctorA, {
      scheduledAt: '2026-09-10T13:00:00Z',
      presented: '   ',
      feedback: longo,
    });
    const [visita] = (await timeline(attendantA, doctorA)).items as DoctorTimelineVisit[];
    expect(visita?.reportExcerpt).toHaveLength(DOCTOR_TIMELINE_EXCERPT_MAX_LENGTH);
    expect(visita?.reportExcerpt?.endsWith('…')).toBe(true);

    expect(reportExcerpt({ presented: null, feedback: null, objections: ' Preço ' })).toBe('Preço');
    expect(reportExcerpt({ presented: null, feedback: '', objections: null })).toBeNull();
  });

  it('cursor mexido: 400 VALIDATION_ERROR, nunca 500', async () => {
    for (const cursor of ['lixo', encodeURIComponent(Buffer.from('2026-01-01|nao-e-uuid').toString('base64url'))]) {
      const response = await app.agent.get(timelinePath(doctorA, `?cursor=${cursor}`)).set(app.auth(attendantA));
      expect(response.status).toBe(400);
      expect(errorOf(response).code).toBe('VALIDATION_ERROR');
    }
  });

  it('cursor ida e volta', () => {
    const cursor = { sortAt: '2026-09-20T12:00:00.000Z', id: '0b7e7a6c-3f0a-4c55-9a43-3b6f1f3f8a10' };
    expect(decodeTimelineCursor(encodeTimelineCursor(cursor))).toEqual(cursor);
  });

  it('limit acima do teto: 400', async () => {
    const response = await app.agent.get(timelinePath(doctorA, '?limit=500')).set(app.auth(attendantA));
    expect(response.status).toBe(400);
  });
});

describe('registro manual', () => {
  it('qualquer papel lanca; medico inativo tambem recebe registro', async () => {
    const inativo = await insertDoctor(tenantA.id, 'Dr. Inativo', false);
    const created = await createInteraction(managerA, inativo, {
      type: 'whatsapp',
      occurredAt: '2026-10-01T12:00:00-03:00',
      description: 'Mandou a tabela de exames',
    });
    expect(created).toMatchObject({
      doctorId: inativo,
      type: 'whatsapp',
      // Volta em UTC.
      occurredAt: '2026-10-01T15:00:00.000Z',
      createdBy: { id: managerA.id, name: 'Gestora Ana' },
    });
  });

  it('valida tipo, data e descricao', async () => {
    const casos: Array<[Record<string, unknown>, string]> = [
      [{ type: 'visita', occurredAt: '2026-10-01T12:00:00Z', description: 'x' }, 'type'],
      [{ type: 'ligacao', occurredAt: 'ontem', description: 'x' }, 'occurredAt'],
      [{ type: 'ligacao', occurredAt: '2026-10-01T12:00:00Z', description: '   ' }, 'description'],
      [{ type: 'ligacao', occurredAt: '2026-10-01T12:00:00Z' }, 'description'],
      [{ type: 'ligacao', occurredAt: '2026-10-01T12:00:00Z', description: 'x', extra: 1 }, ''],
    ];
    for (const [body, field] of casos) {
      const response = await app.agent.post(interactionsPath(doctorA)).set(app.auth(attendantA)).send(body);
      expect({ body, status: response.status }).toMatchObject({ status: 400 });
      expect(errorOf(response).code).toBe('VALIDATION_ERROR');
      if (field) expect(JSON.stringify(errorOf(response).details)).toContain(field);
    }
  });

  it('data no futuro: recusa alem da folga de 5 min', async () => {
    const daquiUmaHora = new Date(Date.now() + 60 * 60_000).toISOString();
    const response = await app.agent
      .post(interactionsPath(doctorA))
      .set(app.auth(attendantA))
      .send({ type: 'ligacao', occurredAt: daquiUmaHora, description: 'Futuro' });
    expect(response.status).toBe(400);
    expect(errorOf(response).details).toMatchObject({ fields: { occurredAt: 'A data não pode ser no futuro' } });

    const daquiUmMinuto = new Date(Date.now() + 60_000).toISOString();
    await createInteraction(attendantA, doctorA, { type: 'ligacao', occurredAt: daquiUmMinuto, description: 'Agora' });
  });

  it('edita parcial, grava quem editou e audita so o diff', async () => {
    const created = await createInteraction(attendantA, doctorA, {
      type: 'ligacao',
      occurredAt: '2026-10-01T12:00:00.000Z',
      description: 'Primeira versão',
    });

    const response = await app.agent
      .patch(interactionPath(doctorA, created.id))
      .set(app.auth(managerA))
      .send({ description: 'Versão corrigida', type: 'ligacao' });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      type: 'ligacao',
      description: 'Versão corrigida',
      occurredAt: '2026-10-01T12:00:00.000Z',
      createdBy: { id: attendantA.id },
      updatedBy: { id: managerA.id, name: 'Gestora Ana' },
    });

    // Sem mudanca de fato: 200 sem segundo audit.
    await app.agent
      .patch(interactionPath(doctorA, created.id))
      .set(app.auth(managerA))
      .send({ description: '  Versão corrigida ' })
      .expect(200);

    const audit = await auditOf(created.id);
    expect(audit.map((a) => a.action)).toEqual(['create_doctor_interaction', 'update_doctor_interaction']);
    expect(audit[0]).toMatchObject({ tenant_id: tenantA.id, user_id: attendantA.id });
    expect(audit[1]).toMatchObject({
      user_id: managerA.id,
      old_values: { description: 'Primeira versão' },
      new_values: { description: 'Versão corrigida' },
    });
  });

  it('exclui de verdade e audita o que foi apagado', async () => {
    const created = await createInteraction(attendantA, doctorA, {
      type: 'email',
      occurredAt: '2026-10-01T12:00:00.000Z',
      description: 'Enviou o folder',
    });

    await app.agent.delete(interactionPath(doctorA, created.id)).set(app.auth(managerA)).expect(204);
    expect((await timeline(attendantA, doctorA)).items).toEqual([]);

    // Segunda exclusao: ja nao existe.
    const again = await app.agent.delete(interactionPath(doctorA, created.id)).set(app.auth(managerA));
    expect(again.status).toBe(404);

    const audit = await auditOf(created.id);
    expect(audit.map((a) => a.action)).toEqual(['create_doctor_interaction', 'delete_doctor_interaction']);
    expect(audit[1]).toMatchObject({
      user_id: managerA.id,
      old_values: { type: 'email', description: 'Enviou o folder', doctorId: doctorA },
    });
  });

  it('registro de OUTRO medico pelo caminho deste: 404 no PATCH e no DELETE', async () => {
    const created = await createInteraction(attendantA, otherDoctorA, {
      type: 'ligacao',
      occurredAt: '2026-10-01T12:00:00.000Z',
      description: 'Do Dr. Paulo',
    });
    const patch = await app.agent
      .patch(interactionPath(doctorA, created.id))
      .set(app.auth(attendantA))
      .send({ description: 'Hackeado' });
    expect(patch.status).toBe(404);
    const del = await app.agent.delete(interactionPath(doctorA, created.id)).set(app.auth(attendantA));
    expect(del.status).toBe(404);
  });

  it('registro de outro laboratorio: invisivel e intocavel (404)', async () => {
    const created = await createInteraction(attendantB, doctorB, {
      type: 'ligacao',
      occurredAt: '2026-10-01T12:00:00.000Z',
      description: 'Segredo do lab B',
    });
    const patch = await app.agent
      .patch(interactionPath(doctorB, created.id))
      .set(app.auth(attendantA))
      .send({ description: 'x' });
    expect(patch.status).toBe(404);
    expect(errorOf(patch).code).toBe('NOT_FOUND');
    const del = await app.agent.delete(interactionPath(doctorB, created.id)).set(app.auth(attendantA));
    expect(del.status).toBe(404);

    // Continua la para o dono.
    expect((await timeline(attendantB, doctorB)).items).toHaveLength(1);
  });
});
