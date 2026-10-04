/**
 * Registro da visita — API_CONTRACTS.md §14 "Registro da visita" (CRMLAB-88, D-258).
 *
 * Foco: check-in/out com a hora do servidor e idempotentes, check-out marca
 * `realizada`, check-out sem check-in -> 409, reagendar depois do check-in ->
 * 409, relato + proximo passo so em `agendada`/`realizada`, anexos de
 * imagem/PDF (sniff, teto, limite por visita, download com os cabecalhos de
 * midia, exclusao por qualquer usuario), isolamento multitenant e audit log.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ApiErrorBody, ListVisitsResponse, VisitAttachment, VisitDetail } from '@crm-lab/shared';
import { MAX_MEDIA_BYTES, VISIT_ATTACHMENTS_MAX } from '@crm-lab/shared';
import { visitModule } from '../../src/controllers/visit.routes.js';
import type { DbClient } from '../../src/db/types.js';
import { readMediaFile } from '../../src/lib/media-storage.js';
import { createTenant, createUser, type TenantRecord, type UserRecord } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

const BASE = '/api/v1/visits';
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000001';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const PDF = Buffer.from('%PDF-1.4\n%folder do painel de check-up');
/** HTML disfarçado de PNG: o vetor de XSS do CRMLAB-31. */
const HTML = Buffer.from('<html><script>alert(1)</script></html>');

let db: DbClient;
let app: TestApp;
let tenantA: TenantRecord;
let tenantB: TenantRecord;
let managerA: UserRecord;
let attendantA: UserRecord;
let attendantB: UserRecord;
let doctorA: string;
let doctorB: string;

beforeAll(async () => {
  db = await getTestDb();
});

async function insertDoctor(tenantId: string, name: string): Promise<string> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ id: string }>('INSERT INTO doctors (tenant_id, name) VALUES ($1, $2) RETURNING id', [tenantId, name]),
  );
  return result.rows[0]?.id as string;
}

beforeEach(async () => {
  await resetDatabase(db);
  app = await createTestApp({ db, modules: [visitModule] });
  tenantA = await createTenant({ name: 'Lab A', slug: 'lab-a', db });
  tenantB = await createTenant({ name: 'Lab B', slug: 'lab-b', db });
  managerA = await createUser({ tenantId: tenantA.id, role: 'manager', name: 'Gestora Ana', db });
  attendantA = await createUser({ tenantId: tenantA.id, role: 'attendant', name: 'Atendente Bia', db });
  attendantB = await createUser({ tenantId: tenantB.id, role: 'attendant', db });
  doctorA = await insertDoctor(tenantA.id, 'Dra. Júlia Costa');
  doctorB = await insertDoctor(tenantB.id, 'Dr. Confidencial Beta');
});

async function createVisit(user: UserRecord, doctorId = doctorA): Promise<VisitDetail> {
  const response = await app.agent
    .post(BASE)
    .set(app.auth(user))
    .send({
      doctorId,
      responsibleId: user.id,
      scheduledAt: '2026-10-06T13:00:00.000Z',
      type: 'presencial',
    });
  expect(response.status).toBe(201);
  return response.body as VisitDetail;
}

function checkIn(user: UserRecord, id: string) {
  return app.agent.post(`${BASE}/${id}/check-in`).set(app.auth(user)).send({});
}

function checkOut(user: UserRecord, id: string) {
  return app.agent.post(`${BASE}/${id}/check-out`).set(app.auth(user)).send({});
}

function attach(user: UserRecord, id: string, file: { fileName: string; mimeType: string; content: Buffer }) {
  return app.agent
    .post(`${BASE}/${id}/attachments`)
    .set(app.auth(user))
    .send({ fileName: file.fileName, mimeType: file.mimeType, contentBase64: file.content.toString('base64') });
}

/** Corpo cru (o supertest so bufferiza `image/*` sozinho). */
function download(user: UserRecord, id: string, attachmentId: string) {
  return app.agent
    .get(`${BASE}/${id}/attachments/${attachmentId}`)
    .set(app.auth(user))
    .buffer(true)
    .parse((res, callback) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => callback(null, Buffer.concat(chunks)));
    });
}

