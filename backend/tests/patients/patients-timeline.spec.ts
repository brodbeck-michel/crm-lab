/**
 * `GET /api/v1/patients/:id/timeline` — API_CONTRACTS.md §2c, D-060.
 *
 * O que estes testes provam:
 *   - as QUATRO especies de entrada aparecem, com o shape discriminado por
 *     `kind` e o `id` no formato `<kind>:<uuid da origem>`;
 *   - a ordenacao e `at DESC` por padrao, `asc` inverte, e a paginacao anda
 *     sobre o conjunto ORDENADO (pagina 2 continua de onde a 1 parou);
 *   - o recorte por papel vale DENTRO da ficha: a mensagem da conversa do
 *     colega nao vaza para o atendente;
 *   - `preview` truncado em 160 caracteres;
 *   - isolamento entre laboratorios.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { patientModule } from '../../src/controllers/patient.routes.js';
import type { DbClient } from '../../src/db/types.js';
import {
  createConversation,
  createExam,
  createProposal,
  createTenant,
  createUser,
  type ExamRecord,
  type TenantRecord,
  type UserRecord,
} from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import {
  createMessage,
  createPatient,
  createStatusHistory,
  linkConversation,
  setProposalCreatedAt,
  type PatientRecord,
} from './helpers.js';

const BASE = '/api/v1/patients';

interface TimelineEntry {
  id: string;
  kind: string;
  at: string;
  [key: string]: unknown;
}

let db: DbClient;
let app: TestApp;
let tenantA: TenantRecord;
let tenantB: TenantRecord;
let managerA: UserRecord;
let ana: UserRecord;
let bia: UserRecord;
let exam: ExamRecord;
let patient: PatientRecord;

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  app = await createTestApp({ db, modules: [patientModule] });
  tenantA = await createTenant({ name: 'Lab A', slug: 'lab-a', db });
  tenantB = await createTenant({ name: 'Lab B', slug: 'lab-b', db });
  managerA = await createUser({ tenantId: tenantA.id, role: 'manager', name: 'Gestora', db });
  ana = await createUser({ tenantId: tenantA.id, role: 'attendant', name: 'Ana', db });
  bia = await createUser({ tenantId: tenantA.id, role: 'attendant', name: 'Bia', db });
  exam = await createExam({ tenantId: tenantA.id, db });
  patient = await createPatient({ tenantId: tenantA.id, name: 'Joao Santos', db });
});

/** Cenario canonico: 1 conversa da Ana, 1 mensagem, 1 proposta e 2 transicoes. */
async function cenarioCompleto(): Promise<{ conversationId: string; proposalId: string }> {
  const conversa = await createConversation({
    tenantId: tenantA.id,
    assignedTo: ana.id,
    patientName: 'Joao Santos',
    channel: 'whatsapp',
    db,
  });
  await linkConversation(conversa.id, patient.id, { lastMessageAt: '2026-08-23T14:25:00', db });
  await db.withoutTenant((tx) =>
    tx.query(`UPDATE conversations SET created_at = $2::timestamp WHERE id = $1`, [
      conversa.id,
      '2026-08-20T10:00:00',
    ]),
  );

  await createMessage({
    tenantId: tenantA.id,
    conversationId: conversa.id,
    senderType: 'patient',
    content: 'Ola, quanto custa um hemograma?',
    createdAt: '2026-08-23T14:25:00',
    db,
  });

  const proposta = await createProposal({
    tenantId: tenantA.id,
    conversationId: conversa.id,
    createdBy: ana.id,
    status: 'orcamento_enviado',
    discountPercent: 10,
    items: [{ examId: exam.id, examName: exam.name, unitPrice: 89.9, quantity: 2 }],
    db,
  });
  await setProposalCreatedAt(proposta.id, '2026-08-23T14:40:00', db);

  await createStatusHistory({
    tenantId: tenantA.id,
    proposalId: proposta.id,
    status: 'novo_contato',
    changedBy: ana.id,
    changedAt: '2026-08-23T14:40:00',
    db,
  });
  await createStatusHistory({
    tenantId: tenantA.id,
    proposalId: proposta.id,
    status: 'orcamento_enviado',
    changedBy: ana.id,
    changedAt: '2026-08-23T15:00:00',
    db,
  });

  return { conversationId: conversa.id, proposalId: proposta.id };
}

