/**
 * Relatorio de Visitacao — API_CONTRACTS.md §14b, BUSINESS_RULES §15b
 * (CRMLAB-193, D-333). Leitura pura: sem audit.
 *
 * Escopo (D-333 item 5, sobre a D-329): gestor/admin veem o laboratorio ou o
 * usuario de `responsibleId`; o representante ve SO o escopo dele, e o
 * `responsibleId` que ele mandar e ignorado (nunca amplia o recorte).
 */
import {
  saoPauloToday,
  VISITATION_REPORT_MAX_PERIOD_DAYS,
  VISITATION_REPORT_STALE_DEFAULT_DAYS,
  VISITATION_REPORT_STALE_MAX_ROWS,
  VISITATION_REPORT_WEEKLY_MAX_DAYS,
  type DoctorAbcClass,
  type IsoDate,
  type VisitationReport,
  type VisitationReportCoverage,
  type VisitationReportCoverageByClass,
  type VisitationReportEvolutionPoint,
  type VisitationReportGranularity,
  type VisitationReportQuery,
  type VisitationReportRepresentativeRow,
  type VisitationReportStaleDoctor,
  type VisitationReportStaleQuery,
  type VisitationReportStaleResponse,
  type VisitStatus,
} from '@crm-lab/shared';
import type { DbClient } from '../db/types.js';
import type { TenantContext } from '../http/context.js';
import { BusinessError } from '../http/errors.js';
import {
  VisitationReportRepository,
  type CoverageCell,
  type DailyStatusCount,
  type VisitationReportCriteria,
} from '../repositories/visitation-report.repository.js';
import { assertVisitationRole, portfolioOwner } from './visitation-access.js';

const DAY_MS = 86_400_000;
/** Meia-noite de Sao Paulo em UTC (UTC-3 fixo, como `saoPauloToday`). */
const SAO_PAULO_MIDNIGHT_UTC = 'T03:00:00.000Z';

export interface VisitationReportService {
  summary(ctx: TenantContext, query: VisitationReportQuery): Promise<VisitationReport>;
  staleDoctors(ctx: TenantContext, query: VisitationReportStaleQuery): Promise<VisitationReportStaleResponse>;
}

export interface VisitationReportServiceDeps {
  db: DbClient;
  /** Relogio injetavel (testes de "dias sem visita"). */
  now?: () => Date;
}

function invalid(fields: Record<string, string>): BusinessError {
  return new BusinessError('VALIDATION_ERROR', { fields });
}

/** Dia local `YYYY-MM-DD` -> instante UTC da meia-noite de Sao Paulo. */
function localMidnight(date: IsoDate): Date {
  return new Date(`${date}${SAO_PAULO_MIDNIGHT_UTC}`);
}

function addDays(date: IsoDate, days: number): IsoDate {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS);
}

/** Percentual com uma casa; `null` sem base. */
export function percent(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
}

function oneDecimal(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10) / 10;
}

function coverageOf(portfolioDoctors: number, visitedDoctors: number): VisitationReportCoverage {
  return { portfolioDoctors, visitedDoctors, rate: percent(visitedDoctors, portfolioDoctors) };
}

function sumCoverage(cells: CoverageCell[]): VisitationReportCoverage {
  let portfolio = 0;
  let visited = 0;
  for (const cell of cells) {
    portfolio += cell.portfolioDoctors;
    visited += cell.visitedDoctors;
  }
  return coverageOf(portfolio, visited);
}

function coverageByClass(cells: CoverageCell[]): VisitationReportCoverageByClass {
  const of = (abc: DoctorAbcClass | null) => sumCoverage(cells.filter((cell) => cell.abcClass === abc));
  return { A: of('A'), B: of('B'), C: of('C'), unclassified: of(null) };
}

/** 1o dia do balde (segunda-feira da semana, ou dia 1 do mes). */
export function bucketOf(date: IsoDate, granularity: VisitationReportGranularity): IsoDate {
  if (granularity === 'month') return `${date.slice(0, 7)}-01`;
  const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay(); // 0 = domingo
  return addDays(date, -((weekday + 6) % 7));
}

