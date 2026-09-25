/**
 * Acesso a dados de `lis_imports`/`lis_budgets` (SCHEMA.md §25/§26, D-109/
 * D-110/D-111/D-114). SEM regra de negocio de alcada/parsing — isso vive no
 * `LisImportService`; aqui so SQL.
 *
 * `resolveInsuranceId`/`upsertBudget` recebem um `DbTx` diretamente (nao abrem
 * `withTenant` por conta propria) porque o service já esta dentro da
 * transacao do chunk (SERVICES.md §19: "upsert em chunks, dentro de uma
 * transacao por chunk").
 */
import type { LisImport, LisImportKind, LisImportStatus } from '@crm-lab/shared';
import type { DbClient, DbTx } from '../db/types.js';
import { findAttendantIdByFoldedName } from './attendant.repository.js';
import { toIso, toIsoOrNull } from './row-mappers.js';
import type { LisSpreadsheetRow } from '../lib/lis-spreadsheet.js';
import { principalInsuranceName } from '../lib/lis-spreadsheet.js';

// ---------------------------------------------------------------------------
// lis_imports
// ---------------------------------------------------------------------------

interface LisImportRow {
  id: string;
  kind: string;
  file_name: string | null;
  rows_in_file: number | null;
  rows_accepted: number | null;
  rows_rejected: number | null;
  proposals_won: number | null;
  status: string;
  error_message: string | null;
  created_by: string | null;
  created_at: Date | string;
  finished_at: Date | string | null;
}

const IMPORT_COLUMNS = `id, kind, file_name, rows_in_file, rows_accepted, rows_rejected,
                         proposals_won, status, error_message, created_by, created_at, finished_at`;

export function toLisImport(row: LisImportRow): LisImport {
  return {
    id: row.id,
    kind: row.kind as LisImportKind,
    fileName: row.file_name,
    rowsInFile: row.rows_in_file,
    rowsAccepted: row.rows_accepted,
    rowsRejected: row.rows_rejected,
    proposalsWon: row.proposals_won,
    status: row.status as LisImportStatus,
    errorMessage: row.error_message,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    finishedAt: toIsoOrNull(row.finished_at),
  };
}

export interface LisImportListCriteria {
  page: number;
  limit: number;
}

export interface LisImportPage {
  rows: LisImport[];
  total: number;
}

export class LisImportRepository {
  constructor(private readonly db: DbClient) {}

  /** Insere o registro inicial (`status: 'processing'`) ANTES de processar chunks. */
  async insertProcessing(
    tenantId: string,
    data: { kind: LisImportKind; fileName: string | null; rowsInFile: number | null; createdBy: string | null },
  ): Promise<LisImport> {
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<LisImportRow>(
        `INSERT INTO lis_imports (tenant_id, kind, file_name, rows_in_file, status, created_by)
         VALUES ($1, $2, $3, $4, 'processing', $5)
         RETURNING ${IMPORT_COLUMNS}`,
        [tenantId, data.kind, data.fileName, data.rowsInFile, data.createdBy],
      );
      const row = result.rows[0];
      if (!row) throw new Error('INSERT em lis_imports nao retornou linha');
      return toLisImport(row);
    });
  }

  /** `kind: 'purge'` nasce e fecha na mesma escrita — sempre `completed` (API_CONTRACTS.md §10.1). */
  async insertPurge(tenantId: string, createdBy: string | null): Promise<LisImport> {
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<LisImportRow>(
        `INSERT INTO lis_imports (tenant_id, kind, file_name, status, created_by, finished_at)
         VALUES ($1, 'purge', NULL, 'completed', $2, NOW())
         RETURNING ${IMPORT_COLUMNS}`,
        [tenantId, createdBy],
      );
      const row = result.rows[0];
      if (!row) throw new Error('INSERT em lis_imports (purge) nao retornou linha');
      return toLisImport(row);
    });
  }

  /** Fecha o registro (completed ou failed) com os contadores finais. */
  async finish(
    tenantId: string,
    id: string,
    data: {
      status: Exclude<LisImportStatus, 'processing'>;
      rowsAccepted: number | null;
      rowsRejected: number | null;
      errorMessage: string | null;
      /** Propostas que esta rodada levou a `ganho` pela conciliacao (D-119 item 9). */
      proposalsWon: number;
    },
  ): Promise<LisImport> {
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<LisImportRow>(
        `UPDATE lis_imports
            SET status = $2, rows_accepted = $3, rows_rejected = $4,
                error_message = $5, proposals_won = $6, finished_at = NOW()
          WHERE id = $1
          RETURNING ${IMPORT_COLUMNS}`,
        [id, data.status, data.rowsAccepted, data.rowsRejected, data.errorMessage, data.proposalsWon],
      );
      const row = result.rows[0];
      if (!row) throw new Error('lis_imports nao encontrado ao finalizar');
      return toLisImport(row);
    });
  }

  async list(tenantId: string, criteria: LisImportListCriteria): Promise<LisImportPage> {
    return this.db.withTenant(tenantId, async (tx) => {
      const counted = await tx.query<{ total: number | string }>(
        'SELECT COUNT(*)::int AS total FROM lis_imports',
      );
      const total = Number(counted.rows[0]?.total ?? 0);

      const offset = (criteria.page - 1) * criteria.limit;
      const paged = await tx.query<LisImportRow>(
        `SELECT ${IMPORT_COLUMNS} FROM lis_imports
          ORDER BY created_at DESC
          LIMIT $1 OFFSET $2`,
        [criteria.limit, offset],
      );
      return { rows: paged.rows.map(toLisImport), total };
    });
  }

  async getLatest(tenantId: string): Promise<LisImport | null> {
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<LisImportRow>(
        `SELECT ${IMPORT_COLUMNS} FROM lis_imports
          ORDER BY created_at DESC
          LIMIT 1`,
      );
      const row = result.rows[0];
      return row ? toLisImport(row) : null;
    });
  }
}

