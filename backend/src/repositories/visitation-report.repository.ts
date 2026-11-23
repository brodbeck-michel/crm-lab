/**
 * Agregacoes do Relatorio de Visitacao — API_CONTRACTS.md §14b (CRMLAB-193,
 * D-333). SEM regra de negocio: quem ve o que (escopo do representante), as
 * formulas (taxa, cobertura, media) e os baldes da evolucao sao do
 * `VisitationReportService`. Aqui so contagens cruas.
 *
 * Todo metodo abre `db.withTenant(tenantId, ...)` (camada 3 do isolamento) E
 * filtra `tenant_id = $1` explicitamente. Nenhum caminho usa `withoutTenant()`.
 */
import type { DoctorAbcClass, VisitPurposeColor, VisitStatus } from '@crm-lab/shared';
import type { DbClient } from '../db/types.js';
import { visitScopeSql } from './visit.repository.js';

/** Perfis que podem ter carteira/visita (D-329 item 5). */
const ELIGIBLE_ROLES_SQL = `('representative', 'manager', 'admin')`;

/** Data local de Sao Paulo (UTC-3 fixo, como `saoPauloToday`) de um `timestamptz`. */
function localDateSql(column: string): string {
  return `to_char((${column} AT TIME ZONE 'UTC') - INTERVAL '3 hours', 'YYYY-MM-DD')`;
}

export interface VisitationReportCriteria {
  /** `[from, to)` em UTC — o service converte os dias locais. */
  from: Date;
  to: Date;
  /** Escopo da D-329 (representante logado ou o filtrado pelo gestor). Ausente = laboratorio. */
  ownerId?: string;
  purposeId?: string;
  abcClass?: DoctorAbcClass;
}

/** Contagem diaria por status (base dos cards e da evolucao). */
export interface DailyStatusCount {
  /** `YYYY-MM-DD` local de Sao Paulo. */
  date: string;
  status: VisitStatus;
  count: number;
}

export interface DurationStats {
  averageMinutes: number | null;
  sampleSize: number;
}

/** Medicos ativos agrupados por (responsavel, classe), e quantos foram visitados. */
export interface CoverageCell {
  responsibleId: string | null;
  abcClass: DoctorAbcClass | null;
  portfolioDoctors: number;
  visitedDoctors: number;
}

export interface ResponsibleStatusCount {
  responsibleId: string;
  status: VisitStatus;
  count: number;
}

export interface ResponsibleRescheduleCount {
  responsibleId: string | null;
  count: number;
}

export interface ReportUser {
  id: string;
  name: string;
  role: string;
  hasDoctors: boolean;
}

export interface PurposeCount {
  id: string;
  name: string;
  color: VisitPurposeColor;
  total: number;
  completed: number;
}

export interface StaleCriteria {
  ownerId?: string;
  abcClass?: DoctorAbcClass;
  /** So entra quem tem a ultima realizada ANTES disto (ou nunca teve). */
  cutoff: Date;
}

export interface StaleDoctorRow {
  id: string;
  name: string;
  crm: string | null;
  crmUf: string | null;
  specialty: string | null;
  abcClass: DoctorAbcClass | null;
  responsibleId: string | null;
  responsibleName: string | null;
  lastVisitAt: Date | null;
}

/**
 * Filtro das visitas do periodo. `$1` = tenant, `$2`/`$3` = janela; o resto e
 * empilhado em `params`. Exige `doctor_visits v JOIN doctors d`.
 */
function visitWhere(criteria: VisitationReportCriteria, params: unknown[], withPeriod = true): string[] {
  const where = ['v.tenant_id = $1'];
  if (withPeriod) where.push('v.scheduled_at >= $2::timestamptz', 'v.scheduled_at < $3::timestamptz');
  if (criteria.ownerId !== undefined) {
    params.push(criteria.ownerId);
    where.push(visitScopeSql(params.length));
  }
  if (criteria.purposeId !== undefined) {
    params.push(criteria.purposeId);
    where.push(`v.purpose_id = $${params.length}`);
  }
  if (criteria.abcClass !== undefined) {
    params.push(criteria.abcClass);
    where.push(`d.abc_class = $${params.length}`);
  }
  return where;
}

function baseParams(tenantId: string, criteria: VisitationReportCriteria): unknown[] {
  return [tenantId, criteria.from.toISOString(), criteria.to.toISOString()];
}

export class VisitationReportRepository {
  constructor(private readonly db: DbClient) {}

