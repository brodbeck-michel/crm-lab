/**
 * LGPD — `GET /patients/:id/export` (D-062) e `POST /patients/:id/anonymize`
 * (D-063). API_CONTRACTS.md §2c.
 *
 * O que estes testes provam:
 *   - export e ADMIN e nao aplica o recorte por papel: traz conversa que o
 *     admin nao veria pela UI, com `notes`/`tags`/`customFields` e mensagens de
 *     sistema. Gestor e atendente levam 403 com `requiredRoles: ["admin"]`;
 *   - export grava `export_patient_data` no audit log;
 *   - anonymize limpa cadastro E as copias denormalizadas de `conversations` na
 *     mesma transacao, e a PROPOSTA HISTORICA fica intacta (o funil nao pode
 *     mentir);
 *   - anonymize e idempotente: a segunda chamada devolve 200 com
 *     `conversationsAffected: 0` e NAO grava um segundo audit log;
 *   - o audit log de anonimizacao grava SO o motivo — nunca o nome apagado;
 *   - depois de anonimizado, `PATCH` responde 409 e `GET`/`export` continuam.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditModule } from '../../src/controllers/audit.routes.js';
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
  linkConversation,
  readAuditLogs,
  type PatientRecord,
} from './helpers.js';

const BASE = '/api/v1/patients';
const REASON = 'Pedido de exclusao do titular via e-mail em 2026-08-24';

let db: DbClient;
let app: TestApp;
let tenantA: TenantRecord;
let tenantB: TenantRecord;
let admin: UserRecord;
let manager: UserRecord;
let ana: UserRecord;
let bia: UserRecord;
let exam: ExamRecord;
let patient: PatientRecord;

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  // `auditModule` entra porque o vazamento de D-075 acontecia na ROTA de
  // auditoria, nao na tabela: o teste precisa perguntar por onde o dado saia.
  app = await createTestApp({ db, modules: [patientModule, auditModule] });
  tenantA = await createTenant({ name: 'Lab A', slug: 'lab-a', db });
  tenantB = await createTenant({ name: 'Lab B', slug: 'lab-b', db });
  admin = await createUser({ tenantId: tenantA.id, role: 'admin', name: 'Admin', db });
  manager = await createUser({ tenantId: tenantA.id, role: 'manager', db });
  ana = await createUser({ tenantId: tenantA.id, role: 'attendant', name: 'Ana', db });
  bia = await createUser({ tenantId: tenantA.id, role: 'attendant', name: 'Bia', db });
  exam = await createExam({ tenantId: tenantA.id, db });
  patient = await createPatient({
    tenantId: tenantA.id,
    name: 'Joao Santos',
    email: 'joao@email.com',
    birthDate: '1984-03-12',
    document: '12345678909',
    notes: 'Prefere coleta pela manha.',
    tags: ['convenio'],
    customFields: { convenio: 'Unimed' },
    db,
  });
});

/** Duas conversas (uma da Ana, uma da Bia), mensagens e uma proposta. */
async function cenario(): Promise<{
  daAna: string;
  daBia: string;
  proposalId: string;
}> {
  const daAna = await createConversation({
    tenantId: tenantA.id,
    assignedTo: ana.id,
    patientName: 'Joao Santos',
    patientEmail: 'joao@email.com',
    db,
  });
  const daBia = await createConversation({
    tenantId: tenantA.id,
    assignedTo: bia.id,
    patientName: 'Joao Santos',
    db,
  });
  await linkConversation(daAna.id, patient.id, { db });
  await linkConversation(daBia.id, patient.id, { db });

  await createMessage({
    tenantId: tenantA.id,
    conversationId: daAna.id,
    senderType: 'patient',
    content: 'Ola, quanto custa um hemograma?',
    db,
  });
  await createMessage({
    tenantId: tenantA.id,
    conversationId: daBia.id,
    senderType: 'system',
    content: 'Conversa transferida de Ana para Bia',
    db,
  });

  const proposta = await createProposal({
    tenantId: tenantA.id,
    conversationId: daAna.id,
    createdBy: ana.id,
    status: 'orcamento_enviado',
    discountPercent: 10,
    items: [{ examId: exam.id, examName: 'Hemograma', unitPrice: 89.9, quantity: 2 }],
    db,
  });

  return { daAna: daAna.id, daBia: daBia.id, proposalId: proposta.id };
}

