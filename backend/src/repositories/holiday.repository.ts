/**
 * Acesso a `tenant_holidays` (SCHEMA.md §34 — CRMLAB-62, D-213). So os
 * feriados que o laboratorio cadastrou; os nacionais sao calculados em
 * `shared/` e nunca gravados. Toda funcao roda na transacao de quem chama,
 * sob RLS.
 */
import type { Holiday, IsoDate } from '@crm-lab/shared';
import type { DbTx } from '../db/types.js';

interface HolidayRow {
  id: string;
  holiday_date: string;
  description: string;
}

const COLUMNS = `id, to_char(holiday_date, 'YYYY-MM-DD') AS holiday_date, description`;

function toHoliday(row: HolidayRow): Holiday {
  return { id: row.id, date: row.holiday_date, description: row.description, source: 'custom' };
}

/** Feriados do laboratorio no ano, em ordem de data. */
export async function listByYear(tx: DbTx, tenantId: string, year: number): Promise<Holiday[]> {
  const result = await tx.query<HolidayRow>(
    `SELECT ${COLUMNS} FROM tenant_holidays
      WHERE tenant_id = $1 AND holiday_date >= $2::date AND holiday_date <= $3::date
      ORDER BY holiday_date ASC`,
    [tenantId, `${year}-01-01`, `${year}-12-31`],
  );
  return result.rows.map(toHoliday);
}

/** As datas cadastradas entre `from` e `to` (inclusive) — o que o motor consulta. */
export async function listDates(
  tx: DbTx,
  tenantId: string,
  from: IsoDate,
  to: IsoDate,
): Promise<Set<IsoDate>> {
  const result = await tx.query<{ holiday_date: string }>(
    `SELECT to_char(holiday_date, 'YYYY-MM-DD') AS holiday_date FROM tenant_holidays
      WHERE tenant_id = $1 AND holiday_date >= $2::date AND holiday_date <= $3::date`,
    [tenantId, from, to],
  );
  return new Set(result.rows.map((r) => r.holiday_date));
}

/** `null` quando a data ja estava cadastrada (UNIQUE por laboratorio). */
export async function insert(
  tx: DbTx,
  input: { tenantId: string; date: IsoDate; description: string; createdBy: string },
): Promise<Holiday | null> {
  const result = await tx.query<HolidayRow>(
    `INSERT INTO tenant_holidays (tenant_id, holiday_date, description, created_by)
          VALUES ($1, $2::date, $3, $4)
     ON CONFLICT (tenant_id, holiday_date) DO NOTHING
     RETURNING ${COLUMNS}`,
    [input.tenantId, input.date, input.description, input.createdBy],
  );
  const row = result.rows[0];
  return row ? toHoliday(row) : null;
}

/** O feriado apagado, ou `null` se nao existe (ou e de outro laboratorio). */
export async function remove(tx: DbTx, tenantId: string, id: string): Promise<Holiday | null> {
  const result = await tx.query<HolidayRow>(
    `DELETE FROM tenant_holidays WHERE id = $1 AND tenant_id = $2 RETURNING ${COLUMNS}`,
    [id, tenantId],
  );
  const row = result.rows[0];
  return row ? toHoliday(row) : null;
}
