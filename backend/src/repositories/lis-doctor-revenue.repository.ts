/**
 * Faturamento por médico solicitante (CRMLAB-198, D-336). Só SQL.
 *
 * É o ÚNICO lugar que liga `lis_budgets` a `doctors` (D-335 item 5): o relatório
 * (`GET /lis-budgets/by-doctor`), a ficha (`GET /doctors/:id/revenue`) e a base da curva
 * ABC (`doctor-abc.repository.ts`) usam os mesmos CTEs daqui.
 *
 * Regras (D-336 itens 1–3):
 *  - médico da requisição = o de qualquer linha dela com o médico preenchido, a de
 *    `updated_at` mais recente (`doctorOfRequisitionCte`);
 *  - valores = a linha da dedupe por requisição (maior `paid_value`, BUSINESS_RULES §11.2),
 *    a mesma dos KPIs de Resultados — os totais batem;
 *  - identificado = CRM com `LIS_DOCTOR_MIN_CRM_DIGITS`+ dígitos e UF; abaixo disso é o coringa
 *    do Bitlab (CRM `1`: sem médico ou pedido da enfermagem), uma linha só `no-doctor`;
 *  - vínculo com `doctors` = identificado, CRM + UF, conselho `CRM` ou vazio.
 */
import { LIS_DOCTOR_MIN_CRM_DIGITS, LIS_DOCTOR_NO_DOCTOR_KEY } from '@crm-lab/shared';
import type { DbTx } from '../db/types.js';
import { summaryFilterClauses, type SummaryFilters } from './lis-analytics.repository.js';
import { toNumber } from './row-mappers.js';

/**
 * CTE `doc(requisition_number, name, council, crm, uf, identified)`. `tenantParam` é o
 * placeholder do tenant (`$1`).
 */
export function doctorOfRequisitionCte(tenantParam: string): string {
  return `doc AS (
       SELECT requisition_number, name, council, crm, uf,
              (crm IS NOT NULL AND length(crm) >= ${LIS_DOCTOR_MIN_CRM_DIGITS} AND uf IS NOT NULL) AS identified
         FROM (
           SELECT DISTINCT ON (requisition_number) requisition_number,
                  requesting_doctor_name AS name, requesting_doctor_council AS council,
                  requesting_doctor_crm AS crm, requesting_doctor_uf AS uf
             FROM lis_budgets
            WHERE tenant_id = ${tenantParam} AND requisition_number IS NOT NULL
              AND (requesting_doctor_name IS NOT NULL OR requesting_doctor_crm IS NOT NULL)
            ORDER BY requisition_number, updated_at DESC
         ) latest
     )`;
}

/** Condição de "esta requisição é deste cadastro" (`d` = `doctors`, `doc` = CTE acima). */
export const DOCTOR_MATCH = `doc.identified AND doc.crm = d.crm AND doc.uf = d.crm_uf
                             AND (doc.council IS NULL OR doc.council = 'CRM')`;

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
 * médicos cadastrados daquela carteira.
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
    `WITH ${doctorOfRequisitionCte('$1')},
     issued AS (
       SELECT DISTINCT ON (requisition_number) requisition_number, requisition_value, issued_on
         FROM lis_budgets
        WHERE tenant_id = $1 AND requisition_number IS NOT NULL
          AND issued_on BETWEEN ${start} AND ${end}${extraSql}
        ORDER BY requisition_number, paid_value DESC
     ),
     paid AS (
       SELECT requisition_number, paid_value, paid_on
         FROM (
           SELECT DISTINCT ON (requisition_number) requisition_number, paid_value, paid_on
             FROM lis_budgets
            WHERE tenant_id = $1 AND requisition_number IS NOT NULL${extraSql}
            ORDER BY requisition_number, paid_value DESC
         ) r
        WHERE paid_on BETWEEN ${start} AND ${end} AND COALESCE(paid_value, 0) > 0
     ),
     facts AS (
       SELECT requisition_number, COALESCE(requisition_value, 0) AS requisition_value,
              0::numeric AS paid_value, 1 AS req, 0 AS pay, issued_on AS on_date
         FROM issued
       UNION ALL
       SELECT requisition_number, 0, paid_value, 0, 1, paid_on FROM paid
     ),
     keyed AS (
       SELECT f.*, doc.name, doc.council, doc.crm, doc.uf, COALESCE(doc.identified, false) AS identified,
              CASE WHEN doc.identified THEN 'crm:' || COALESCE(doc.council, '') || ':' || doc.crm || ':' || doc.uf
                   WHEN doc.requisition_number IS NOT NULL THEN '${LIS_DOCTOR_NO_DOCTOR_KEY}'
                   ELSE NULL END AS doctor_key
         FROM facts f
         LEFT JOIN doc USING (requisition_number)
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
      ORDER BY g.paid_value DESC, g.requisition_value DESC, g.name ASC NULLS LAST`,
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
 * Faturamento de UM cadastro (ficha do médico, D-336 item 6). Requisição pela emissão e recebido
 * pelo pagamento, em `[start, end]`; `lastRequisitionOn` é a maior emissão de qualquer época.
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
    `WITH ${doctorOfRequisitionCte('$1')},
     mine AS (
       SELECT doc.requisition_number
         FROM doc JOIN doctors d ON d.id = $2 AND d.tenant_id = $1 AND ${DOCTOR_MATCH}
     ),
     dedupe AS (
       SELECT DISTINCT ON (b.requisition_number) b.requisition_number, b.requisition_value,
              b.paid_value, b.paid_on, b.issued_on
         FROM lis_budgets b JOIN mine USING (requisition_number)
        WHERE b.tenant_id = $1
        ORDER BY b.requisition_number, b.paid_value DESC
     ),
     issued AS (
       SELECT DISTINCT ON (b.requisition_number) b.requisition_number, b.requisition_value
         FROM lis_budgets b JOIN mine USING (requisition_number)
        WHERE b.tenant_id = $1 AND b.issued_on BETWEEN $3 AND $4
        ORDER BY b.requisition_number, b.paid_value DESC
     )
     SELECT (SELECT COUNT(*)::int FROM issued) AS requisition_count,
            (SELECT COALESCE(SUM(requisition_value), 0) FROM issued) AS requisition_value,
            (SELECT COUNT(*)::int FROM dedupe
              WHERE paid_on BETWEEN $3 AND $4 AND COALESCE(paid_value, 0) > 0) AS paid_count,
            (SELECT COALESCE(SUM(paid_value), 0) FROM dedupe
              WHERE paid_on BETWEEN $3 AND $4 AND COALESCE(paid_value, 0) > 0) AS paid_value,
            (SELECT to_char(MAX(b.issued_on), 'YYYY-MM-DD')
               FROM lis_budgets b JOIN mine USING (requisition_number)
              WHERE b.tenant_id = $1) AS last_requisition_on`,
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