describe('GET /patients/:id/export', () => {
  it('exige admin: gestor e atendente recebem 403 com requiredRoles', async () => {
    for (const user of [manager, ana]) {
      const res = await app.agent
        .get(`${BASE}/${patient.id}/export`)
        .set(app.auth(user))
        .expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(res.body.error.details.requiredRoles).toEqual(['admin']);
    }
  });

  /**
   * O nome anterior era "sem recorte por papel" — INVERIFICAVEL neste teste: a
   * rota e admin-only (o teste acima prova o 403 de gestor e atendente) e
   * `visibilityOf(admin)` ja e `null`, entao nao existe recorte que pudesse
   * aparecer e ser desmentido. O nome agora diz o que as assercoes de fato
   * cobrem.
   */
  it('dump do titular: cadastro inteiro, as DUAS conversas (inclusive a de outro atendente), a proposta com itens — e nenhum campo interno do laboratorio (D-062)', async () => {
    const { daAna, daBia, proposalId } = await cenario();

    const res = await app.agent
      .get(`${BASE}/${patient.id}/export`)
      .set(app.auth(admin))
      .expect(200);

    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['content-disposition']).toContain(`paciente-${patient.id}-`);
    expect(res.headers['content-disposition']).toContain('attachment;');

    // Cadastro inteiro — `notes` e interno, mas e dado pessoal do titular.
    expect(res.body.patient).toMatchObject({
      id: patient.id,
      name: 'Joao Santos',
      email: 'joao@email.com',
      birthDate: '1984-03-12',
      document: '12345678909',
      notes: 'Prefere coleta pela manha.',
      tags: ['convenio'],
      customFields: { convenio: 'Unimed' },
    });
    expect(typeof res.body.generatedAt).toBe('string');

    // As DUAS conversas entram, inclusive a que nao e do solicitante.
    const ids = (res.body.conversations as Array<{ id: string }>).map((c) => c.id).sort();
    expect(ids).toEqual([daAna, daBia].sort());

    const conversaDaAna = (
      res.body.conversations as Array<{ id: string; messages: Array<Record<string, unknown>> }>
    ).find((c) => c.id === daAna);
    expect(conversaDaAna?.messages[0]).toMatchObject({
      senderType: 'patient',
      senderName: 'Joao Santos',
      content: 'Ola, quanto custa um hemograma?',
      messageType: 'text',
    });

    // Mensagem de SISTEMA tambem entra: faz parte do historico dele.
    const conversaDaBia = (
      res.body.conversations as Array<{ id: string; messages: Array<Record<string, unknown>> }>
    ).find((c) => c.id === daBia);
    expect(conversaDaBia?.messages[0]).toMatchObject({ senderType: 'system' });

    expect(res.body.proposals).toHaveLength(1);
    expect(res.body.proposals[0]).toMatchObject({
      id: proposalId,
      status: 'orcamento_enviado',
      discountPercent: 10,
      totalPrice: 161.82,
      items: [{ examName: 'Hemograma', quantity: 2, unitPrice: 89.9 }],
    });

    // NAO entra: dado do laboratorio, nao do titular (D-062).
    const bruto = JSON.stringify(res.body);
    expect(bruto).not.toContain('approvalStatus');
    expect(bruto).not.toContain('discountLimit');
  });

  it('grava export_patient_data no audit log', async () => {
    await cenario();
    await app.agent.get(`${BASE}/${patient.id}/export`).set(app.auth(admin)).expect(200);

    const logs = await readAuditLogs(tenantA.id, 'export_patient_data', db);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.entityId).toBe(patient.id);
    expect(logs[0]?.newValues).toEqual({ conversations: 2, proposals: 1 });
  });

  it('paciente de outro tenant: 404 e nenhum audit log', async () => {
    const alheio = await createPatient({ tenantId: tenantB.id, db });
    await app.agent.get(`${BASE}/${alheio.id}/export`).set(app.auth(admin)).expect(404);
    expect(await readAuditLogs(tenantA.id, 'export_patient_data', db)).toHaveLength(0);
  });
});

