/**
 * Requisicoes do Bitlab (SCHEMA.md §54 — CRMLAB-200, D-338) e o estado da sincronizacao delas
 * (colunas `requisitions_*` de `lis_sync_settings`, §31).
 *
 * Escrita so pela `LisRequisitionSyncService`. A leitura dos relatorios mora em
 * `lis-doctor-revenue.repository.ts` e `doctor-abc.repository.ts`.
 *
 * `listEnabledTenants` e a UNICA leitura fora do contexto de tenant (como D-186): projeta so
 * `tenant_id` e a hora da ultima rodada. A chave so e decifrada em `startRun`, e o retorno vai
 * direto para o cliente do Bitlab.
 */
import type { DbClient, DbTx } from '../db/types.js';
import type { LisRequisitionRow } from '../lib/bitlab-requisitions-client.js';
import { decryptSecret } from '../lib/secret-box.js';
import { findAttendantIdByFoldedName } from './attendant.repository.js';
import { resolveInsuranceIdByName } from './lis-import.repository.js';
import { toIsoOrNull } from './row-mappers.js';

export interface LisRequisitionsState {
  enabled: boolean;
  watermark: string | null;
  cursor: string | null;
  loadNextDay: string | null;
  loadStartedAt: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  total: number;
}

export interface RequisitionsProgress {
  watermark?: string | null;
  cursor?: string | null;
  loadNextDay?: string | null;
  loadStartedAt?: string | null;
}

export class LisRequisitionRepository {
  constructor(private readonly db: DbClient) {}

  async getState(tenantId: string): Promise<LisRequisitionsState> {
    return this.db.withTenant(tenantId, async (tx) => {
      const s = await tx.query<{
        enabled: boolean;
        requisitions_watermark: string | null;
        requisitions_cursor: string | null;
        load_next_day: string | null;
        requisitions_load_started_at: string | null;
        requisitions_last_run_at: Date | string | null;
        requisitions_last_success_at: Date | string | null;
        requisitions_last_error: string | null;
      }>(
        `SELECT enabled, requisitions_watermark, requisitions_cursor,
                to_char(requisitions_load_next_day, 'YYYY-MM-DD') AS load_next_day,
                requisitions_load_started_at, requisitions_last_run_at,
                requisitions_last_success_at, requisitions_last_error
           FROM lis_sync_settings WHERE tenant_id = $1`,
        [tenantId],
      );
      const c = await tx.query<{ total: number | string }>(
        'SELECT COUNT(*)::int AS total FROM lis_requisitions WHERE tenant_id = $1',
        [tenantId],
      );
      const row = s.rows[0];
      return {
        enabled: row?.enabled ?? false,
        watermark: row?.requisitions_watermark ?? null,
        cursor: row?.requisitions_cursor ?? null,
        loadNextDay: row?.load_next_day ?? null,
        loadStartedAt: row?.requisitions_load_started_at ?? null,
        lastRunAt: toIsoOrNull(row?.requisitions_last_run_at ?? null),
        lastSuccessAt: toIsoOrNull(row?.requisitions_last_success_at ?? null),
        lastError: row?.requisitions_last_error ?? null,
        total: Number(c.rows[0]?.total ?? 0),
      };
    });
  }

  /**
   * UNICO ponto que decifra a chave para as requisicoes. `null` = desligado ou sem chave. Grava
   * `requisitions_last_run_at` na mesma transacao.
   */
  async startRun(tenantId: string, at: Date): Promise<{ apiKey: string } | null> {
    return this.db.withTenant(tenantId, async (tx) => {
      // Relogio do service (UTC, sem fuso como as outras colunas `TIMESTAMP`, D-078): o agendador
      // compara com o horario devido no mesmo relogio.
      const result = await tx.query<{ api_key: string | null }>(
        `UPDATE lis_sync_settings SET requisitions_last_run_at = $2::timestamp
          WHERE tenant_id = $1 AND enabled AND api_key IS NOT NULL
          RETURNING api_key`,
        [tenantId, at.toISOString().slice(0, 19).replace('T', ' ')],
      );
      const apiKey = decryptSecret(result.rows[0]?.api_key ?? null);
      return apiKey ? { apiKey } : null;
    });
  }

  async saveProgress(tenantId: string, progress: RequisitionsProgress): Promise<void> {
    await this.db.withTenant(tenantId, (tx) => saveProgressTx(tx, tenantId, progress));
  }

  async finishRun(tenantId: string, error: string | null): Promise<void> {
    await this.db.withTenant(tenantId, async (tx) => {
      if (error === null) {
        await tx.query(
          `UPDATE lis_sync_settings
              SET requisitions_last_success_at = NOW(), requisitions_last_error = NULL
            WHERE tenant_id = $1`,
          [tenantId],
        );
      } else {
        await tx.query('UPDATE lis_sync_settings SET requisitions_last_error = $2 WHERE tenant_id = $1', [
          tenantId,
          error,
        ]);
      }
    });
  }