async function auditOf(entityId: string) {
  const result = await db.withoutTenant((tx) =>
    tx.query<{
      action: string;
      user_id: string;
      old_values: Record<string, unknown> | null;
      new_values: Record<string, unknown> | null;
    }>(
      `SELECT action, user_id, old_values, new_values FROM audit_logs
       WHERE entity_type = 'visit' AND entity_id = $1 ORDER BY timestamp, action`,
      [entityId],
    ),
  );
  return result.rows;
}

/** O `download` usa parser binario: o JSON de erro chega como `Buffer`. */
function errorOf(response: { body: unknown }) {
  const body: unknown = Buffer.isBuffer(response.body) ? JSON.parse(response.body.toString('utf8')) : response.body;
  return (body as ApiErrorBody).error;
}

describe('check-in e check-out', () => {
  it('check-in grava a hora do servidor e quem tocou; a visita continua agendada', async () => {
    const visit = await createVisit(attendantA);
    expect(visit).toMatchObject({ checkInAt: null, checkOutAt: null, nextVisitDate: null, attachmentCount: 0 });

    const before = Date.now();
    const response = await checkIn(attendantA, visit.id);
    expect(response.status).toBe(200);
    const body = response.body as VisitDetail;
    expect(body.status).toBe('agendada');
    expect(body.checkInBy).toEqual({ id: attendantA.id, name: 'Atendente Bia' });
    expect(new Date(body.checkInAt ?? '').getTime()).toBeGreaterThanOrEqual(before - 5_000);
    expect(body.checkOutAt).toBeNull();
  });

  it('check-out marca realizada, com quem e quando, e a duração sai dos dois horários', async () => {
    const visit = await createVisit(attendantA);
    await checkIn(attendantA, visit.id).expect(200);
    // Simula 45 min de visita sem esperar: recua o check-in no banco.
    await db.withoutTenant((tx) =>
      tx.query(`UPDATE doctor_visits SET check_in_at = now() - interval '45 minutes' WHERE id = $1`, [visit.id]),
    );

    const response = await checkOut(managerA, visit.id);
    expect(response.status).toBe(200);
    const body = response.body as VisitDetail;
    expect(body.status).toBe('realizada');
    expect(body.checkOutBy).toEqual({ id: managerA.id, name: 'Gestora Ana' });
    expect(body.statusChangedBy?.id).toBe(managerA.id);
    expect(body.statusChangedAt).toBe(body.checkOutAt);
    expect(body.statusReason).toBeNull();
    const minutes = (new Date(body.checkOutAt ?? '').getTime() - new Date(body.checkInAt ?? '').getTime()) / 60_000;
    expect(Math.round(minutes)).toBe(45);

    const audit = await auditOf(visit.id);
    expect(audit.map((a) => a.action)).toEqual(['create_visit', 'check_in_visit', 'check_out_visit']);
    expect(audit[2]).toMatchObject({
      user_id: managerA.id,
      old_values: { status: 'agendada' },
      new_values: { status: 'realizada', durationMinutes: 45 },
    });
  });

  it('repetir check-in e check-out é idempotente: mantém a hora original e não gera audit', async () => {
    const visit = await createVisit(attendantA);
    const first = (await checkIn(attendantA, visit.id).expect(200)).body as VisitDetail;
    const again = (await checkIn(managerA, visit.id).expect(200)).body as VisitDetail;
    expect(again.checkInAt).toBe(first.checkInAt);
    expect(again.checkInBy?.id).toBe(attendantA.id);

    const out = (await checkOut(attendantA, visit.id).expect(200)).body as VisitDetail;
    const outAgain = (await checkOut(managerA, visit.id).expect(200)).body as VisitDetail;
    expect(outAgain.checkOutAt).toBe(out.checkOutAt);
    expect(outAgain.checkOutBy?.id).toBe(attendantA.id);
    // Check-in de visita já realizada também devolve 200 sem mudar.
    const late = (await checkIn(managerA, visit.id).expect(200)).body as VisitDetail;
    expect(late.checkInAt).toBe(first.checkInAt);

    const actions = (await auditOf(visit.id)).map((a) => a.action);
    expect(actions.filter((a) => a === 'check_in_visit')).toHaveLength(1);
    expect(actions.filter((a) => a === 'check_out_visit')).toHaveLength(1);
  });

  it('check-out sem check-in -> 409 VISIT_NOT_CHECKED_IN', async () => {
    const visit = await createVisit(attendantA);
    const response = await checkOut(attendantA, visit.id);
    expect(response.status).toBe(409);
    expect(errorOf(response)).toMatchObject({ code: 'VISIT_NOT_CHECKED_IN', details: { status: 'agendada' } });
  });

  it('check-in e check-out em visita cancelada ou "não recebeu" -> 409 VISIT_ALREADY_CLOSED', async () => {
    const cancelada = await createVisit(attendantA);
    await app.agent.post(`${BASE}/${cancelada.id}/cancel`).set(app.auth(attendantA)).send({ reason: 'Férias' }).expect(200);
    const naoRecebeu = await createVisit(attendantA);
    await app.agent
      .post(`${BASE}/${naoRecebeu.id}/not-received`)
      .set(app.auth(attendantA))
      .send({ reason: 'Agenda cheia' })
      .expect(200);

    for (const visit of [cancelada, naoRecebeu]) {
      for (const response of [await checkIn(attendantA, visit.id), await checkOut(attendantA, visit.id)]) {
        expect(response.status).toBe(409);
        expect(errorOf(response).code).toBe('VISIT_ALREADY_CLOSED');
      }
    }
  });

  it('depois do check-in não reagenda (409), mas ainda pode ser marcada "médico não recebeu"', async () => {
    const visit = await createVisit(attendantA);
    const checked = (await checkIn(attendantA, visit.id).expect(200)).body as VisitDetail;

    const reschedule = await app.agent
      .post(`${BASE}/${visit.id}/reschedule`)
      .set(app.auth(attendantA))
      .send({ scheduledAt: '2026-10-07T13:00:00.000Z' });
    expect(reschedule.status).toBe(409);
    expect(errorOf(reschedule)).toMatchObject({
      code: 'VISIT_ALREADY_CHECKED_IN',
      details: { checkInAt: checked.checkInAt },
    });

    const notReceived = await app.agent
      .post(`${BASE}/${visit.id}/not-received`)
      .set(app.auth(attendantA))
      .send({ reason: 'Cheguei e o médico estava em cirurgia' });
    expect(notReceived.status).toBe(200);
    expect(notReceived.body).toMatchObject({ status: 'nao_recebeu', checkInAt: checked.checkInAt });
  });

  it('check-in e check-out aparecem na listagem da agenda', async () => {
    const visit = await createVisit(attendantA);
    await checkIn(attendantA, visit.id).expect(200);
    await checkOut(attendantA, visit.id).expect(200);
    const response = await app.agent
      .get(BASE)
      .set(app.auth(attendantA))
      .query({ from: '2026-10-05T03:00:00.000Z', to: '2026-10-12T03:00:00.000Z' });
    const listed = (response.body as ListVisitsResponse).visits[0];
    expect(listed).toMatchObject({ id: visit.id, status: 'realizada', attachmentCount: 0 });
    expect(listed?.checkInAt).not.toBeNull();
    expect(listed?.checkOutAt).not.toBeNull();
  });

  it('corpo com campo desconhecido -> 400', async () => {
    const visit = await createVisit(attendantA);
    const response = await app.agent
      .post(`${BASE}/${visit.id}/check-in`)
      .set(app.auth(attendantA))
      .send({ checkInAt: '2026-10-06T13:00:00.000Z' });
    expect(response.status).toBe(400);
  });
});

