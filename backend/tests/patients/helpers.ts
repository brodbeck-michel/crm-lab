/**
 * Factories locais do dominio Paciente.
 *
 * `tests/helpers/factories.ts` e compartilhado entre agentes e nao conhece
 * `patients`, `messages` nem `proposal_status_history` — as tres tabelas que a
 * ficha le. Estas factories cobrem essa lacuna SEM tocar no arquivo comum.
 *
 * Como as do arquivo compartilhado, escrevem por `withoutTenant()`: o cenario
 * de DOIS tenants precisa existir antes de o teste exercitar o RLS por
 * `withTenant()`.
 */
import { randomUUID } from 'node:crypto';
import type { DbClient } from '../../src/db/types.js';
import { getTestDb } from '../helpers/test-db.js';

async function client(db?: DbClient): Promise<DbClient> {
  return db ?? (await getTestDb());
}

let counter = 0;
const seq = (): number => (counter += 1);

export interface PatientRecord {
  id: string;
  tenantId: string;
  phone: string;
  name: string | null;
}

export interface CreatePatientInput {
  id?: string;
  tenantId: string;
  phone?: string;
  name?: string | null;
  email?: string | null;
  birthDate?: string | null;
  document?: string | null;
  notes?: string | null;
  tags?: string[];
  customFields?: Record<string, string>;
  createdAt?: string;
  db?: DbClient;
}

export async function createPatient(input: CreatePatientInput): Promise<PatientRecord> {
  const db = await client(input.db);
  const n = seq();
  const id = input.id ?? randomUUID();
  const phone = input.phone ?? `+5548988${String(100000 + n).slice(-6)}`;
  const name = input.name === undefined ? `Paciente ${n}` : input.name;

  await db.withoutTenant((tx) =>
    tx.query(
      `INSERT INTO patients (id, tenant_id, phone, name, email, birth_date, document, notes,
                             tags, custom_fields, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb,
               COALESCE($11::timestamp, NOW()), COALESCE($11::timestamp, NOW()))`,
      [
        id,
        input.tenantId,
        phone,
        name,
        input.email ?? null,
        input.birthDate ?? null,
        input.document ?? null,
        input.notes ?? null,
        JSON.stringify(input.tags ?? []),
        JSON.stringify(input.customFields ?? {}),
        input.createdAt ?? null,
      ],
    ),
  );
  return { id, tenantId: input.tenantId, phone, name };
}

/** Religa uma conversa ja criada ao paciente (o que o backfill da 003 faz). */
export async function linkConversation(
  conversationId: string,
  patientId: string,
  options: { lastMessageAt?: string; db?: DbClient } = {},
): Promise<void> {
  const db = await client(options.db);
  await db.withoutTenant((tx) =>
    tx.query(
      `UPDATE conversations
          SET patient_id = $1,
              last_message_at = COALESCE($3::timestamp, last_message_at)
        WHERE id = $2`,
      [patientId, conversationId, options.lastMessageAt ?? null],
    ),
  );
}

export interface CreateMessageInput {
  id?: string;
  tenantId: string;
  conversationId: string;
  senderType?: 'patient' | 'agent' | 'system';
  senderId?: string | null;
  content?: string;
  messageType?: string;
  /** URL do anexo (foto, PDF de exame) — dado pessoal do titular (D-075). */
  attachmentUrl?: string | null;
  createdAt?: string;
  db?: DbClient;
}

export async function createMessage(input: CreateMessageInput): Promise<{ id: string }> {
  const db = await client(input.db);
  const id = input.id ?? randomUUID();
  await db.withoutTenant((tx) =>
    tx.query(
      `INSERT INTO messages (id, tenant_id, conversation_id, sender_type, sender_id, content,
                             message_type, attachment_url, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamp, NOW()))`,
      [
        id,
        input.tenantId,
        input.conversationId,
        input.senderType ?? 'patient',
        input.senderId ?? null,
        input.content ?? 'Ola, quanto custa um hemograma?',
        input.messageType ?? 'text',
        input.attachmentUrl ?? null,
        input.createdAt ?? null,
      ],
    ),
  );
  return { id };
}

export interface CreateStatusHistoryInput {
  id?: string;
  tenantId: string;
  proposalId: string;
  status: string;
  changedBy?: string | null;
  changedAt?: string;
  db?: DbClient;
}

export async function createStatusHistory(
  input: CreateStatusHistoryInput,
): Promise<{ id: string }> {
  const db = await client(input.db);
  const id = input.id ?? randomUUID();
  await db.withoutTenant((tx) =>
    tx.query(
      `INSERT INTO proposal_status_history (id, tenant_id, proposal_id, status, changed_by,
                                            changed_at)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamp, NOW()))`,
      [id, input.tenantId, input.proposalId, input.status, input.changedBy ?? null,
       input.changedAt ?? null],
    ),
  );
  return { id };
}

/** Ajusta `proposals.created_at` — a timeline ordena por ele. */
export async function setProposalCreatedAt(
  proposalId: string,
  createdAt: string,
  db?: DbClient,
): Promise<void> {
  const client_ = await client(db);
  await client_.withoutTenant((tx) =>
    tx.query(`UPDATE proposals SET created_at = $2::timestamp WHERE id = $1`, [
      proposalId,
      createdAt,
    ]),
  );
}

/** Le o audit log direto do banco — o teste checa o que ficou gravado. */
export async function readAuditLogs(
  tenantId: string,
  action: string,
  db?: DbClient,
): Promise<Array<{ entityId: string; newValues: unknown; oldValues: unknown }>> {
  const client_ = await client(db);
  const result = await client_.withoutTenant((tx) =>
    tx.query<{ entity_id: string; new_values: unknown; old_values: unknown }>(
      `SELECT entity_id, new_values, old_values FROM audit_logs
        WHERE tenant_id = $1 AND action = $2
        ORDER BY timestamp ASC`,
      [tenantId, action],
    ),
  );
  return result.rows.map((row) => ({
    entityId: row.entity_id,
    newValues: typeof row.new_values === 'string' ? JSON.parse(row.new_values) : row.new_values,
    oldValues: typeof row.old_values === 'string' ? JSON.parse(row.old_values) : row.old_values,
  }));
}