  /**
   * Grava uma pagina (ou um dia/janela inteiro) e o progresso numa transacao so: a requisicao
   * substitui a gravada (pagamentos inclusive) e a excluida e apagada (SCHEMA §54).
   */
  async applyBatch(
    tenantId: string,
    rows: LisRequisitionRow[],
    excluded: string[],
    progress: RequisitionsProgress,
  ): Promise<{ written: number; deleted: number }> {
    return this.db.withTenant(tenantId, async (tx) => {
      const insuranceIds = new Map<string, string | null>();
      const attendantIds = new Map<string, string | null>();
      let written = 0;
      for (const row of rows) {
        const insKey = (row.insuranceName ?? '').trim().toLowerCase();
        if (!insuranceIds.has(insKey)) {
          insuranceIds.set(insKey, await resolveInsuranceIdByName(tx, tenantId, row.insuranceName));
        }
        const attKey = row.attendantName ?? '';
        if (!attendantIds.has(attKey)) {
          attendantIds.set(
            attKey,
            row.attendantName === null ? null : await findAttendantIdByFoldedName(tx, tenantId, row.attendantName),
          );
        }
        const up = await tx.query<{ id: string }>(
          `INSERT INTO lis_requisitions (
             tenant_id, number, requested_at, requested_on, budget_number,
             insurance_code, insurance_name, insurance_type, insurance_id,
             attendant_name, attendant_id,
             requesting_doctor_name, requesting_doctor_council, requesting_doctor_crm, requesting_doctor_uf,
             patient_value, insurance_value, paid_value, changed_at)
           VALUES ($1, $2, $3::timestamp, $4::date, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
                   $16, $17, $18, $19::timestamp)
           ON CONFLICT (tenant_id, number) DO UPDATE SET
             requested_at = EXCLUDED.requested_at,
             requested_on = EXCLUDED.requested_on,
             budget_number = EXCLUDED.budget_number,
             insurance_code = EXCLUDED.insurance_code,
             insurance_name = EXCLUDED.insurance_name,
             insurance_type = EXCLUDED.insurance_type,
             insurance_id = EXCLUDED.insurance_id,
             attendant_name = EXCLUDED.attendant_name,
             attendant_id = EXCLUDED.attendant_id,
             requesting_doctor_name = EXCLUDED.requesting_doctor_name,
             requesting_doctor_council = EXCLUDED.requesting_doctor_council,
             requesting_doctor_crm = EXCLUDED.requesting_doctor_crm,
             requesting_doctor_uf = EXCLUDED.requesting_doctor_uf,
             patient_value = EXCLUDED.patient_value,
             insurance_value = EXCLUDED.insurance_value,
             paid_value = EXCLUDED.paid_value,
             changed_at = EXCLUDED.changed_at
           RETURNING id`,
          [
            tenantId,
            row.number,
            row.requestedAt,
            row.requestedOn,
            row.budgetNumber,
            row.insuranceCode,
            row.insuranceName,
            row.insuranceType,
            insuranceIds.get(insKey) ?? null,
            row.attendantName,
            attendantIds.get(attKey) ?? null,
            row.requestingDoctorName,
            row.requestingDoctorCouncil,
            row.requestingDoctorCrm,
            row.requestingDoctorUf,
            row.patientValue,
            row.insuranceValue,
            row.paidValue,
            row.changedAt,
          ],
        );
        const requisitionId = up.rows[0]?.id;
        if (!requisitionId) throw new Error('upsert em lis_requisitions nao retornou linha');
        await tx.query('DELETE FROM lis_requisition_payments WHERE requisition_id = $1', [requisitionId]);
        for (const p of row.payments) {
          await tx.query(
            `INSERT INTO lis_requisition_payments
               (tenant_id, requisition_id, payment_key, paid_at, paid_on, paid_value, status, payment_method)
             VALUES ($1, $2, $3, $4::timestamp, $5::date, $6, $7, $8)`,
            [tenantId, requisitionId, p.paymentKey, p.paidAt, p.paidOn, p.paidValue, p.status, p.paymentMethod],
          );
        }
        written += 1;
      }
      let deleted = 0;
      if (excluded.length > 0) {
        const del = await tx.query<{ id: string }>(
          'DELETE FROM lis_requisitions WHERE tenant_id = $1 AND number = ANY($2::text[]) RETURNING id',
          [tenantId, excluded],
        );
        deleted = del.rows.length;
      }
      await saveProgressTx(tx, tenantId, progress);
      return { written, deleted };
    });
  }

  /** D-186: fora do contexto de tenant, SO `tenant_id` e a ultima rodada. */
  async listEnabledTenants(): Promise<Array<{ tenantId: string; lastRunAt: Date | null }>> {
    return this.db.withoutTenant(async (tx) => {
      const result = await tx.query<{ tenant_id: string; last_run: string | null }>(
        `SELECT tenant_id, to_char(requisitions_last_run_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS last_run
           FROM lis_sync_settings
          WHERE enabled AND api_key IS NOT NULL
          ORDER BY tenant_id`,
      );
      return result.rows.map((r) => ({
        tenantId: r.tenant_id,
        lastRunAt: r.last_run === null ? null : new Date(`${r.last_run}Z`),
      }));
    });
  }
}

async function saveProgressTx(tx: DbTx, tenantId: string, progress: RequisitionsProgress): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [tenantId];
  const add = (column: string, value: string | null, cast = ''): void => {
    params.push(value);
    sets.push(`${column} = $${params.length}${cast}`);
  };
  if (progress.watermark !== undefined) add('requisitions_watermark', progress.watermark);
  if (progress.cursor !== undefined) add('requisitions_cursor', progress.cursor);
  if (progress.loadNextDay !== undefined) add('requisitions_load_next_day', progress.loadNextDay, '::date');
  if (progress.loadStartedAt !== undefined) add('requisitions_load_started_at', progress.loadStartedAt);
  if (sets.length === 0) return;
  await tx.query(`UPDATE lis_sync_settings SET ${sets.join(', ')} WHERE tenant_id = $1`, params);
}