  /** Visitas do periodo por dia local e status. */
  async dailyStatusCounts(tenantId: string, criteria: VisitationReportCriteria): Promise<DailyStatusCount[]> {
    const params = baseParams(tenantId, criteria);
    const where = visitWhere(criteria, params);
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{ day: string; status: VisitStatus; count: number | string }>(
        `SELECT ${localDateSql('v.scheduled_at')} AS day, v.status, COUNT(*)::int AS count
           FROM doctor_visits v
           JOIN doctors d ON d.id = v.doctor_id
          WHERE ${where.join(' AND ')}
          GROUP BY 1, 2`,
        params,
      );
      return result.rows.map((row) => ({ date: row.day, status: row.status, count: Number(row.count) }));
    });
  }

  /** Media de (check-out - check-in) das realizadas com os dois horarios. */
  async durationStats(tenantId: string, criteria: VisitationReportCriteria): Promise<DurationStats> {
    const params = baseParams(tenantId, criteria);
    const where = visitWhere(criteria, params);
    where.push(
      `v.status = 'realizada'`,
      'v.check_in_at IS NOT NULL',
      'v.check_out_at IS NOT NULL',
      'v.check_out_at >= v.check_in_at',
    );
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{ avg_seconds: number | string | null; sample: number | string }>(
        `SELECT AVG(EXTRACT(EPOCH FROM (v.check_out_at - v.check_in_at))) AS avg_seconds,
                COUNT(*)::int AS sample
           FROM doctor_visits v
           JOIN doctors d ON d.id = v.doctor_id
          WHERE ${where.join(' AND ')}`,
        params,
      );
      const row = result.rows[0];
      const sample = Number(row?.sample ?? 0);
      const avg = row?.avg_seconds;
      return {
        averageMinutes: sample > 0 && avg !== null && avg !== undefined ? Number(avg) / 60 : null,
        sampleSize: sample,
      };
    });
  }

  /**
   * Medicos ATIVOS por (responsavel, classe) e quantos tiveram visita
   * `realizada` no periodo — de qualquer responsavel, respeitando a finalidade.
   * `ownerId` aqui e a CARTEIRA (medicos dele), nao o escopo de visita.
   */
  async coverage(tenantId: string, criteria: VisitationReportCriteria): Promise<CoverageCell[]> {
    const params: unknown[] = baseParams(tenantId, criteria);
    const doctorWhere = ['d.tenant_id = $1', 'd.is_active = TRUE'];
    const visitFilter = [
      'v.doctor_id = d.id',
      `v.status = 'realizada'`,
      'v.scheduled_at >= $2::timestamptz',
      'v.scheduled_at < $3::timestamptz',
    ];
    if (criteria.ownerId !== undefined) {
      params.push(criteria.ownerId);
      doctorWhere.push(`d.responsible_user_id = $${params.length}`);
    }
    if (criteria.abcClass !== undefined) {
      params.push(criteria.abcClass);
      doctorWhere.push(`d.abc_class = $${params.length}`);
    }
    if (criteria.purposeId !== undefined) {
      params.push(criteria.purposeId);
      visitFilter.push(`v.purpose_id = $${params.length}`);
    }
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{
        responsible_user_id: string | null;
        abc_class: DoctorAbcClass | null;
        portfolio: number | string;
        visited: number | string;
      }>(
        `SELECT d.responsible_user_id, d.abc_class,
                COUNT(*)::int AS portfolio,
                COUNT(*) FILTER (WHERE EXISTS (
                  SELECT 1 FROM doctor_visits v WHERE ${visitFilter.join(' AND ')}
                ))::int AS visited
           FROM doctors d
          WHERE ${doctorWhere.join(' AND ')}
          GROUP BY d.responsible_user_id, d.abc_class`,
        params,
      );
      return result.rows.map((row) => ({
        responsibleId: row.responsible_user_id,
        abcClass: row.abc_class,
        portfolioDoctors: Number(row.portfolio),
        visitedDoctors: Number(row.visited),
      }));
    });
  }

  /** Reagendamentos com `changed_at` no periodo, da visita no escopo/filtros, por responsavel da visita. */
  async reschedulesByResponsible(
    tenantId: string,
    criteria: VisitationReportCriteria,
  ): Promise<ResponsibleRescheduleCount[]> {
    const params = baseParams(tenantId, criteria);
    const where = visitWhere(criteria, params, false);
    where.push('r.tenant_id = $1', 'r.changed_at >= $2::timestamptz', 'r.changed_at < $3::timestamptz');
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{ responsible_user_id: string | null; count: number | string }>(
        `SELECT v.responsible_user_id, COUNT(*)::int AS count
           FROM doctor_visit_reschedules r
           JOIN doctor_visits v ON v.id = r.visit_id
           JOIN doctors d ON d.id = v.doctor_id
          WHERE ${where.join(' AND ')}
          GROUP BY v.responsible_user_id`,
        params,
      );
      return result.rows.map((row) => ({ responsibleId: row.responsible_user_id, count: Number(row.count) }));
    });
  }

  /** Visitas do periodo por responsavel DA VISITA e status (tabela "por representante"). */
  async statusByResponsible(tenantId: string, criteria: VisitationReportCriteria): Promise<ResponsibleStatusCount[]> {
    const params = baseParams(tenantId, criteria);
    const where = visitWhere(criteria, params);
    where.push('v.responsible_user_id IS NOT NULL');
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{ responsible_user_id: string; status: VisitStatus; count: number | string }>(
        `SELECT v.responsible_user_id, v.status, COUNT(*)::int AS count
           FROM doctor_visits v
           JOIN doctors d ON d.id = v.doctor_id
          WHERE ${where.join(' AND ')}
          GROUP BY 1, 2`,
        params,
      );
      return result.rows.map((row) => ({
        responsibleId: row.responsible_user_id,
        status: row.status,
        count: Number(row.count),
      }));
    });
  }

  /** Usuarios ativos de perfil elegivel, com a marca "tem medico na carteira". */
  async eligibleUsers(tenantId: string): Promise<ReportUser[]> {
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{ id: string; name: string; role: string; has_doctors: boolean }>(
        `SELECT u.id, u.name, u.role,
                EXISTS (SELECT 1 FROM doctors d WHERE d.tenant_id = $1 AND d.responsible_user_id = u.id) AS has_doctors
           FROM users u
          WHERE u.tenant_id = $1
            AND u.is_active = TRUE
            AND u.role IN ${ELIGIBLE_ROLES_SQL}
          ORDER BY u.name ASC, u.id ASC`,
        [tenantId],
      );
      return result.rows.map((row) => ({ id: row.id, name: row.name, role: row.role, hasDoctors: row.has_doctors }));
    });
  }

  /** Visitas do periodo por finalidade (so as que tem visita). */
  async purposeCounts(tenantId: string, criteria: VisitationReportCriteria): Promise<PurposeCount[]> {
    const params = baseParams(tenantId, criteria);
    const where = visitWhere(criteria, params);
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{
        id: string;
        name: string;
        color: VisitPurposeColor;
        total: number | string;
        completed: number | string;
      }>(
        `SELECT vp.id, vp.name, vp.color,
                COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE v.status = 'realizada')::int AS completed
           FROM doctor_visits v
           JOIN doctors d ON d.id = v.doctor_id
           JOIN visit_purposes vp ON vp.id = v.purpose_id
          WHERE ${where.join(' AND ')}
          GROUP BY vp.id, vp.name, vp.color
          ORDER BY total DESC, vp.name ASC`,
        params,
      );
      return result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        color: row.color,
        total: Number(row.total),
        completed: Number(row.completed),
      }));
    });
  }

  /**
   * Medicos ATIVOS sem visita realizada desde `cutoff` (ou nunca). A ultima
   * visita e de qualquer responsavel, pelo `check_out_at` (realizada sempre tem — CHECK da 050).
   */
  async staleDoctors(tenantId: string, criteria: StaleCriteria): Promise<StaleDoctorRow[]> {
    const params: unknown[] = [tenantId, criteria.cutoff.toISOString()];
    const where = ['d.tenant_id = $1', 'd.is_active = TRUE'];
    if (criteria.ownerId !== undefined) {
      params.push(criteria.ownerId);
      where.push(`d.responsible_user_id = $${params.length}`);
    }
    if (criteria.abcClass !== undefined) {
      params.push(criteria.abcClass);
      where.push(`d.abc_class = $${params.length}`);
    }
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{
        id: string;
        name: string;
        crm: string | null;
        crm_uf: string | null;
        specialty: string | null;
        abc_class: DoctorAbcClass | null;
        responsible_user_id: string | null;
        responsible_name: string | null;
        last_visit_at: Date | string | null;
      }>(
        `SELECT * FROM (
           SELECT d.id, d.name, d.crm, d.crm_uf, d.specialty, d.abc_class,
                  d.responsible_user_id, u.name AS responsible_name,
                  (SELECT MAX(v.check_out_at)
                     FROM doctor_visits v
                    WHERE v.tenant_id = $1 AND v.doctor_id = d.id AND v.status = 'realizada') AS last_visit_at
             FROM doctors d
             LEFT JOIN users u ON u.id = d.responsible_user_id
            WHERE ${where.join(' AND ')}
         ) s
         WHERE s.last_visit_at IS NULL OR s.last_visit_at < $2::timestamptz`,
        params,
      );
      return result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        crm: row.crm,
        crmUf: row.crm_uf,
        specialty: row.specialty,
        abcClass: row.abc_class,
        responsibleId: row.responsible_user_id,
        responsibleName: row.responsible_name,
        lastVisitAt:
          row.last_visit_at === null
            ? null
            : row.last_visit_at instanceof Date
              ? row.last_visit_at
              : new Date(row.last_visit_at),
      }));
    });
  }
}