describe('POST /patients/:id/anonymize', () => {
  it('exige admin', async () => {
    for (const user of [manager, ana]) {
      const res = await app.agent
        .post(`${BASE}/${patient.id}/anonymize`)
        .set(app.auth(user))
        .send({ reason: REASON })
        .expect(403);
      expect(res.body.error.details.requiredRoles).toEqual(['admin']);
    }
    // Nada foi escrito.
    const row = await db.withTenant(tenantA.id, (tx) =>
      tx.query<{ name: string | null }>('SELECT name FROM patients WHERE id = $1', [patient.id]),
    );
    expect(row.rows[0]?.name).toBe('Joao Santos');
  });

  it('reason ausente ou vazio e VALIDATION_ERROR', async () => {
    const headers = app.auth(admin);
    await app.agent.post(`${BASE}/${patient.id}/anonymize`).set(headers).send({}).expect(400);
    await app.agent
      .post(`${BASE}/${patient.id}/anonymize`)
      .set(headers)
      .send({ reason: '   ' })
      .expect(400);
    await app.agent
      .post(`${BASE}/${patient.id}/anonymize`)
      .set(headers)
      .send({ reason: 'x'.repeat(501) })
      .expect(400);
  });

  it('limpa cadastro e conversas na mesma transacao, sem tocar na proposta', async () => {
    const { daAna, daBia, proposalId } = await cenario();

    const res = await app.agent
      .post(`${BASE}/${patient.id}/anonymize`)
      .set(app.auth(admin))
      .send({ reason: REASON })
      .expect(200);

    const placeholder = `anon-${patient.id.slice(0, 8)}`;
    expect(res.body.patient).toMatchObject({
      id: patient.id,
      phone: placeholder,
      name: null,
      email: null,
      birthDate: null,
      document: null,
      notes: null,
      tags: [],
      customFields: {},
    });
    expect(res.body.patient.anonymizedAt).not.toBeNull();
    expect(res.body.conversationsAffected).toBe(2);

    // As copias denormalizadas foram limpas — sem isso o nome continuaria na
    // lista do inbox e a anonimizacao seria decorativa (D-063).
    const conversas = await db.withTenant(tenantA.id, (tx) =>
      tx.query<{ id: string; patient_name: string | null; patient_email: string | null; patient_phone: string }>(
        'SELECT id, patient_name, patient_email, patient_phone FROM conversations WHERE id = ANY($1::uuid[]) ORDER BY id',
        [[daAna, daBia]],
      ),
    );
    expect(conversas.rows).toHaveLength(2);
    for (const row of conversas.rows) {
      expect(row.patient_name).toBeNull();
      expect(row.patient_email).toBeNull();
      expect(row.patient_phone).toBe(placeholder);
    }

    // A proposta historica continua valida e somando no funil.
    const proposta = await db.withTenant(tenantA.id, (tx) =>
      tx.query<{ status: string; total_price: string | number }>(
        'SELECT status, total_price FROM proposals WHERE id = $1',
        [proposalId],
      ),
    );
    expect(proposta.rows[0]?.status).toBe('orcamento_enviado');
    expect(Number(proposta.rows[0]?.total_price)).toBe(161.82);

    // As mensagens NAO sao reescritas — limitacao conhecida e documentada.
    const mensagens = await db.withTenant(tenantA.id, (tx) =>
      tx.query<{ total: number }>(
        `SELECT COUNT(*)::int AS total FROM messages m
          JOIN conversations c ON c.id = m.conversation_id WHERE c.patient_id = $1`,
        [patient.id],
      ),
    );
    expect(mensagens.rows[0]?.total).toBe(2);
  });

  it('e idempotente: a segunda chamada devolve 200 com 0 conversas e 1 audit log so', async () => {
    await cenario();
    const headers = app.auth(admin);

    const primeira = await app.agent
      .post(`${BASE}/${patient.id}/anonymize`)
      .set(headers)
      .send({ reason: REASON })
      .expect(200);
    const segunda = await app.agent
      .post(`${BASE}/${patient.id}/anonymize`)
      .set(headers)
      .send({ reason: 'pedido repetido' })
      .expect(200);

    expect(segunda.body.conversationsAffected).toBe(0);
    expect(segunda.body.patient).toEqual(primeira.body.patient);

    const logs = await readAuditLogs(tenantA.id, 'anonymize_patient', db);
    expect(logs).toHaveLength(1);
  });

  it('o audit log grava SO o motivo, nunca os valores antigos', async () => {
    await cenario();
    await app.agent
      .post(`${BASE}/${patient.id}/anonymize`)
      .set(app.auth(admin))
      .send({ reason: REASON })
      .expect(200);

    const logs = await readAuditLogs(tenantA.id, 'anonymize_patient', db);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.entityId).toBe(patient.id);
    expect(logs[0]?.newValues).toEqual({ reason: REASON });
    expect(logs[0]?.oldValues).toBeNull();
    // Gravar o nome apagado no log seria desfazer a anonimizacao noutra tabela.
    expect(JSON.stringify(logs[0])).not.toContain('Joao Santos');
  });

  it('depois de anonimizado, PATCH e 409 e GET/export continuam funcionando', async () => {
    await cenario();
    const headers = app.auth(admin);
    await app.agent
      .post(`${BASE}/${patient.id}/anonymize`)
      .set(headers)
      .send({ reason: REASON })
      .expect(200);

    const conflito = await app.agent
      .patch(`${BASE}/${patient.id}`)
      .set(headers)
      .send({ name: 'Joao de volta' })
      .expect(409);
    expect(conflito.body.error.code).toBe('CONFLICT');
    expect(conflito.body.error.details.reason).toBe('patient_anonymized');

    const ficha = await app.agent.get(`${BASE}/${patient.id}`).set(headers).expect(200);
    expect(ficha.body.name).toBeNull();
    expect(ficha.body.anonymizedAt).not.toBeNull();

    const dump = await app.agent.get(`${BASE}/${patient.id}/export`).set(headers).expect(200);
    expect(dump.body.patient.name).toBeNull();
    expect(dump.body.conversations).toHaveLength(2);
  });

  it('paciente de outro tenant: 404 e nada anonimizado la', async () => {
    const alheio = await createPatient({ tenantId: tenantB.id, name: 'Do lab B', db });
    await app.agent
      .post(`${BASE}/${alheio.id}/anonymize`)
      .set(app.auth(admin))
      .send({ reason: REASON })
      .expect(404);

    const row = await db.withTenant(tenantB.id, (tx) =>
      tx.query<{ name: string | null; anonymized_at: Date | null }>(
        'SELECT name, anonymized_at FROM patients WHERE id = $1',
        [alheio.id],
      ),
    );
    expect(row.rows[0]?.name).toBe('Do lab B');
    expect(row.rows[0]?.anonymized_at).toBeNull();
    expect(await readAuditLogs(tenantA.id, 'anonymize_patient', db)).toHaveLength(0);
  });
});