describe('relato e próximo passo', () => {
  it('grava os três campos e a data de retorno; o audit leva só o que mudou', async () => {
    const visit = await createVisit(attendantA);
    const response = await app.agent
      .patch(`${BASE}/${visit.id}/report`)
      .set(app.auth(attendantA))
      .send({
        presented: '  Painel de check-up  ',
        doctorFeedback: 'Gostou do prazo',
        objections: '',
        nextVisitDate: '2026-11-03',
      });
    expect(response.status).toBe(200);
    const body = response.body as VisitDetail;
    expect(body.report).toEqual({ presented: 'Painel de check-up', doctorFeedback: 'Gostou do prazo', objections: null });
    expect(body.nextVisitDate).toBe('2026-11-03');

    // Só o feedback muda: o resto fica, e o audit leva só o diff.
    const second = await app.agent
      .patch(`${BASE}/${visit.id}/report`)
      .set(app.auth(managerA))
      .send({ doctorFeedback: 'Quer tabela de preços', nextVisitDate: '2026-11-03' });
    expect(second.status).toBe(200);
    expect((second.body as VisitDetail).report.presented).toBe('Painel de check-up');

    const audit = (await auditOf(visit.id)).filter((a) => a.action === 'update_visit_report');
    expect(audit).toHaveLength(2);
    expect(audit[1]).toMatchObject({
      user_id: managerA.id,
      old_values: { doctorFeedback: 'Gostou do prazo' },
      new_values: { doctorFeedback: 'Quer tabela de preços' },
    });
    expect(audit[1]?.new_values).not.toHaveProperty('nextVisitDate');
  });

  it('sem mudança real -> 200 sem audit', async () => {
    const visit = await createVisit(attendantA);
    await app.agent.patch(`${BASE}/${visit.id}/report`).set(app.auth(attendantA)).send({ presented: null }).expect(200);
    expect((await auditOf(visit.id)).map((a) => a.action)).toEqual(['create_visit']);
  });

  it('vale em visita realizada e é bloqueado em cancelada (409)', async () => {
    const realizada = await createVisit(attendantA);
    await checkIn(attendantA, realizada.id).expect(200);
    await checkOut(attendantA, realizada.id).expect(200);
    await app.agent
      .patch(`${BASE}/${realizada.id}/report`)
      .set(app.auth(attendantA))
      .send({ presented: 'Relato depois do Saí' })
      .expect(200);

    const cancelada = await createVisit(attendantA);
    await app.agent.post(`${BASE}/${cancelada.id}/cancel`).set(app.auth(attendantA)).send({ reason: 'x' }).expect(200);
    const response = await app.agent
      .patch(`${BASE}/${cancelada.id}/report`)
      .set(app.auth(attendantA))
      .send({ presented: 'Tarde demais' });
    expect(response.status).toBe(409);
    expect(errorOf(response).code).toBe('VISIT_ALREADY_CLOSED');
  });

  it('data de retorno inválida ou campo desconhecido -> 400', async () => {
    const visit = await createVisit(attendantA);
    for (const body of [{ nextVisitDate: '2026-02-30' }, { nextVisitDate: '03/11/2026' }, { status: 'realizada' }]) {
      const response = await app.agent.patch(`${BASE}/${visit.id}/report`).set(app.auth(attendantA)).send(body);
      expect(response.status).toBe(400);
      expect(errorOf(response).code).toBe('VALIDATION_ERROR');
    }
  });
});