describe('as quatro especies de entrada', () => {
  it('monta a linha do tempo completa, ordenada por at DESC', async () => {
    const { conversationId, proposalId } = await cenarioCompleto();

    const res = await app.agent
      .get(`${BASE}/${patient.id}/timeline`)
      .set(app.auth(managerA))
      .expect(200);

    const entries = res.body.entries as TimelineEntry[];
    // `proposal_created` e a primeira transicao compartilham o instante
    // 14:40 — o desempate por `id DESC` do contrato poe
    // `proposal_stage_changed:` antes de `proposal_created:`, e e essa ordem
    // estavel que impede a paginacao de repetir/pular linha.
    expect(entries.map((e) => e.kind)).toEqual([
      'proposal_stage_changed',
      'proposal_stage_changed',
      'proposal_created',
      'message',
      'conversation_started',
    ]);
    expect(res.body.pagination).toMatchObject({ page: 1, limit: 50, total: 5, totalPages: 1 });

    // `proposal_stage_changed` mais recente: from = status anterior do historico.
    expect(entries[0]).toMatchObject({
      kind: 'proposal_stage_changed',
      at: '2026-08-23T15:00:00.000Z',
      proposalId,
      from: 'novo_contato',
      to: 'orcamento_enviado',
      changedByName: 'Ana',
    });

    expect(entries[1]).toMatchObject({
      kind: 'proposal_stage_changed',
      at: '2026-08-23T14:40:00.000Z',
      from: null,
      to: 'novo_contato',
    });

    expect(entries[2]).toMatchObject({
      kind: 'proposal_created',
      at: '2026-08-23T14:40:00.000Z',
      proposalId,
      status: 'orcamento_enviado',
      discountPercent: 10,
      totalPrice: 161.82,
      createdByName: 'Ana',
    });
    expect(entries[2]?.id).toBe(`proposal_created:${proposalId}`);

    expect(entries[3]).toMatchObject({
      kind: 'message',
      at: '2026-08-23T14:25:00.000Z',
      conversationId,
      senderType: 'patient',
      senderName: 'Joao Santos',
      messageType: 'text',
      preview: 'Ola, quanto custa um hemograma?',
    });

    expect(entries[4]).toMatchObject({
      kind: 'conversation_started',
      at: '2026-08-20T10:00:00.000Z',
      conversationId,
      channel: 'whatsapp',
    });
    expect(entries[4]?.id).toBe(`conversation_started:${conversationId}`);
  });

  it('a primeira transicao do historico tem from = null', async () => {
    await cenarioCompleto();
    const res = await app.agent
      .get(`${BASE}/${patient.id}/timeline?kind=proposal_stage_changed&order=asc`)
      .set(app.auth(managerA))
      .expect(200);

    const entries = res.body.entries as TimelineEntry[];
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ from: null, to: 'novo_contato' });
    expect(entries[1]).toMatchObject({ from: 'novo_contato', to: 'orcamento_enviado' });
  });
});

