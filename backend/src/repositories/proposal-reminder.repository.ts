/**
 * Acesso a `proposal_reminders` (SCHEMA.md §41, CRMLAB-102, D-272).
 *
 * SEM regra de negocio: quem pode, quando vence e qual desfecho valem ficam
 * no `ProposalReminderService` / `ProposalService`. Todos os metodos recebem
 * o `DbTx` de quem chama (sempre dentro de `withTenant`: RLS por tenant).
 *
 * Datas: `due_date` e `DATE` (sai como `YYYY-MM-DD` pelo `to_char`); os
 * `TIMESTAMP` saem ja em ISO UTC pelo `to_char` (D-078).
 */
import type {
  ProposalReminderEntry,
  ProposalReminderOrigin,
  ProposalReminderOutcome,
} from '@crm-lab/shared';
import type { DbTx } from '../db/types.js';

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

interface ReminderRow {
  id: string;
  origin: string;
  due_date: string;
  note: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolved_by_name: string | null;
  outcome: string | null;
  outcome_note: string | null;
}

const SELECT_REMINDER = `
  SELECT r.id, r.origin, to_char(r.due_date, 'YYYY-MM-DD') AS due_date, r.note,
         r.created_by, cu.name AS created_by_name,
         to_char(r.created_at, ${ISO}) AS created_at,
         to_char(r.resolved_at, ${ISO}) AS resolved_at,
         r.resolved_by, ru.name AS resolved_by_name, r.outcome, r.outcome_note
    FROM proposal_reminders r
    LEFT JOIN users cu ON cu.id = r.created_by
    LEFT JOIN users ru ON ru.id = r.resolved_by`;

function mapReminder(row: ReminderRow): ProposalReminderEntry {
  return {
    id: row.id,
    origin: row.origin as ProposalReminderOrigin,
    dueDate: row.due_date,
    note: row.note,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    resolvedByName: row.resolved_by_name,
    outcome: (row.outcome as ProposalReminderOutcome | null) ?? null,
    outcomeNote: row.outcome_note,
  };
}

/** Todos os lembretes da proposta, do mais antigo para o mais novo. */
export async function findAll(tx: DbTx, proposalId: string): Promise<ProposalReminderEntry[]> {
  const result = await tx.query<ReminderRow>(
    `${SELECT_REMINDER} WHERE r.proposal_id = $1 ORDER BY r.created_at ASC, r.id ASC`,
    [proposalId],
  );
  return result.rows.map(mapReminder);
}

/** O lembrete aberto, travado (`FOR UPDATE`) ate o fim da transacao de quem chama. */
export async function findOpenForUpdate(
  tx: DbTx,
  proposalId: string,
): Promise<{ id: string; dueDate: string; note: string | null } | null> {
  const result = await tx.query<{ id: string; due_date: string; note: string | null }>(
    `SELECT id, to_char(due_date, 'YYYY-MM-DD') AS due_date, note
       FROM proposal_reminders
      WHERE proposal_id = $1 AND resolved_at IS NULL
      FOR UPDATE`,
    [proposalId],
  );
  const row = result.rows[0];
  return row ? { id: row.id, dueDate: row.due_date, note: row.note } : null;
}

export interface ReminderInsert {
  tenantId: string;
  proposalId: string;
  origin: ProposalReminderOrigin;
  dueDate: string;
  note: string | null;
  createdBy: string | null;
  /** Instante de criacao; ausente = `NOW()`. O motor passa o relogio injetado. */
  createdAt?: Date;
}

/**
 * Insere o lembrete. `ON CONFLICT DO NOTHING` nos dois indices unicos
 * parciais (um aberto por proposta; um automatico por proposta): `null` =
 * nada gravado. O automatico so entra se a proposta ainda esta aberta.
 */
