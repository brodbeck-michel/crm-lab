/**
 * Faturamento por médico solicitante (CRMLAB-198, D-336; fonte trocada na D-338). Só SQL.
 *
 * Desde a D-338 (CRMLAB-200) lê `lis_requisitions` (SCHEMA §54): TODAS as requisições do Bitlab,
 * com ou sem orçamento, uma linha por requisição, sem dedupe. É o ÚNICO lugar que liga o LIS a
 * `doctors`: o relatório (`GET /lis-budgets/by-doctor`), a ficha (`GET /doctors/:id/revenue`) e
 * a base da curva ABC (`doctor-abc.repository.ts`) usam os mesmos trechos daqui.
 *
 * Regras (D-336 itens 2–3, D-338 itens 3–5):
 *  - valor da requisição = `total_value` (paciente líquido + convênio), pela data da requisição;
 *  - recebido = pagamentos `ativo` do paciente, pela data do pagamento;
 *  - identificado = CRM com `LIS_DOCTOR_MIN_CRM_DIGITS`+ dígitos e UF; abaixo disso é o coringa
 *    do Bitlab (CRM `1`), uma linha só `no-doctor`; sem campo de médico nenhum = `null`;
 *  - vínculo com `doctors` = identificado, CRM + UF, conselho `CRM` ou vazio.
 */
import { LIS_DOCTOR_MIN_CRM_DIGITS, LIS_DOCTOR_NO_DOCTOR_KEY } from '@crm-lab/shared';
import type { DbTx } from '../db/types.js';
import { summaryFilterClauses, type SummaryFilters } from './lis-analytics.repository.js';
import { toNumber } from './row-mappers.js';

/** Requisição `r` com médico identificado (D-336 item 2). */
const IDENTIFIED = `(r.requesting_doctor_crm IS NOT NULL
   AND length(r.requesting_doctor_crm) >= ${LIS_DOCTOR_MIN_CRM_DIGITS}
   AND r.requesting_doctor_uf IS NOT NULL)`;

/** Condição de "esta requisição (`r`) é deste cadastro (`d`)" (D-335 item 5). */
export const DOCTOR_MATCH = `${IDENTIFIED} AND r.requesting_doctor_crm = d.crm AND r.requesting_doctor_uf = d.crm_uf
                             AND (r.requesting_doctor_council IS NULL OR r.requesting_doctor_council = 'CRM')`;

export interface DoctorRevenueRowDb {
  doctorKey: string | null;
  doctorName: string | null;
  council: string | null;
  crm: string | null;
  uf: string | null;
  identified: boolean;
  doctorId: string | null;
  responsibleName: string | null;
  requisitionCount: number;
  requisitionValue: number;
  paidCount: number;
  paidValue: number;
}

/**
 * Uma linha por médico (chave do D-336 item 2) com as duas janelas. `responsibleId` deixa só os
 * médicos cadastrados daquela carteira. Os filtros de convênio/atendente valem sobre a requisição.
 */