describe('ordenacao, filtro e paginacao', () => {
  it('order=asc inverte e o total conta o recorte inteiro', async () => {
    await cenarioCompleto();
    const res = await app.agent
      .get(`${BASE}/${patient.id}/timeline?order=asc`)
      .set(app.auth(managerA))
      .expect(200);

    const entries = res.body.entries as TimelineEntry[];
    expect(entries[0]?.kind).toBe('conversation_started');
    expect(entries[entries.length - 1]?.kind).toBe('proposal_stage_changed');
    expect(res.body.pagination.total).toBe(5);
  });

  it('kind filtra as especies exibidas', async () => {
    await cenarioCompleto();
    const res = await app.agent
      .get(`${BASE}/${patient.id}/timeline?kind=message`)
      .set(app.auth(managerA))
      .expect(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.pagination.total).toBe(1);

    await app.agent
      .get(`${BASE}/${patient.id}/timeline?kind=inventado`)
      .set(app.auth(managerA))
      .expect(400);
  });

  /** A pagina 2 tem que continuar de onde a 1 parou — sem repetir nem pular. */
  it('pagina sobre o conjunto ordenado, sem repetir entradas', async () => {
    const conversa = await createConversation({ tenantId: tenantA.id, assignedTo: ana.id, db });
    await linkConversation(conversa.id, patient.id, { db });
    for (let i = 0; i < 7; i += 1) {
      await createMessage({
        tenantId: tenantA.id,
        conversationId: conversa.id,
        content: `mensagem ${i}`,
        createdAt: `2026-08-2${i} 10:00:00`,
        db,
      });
    }
    const headers = app.auth(managerA);

    const p1 = await app.agent
      .get(`${BASE}/${patient.id}/timeline?kind=message&limit=3&page=1`)
      .set(headers)
      .expect(200);
    const p2 = await app.agent
      .get(`${BASE}/${patient.id}/timeline?kind=message&limit=3&page=2`)
      .set(headers)
      .expect(200);
    const p3 = await app.agent
      .get(`${BASE}/${patient.id}/timeline?kind=message&limit=3&page=3`)
      .set(headers)
      .expect(200);

    expect(p1.body.pagination).toMatchObject({ total: 7, totalPages: 3 });
    const ids = [...p1.body.entries, ...p2.body.entries, ...p3.body.entries].map(
      (e: TimelineEntry) => e.id,
    );
    expect(ids).toHaveLength(7);
    expect(new Set(ids).size).toBe(7);
    expect(p1.body.entries[0].preview).toBe('mensagem 6');
    expect(p3.body.entries[0].preview).toBe('mensagem 0');
  });

  it('preview e truncado em 160 caracteres pelo backend', async () => {
    const conversa = await createConversation({ tenantId: tenantA.id, assignedTo: ana.id, db });
    await linkConversation(conversa.id, patient.id, { db });
    const longo = 'x'.repeat(400);
    await createMessage({
      tenantId: tenantA.id,
      conversationId: conversa.id,
      content: longo,
      db,
    });

    const res = await app.agent
      .get(`${BASE}/${patient.id}/timeline?kind=message`)
      .set(app.auth(managerA))
      .expect(200);
    expect(res.body.entries[0].preview).toHaveLength(160);
    expect(res.body.entries[0].preview).toBe('x'.repeat(160));
  });
});

describe('recorte por papel dentro da ficha (D-060)', () => {
  it('atendente nao ve mensagem da conversa do colega nem proposta alheia', async () => {
    const minha = await createConversation({ tenantId: tenantA.id, assignedTo: ana.id, db });
    const doColega = await createConversation({ tenantId: tenantA.id, assignedTo: bia.id, db });
    await linkConversation(minha.id, patient.id, { db });
    await linkConversation(doColega.id, patient.id, { db });

    await createMessage({
      tenantId: tenantA.id,
      conversationId: minha.id,
      content: 'visivel para a Ana',
      db,
    });
    await createMessage({
      tenantId: tenantA.id,
      conversationId: doColega.id,
      content: 'segredo da Bia',
      db,
    });
    await createProposal({
      tenantId: tenantA.id,
      conversationId: doColega.id,
      createdBy: bia.id,
      items: [{ examId: exam.id, examName: exam.name, unitPrice: 10 }],
      db,
    });

    const daAna = await app.agent
      .get(`${BASE}/${patient.id}/timeline`)
      .set(app.auth(ana))
      .expect(200);
    const texto = JSON.stringify(daAna.body);
    expect(texto).toContain('visivel para a Ana');
    expect(texto).not.toContain('segredo da Bia');
    expect(
      (daAna.body.entries as TimelineEntry[]).some((e) => e.kind === 'proposal_created'),
    ).toBe(false);
    // 1 conversa + 1 mensagem — a fila do colega nao entra no `total`.
    expect(daAna.body.pagination.total).toBe(2);

    const doGestor = await app.agent
      .get(`${BASE}/${patient.id}/timeline`)
      .set(app.auth(managerA))
      .expect(200);
    expect(JSON.stringify(doGestor.body)).toContain('segredo da Bia');
    // 2 conversas + 2 mensagens + 1 proposta.
    expect(doGestor.body.pagination.total).toBe(5);
  });
});

describe('isolamento multitenant', () => {
  it('timeline de paciente do tenant B responde 404', async () => {
    const alheio = await createPatient({ tenantId: tenantB.id, db });
    const res = await app.agent
      .get(`${BASE}/${alheio.id}/timeline`)
      .set(app.auth(managerA))
      .expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
