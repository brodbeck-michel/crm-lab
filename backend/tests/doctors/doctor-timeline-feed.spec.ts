/**
 * Feed do médico — API_CONTRACTS.md §13 (CRMLAB-192, D-332).
 *
 * Foco: a visita no feed traz o relato inteiro, a data de retorno e os anexos;
 * filtro por tipo (no SQL, com cursor); comentários em visita e em registro
 * manual com escopo por perfil (atendente 403, representante só na carteira →
 * 404 fora dela, gestor/admin tudo), isolamento de tenant, item de outro
 * médico → 404, só o autor edita, autor ou admin exclui, teto por item e audit
 * log de criar/editar/excluir. Editar o relato pela ficha usa o
 * `PATCH /visits/:id/report` de sempre — conferido aqui com o escopo.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  ApiErrorBody,
  DoctorTimelineComment,
  DoctorTimelineInteraction,
  DoctorTimelineResponse,
  DoctorTimelineVisit,
} from '@crm-lab/shared';
import { DOCTOR_TIMELINE_COMMENTS_PER_ITEM_MAX } from '@crm-lab/shared';
import { doctorModule } from '../../src/controllers/doctor.routes.js';
import { visitModule } from '../../src/controllers/visit.routes.js';
import type { DbClient } from '../../src/db/types.js';
import { timelineFilter } from '../../src/services/doctor-interaction.service.js';
import { createTenant, createUser, type TenantRecord, type UserRecord } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000001';

let db: DbClient;
let app: TestApp;
let tenantA: TenantRecord;
let tenantB: TenantRecord;
let repA: UserRecord;
let otherRepA: UserRecord;
let managerA: UserRecord;
let adminA: UserRecord;
let attendantA: UserRecord;
let repB: UserRecord;
let doctorA: string;
let otherDoctorA: string;
let doctorB: string;
let visitA: string;
let interactionA: string;
let visitOtherDoctor: string;
let visitB: string;

beforeAll(async () => {
  db = await getTestDb();
});

async function insertDoctor(tenantId: string, name: string, responsibleId: string): Promise<string> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ id: string }>(
      'INSERT INTO doctors (tenant_id, name, responsible_user_id) VALUES ($1, $2, $3) RETURNING id',
      [tenantId, name, responsibleId],
    ),
  );
  return result.rows[0]?.id as string;
}

async function insertVisit(
  tenantId: string,
  doctorId: string,
  responsibleId: string,
  seed: { scheduledAt: string; status?: string; checkInAt?: string; checkOutAt?: string } = {
    scheduledAt: '2026-10-06T13:00:00Z',
  },
): Promise<string> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ id: string }>(
      `INSERT INTO doctor_visits (tenant_id, doctor_id, responsible_user_id, scheduled_at, type, status,
                                  check_in_at, check_out_at, purpose_id)
       VALUES ($1, $2, $3, $4, 'presencial', $5, $6, $7,
               (SELECT id FROM visit_purposes WHERE tenant_id = $1 AND name = 'Visita')) RETURNING id`,
      [
        tenantId,
        doctorId,
        responsibleId,
        seed.scheduledAt,
        seed.status ?? 'agendada',
        seed.checkInAt ?? null,
        seed.checkOutAt ?? null,
      ],
    ),
  );
  return result.rows[0]?.id as string;
}

async function insertInteraction(
  tenantId: string,
  doctorId: string,
  type: string,
  occurredAt: string,
  createdBy: string,
): Promise<string> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ id: string }>(
      `INSERT INTO doctor_interactions (tenant_id, doctor_id, type, occurred_at, description, created_by)
       VALUES ($1, $2, $3, $4, 'Registro', $5) RETURNING id`,
      [tenantId, doctorId, type, occurredAt, createdBy],
    ),
  );
  return result.rows[0]?.id as string;
}

beforeEach(async () => {
  await resetDatabase(db);
  app = await createTestApp({ db, modules: [doctorModule, visitModule] });
  tenantA = await createTenant({ name: 'Lab A', slug: 'lab-a', db });
  tenantB = await createTenant({ name: 'Lab B', slug: 'lab-b', db });
  repA = await createUser({ tenantId: tenantA.id, role: 'representative', name: 'Rep Bia', db });
  otherRepA = await createUser({ tenantId: tenantA.id, role: 'representative', name: 'Rep Caio', db });
  managerA = await createUser({ tenantId: tenantA.id, role: 'manager', name: 'Gestora Ana', db });
  adminA = await createUser({ tenantId: tenantA.id, role: 'admin', name: 'Admin Davi', db });
  attendantA = await createUser({ tenantId: tenantA.id, role: 'attendant', db });
  repB = await createUser({ tenantId: tenantB.id, role: 'representative', db });
  doctorA = await insertDoctor(tenantA.id, 'Dra. Helena', repA.id);
  otherDoctorA = await insertDoctor(tenantA.id, 'Dr. Paulo', otherRepA.id);
  doctorB = await insertDoctor(tenantB.id, 'Dr. Segredo B', repB.id);
  visitA = await insertVisit(tenantA.id, doctorA, repA.id, {
    scheduledAt: '2026-10-06T13:00:00Z',
    status: 'realizada',
    checkInAt: '2026-10-06T13:20:00Z',
    checkOutAt: '2026-10-06T13:55:00Z',
  });
  interactionA = await insertInteraction(tenantA.id, doctorA, 'ligacao', '2026-10-03T12:00:00Z', repA.id);
  visitOtherDoctor = await insertVisit(tenantA.id, otherDoctorA, otherRepA.id);
  visitB = await insertVisit(tenantB.id, doctorB, repB.id);
});

const timelinePath = (doctorId: string, query = '') => `/api/v1/doctors/${doctorId}/timeline${query}`;
const commentsPath = (doctorId: string) => `/api/v1/doctors/${doctorId}/comments`;
const commentPath = (doctorId: string, id: string) => `/api/v1/doctors/${doctorId}/comments/${id}`;

async function timeline(user: UserRecord, doctorId: string, query = ''): Promise<DoctorTimelineResponse> {
  const response = await app.agent.get(timelinePath(doctorId, query)).set(app.auth(user));
  expect(response.status).toBe(200);
  return response.body as DoctorTimelineResponse;
}

async function comment(
  user: UserRecord,
  body: { itemKind: 'visit' | 'interaction'; itemId: string; body: string },
  doctorId = doctorA,
): Promise<DoctorTimelineComment> {
  const response = await app.agent.post(commentsPath(doctorId)).set(app.auth(user)).send(body);
  expect(response.status).toBe(201);
  return response.body as DoctorTimelineComment;
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
       WHERE entity_type = 'doctor_timeline_comment' AND entity_id = $1 ORDER BY timestamp, action`,
      [entityId],
    ),
  );
  return result.rows;
}

function errorOf(response: { body: unknown }) {
  return (response.body as ApiErrorBody).error;
}

describe('visita completa no feed', () => {
  it('traz o relato inteiro, a data de retorno e os anexos (mais antigo primeiro)', async () => {
    const long = 'Apresentei o painel completo. '.repeat(20);
    await db.withoutTenant(async (tx) => {
      await tx.query(
        `UPDATE doctor_visits SET report_presented = $2, report_feedback = 'Gostou', report_objections = 'Preço',
                next_visit_date = '2026-11-03' WHERE id = $1`,
        [visitA, long],
      );
      await tx.query(
        `INSERT INTO doctor_visit_attachments (tenant_id, visit_id, mime_type, file_name, byte_size, uploaded_by, created_at)
         VALUES ($1, $2, 'image/jpeg', 'folder.jpg', 1200, $3, '2026-10-06T14:00:00Z'),
                ($1, $2, 'application/pdf', 'tabela.pdf', 5400, $3, '2026-10-06T14:05:00Z')`,
        [tenantA.id, visitA, repA.id],
      );
    });

    const body = await timeline(repA, doctorA);
    const visit = body.items.find((item) => item.kind === 'visit') as DoctorTimelineVisit;
    expect(visit.report).toEqual({ presented: long, doctorFeedback: 'Gostou', objections: 'Preço' });
    expect(visit.nextVisitDate).toBe('2026-11-03');
    expect(visit.reportExcerpt?.endsWith('…')).toBe(true);
    expect(visit.attachments.map((a) => [a.fileName, a.mimeType, a.uploadedBy?.name])).toEqual([
      ['folder.jpg', 'image/jpeg', 'Rep Bia'],
      ['tabela.pdf', 'application/pdf', 'Rep Bia'],
    ]);
    expect(visit.attachmentCount).toBe(2);
    expect(visit.checkInAt).toBe('2026-10-06T13:20:00.000Z');
    expect(visit.checkOutAt).toBe('2026-10-06T13:55:00.000Z');
    expect(visit.comments).toEqual([]);
    const interaction = body.items.find((item) => item.kind === 'interaction') as DoctorTimelineInteraction;
    expect(interaction.comments).toEqual([]);
  });
});

describe('filtro por tipo', () => {
  beforeEach(async () => {
    await insertInteraction(tenantA.id, doctorA, 'whatsapp', '2026-10-04T12:00:00Z', repA.id);
    await insertInteraction(tenantA.id, doctorA, 'email', '2026-10-02T12:00:00Z', repA.id);
  });

  it('só visitas, só ligações, combinação e tudo', async () => {
    const kinds = async (query: string) =>
      (await timeline(managerA, doctorA, query)).items.map((item) => (item.kind === 'visit' ? 'visita' : item.type));

    expect(await kinds('?types=visita')).toEqual(['visita']);
    expect(await kinds('?types=ligacao')).toEqual(['ligacao']);
    expect(await kinds('?types=whatsapp,email')).toEqual(['whatsapp', 'email']);
    expect(await kinds('?types=visita,ligacao')).toEqual(['visita', 'ligacao']);
    expect(await kinds('')).toEqual(['visita', 'whatsapp', 'ligacao', 'email']);
    expect(await kinds('?types=')).toEqual(['visita', 'whatsapp', 'ligacao', 'email']);
  });

  it('pagina por cursor dentro do filtro sem repetir nem pular', async () => {
    const first = await timeline(managerA, doctorA, '?types=whatsapp,ligacao,email&limit=2');
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await timeline(
      managerA,
      doctorA,
      `?types=whatsapp,ligacao,email&limit=2&cursor=${first.nextCursor ?? ''}`,
    );
    expect([...first.items, ...second.items].map((item) => (item.kind === 'interaction' ? item.type : 'visita'))).toEqual([
      'whatsapp',
      'ligacao',
      'email',
    ]);
    expect(second.nextCursor).toBeNull();
  });

  it('tipo fora da lista: VALIDATION_ERROR', async () => {
    const response = await app.agent.get(timelinePath(doctorA, '?types=visita,sms')).set(app.auth(managerA));
    expect(response.status).toBe(400);
    expect(errorOf(response).code).toBe('VALIDATION_ERROR');
  });

  it('timelineFilter: ausente = tudo; lista = só o que veio', () => {
    expect(timelineFilter(undefined)).toEqual({ visits: true, interactionTypes: ['ligacao', 'email', 'whatsapp'] });
    expect(timelineFilter(['email'])).toEqual({ visits: false, interactionTypes: ['email'] });
  });
});

describe('comentários — escopo e isolamento', () => {
  it('atendente: 403 FORBIDDEN em comentar, editar e excluir', async () => {
    const created = await comment(managerA, { itemKind: 'visit', itemId: visitA, body: 'Oi' });
    const post = await app.agent
      .post(commentsPath(doctorA))
      .set(app.auth(attendantA))
      .send({ itemKind: 'visit', itemId: visitA, body: 'x' });
    expect(post.status).toBe(403);
    expect(errorOf(post).code).toBe('FORBIDDEN');
    const patch = await app.agent.patch(commentPath(doctorA, created.id)).set(app.auth(attendantA)).send({ body: 'y' });
    expect(patch.status).toBe(403);
    const del = await app.agent.delete(commentPath(doctorA, created.id)).set(app.auth(attendantA));
    expect(del.status).toBe(403);
  });

  it('representante comenta na carteira dele; médico de outra carteira → 404', async () => {
    await comment(repA, { itemKind: 'visit', itemId: visitA, body: 'Na minha carteira' });
    const alheio = await app.agent
      .post(commentsPath(otherDoctorA))
      .set(app.auth(repA))
      .send({ itemKind: 'visit', itemId: visitOtherDoctor, body: 'Intruso' });
    expect(alheio.status).toBe(404);
    expect(errorOf(alheio).code).toBe('NOT_FOUND');

    // Comentário da carteira alheia (feito pelo gestor) também é 404 para editar/excluir.
    const doGestor = await comment(managerA, { itemKind: 'visit', itemId: visitOtherDoctor, body: 'Gestor' }, otherDoctorA);
    const edit = await app.agent.patch(commentPath(otherDoctorA, doGestor.id)).set(app.auth(repA)).send({ body: 'x' });
    expect(edit.status).toBe(404);
    const del = await app.agent.delete(commentPath(otherDoctorA, doGestor.id)).set(app.auth(repA));
    expect(del.status).toBe(404);
  });

  it('gestor comenta em qualquer médico do laboratório', async () => {
    await comment(managerA, { itemKind: 'visit', itemId: visitOtherDoctor, body: 'Ok' }, otherDoctorA);
    await comment(managerA, { itemKind: 'interaction', itemId: interactionA, body: 'Ok' });
  });

  it('item de outro médico, inexistente ou de outro tenant → 404', async () => {
    for (const body of [
      { itemKind: 'visit', itemId: visitOtherDoctor, body: 'x' },
      { itemKind: 'visit', itemId: UNKNOWN_ID, body: 'x' },
      { itemKind: 'visit', itemId: visitB, body: 'x' },
      { itemKind: 'interaction', itemId: visitA, body: 'x' },
    ]) {
      const response = await app.agent.post(commentsPath(doctorA)).set(app.auth(managerA)).send(body);
      expect(response.status).toBe(404);
      expect(errorOf(response).code).toBe('NOT_FOUND');
    }
    // Médico de outro tenant no caminho.
    const outro = await app.agent
      .post(commentsPath(doctorB))
      .set(app.auth(managerA))
      .send({ itemKind: 'visit', itemId: visitB, body: 'x' });
    expect(outro.status).toBe(404);
  });

  it('comentário de outro tenant ou de outro médico no caminho → 404', async () => {
    const deB = await comment(repB, { itemKind: 'visit', itemId: visitB, body: 'Segredo B' }, doctorB);
    const patchB = await app.agent.patch(commentPath(doctorA, deB.id)).set(app.auth(managerA)).send({ body: 'x' });
    expect(patchB.status).toBe(404);
    const deA = await comment(managerA, { itemKind: 'visit', itemId: visitA, body: 'A' });
    const caminhoErrado = await app.agent
      .patch(commentPath(otherDoctorA, deA.id))
      .set(app.auth(managerA))
      .send({ body: 'x' });
    expect(caminhoErrado.status).toBe(404);
    expect(JSON.stringify((await timeline(managerA, doctorA)).items)).not.toContain('Segredo B');
  });
});

describe('comentários — criar, editar, excluir', () => {
  it('cria em visita e em registro; vem embutido no item, mais antigo primeiro', async () => {
    const primeiro = await comment(repA, { itemKind: 'visit', itemId: visitA, body: '  Manda o material  ' });
    expect(primeiro).toMatchObject({
      itemKind: 'visit',
      itemId: visitA,
      body: 'Manda o material',
      author: { id: repA.id, name: 'Rep Bia' },
      editedAt: null,
    });
    const segundo = await comment(managerA, { itemKind: 'visit', itemId: visitA, body: 'Combinado' });
    const noRegistro = await comment(managerA, { itemKind: 'interaction', itemId: interactionA, body: 'Ligou de novo?' });

    const body = await timeline(repA, doctorA);
    const visit = body.items.find((item) => item.kind === 'visit') as DoctorTimelineVisit;
    expect(visit.comments.map((c) => c.id)).toEqual([primeiro.id, segundo.id]);
    const interaction = body.items.find((item) => item.kind === 'interaction') as DoctorTimelineInteraction;
    expect(interaction.comments.map((c) => c.id)).toEqual([noRegistro.id]);

    const audit = await auditOf(primeiro.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'create_doctor_timeline_comment',
      tenant_id: tenantA.id,
      user_id: repA.id,
      new_values: { doctorId: doctorA, itemKind: 'visit', itemId: visitA, body: 'Manda o material' },
    });
  });

  it('aceita comentário em visita cancelada', async () => {
    const cancelada = await insertVisit(tenantA.id, doctorA, repA.id, {
      scheduledAt: '2026-09-01T13:00:00Z',
      status: 'cancelada',
    });
    await db.withoutTenant((tx) =>
      tx.query("UPDATE doctor_visits SET status_reason = 'Férias' WHERE id = $1", [cancelada]),
    );
    await comment(repA, { itemKind: 'visit', itemId: cancelada, body: 'Remarcar em outubro' });
  });

  it('texto vazio ou acima de 2000 e campo a mais → VALIDATION_ERROR', async () => {
    for (const body of [
      { itemKind: 'visit', itemId: visitA, body: '   ' },
      { itemKind: 'visit', itemId: visitA, body: 'x'.repeat(2001) },
      { itemKind: 'visit', itemId: visitA, body: 'ok', extra: true },
      { itemKind: 'outro', itemId: visitA, body: 'ok' },
    ]) {
      const response = await app.agent.post(commentsPath(doctorA)).set(app.auth(repA)).send(body);
      expect(response.status).toBe(400);
      expect(errorOf(response).code).toBe('VALIDATION_ERROR');
    }
  });

  it(`teto de ${DOCTOR_TIMELINE_COMMENTS_PER_ITEM_MAX} comentários por item`, async () => {
    await db.withoutTenant((tx) =>
      tx.query(
        `INSERT INTO doctor_timeline_comments (tenant_id, visit_id, author_id, body)
         SELECT $1, $2, $3, 'c' || g FROM generate_series(1, $4::int) g`,
        [tenantA.id, visitA, repA.id, DOCTOR_TIMELINE_COMMENTS_PER_ITEM_MAX],
      ),
    );
    const response = await app.agent
      .post(commentsPath(doctorA))
      .set(app.auth(repA))
      .send({ itemKind: 'visit', itemId: visitA, body: 'Mais um' });
    expect(response.status).toBe(400);
    expect(errorOf(response).details).toMatchObject({ fields: { body: expect.any(String) } });
  });

  it('só o autor edita: grava editedAt e audita o diff; texto igual não audita', async () => {
    const created = await comment(repA, { itemKind: 'visit', itemId: visitA, body: 'Original' });

    for (const user of [managerA, adminA]) {
      const response = await app.agent.patch(commentPath(doctorA, created.id)).set(app.auth(user)).send({ body: 'Hack' });
      expect(response.status).toBe(403);
      expect(errorOf(response).code).toBe('FORBIDDEN');
      expect(errorOf(response).details).toMatchObject({ reason: 'not_author' });
    }

    const igual = await app.agent.patch(commentPath(doctorA, created.id)).set(app.auth(repA)).send({ body: ' Original ' });
    expect(igual.status).toBe(200);
    expect((igual.body as DoctorTimelineComment).editedAt).toBeNull();

    const edited = await app.agent.patch(commentPath(doctorA, created.id)).set(app.auth(repA)).send({ body: 'Corrigido' });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ body: 'Corrigido', editedAt: expect.any(String) });

    const audit = await auditOf(created.id);
    expect(audit.map((row) => row.action)).toEqual(['create_doctor_timeline_comment', 'update_doctor_timeline_comment']);
    expect(audit[1]).toMatchObject({ old_values: { body: 'Original' }, new_values: { body: 'Corrigido' } });
  });

  it('exclui o autor ou o admin; o gestor não exclui de colega', async () => {
    const doRep = await comment(repA, { itemKind: 'visit', itemId: visitA, body: 'Do rep' });

    const gestor = await app.agent.delete(commentPath(doctorA, doRep.id)).set(app.auth(managerA));
    expect(gestor.status).toBe(403);
    expect(errorOf(gestor).details).toMatchObject({ reason: 'not_author' });

    const admin = await app.agent.delete(commentPath(doctorA, doRep.id)).set(app.auth(adminA));
    expect(admin.status).toBe(204);
    const repetido = await app.agent.delete(commentPath(doctorA, doRep.id)).set(app.auth(adminA));
    expect(repetido.status).toBe(404);

    const proprio = await comment(managerA, { itemKind: 'interaction', itemId: interactionA, body: 'Meu' });
    const autor = await app.agent.delete(commentPath(doctorA, proprio.id)).set(app.auth(managerA));
    expect(autor.status).toBe(204);

    const audit = await auditOf(doRep.id);
    expect(audit[audit.length - 1]).toMatchObject({
      action: 'delete_doctor_timeline_comment',
      user_id: adminA.id,
      old_values: { doctorId: doctorA, itemKind: 'visit', itemId: visitA, body: 'Do rep' },
    });
    const visit = (await timeline(managerA, doctorA)).items.find((item) => item.kind === 'visit') as DoctorTimelineVisit;
    expect(visit.comments).toEqual([]);
  });

  it('excluir o registro manual leva os comentários dele', async () => {
    await comment(managerA, { itemKind: 'interaction', itemId: interactionA, body: 'Some junto' });
    const response = await app.agent
      .delete(`/api/v1/doctors/${doctorA}/interactions/${interactionA}`)
      .set(app.auth(managerA));
    expect(response.status).toBe(204);
    const left = await db.withoutTenant((tx) =>
      tx.query('SELECT id FROM doctor_timeline_comments WHERE interaction_id = $1', [interactionA]),
    );
    expect(left.rows).toHaveLength(0);
  });
});

describe('editar o relato pela ficha (PATCH /visits/:id/report)', () => {
  it('representante da carteira edita e o feed devolve o relato novo', async () => {
    const response = await app.agent
      .patch(`/api/v1/visits/${visitA}/report`)
      .set(app.auth(repA))
      .send({ presented: 'Painel novo', objections: 'Prazo' });
    expect(response.status).toBe(200);
    const visit = (await timeline(repA, doctorA)).items.find((item) => item.kind === 'visit') as DoctorTimelineVisit;
    expect(visit.report).toEqual({ presented: 'Painel novo', doctorFeedback: null, objections: 'Prazo' });
  });

  it('representante de outra carteira → 404; atendente → 403', async () => {
    const alheio = await app.agent
      .patch(`/api/v1/visits/${visitA}/report`)
      .set(app.auth(otherRepA))
      .send({ presented: 'x' });
    expect(alheio.status).toBe(404);
    const atendente = await app.agent
      .patch(`/api/v1/visits/${visitA}/report`)
      .set(app.auth(attendantA))
      .send({ presented: 'x' });
    expect(atendente.status).toBe(403);
  });
});