export async function getDoctorRevenue(
  tx: DbTx,
  tenantId: string,
  filters: SummaryFilters & { responsibleId?: string },
): Promise<DoctorRevenueRowDb[]> {
  const params: unknown[] = [tenantId];
  const extra = summaryFilterClauses(filters, params);
  const extraSql = extra.map((c) => ` AND ${c}`).join('');
  params.push(filters.startDate, filters.endDate);
  const start = `$${params.length - 1}`;
  const end = `$${params.length}`;
  let responsibleSql = '';
  if (filters.responsibleId !== undefined) {
    params.push(filters.responsibleId);
    responsibleSql = `WHERE d.responsible_user_id = $${params.length}`;
  }

  const result = await tx.query<{
    doctor_key: string | null;
    name: string | null;
    council: string | null;
    crm: string | null;
    uf: string | null;
    identified: boolean | null;
    doctor_id: string | null;
    responsible_name: string | null;
    requisition_count: number | string;
    requisition_value: string | number | null;
    paid_count: number | string;
    paid_value: string | number | null;
  }>(
    `WITH req AS (
       SELECT r.id, r.total_value, r.requested_on,
              r.requesting_doctor_name AS name, r.requesting_doctor_council AS council,
              r.requesting_doctor_crm AS crm, r.requesting_doctor_uf AS uf,
              ${IDENTIFIED} AS identified,
              (r.requesting_doctor_name IS NOT NULL OR r.requesting_doctor_crm IS NOT NULL) AS has_doctor
         FROM lis_requisitions r
        WHERE r.tenant_id = $1${extraSql}
     ),
     pay AS (
       SELECT p.requisition_id, SUM(p.paid_value) AS paid_value
         FROM lis_requisition_payments p
        WHERE p.tenant_id = $1 AND p.status = 'ativo' AND p.paid_on BETWEEN ${start} AND ${end}
        GROUP BY p.requisition_id
     ),
     facts AS (
       SELECT id, COALESCE(total_value, 0) AS requisition_value, 0::numeric AS paid_value,
              1 AS req, 0 AS pay, requested_on AS on_date
         FROM req
        WHERE requested_on BETWEEN ${start} AND ${end}
       UNION ALL
       SELECT req.id, 0, pay.paid_value, 0, 1, req.requested_on
         FROM pay JOIN req ON req.id = pay.requisition_id
        WHERE pay.paid_value > 0
     ),
     keyed AS (
       SELECT f.*, req.name, req.council, req.crm, req.uf, req.identified,
              CASE WHEN req.identified THEN 'crm:' || COALESCE(req.council, '') || ':' || req.crm || ':' || req.uf
                   WHEN req.has_doctor THEN '${LIS_DOCTOR_NO_DOCTOR_KEY}'
                   ELSE NULL END AS doctor_key
         FROM facts f
         JOIN req ON req.id = f.id
     ),
     grouped AS (
       SELECT doctor_key,
              bool_or(identified) AS identified,
              -- Coringa (CRM curto) não tem nome nem CRM: são vários "médicos" juntos.
              CASE WHEN bool_or(identified)
                   THEN (array_agg(name ORDER BY on_date DESC NULLS LAST) FILTER (WHERE name IS NOT NULL))[1]
              END AS name,
              CASE WHEN bool_or(identified) THEN max(council) END AS council,
              CASE WHEN bool_or(identified) THEN max(crm) END AS crm,
              CASE WHEN bool_or(identified) THEN max(uf) END AS uf,
              SUM(req)::int AS requisition_count,
              SUM(CASE WHEN req = 1 THEN requisition_value ELSE 0 END) AS requisition_value,
              SUM(pay)::int AS paid_count,
              SUM(paid_value) AS paid_value
         FROM keyed
        GROUP BY doctor_key
     )
     SELECT g.*, d.id AS doctor_id, u.name AS responsible_name
       FROM grouped g
       LEFT JOIN doctors d
         ON g.identified AND d.tenant_id = $1 AND d.crm = g.crm AND d.crm_uf = g.uf
        AND (g.council IS NULL OR g.council = 'CRM')
       LEFT JOIN users u ON u.id = d.responsible_user_id AND u.tenant_id = $1
       ${responsibleSql}
      ORDER BY g.requisition_value DESC, g.paid_value DESC, g.name ASC NULLS LAST`,
    params,
  );

  return result.rows.map((row) => ({
    doctorKey: row.doctor_key,
    doctorName: row.name,
    council: row.council,
    crm: row.crm,
    uf: row.uf,
    identified: row.identified === true,
    doctorId: row.doctor_id,
    responsibleName: row.responsible_name,
    requisitionCount: Number(row.requisition_count),
    requisitionValue: toNumber(row.requisition_value),
    paidCount: Number(row.paid_count),
    paidValue: toNumber(row.paid_value),
  }));
}

export interface SingleDoctorRevenueDb {
  requisitionCount: number;
  requisitionValue: number;
  paidCount: number;
  paidValue: number;
  lastRequisitionOn: string | null;
}

/**
 * Faturamento de UM cadastro (ficha do médico, D-336 item 6, D-338). Requisição pela data da
 * requisição e recebido pelo pagamento, em `[start, end]`; `lastRequisitionOn` é a maior data de
 * requisição de qualquer época.
 */
export async function getSingleDoctorRevenue(
  tx: DbTx,
  tenantId: string,
  doctorId: string,
  start: string,
  end: string,
): Promise<SingleDoctorRevenueDb> {
  const result = await tx.query<{
    requisition_count: number | string;
    requisition_value: string | number | null;
    paid_count: number | string;
    paid_value: string | number | null;
    last_requisition_on: string | null;
  }>(
    `WITH mine AS (
       SELECT r.id, r.total_value, r.requested_on
         FROM lis_requisitions r
         JOIN doctors d ON d.id = $2 AND d.tenant_id = $1 AND ${DOCTOR_MATCH}
        WHERE r.tenant_id = $1
     ),
     paid AS (
       SELECT p.requisition_id, SUM(p.paid_value) AS paid_value
         FROM lis_requisition_payments p JOIN mine ON mine.id = p.requisition_id
        WHERE p.tenant_id = $1 AND p.status = 'ativo' AND p.paid_on BETWEEN $3 AND $4
        GROUP BY p.requisition_id
       HAVING SUM(p.paid_value) > 0
     )
     SELECT (SELECT COUNT(*)::int FROM mine WHERE requested_on BETWEEN $3 AND $4) AS requisition_count,
            (SELECT COALESCE(SUM(total_value), 0) FROM mine WHERE requested_on BETWEEN $3 AND $4)
              AS requisition_value,
            (SELECT COUNT(*)::int FROM paid) AS paid_count,
            (SELECT COALESCE(SUM(paid_value), 0) FROM paid) AS paid_value,
            (SELECT to_char(MAX(requested_on), 'YYYY-MM-DD') FROM mine) AS last_requisition_on`,
    [tenantId, doctorId, start, end],
  );
  const row = result.rows[0];
  return {
    requisitionCount: Number(row?.requisition_count ?? 0),
    requisitionValue: toNumber(row?.requisition_value),
    paidCount: Number(row?.paid_count ?? 0),
    paidValue: toNumber(row?.paid_value),
    lastRequisitionOn: row?.last_requisition_on ?? null,
  };
}