function nextBucket(bucket: IsoDate, granularity: VisitationReportGranularity): IsoDate {
  if (granularity === 'week') return addDays(bucket, 7);
  const d = new Date(`${bucket}T00:00:00.000Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}

/** Todos os baldes que tocam `[from, to]`, zerados, preenchidos com as contagens diarias. */
export function buildEvolution(
  from: IsoDate,
  to: IsoDate,
  granularity: VisitationReportGranularity,
  daily: DailyStatusCount[],
): VisitationReportEvolutionPoint[] {
  const points = new Map<IsoDate, VisitationReportEvolutionPoint>();
  for (let bucket = bucketOf(from, granularity); bucket <= to; bucket = nextBucket(bucket, granularity)) {
    points.set(bucket, { bucket, total: 0, completed: 0, cancelled: 0, notReceived: 0 });
  }
  for (const row of daily) {
    const point = points.get(bucketOf(row.date, granularity));
    if (!point) continue;
    point.total += row.count;
    if (row.status === 'realizada') point.completed += row.count;
    else if (row.status === 'cancelada') point.cancelled += row.count;
    else if (row.status === 'nao_recebeu') point.notReceived += row.count;
  }
  return [...points.values()];
}

type StatusTotals = Record<VisitStatus, number>;

function emptyTotals(): StatusTotals {
  return { agendada: 0, realizada: 0, cancelada: 0, nao_recebeu: 0 };
}

const CLASS_ORDER: Record<DoctorAbcClass, number> = { A: 0, B: 1, C: 2 };

function classRank(abc: DoctorAbcClass | null): number {
  return abc === null ? 3 : CLASS_ORDER[abc];
}

export function createVisitationReportService(deps: VisitationReportServiceDeps): VisitationReportService {
  const repository = new VisitationReportRepository(deps.db);
  const now = deps.now ?? (() => new Date());

  /** Representante: sempre ele mesmo. Gestor/admin: o filtro (ou nada). */
  function ownerFor(ctx: TenantContext, responsibleId: string | undefined): string | undefined {
    return portfolioOwner(ctx) ?? responsibleId;
  }

  return {
    async summary(ctx, query) {
      assertVisitationRole(ctx);
      if (query.to < query.from) throw invalid({ to: 'A data final não pode ser anterior à inicial' });
      const spanDays = daysBetween(query.from, query.to) + 1;
      if (spanDays > VISITATION_REPORT_MAX_PERIOD_DAYS) {
        throw invalid({ to: `O período pode ter no máximo ${VISITATION_REPORT_MAX_PERIOD_DAYS} dias` });
      }
      const granularity: VisitationReportGranularity =
        query.granularity ?? (spanDays <= VISITATION_REPORT_WEEKLY_MAX_DAYS ? 'week' : 'month');
      const isOwnScope = portfolioOwner(ctx) !== undefined;
      const ownerId = ownerFor(ctx, query.responsibleId);

      const criteria: VisitationReportCriteria = {
        from: localMidnight(query.from),
        to: localMidnight(addDays(query.to, 1)),
        ownerId,
        purposeId: query.purposeId,
        abcClass: query.abcClass,
      };
      // Sem escopo de visita na tabela: cada linha recorta pelo responsavel DA visita.
      const tableCriteria: VisitationReportCriteria = { ...criteria, ownerId: undefined };

      const [daily, duration, coverageCells, reschedules, byResponsible, users, purposes] = await Promise.all([
        repository.dailyStatusCounts(ctx.tenantId, criteria),
        repository.durationStats(ctx.tenantId, criteria),
        repository.coverage(ctx.tenantId, tableCriteria),
        repository.reschedulesByResponsible(ctx.tenantId, criteria),
        repository.statusByResponsible(ctx.tenantId, tableCriteria),
        repository.eligibleUsers(ctx.tenantId),
        repository.purposeCounts(ctx.tenantId, criteria),
      ]);

      const totals = emptyTotals();
      for (const row of daily) totals[row.status] += row.count;
      const closed = totals.realizada + totals.cancelada + totals.nao_recebeu;

      const summaryCoverage = sumCoverage(
        ownerId === undefined ? coverageCells : coverageCells.filter((cell) => cell.responsibleId === ownerId),
      );

      // Tabela por representante.
      const statusByUser = new Map<string, StatusTotals>();
      for (const row of byResponsible) {
        const current = statusByUser.get(row.responsibleId) ?? emptyTotals();
        current[row.status] += row.count;
        statusByUser.set(row.responsibleId, current);
      }
      const rescheduleTable =
        ownerId === undefined
          ? reschedules
          : await repository.reschedulesByResponsible(ctx.tenantId, tableCriteria);
      const reschedulesByUser = new Map<string, number>();
      for (const row of rescheduleTable) {
        if (row.responsibleId !== null) reschedulesByUser.set(row.responsibleId, row.count);
      }

      const rows: VisitationReportRepresentativeRow[] = users
        .filter((user) =>
          ownerId !== undefined
            ? user.id === ownerId
            : user.role === 'representative' || user.hasDoctors || statusByUser.has(user.id),
        )
        .map((user) => {
          const cells = coverageCells.filter((cell) => cell.responsibleId === user.id);
          const coverage = sumCoverage(cells);
          const status = statusByUser.get(user.id) ?? emptyTotals();
          return {
            responsible: { id: user.id, name: user.name },
            portfolioDoctors: coverage.portfolioDoctors,
            visitedDoctors: coverage.visitedDoctors,
            coverage,
            coverageByClass: coverageByClass(cells),
            completed: status.realizada,
            cancelled: status.cancelada,
            notReceived: status.nao_recebeu,
            reschedules: reschedulesByUser.get(user.id) ?? 0,
          };
        });

      return {
        period: { from: query.from, to: query.to },
        granularity,
        scope: isOwnScope ? 'own' : 'all',
        summary: {
          scheduled: totals.agendada,
          completed: totals.realizada,
          cancelled: totals.cancelada,
          notReceived: totals.nao_recebeu,
          total: totals.agendada + closed,
          reschedules: reschedules.reduce((sum, row) => sum + row.count, 0),
          completionRate: percent(totals.realizada, closed),
          averageDurationMinutes: oneDecimal(duration.averageMinutes),
          durationSampleSize: duration.sampleSize,
          coverage: summaryCoverage,
        },
        byRepresentative: rows,
        byPurpose: purposes.map((purpose) => ({
          purpose: { id: purpose.id, name: purpose.name, color: purpose.color },
          total: purpose.total,
          completed: purpose.completed,
        })),
        evolution: buildEvolution(query.from, query.to, granularity, daily),
      };
    },

    async staleDoctors(ctx, query) {
      assertVisitationRole(ctx);
      const days = query.days ?? VISITATION_REPORT_STALE_DEFAULT_DAYS;
      const referenceDate = saoPauloToday(now());
      // "ha mais de X dias" = ultima visita num dia local ANTERIOR a (hoje - X).
      const cutoff = localMidnight(addDays(referenceDate, -days));
      const found = await repository.staleDoctors(ctx.tenantId, {
        ownerId: ownerFor(ctx, query.responsibleId),
        abcClass: query.abcClass,
        cutoff,
      });

      const doctors: VisitationReportStaleDoctor[] = found.map((row) => {
        const lastDate = row.lastVisitAt === null ? null : saoPauloToday(row.lastVisitAt);
        return {
          id: row.id,
          name: row.name,
          crm: row.crm,
          crmUf: row.crmUf,
          specialty: row.specialty,
          abcClass: row.abcClass,
          responsible:
            row.responsibleId !== null ? { id: row.responsibleId, name: row.responsibleName ?? '' } : null,
          lastVisitAt: row.lastVisitAt === null ? null : row.lastVisitAt.toISOString(),
          daysSinceLastVisit: lastDate === null ? null : daysBetween(lastDate, referenceDate),
        };
      });

      doctors.sort((a, b) => {
        const byClass = classRank(a.abcClass) - classRank(b.abcClass);
        if (byClass !== 0) return byClass;
        const aDays = a.daysSinceLastVisit ?? Number.POSITIVE_INFINITY;
        const bDays = b.daysSinceLastVisit ?? Number.POSITIVE_INFINITY;
        if (aDays !== bDays) return bDays - aDays;
        return a.name.localeCompare(b.name, 'pt-BR');
      });

      return {
        days,
        referenceDate,
        doctors: doctors.slice(0, VISITATION_REPORT_STALE_MAX_ROWS),
        total: doctors.length,
        truncated: doctors.length > VISITATION_REPORT_STALE_MAX_ROWS,
      };
    },
  };
}