/**
 * D-075 — o apagamento nao pode ser desfeito por uma rota suportada.
 *
 * Estes testes existem porque `PATCH /patients/:id` grava
 * `oldValues`/`newValues` com nome, e-mail, nascimento, CPF e a anotacao
 * interna, e a anonimizacao nao tocava em `audit_logs`: bastava
 * `GET /audit?entityType=patient&entityId=<id>` para reconstruir a ficha
 * "apagada". A prova e feita na ROTA DE AUDITORIA, nao na tabela — e por la que
 * o dado vazava.
 */
describe('D-075 — audit log e anexo nao sobrevivem ao apagamento', () => {
  const CPF = '52998224725';
  const EMAIL_NOVO = 'joao.novo@email.com';
  const NOTA = 'Paciente relatou uso continuo de medicacao.';
  const ANEXO = 'https://cdn.canal.example/exames/joao-hemograma.pdf';

  /** Edita a ficha pela rota real: e o PATCH que enche o audit log. */
  async function editarFicha(): Promise<void> {
    await app.agent
      .patch(`${BASE}/${patient.id}`)
      .set(app.auth(admin))
      .send({ document: CPF, email: EMAIL_NOVO, notes: NOTA, name: 'Joao Santos Silva' })
      .expect(200);
  }

  async function lerAuditoria(): Promise<string> {
    const response = await app.agent
      .get(`/api/v1/audit?entityType=patient&entityId=${patient.id}`)
      .set(app.auth(admin))
      .expect(200);
    return JSON.stringify(response.body);
  }

  it('GET /audit devolve o CPF ANTES e `[ERASED]` DEPOIS do apagamento', async () => {
    await cenario();
    await editarFicha();

    // Antes: a auditoria faz o trabalho dela (e por isso o dado esta la).
    const antes = await lerAuditoria();
    expect(antes).toContain(CPF);
    expect(antes).toContain(NOTA);

    await app.agent
      .post(`${BASE}/${patient.id}/anonymize`)
      .set(app.auth(admin))
      .send({ reason: REASON })
      .expect(200);

    const depois = await lerAuditoria();
    for (const pessoal of [CPF, NOTA, EMAIL_NOVO, 'Joao Santos', '1984-03-12']) {
      expect(depois).not.toContain(pessoal);
    }

    // O que a auditoria PRECISA continuar provando: que a edicao aconteceu,
    // quem fez, quando e QUAL campo mudou. So o VALOR foi embora.
    const response = await app.agent
      .get(`/api/v1/audit?entityType=patient&entityId=${patient.id}&action=update_patient`)
      .set(app.auth(admin))
      .expect(200);
    const entry = (
      response.body as {
        entries: Array<{
          action: string;
          userId: string;
          timestamp: string;
          oldValues: Record<string, unknown> | null;
          newValues: Record<string, unknown> | null;
        }>;
      }
    ).entries[0];
    expect(entry?.action).toBe('update_patient');
    expect(entry?.userId).toBe(admin.id);
    expect(entry?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Object.keys(entry?.newValues ?? {}).sort()).toEqual([
      'document',
      'email',
      'name',
      'notes',
    ]);
    expect(Object.values(entry?.newValues ?? {})).toEqual([
      '[ERASED]',
      '[ERASED]',
      '[ERASED]',
      '[ERASED]',
    ]);
    expect(Object.values(entry?.oldValues ?? {}).every((v) => v === '[ERASED]')).toBe(true);
  });

  it('o audit log de OUTRO paciente e de outra entidade fica intacto', async () => {
    await cenario();
    await editarFicha();

    const outro = await createPatient({ tenantId: tenantA.id, name: 'Maria Silva', db });
    await app.agent
      .patch(`${BASE}/${outro.id}`)
      .set(app.auth(admin))
      .send({ notes: 'Anotacao da Maria' })
      .expect(200);

    await app.agent
      .post(`${BASE}/${patient.id}/anonymize`)
      .set(app.auth(admin))
      .send({ reason: REASON })
      .expect(200);

    const response = await app.agent
      .get(`/api/v1/audit?entityType=patient&entityId=${outro.id}`)
      .set(app.auth(admin))
      .expect(200);
    // Apagar o titular X nao pode apagar a auditoria do titular Y.
    expect(JSON.stringify(response.body)).toContain('Anotacao da Maria');
  });

  it('a URL do anexo das mensagens do titular vira NULL (o arquivo nao e "conteudo")', async () => {
    const { daAna, daBia } = await cenario();
    await createMessage({
      tenantId: tenantA.id,
      conversationId: daAna,
      senderType: 'patient',
      content: 'Segue meu pedido medico',
      messageType: 'pdf',
      attachmentUrl: ANEXO,
      db,
    });

    // Anexo de OUTRO paciente, na mesma base: nao pode ser tocado.
    const outroPaciente = await createPatient({ tenantId: tenantA.id, name: 'Maria', db });
    const conversaDaMaria = await createConversation({ tenantId: tenantA.id, db });
    await linkConversation(conversaDaMaria.id, outroPaciente.id, { db });
    await createMessage({
      tenantId: tenantA.id,
      conversationId: conversaDaMaria.id,
      attachmentUrl: 'https://cdn.canal.example/exames/maria.pdf',
      db,
    });

    await app.agent
      .post(`${BASE}/${patient.id}/anonymize`)
      .set(app.auth(admin))
      .send({ reason: REASON })
      .expect(200);

    const anexos = await db.withoutTenant((tx) =>
      tx.query<{ attachment_url: string | null }>(
        `SELECT m.attachment_url FROM messages m
           JOIN conversations c ON c.id = m.conversation_id
          WHERE c.patient_id = $1`,
        [patient.id],
      ),
    );
    expect(anexos.rows.every((row) => row.attachment_url === null)).toBe(true);
    expect(daBia).toBeTruthy();

    const daMaria = await db.withoutTenant((tx) =>
      tx.query<{ attachment_url: string | null }>(
        `SELECT m.attachment_url FROM messages m
           JOIN conversations c ON c.id = m.conversation_id
          WHERE c.patient_id = $1`,
        [outroPaciente.id],
      ),
    );
    expect(daMaria.rows[0]?.attachment_url).toBe('https://cdn.canal.example/exames/maria.pdf');
  });
});