// ---------------------------------------------------------------------------
// lis_budgets — resolucao + upsert dentro da transacao do chunk
// ---------------------------------------------------------------------------

/** Grafias de "sem convenio" que NUNCA criam linha em `insurances` (BUSINESS_RULES.md §11.4). */
const PARTICULAR_PATTERN = /^PARTICULAR(\b.*)?$/i;

function isParticular(name: string | null): boolean {
  if (name === null) return true;
  const trimmed = name.trim();
  if (trimmed === '') return true;
  return PARTICULAR_PATTERN.test(trimmed);
}

function foldInsuranceName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Resolve `insurance_id` a partir do nome principal do orcamento (D-114,
 * BUSINESS_RULES.md §11.4). `PARTICULAR`/variantes -> `null`, sem criar linha.
 * Inexistente -> CRIADO com `type: 'outro'`, `source: 'lis'`, na MESMA
 * transacao do chunk.
 */
export async function resolveInsuranceId(
  tx: DbTx,
  tenantId: string,
  row: LisSpreadsheetRow,
): Promise<string | null> {
  const name = principalInsuranceName(row);
  if (isParticular(name)) return null;
  const trimmedName = (name as string).trim();

  const existing = await tx.query<{ id: string }>(
    `SELECT id FROM insurances WHERE tenant_id = $1 AND lower(name) = $2 LIMIT 1`,
    [tenantId, foldInsuranceName(trimmedName)],
  );
  const found = existing.rows[0]?.id;
  if (found) return found;

  const created = await tx.query<{ id: string }>(
    `INSERT INTO insurances (tenant_id, name, type, source, is_active)
     VALUES ($1, $2, 'outro', 'lis', TRUE)
     RETURNING id`,
    [tenantId, trimmedName],
  );
  const row0 = created.rows[0];
  if (!row0) throw new Error('INSERT em insurances (auto, D-114) nao retornou linha');
  return row0.id;
}

/** Resolve `attendant_id` por `folded_name` — nunca cria (BUSINESS_RULES.md §11.6). */
export async function resolveAttendantId(
  tx: DbTx,
  tenantId: string,
  row: LisSpreadsheetRow,
): Promise<string | null> {
  if (row.attendantName === null) return null;
  return findAttendantIdByFoldedName(tx, tenantId, row.attendantName);
}

/**
 * Upsert em `lis_budgets` — `ON CONFLICT (tenant_id, number)` só sobrescreve
 * quando o novo total é maior ou igual (BUSINESS_RULES.md §11.1). `EXCLUDED`
 * inclui as colunas GERADAS (`total_value`) computadas para a linha proposta.
 */
export async function upsertBudget(
  tx: DbTx,
  tenantId: string,
  importId: string,
  row: LisSpreadsheetRow,
  insuranceId: string | null,
  attendantId: string | null,
): Promise<void> {
  await tx.query(
    `INSERT INTO lis_budgets (
       tenant_id, number, issued_on, patient_name,
       insurance_1, value_1, insurance_2, value_2, insurance_3, value_3,
       insurance_id, attendant_name, attendant_id, insurance_average,
       requisition_number, requisition_value, paid_value, paid_on, import_id
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19
     )
     ON CONFLICT (tenant_id, number) DO UPDATE SET
       issued_on = EXCLUDED.issued_on,
       patient_name = EXCLUDED.patient_name,
       insurance_1 = EXCLUDED.insurance_1,
       value_1 = EXCLUDED.value_1,
       insurance_2 = EXCLUDED.insurance_2,
       value_2 = EXCLUDED.value_2,
       insurance_3 = EXCLUDED.insurance_3,
       value_3 = EXCLUDED.value_3,
       insurance_id = EXCLUDED.insurance_id,
       attendant_name = EXCLUDED.attendant_name,
       attendant_id = EXCLUDED.attendant_id,
       insurance_average = EXCLUDED.insurance_average,
       requisition_number = EXCLUDED.requisition_number,
       requisition_value = EXCLUDED.requisition_value,
       paid_value = EXCLUDED.paid_value,
       paid_on = EXCLUDED.paid_on,
       import_id = EXCLUDED.import_id,
       updated_at = NOW()
     WHERE EXCLUDED.total_value >= lis_budgets.total_value`,
    [
      tenantId,
      row.number.trim(),
      row.issuedOn,
      row.patientName,
      row.insurance1,
      row.value1,
      row.insurance2,
      row.value2,
      row.insurance3,
      row.value3,
      insuranceId,
      row.attendantName,
      attendantId,
      row.insuranceAverage,
      row.requisitionNumber,
      row.requisitionValue,
      row.paidValue,
      row.paidOn,
      importId,
    ],
  );
}

/** Quantos `lis_budgets` do tenant estao vinculados a proposta (purge bloqueado, D-119 item 8). */
export async function countReconciledBudgets(tx: DbTx, tenantId: string): Promise<number> {
  const result = await tx.query<{ total: number | string }>(
    'SELECT COUNT(*)::int AS total FROM lis_budgets WHERE tenant_id = $1 AND proposal_id IS NOT NULL',
    [tenantId],
  );
  return Number(result.rows[0]?.total ?? 0);
}

/** `POST /lis-imports/purge` — apaga TODAS as linhas de `lis_budgets` do tenant. */
export async function purgeBudgets(tx: DbTx, tenantId: string): Promise<void> {
  await tx.query('DELETE FROM lis_budgets WHERE tenant_id = $1', [tenantId]);
}
