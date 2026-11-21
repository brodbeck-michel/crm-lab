/**
 * Proposta ↔ medico do cadastro (`doctorId`) — API_CONTRACTS.md §3
 * (CRMLAB-188, D-328 item 10): so medico ATIVO do mesmo laboratorio, texto
 * preenchido com o nome quando vazio, PATCH mantem/troca/desvincula e audit.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ApiErrorBody, ProposalDetail } from '@crm-lab/shared';
import type { DbClient } from '../../src/db/types.js';
import { proposalModule } from '../../src/controllers/proposal.routes.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { createConversation, createExam, createTenant, createUser, type UserRecord } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

let db: DbClient;
let app: TestApp;
let attendant: UserRecord;
let conversationId: string;
let examId: string;
let tenantId: string;
let otherTenantId: string;

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  app = await createTestApp({ db, modules: [proposalModule] });
  const tenant = await createTenant({ db });
  const other = await createTenant({ db });
  tenantId = tenant.id;
  otherTenantId = other.id;
  attendant = await createUser({ tenantId, role: 'attendant', discountLimit: 15, db });
  conversationId = (await createConversation({ tenantId, db })).id;
  examId = (await createExam({ tenantId, pricePrivate: 50, db })).id;
});

async function doctor(tenant: string, name: string, isActive = true): Promise<string> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ id: string }>('INSERT INTO doctors (tenant_id, name, is_active) VALUES ($1, $2, $3) RETURNING id', [
      tenant,
      name,
      isActive,
    ]),
  );
  return result.rows[0]?.id as string;
}

async function createProposal(body: Record<string, unknown>) {
  return app.agent
    .post('/api/v1/proposals')
    .set(app.auth(attendant))
    .send({ conversationId, items: [{ examId, quantity: 1 }], ...body });
}

function fieldsOf(response: { body: unknown }): Record<string, string> {
  const details = (response.body as ApiErrorBody).error.details as { fields?: Record<string, string> } | undefined;
  return details?.fields ?? {};
}

describe('POST /proposals com doctorId', () => {
  it('vincula e preenche o texto com o nome quando vazio', async () => {
    const id = await doctor(tenantId, 'Dra. Ana Souza');
    const res = await createProposal({ doctorId: id });
    expect(res.status).toBe(201);
    expect(res.body as ProposalDetail).toMatchObject({
      doctorId: id,
      doctorName: 'Dra. Ana Souza',
      requestingDoctor: 'Dra. Ana Souza',
    });
  });

  it('texto informado é mantido', async () => {
    const id = await doctor(tenantId, 'Dra. Ana Souza');
    const res = await createProposal({ doctorId: id, requestingDoctor: 'Ana (gineco)' });
    expect((res.body as ProposalDetail).requestingDoctor).toBe('Ana (gineco)');
  });

  it('sem doctorId: null, como antes', async () => {
    const res = await createProposal({ requestingDoctor: 'Dr. Livre' });
    expect(res.body as ProposalDetail).toMatchObject({ doctorId: null, doctorName: null, requestingDoctor: 'Dr. Livre' });
  });

  it('médico inativo, de outro laboratório ou inexistente -> 400 em doctorId', async () => {
    const inactive = await doctor(tenantId, 'Dr. Inativo', false);
    const foreign = await doctor(otherTenantId, 'Dr. Outro Lab');
    for (const doctorId of [inactive, foreign, '00000000-0000-4000-8000-000000000001']) {
      const res = await createProposal({ doctorId });
      expect(res.status).toBe(400);
      expect(fieldsOf(res)).toHaveProperty('doctorId');
    }
    await createProposal({ doctorId: 'nao-uuid' }).then((res) => expect(res.status).toBe(400));
  });
});

describe('PATCH /proposals/:id/items com doctorId', () => {
  it('ausente mantém; troca exige ativo; manter o atual inativado vale; null desvincula', async () => {
    const first = await doctor(tenantId, 'Dr. Primeiro');
    const second = await doctor(tenantId, 'Dr. Segundo');
    const created = (await createProposal({ doctorId: first })).body as ProposalDetail;
    const items = [{ examId, quantity: 2 }];
    const url = `/api/v1/proposals/${created.id}/items`;

    const kept = await app.agent.patch(url).set(app.auth(attendant)).send({ items }).expect(200);
    expect((kept.body as ProposalDetail).doctorId).toBe(first);

    // inativa o atual: manter continua valendo
    await db.withoutTenant((tx) => tx.query('UPDATE doctors SET is_active = FALSE WHERE id = $1', [first]));
    await app.agent.patch(url).set(app.auth(attendant)).send({ items, doctorId: first }).expect(200);

    // trocar para inativo: não
    await db.withoutTenant((tx) => tx.query('UPDATE doctors SET is_active = FALSE WHERE id = $1', [second]));
    const bad = await app.agent.patch(url).set(app.auth(attendant)).send({ items, doctorId: second });
    expect(bad.status).toBe(400);
    expect(fieldsOf(bad)).toHaveProperty('doctorId');

    await db.withoutTenant((tx) => tx.query('UPDATE doctors SET is_active = TRUE WHERE id = $1', [second]));
    const swapped = await app.agent.patch(url).set(app.auth(attendant)).send({ items, doctorId: second }).expect(200);
    expect(swapped.body as ProposalDetail).toMatchObject({ doctorId: second, doctorName: 'Dr. Segundo' });

    const unlinked = await app.agent.patch(url).set(app.auth(attendant)).send({ items, doctorId: null }).expect(200);
    expect((unlinked.body as ProposalDetail).doctorId).toBeNull();

    const audit = await db.withoutTenant((tx) =>
      tx.query<{ old_values: Record<string, unknown>; new_values: Record<string, unknown> }>(
        `SELECT old_values, new_values FROM audit_logs
          WHERE action = 'update_proposal_items' AND entity_id = $1 ORDER BY timestamp`,
        [created.id],
      ),
    );
    const last = audit.rows[audit.rows.length - 1];
    expect(last?.old_values.doctorId).toBe(second);
    expect(last?.new_values.doctorId).toBeNull();
  });
});