describe('anexos', () => {
  it('anexa PNG e PDF, lista no detalhe e baixa com os cabeçalhos de mídia', async () => {
    const visit = await createVisit(attendantA);
    const png = await attach(attendantA, visit.id, { fileName: 'foto consultório.png', mimeType: 'image/png', content: PNG });
    expect(png.status).toBe(201);
    const pngBody = png.body as VisitAttachment;
    expect(pngBody).toMatchObject({
      fileName: 'foto consultório.png',
      mimeType: 'image/png',
      byteSize: PNG.byteLength,
      uploadedBy: { id: attendantA.id, name: 'Atendente Bia' },
    });
    expect(await readMediaFile(pngBody.id)).toEqual(PNG);

    const pdf = await attach(managerA, visit.id, { fileName: 'folder.pdf', mimeType: 'application/pdf', content: PDF });
    expect(pdf.status).toBe(201);
    const pdfBody = pdf.body as VisitAttachment;

    const detail = (await app.agent.get(`${BASE}/${visit.id}`).set(app.auth(attendantA)).expect(200)).body as VisitDetail;
    expect(detail.attachmentCount).toBe(2);
    expect(detail.attachments.map((a) => a.fileName)).toEqual(['foto consultório.png', 'folder.pdf']);

    const image = await download(managerA, visit.id, pngBody.id);
    expect(image.status).toBe(200);
    expect(image.headers['content-type']).toBe('image/png');
    expect(image.headers['x-content-type-options']).toBe('nosniff');
    expect(image.headers['content-disposition']).toBe(
      `inline; filename="${encodeURIComponent('foto consultório.png')}"`,
    );
    expect(image.body).toEqual(PNG);

    const doc = await download(attendantA, visit.id, pdfBody.id);
    expect(doc.status).toBe(200);
    expect(doc.headers['content-type']).toBe('application/pdf');
    expect(doc.headers['content-disposition']).toBe('attachment; filename="folder.pdf"');
    expect(doc.body).toEqual(PDF);

    const audit = (await auditOf(visit.id)).filter((a) => a.action === 'add_visit_attachment');
    expect(audit[0]?.new_values).toMatchObject({
      attachmentId: pngBody.id,
      fileName: 'foto consultório.png',
      mimeType: 'image/png',
      byteSize: PNG.byteLength,
    });
  });

  it('só imagem e PDF: áudio, Word e HTML disfarçado de PNG -> 400', async () => {
    const visit = await createVisit(attendantA);
    const cases = [
      { fileName: 'audio.ogg', mimeType: 'audio/ogg', content: Buffer.from('OggS') },
      { fileName: 'proposta.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', content: PDF },
      { fileName: 'pagina.html', mimeType: 'text/html', content: HTML },
      { fileName: 'falso.png', mimeType: 'image/png', content: PDF },
    ];
    for (const file of cases) {
      const response = await attach(attendantA, visit.id, file);
      expect(response.status).toBe(400);
      expect(errorOf(response).code).toBe('VALIDATION_ERROR');
    }
    const detail = (await app.agent.get(`${BASE}/${visit.id}`).set(app.auth(attendantA))).body as VisitDetail;
    expect(detail.attachments).toEqual([]);
  });

  it('acima de 15 MiB -> 413 MEDIA_TOO_LARGE', async () => {
    const visit = await createVisit(attendantA);
    const big = Buffer.concat([PDF, Buffer.alloc(MAX_MEDIA_BYTES)]);
    const response = await attach(attendantA, visit.id, { fileName: 'grande.pdf', mimeType: 'application/pdf', content: big });
    expect(response.status).toBe(413);
    expect(errorOf(response).code).toBe('MEDIA_TOO_LARGE');
  });

  it(`no máximo ${VISIT_ATTACHMENTS_MAX} anexos por visita`, async () => {
    const visit = await createVisit(attendantA);
    // Enche direto no banco: 20 uploads pela API só deixariam o teste lento.
    await db.withoutTenant((tx) =>
      tx.query(
        `INSERT INTO doctor_visit_attachments (tenant_id, visit_id, mime_type, file_name, byte_size)
         SELECT $1, $2, 'application/pdf', 'x' || n || '.pdf', 10 FROM generate_series(1, $3::int) AS n`,
        [tenantA.id, visit.id, VISIT_ATTACHMENTS_MAX],
      ),
    );
    const response = await attach(attendantA, visit.id, { fileName: 'mais.pdf', mimeType: 'application/pdf', content: PDF });
    expect(response.status).toBe(400);
    expect(errorOf(response)).toMatchObject({ code: 'VALIDATION_ERROR', details: { fields: { attachments: expect.any(String) } } });
  });

  it('qualquer usuário exclui: some a linha e o arquivo, com audit', async () => {
    const visit = await createVisit(attendantA);
    const created = (await attach(attendantA, visit.id, { fileName: 'folder.pdf', mimeType: 'application/pdf', content: PDF }))
      .body as VisitAttachment;

    await app.agent.delete(`${BASE}/${visit.id}/attachments/${created.id}`).set(app.auth(managerA)).expect(204);
    expect(await readMediaFile(created.id)).toBeNull();
    const detail = (await app.agent.get(`${BASE}/${visit.id}`).set(app.auth(attendantA))).body as VisitDetail;
    expect(detail.attachments).toEqual([]);
    await download(attendantA, visit.id, created.id).expect(404);
    await app.agent.delete(`${BASE}/${visit.id}/attachments/${created.id}`).set(app.auth(managerA)).expect(404);

    const audit = (await auditOf(visit.id)).filter((a) => a.action === 'delete_visit_attachment');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      user_id: managerA.id,
      old_values: { attachmentId: created.id, fileName: 'folder.pdf', mimeType: 'application/pdf' },
    });
  });

  it('visita cancelada: anexar e excluir -> 409, baixar continua', async () => {
    const visit = await createVisit(attendantA);
    const created = (await attach(attendantA, visit.id, { fileName: 'folder.pdf', mimeType: 'application/pdf', content: PDF }))
      .body as VisitAttachment;
    await app.agent.post(`${BASE}/${visit.id}/cancel`).set(app.auth(attendantA)).send({ reason: 'x' }).expect(200);

    const add = await attach(attendantA, visit.id, { fileName: 'outro.pdf', mimeType: 'application/pdf', content: PDF });
    expect(add.status).toBe(409);
    expect(errorOf(add).code).toBe('VISIT_ALREADY_CLOSED');
    const del = await app.agent.delete(`${BASE}/${visit.id}/attachments/${created.id}`).set(app.auth(attendantA));
    expect(del.status).toBe(409);
    await download(attendantA, visit.id, created.id).expect(200);
  });

  it('anexo de outra visita -> 404', async () => {
    const visit = await createVisit(attendantA);
    const other = await createVisit(attendantA);
    const created = (await attach(attendantA, visit.id, { fileName: 'folder.pdf', mimeType: 'application/pdf', content: PDF }))
      .body as VisitAttachment;
    await download(attendantA, other.id, created.id).expect(404);
    await app.agent.delete(`${BASE}/${other.id}/attachments/${created.id}`).set(app.auth(attendantA)).expect(404);
  });
});