export async function insert(tx: DbTx, input: ReminderInsert): Promise<string | null> {
  const result = await tx.query<{ id: string }>(
    `INSERT INTO proposal_reminders (tenant_id, proposal_id, origin, due_date, note, created_by, created_at)
     SELECT $1, p.id, $3, $4::date, $5, $6, COALESCE($7::timestamp, NOW())
       FROM proposals p
      WHERE p.id = $2 AND p.tenant_id = $1 AND p.status NOT IN ('ganho', 'perdido')
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      input.tenantId,
      input.proposalId,
      input.origin,
      input.dueDate,
      input.note,
      input.createdBy,
      input.createdAt ? input.createdAt.toISOString() : null,
    ],
  );
  return result.rows[0]?.id ?? null;
}

/** Reagenda o aberto pelo "Agendar lembrete": novo dia, nova nota, aviso zerado. */
export async function reschedule(
  tx: DbTx,
  id: string,
  dueDate: string,
  note: string | null,
): Promise<void> {
  await tx.query(
    `UPDATE proposal_reminders SET due_date = $2::date, note = $3, alerted_at = NULL
      WHERE id = $1 AND resolved_at IS NULL`,
    [id, dueDate, note],
  );
}

/** Fecha o aberto com o desfecho. `false` = ja estava fechado (nada gravado). */
export async function resolve(
  tx: DbTx,
  input: {
    id: string;
    outcome: ProposalReminderOutcome;
    resolvedBy: string | null;
    outcomeNote: string | null;
    at?: Date;
  },
): Promise<boolean> {
  const result = await tx.query<{ id: string }>(
    `UPDATE proposal_reminders
        SET resolved_at = COALESCE($5::timestamp, NOW()), resolved_by = $3,
            outcome = $2, outcome_note = $4
      WHERE id = $1 AND resolved_at IS NULL
      RETURNING id`,
    [
      input.id,
      input.outcome,
      input.resolvedBy,
      input.outcomeNote,
      input.at ? input.at.toISOString() : null,
    ],
  );
  return result.rows.length > 0;
}

// ---------------------------------------------------------------------------
// Motor de tempo (FunnelTimerService)
// ---------------------------------------------------------------------------

/**
 * Propostas abertas criadas ate `cutoff`, sem lembrete aberto e que nunca
 * tiveram um automatico (D-272 item 2), da mais antiga para a mais nova.
 */
export async function selectAutoCandidates(
  tx: DbTx,
  tenantId: string,
  cutoff: Date,
  limit: number,
): Promise<Array<{ id: string; createdAt: string }>> {
  const result = await tx.query<{ id: string; created_at: string }>(
    `SELECT p.id, to_char(p.created_at, ${ISO}) AS created_at
       FROM proposals p
      WHERE p.tenant_id = $1 AND p.status NOT IN ('ganho', 'perdido')
        AND p.created_at <= $2::timestamp
        AND NOT EXISTS (
              SELECT 1 FROM proposal_reminders r
               WHERE r.proposal_id = p.id AND (r.resolved_at IS NULL OR r.origin = 'auto'))
      ORDER BY p.created_at ASC, p.id ASC
      LIMIT $3`,
    [tenantId, cutoff.toISOString(), limit],
  );
  return result.rows.map((r) => ({ id: r.id, createdAt: r.created_at }));
}

/** Abertos vencidos (`due_date <= today`) ainda sem aviso, de proposta aberta. */
export async function selectDueUnalerted(
  tx: DbTx,
  tenantId: string,
  today: string,
  limit: number,
): Promise<Array<{ id: string; proposalId: string; dueDate: string; createdBy: string | null }>> {
  const result = await tx.query<{
    id: string;
    proposal_id: string;
    due_date: string;
    created_by: string | null;
  }>(
    `SELECT r.id, r.proposal_id, to_char(r.due_date, 'YYYY-MM-DD') AS due_date, p.created_by
       FROM proposal_reminders r
       JOIN proposals p ON p.id = r.proposal_id
      WHERE r.tenant_id = $1 AND r.resolved_at IS NULL AND r.alerted_at IS NULL
        AND r.due_date <= $2::date AND p.status NOT IN ('ganho', 'perdido')
      ORDER BY r.due_date ASC, r.id ASC
      LIMIT $3`,
    [tenantId, today, limit],
  );
  return result.rows.map((r) => ({
    id: r.id,
    proposalId: r.proposal_id,
    dueDate: r.due_date,
    createdBy: r.created_by,
  }));
}

/** Marca o aviso. `false` = outro tique ja avisou ou o lembrete fechou. */
export async function markAlerted(tx: DbTx, id: string, at: Date): Promise<boolean> {
  const result = await tx.query<{ id: string }>(
    `UPDATE proposal_reminders SET alerted_at = $2::timestamp
      WHERE id = $1 AND alerted_at IS NULL AND resolved_at IS NULL
      RETURNING id`,
    [id, at.toISOString()],
  );
  return result.rows.length > 0;
}