describe('isolamento multitenant', () => {
  it('visita e anexo de outro tenant -> 404 NOT_FOUND em todas as rotas novas', async () => {
    const visitB = await createVisit(attendantB, doctorB);
    const attachmentB = (await attach(attendantB, visitB.id, { fileName: 'b.pdf', mimeType: 'application/pdf', content: PDF }))
      .body as VisitAttachment;

    const h = app.auth(attendantA);
    const responses = [
      await checkIn(attendantA, visitB.id),
      await checkOut(attendantA, visitB.id),
      await app.agent.patch(`${BASE}/${visitB.id}/report`).set(h).send({ presented: 'x' }),
      await attach(attendantA, visitB.id, { fileName: 'a.pdf', mimeType: 'application/pdf', content: PDF }),
      await download(attendantA, visitB.id, attachmentB.id),
      await app.agent.delete(`${BASE}/${visitB.id}/attachments/${attachmentB.id}`).set(h),
      await checkIn(attendantA, UNKNOWN_ID),
    ];
    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(errorOf(response).code).toBe('NOT_FOUND');
    }
    // Nada mudou no tenant B.
    const detailB = (await app.agent.get(`${BASE}/${visitB.id}`).set(app.auth(attendantB))).body as VisitDetail;
    expect(detailB).toMatchObject({ checkInAt: null, report: { presented: null }, attachmentCount: 1 });
  });

  it('platform_operator recebe 403 nas rotas novas', async () => {
    const plataforma = await createTenant({ name: 'Plataforma', slug: 'plataforma', db });
    const operator = await createUser({ tenantId: plataforma.id, role: 'platform_operator', db });
    const h = app.auth(operator);
    const responses = [
      await app.agent.post(`${BASE}/${UNKNOWN_ID}/check-in`).set(h).send({}),
      await app.agent.post(`${BASE}/${UNKNOWN_ID}/check-out`).set(h).send({}),
      await app.agent.patch(`${BASE}/${UNKNOWN_ID}/report`).set(h).send({}),
      await app.agent.post(`${BASE}/${UNKNOWN_ID}/attachments`).set(h).send({ fileName: 'a', mimeType: 'application/pdf', contentBase64: 'eA==' }),
      await app.agent.get(`${BASE}/${UNKNOWN_ID}/attachments/${UNKNOWN_ID}`).set(h),
      await app.agent.delete(`${BASE}/${UNKNOWN_ID}/attachments/${UNKNOWN_ID}`).set(h),
    ];
    for (const response of responses) expect(response.status).toBe(403);
  });
});
