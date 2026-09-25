/**
 * AnalyticsService — SERVICES.md §9. READ-ONLY.
 *
 * ============================================================================
 * A REGRA QUE MANDA AQUI: "um numero, uma origem" (BUSINESS_RULES.md §5)
 * ============================================================================
 * Todo numero deste service sai de uma agregacao sobre `proposals`, feita na
 * query (`repositories/analytics.repository.ts`). Nao existe contador separado,
 * nao existe coluna `revenue` materializada, e este arquivo NAO importa o
 * ProposalService: `proposals` e lido direto, em modo somente leitura, que e
 * exatamente como SERVICES.md §9 define o servico.
 *
 * ============================================================================
 * DINHEIRO E NUMERO
 * ============================================================================
 * `revenue`, `averageTicket`, `totalValue` e `value` sao `number` decimais
 * (`15000` / `179.8`), nunca `"R$ 15.000,00"`. API_CONTRACTS.md §5 mostrava
 * string formatada no exemplo; isso contraria FRONTEND_BACKEND.md ("Datas e
 * Dinheiro": numero no fio, formatacao no frontend) e os tipos de
 * `@crm-lab/shared`, que ja sao `number`. Seguimos o tipo — divergencia
 * registrada em docs/DECISIONS.md (D-018) e o doc foi corrigido.
 *
 * ============================================================================
 * AS DUAS JANELAS DE TEMPO
 * ============================================================================
 *   funil / conversao / motivos de perda -> propostas CRIADAS no periodo
 *   receita / ticket medio / performers  -> propostas GANHAS no periodo
 *
 * Nao e descuido: WORKFLOWS.md §10 define o funil por criacao e a conversao
 * como "ganhos / total criadas"; BUSINESS_RULES.md §5 calcula receita por
 * `closedAt`. Detalhes no cabecalho do repositorio.
 *
 * ============================================================================
 * PERMISSAO DENTRO DO TENANT
 * ============================================================================
 * Isolamento entre tenants (RLS + filtro por `tenant_id`) NAO e a unica
 * fronteira: dentro do laboratorio, atendente ve so as proprias metricas
 * (`partial: true`), gestor e admin veem o time. `platform_operator` nao ve
 * nada — o console da plataforma nao tem caminho para dado de laboratorio
 * (SECURITY.md "Console de Plataforma").
 *
 * ============================================================================
 * CACHE (5 min, SERVICES.md §9) — o detalhe que seria um vazamento
 * ============================================================================
 * A chave e `analytics:<tenantId>:<escopo>:<relatorio>:<periodo>`.
 *
 * O `<escopo>` E OBRIGATORIO na chave. Cachear so por (tenant, periodo) faria o
 * atendente que consulta depois do gestor receber os numeros do TIME inteiro —
 * um vazamento de permissao com cara de otimizacao. Escopo do gestor/admin e
 * `all`; o do atendente e `user:<userId>`, entao os dois nunca colidem. Ha
 * teste para exatamente esse caso.
 */
import type {
  FunnelReport,
  LossReason,
  PipelineSnapshot,
  ProposalStatus,
  TeamMemberPerformance,
  TeamReport,
} from '@crm-lab/shared';
import { LOSS_REASONS, PROPOSAL_STATUSES, TERMINAL_STATUSES } from '@crm-lab/shared';
import type { DbClient } from '../db/types.js';
import type { TenantContext } from '../http/context.js';
import { BusinessError } from '../http/errors.js';
import type { CacheService } from '../lib/cache.js';
import * as analyticsRepo from '../repositories/analytics.repository.js';
import type { AnalyticsScope, PeriodBounds } from '../repositories/analytics.repository.js';

/** TTL de analytics: 5 minutos (SERVICES.md §9). */
export const ANALYTICS_CACHE_TTL_SECONDS = 300;

/** Quantos atendentes aparecem em `topPerformers`. */
export const TOP_PERFORMERS_LIMIT = 5;

/** Periodo padrao quando o cliente nao informa datas: ultimos 30 dias. */
export const DEFAULT_PERIOD_DAYS = 30;

const MS_PER_DAY = 86_400_000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Intervalo de datas (YYYY-MM-DD), como pede a assinatura de SERVICES.md §9. */
export interface DateRange {
  startDate?: string;
  endDate?: string;
}

/** Periodo ja validado e normalizado. `endDate` e INCLUSIVO para o cliente. */
export interface ResolvedPeriod {
  startDate: string;
  endDate: string;
  bounds: PeriodBounds;
}

export interface AnalyticsService {
  getConversionFunnel(ctx: TenantContext, period: DateRange): Promise<FunnelReport>;
  getPipelineSnapshot(ctx: TenantContext): Promise<PipelineSnapshot>;
  /** gestor/admin. Atendente recebe FORBIDDEN. */
  getTeamPerformance(ctx: TenantContext, period: DateRange): Promise<TeamReport>;
}

export interface AnalyticsServiceDeps {
  db: DbClient;
  cache: CacheService;
  /** Injetavel para teste de borda de data sem depender do relogio da maquina. */
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Periodo
// ---------------------------------------------------------------------------

/** `Date` -> `YYYY-MM-DD` em UTC (nunca no fuso da maquina). */
function toUtcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Meia-noite UTC do dia informado, em epoch ms. `NaN` se a data nao existe. */
function utcMidnight(day: string): number {
  const parsed = Date.parse(`${day}T00:00:00.000Z`);
  if (Number.isNaN(parsed)) return Number.NaN;
  // `Date.parse` aceita 2026-02-31 em alguns runtimes; a volta detecta.
  return toUtcDay(new Date(parsed)) === day ? parsed : Number.NaN;
}

/**
 * Valida e normaliza o intervalo.
 *
 * - ausente -> ultimos `DEFAULT_PERIOD_DAYS` dias, terminando hoje (UTC)
 * - formato invalido / data inexistente -> VALIDATION_ERROR com `details.fields`
 * - invertido (`startDate > endDate`) -> VALIDATION_ERROR em `endDate`
 *
 * `endDate` e inclusivo para quem chama: `2026-08-31` cobre ate
 * `2026-08-31 23:59:59.999Z`. Internamente vira `< 2026-09-01 00:00:00`, que e
 * a unica forma de nao perder o ultimo dia por causa de fracao de segundo.
 */
export function resolvePeriod(range: DateRange, now: Date): ResolvedPeriod {
  const fields: Record<string, string> = {};

  const check = (key: 'startDate' | 'endDate'): number | null => {
    const raw = range[key];
    if (raw === undefined || raw === null || raw === '') return null;
    if (typeof raw !== 'string' || !DATE_PATTERN.test(raw)) {
      fields[key] = 'Data deve estar no formato YYYY-MM-DD';
      return null;
    }
    const ms = utcMidnight(raw);
    if (Number.isNaN(ms)) {
      fields[key] = 'Data inexistente no calendario';
      return null;
    }
    return ms;
  };

  const startMs = check('startDate');
  const endMs = check('endDate');
  if (Object.keys(fields).length > 0) {
    throw new BusinessError('VALIDATION_ERROR', { fields });
  }

  const todayMs = utcMidnight(toUtcDay(now));
  const resolvedEnd = endMs ?? todayMs;
  const resolvedStart = startMs ?? resolvedEnd - (DEFAULT_PERIOD_DAYS - 1) * MS_PER_DAY;

  if (resolvedStart > resolvedEnd) {
    throw new BusinessError('VALIDATION_ERROR', {
      fields: { endDate: 'endDate deve ser igual ou posterior a startDate' },
    });
  }

  const startDate = toUtcDay(new Date(resolvedStart));
  const endDate = toUtcDay(new Date(resolvedEnd));
  return {
    startDate,
    endDate,
    bounds: {
      start: `${startDate} 00:00:00`,
      endExclusive: `${toUtcDay(new Date(resolvedEnd + MS_PER_DAY))} 00:00:00`,
    },
  };
}

// ---------------------------------------------------------------------------
// Escopo e permissao
// ---------------------------------------------------------------------------

const TEAM_ROLES = ['manager', 'admin'] as const;

/**
 * O console da plataforma nao le dado de laboratorio. A rota ja barra com
 * `denyPlatformOperator()`; o service confere de novo ("a UI esconde, o
 * servidor recusa" — e o service tambem e chamado sem middleware).
 */
function assertLabUser(ctx: TenantContext): void {
  if (ctx.role === 'platform_operator') {
    throw new BusinessError('FORBIDDEN', { requiredRoles: ['attendant', 'manager', 'admin'] });
  }
}

function assertTeamRole(ctx: TenantContext): void {
  if (ctx.role !== 'manager' && ctx.role !== 'admin') {
    throw new BusinessError('FORBIDDEN', { requiredRoles: [...TEAM_ROLES] });
  }
}

/** Atendente = so as proprias propostas. Gestor/admin = o time. */
export function scopeOf(ctx: TenantContext): AnalyticsScope {
  return ctx.role === 'attendant'
    ? { tenantId: ctx.tenantId, userId: ctx.userId }
    : { tenantId: ctx.tenantId };
}

/** Segmento de cache que representa o recorte de visibilidade do usuario. */
export function scopeKey(scope: AnalyticsScope): string {
  return scope.userId === undefined ? 'all' : `user:${scope.userId}`;
}

export function cachePrefix(tenantId: string): string {
  return `analytics:${tenantId}:`;
}

/**
 * Chave completa. Ordem: tenant -> escopo -> relatorio -> periodo. Tudo que
 * muda o resultado esta na chave; nada que muda o resultado fica de fora.
 */
export function cacheKey(
  tenantId: string,
  scope: AnalyticsScope,
  report: string,
  periodPart = 'now',
): string {
  return `${cachePrefix(tenantId)}${scopeKey(scope)}:${report}:${periodPart}`;
}

// ---------------------------------------------------------------------------
// Aritmetica — um lugar so
// ---------------------------------------------------------------------------

/** Arredonda para centavos, evitando o lixo de ponto flutuante da soma. */
export function toMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Percentual com 2 casas. `total` zero -> 0 (nunca `NaN`/`Infinity`). */
export function percent(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 10000) / 100;
}

/** Media que NAO divide por zero: sem ganhos, ticket medio e 0. */
export function average(total: number, count: number): number {
  if (count <= 0) return 0;
  return toMoney(total / count);
}

const OPEN_STATUSES: readonly ProposalStatus[] = PROPOSAL_STATUSES.filter(
  (status) => !TERMINAL_STATUSES.includes(status),
);

function emptyFunnelCounts(): Record<ProposalStatus, number> {
  return Object.fromEntries(PROPOSAL_STATUSES.map((s) => [s, 0])) as Record<
    ProposalStatus,
    number
  >;
}

/** As 5 chaves de LOSS_REASONS, sempre. Zero onde nao houve perda. */
function emptyLossReasons(): Record<LossReason, number> {
  return Object.fromEntries(LOSS_REASONS.map((r) => [r, 0])) as Record<LossReason, number>;
}

function isLossReason(value: string | null): value is LossReason {
  return value !== null && (LOSS_REASONS as readonly string[]).includes(value);
}

function isProposalStatus(value: string): value is ProposalStatus {
  return (PROPOSAL_STATUSES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function createAnalyticsService(deps: AnalyticsServiceDeps): AnalyticsService {
  const { db, cache } = deps;
  const now = deps.now ?? ((): Date => new Date());

  /** Le do cache ou calcula e grava. Uma unica porta para os tres relatorios. */
  const cached = async <T>(key: string, compute: () => Promise<T>): Promise<T> => {
    const hit = await cache.get<T>(key);
    if (hit) return hit;
    const value = await compute();
    await cache.set(key, value, ANALYTICS_CACHE_TTL_SECONDS);
    return value;
  };

  const getConversionFunnel = async (
    ctx: TenantContext,
    range: DateRange,
  ): Promise<FunnelReport> => {
    assertLabUser(ctx);
    const period = resolvePeriod(range, now());
    const scope = scopeOf(ctx);
    const key = cacheKey(
      ctx.tenantId,
      scope,
      'conversion',
      `${period.startDate}_${period.endDate}`,
    );

    return cached(key, async () => {
      const data = await db.withTenant(ctx.tenantId, async (tx) => ({
        byStatus: await analyticsRepo.countByStatusCreatedIn(tx, scope, period.bounds),
        lossReasons: await analyticsRepo.countLossReasonsCreatedIn(tx, scope, period.bounds),
        won: await analyticsRepo.aggregateWonIn(tx, scope, period.bounds),
        realized: await analyticsRepo.aggregateRealizedIn(tx, scope, period.bounds),
        performers: await analyticsRepo.topPerformersIn(
          tx,
          scope,
          period.bounds,
          TOP_PERFORMERS_LIMIT,
        ),
      }));

      const counts = emptyFunnelCounts();
      let createdTotal = 0;
      for (const row of data.byStatus) {
        if (!isProposalStatus(row.status)) continue;
        counts[row.status] = row.count;
        createdTotal += row.count;
      }

      // Todas as 5 chaves, sempre — senao o grafico do frontend fica com buracos.
      const lossReasons = emptyLossReasons();
      for (const row of data.lossReasons) {
        // `reason_lost` nulo nao vira chave inventada: a proposta ja esta
        // contada em `funnel.perdido` e o motivo simplesmente nao existe.
        if (isLossReason(row.reason)) lossReasons[row.reason] += row.count;
      }

      const revenue = toMoney(data.won.revenue);

      return {
        period: { startDate: period.startDate, endDate: period.endDate },
        funnel: {
          novoContato: counts.novo_contato,
          orcamentoEnviado: counts.orcamento_enviado,
          followUp: counts.follow_up,
          negociacao: counts.negociacao,
          ganho: counts.ganho,
          perdido: counts.perdido,
          conversionRate: percent(counts.ganho, createdTotal),
        },
        lossReasons,
        revenue,
        averageTicket: average(revenue, data.won.count),
        topPerformers: data.performers.map((row) => ({
          userId: row.userId,
          name: row.name,
          conversions: row.conversions,
          revenue: toMoney(row.revenue),
        })),
        // Atendente ve versao PARCIAL (PAGES.md §8).
        partial: scope.userId !== undefined,
        realized: {
          wonFromLis: data.realized.wonFromLis,
          paidCount: data.realized.paidCount,
          paidValue: toMoney(data.realized.paidValue),
        },
      } satisfies FunnelReport;
    });
  };

  const getPipelineSnapshot = async (ctx: TenantContext): Promise<PipelineSnapshot> => {
    assertLabUser(ctx);
    const scope = scopeOf(ctx);
    // Snapshot nao tem periodo; o TTL de 5 min ja e a granularidade.
    const key = cacheKey(ctx.tenantId, scope, 'pipeline');

    return cached(key, async () => {
      const data = await db.withTenant(ctx.tenantId, async (tx) => ({
        rows: await analyticsRepo.pipelineByStatus(tx, scope),
        oldest: await analyticsRepo.oldestOpen(tx, scope),
      }));

      const byStatus = Object.fromEntries(
        PROPOSAL_STATUSES.map((status) => [status, { count: 0, value: 0 }]),
      ) as PipelineSnapshot['byStatus'];

      for (const row of data.rows) {
        if (!isProposalStatus(row.status)) continue;
        byStatus[row.status] = { count: row.count, value: toMoney(row.value) };
      }

      // `totalValue`/`averageTicket` cobrem o que esta EM ABERTO — e isso que
      // "pipeline" significa. Ganho e perdido continuam visiveis em `byStatus`.
      let openCount = 0;
      let openValue = 0;
      for (const status of OPEN_STATUSES) {
        openCount += byStatus[status].count;
        openValue += byStatus[status].value;
      }

      const oldestProposal =
        data.oldest === null
          ? null
          : {
              id: data.oldest.id,
              daysOpen: daysBetween(data.oldest.createdAt, now()),
              status: data.oldest.status as ProposalStatus,
            };

      return {
        byStatus,
        totalValue: toMoney(openValue),
        averageTicket: average(openValue, openCount),
        openCount,
        oldestProposal,
      } satisfies PipelineSnapshot;
    });
  };

  const getTeamPerformance = async (
    ctx: TenantContext,
    range: DateRange,
  ): Promise<TeamReport> => {
    assertLabUser(ctx);
    assertTeamRole(ctx);
    const period = resolvePeriod(range, now());
    // Sempre escopo de time: quem chega aqui e gestor ou admin.
    const scope: AnalyticsScope = { tenantId: ctx.tenantId };
    const key = cacheKey(ctx.tenantId, scope, 'team', `${period.startDate}_${period.endDate}`);

    return cached(key, async () => {
      const rows = await db.withTenant(ctx.tenantId, (tx) =>
        analyticsRepo.teamPerformanceIn(tx, scope, period.bounds),
      );

      const members: TeamMemberPerformance[] = rows.map((row) => {
        const revenue = toMoney(row.revenue);
        return {
          userId: row.userId,
          name: row.name,
          created: row.created,
          won: row.won,
          lost: row.lost,
          conversionRate: percent(row.won, row.created),
          revenue,
          averageTicket: average(revenue, row.won),
        };
      });

      const sum = (pick: (m: TeamMemberPerformance) => number): number =>
        members.reduce((total, member) => total + pick(member), 0);

      const created = sum((m) => m.created);
      const won = sum((m) => m.won);
      const revenue = toMoney(sum((m) => m.revenue));

      return {
        period: { startDate: period.startDate, endDate: period.endDate },
        members,
        totals: {
          created,
          won,
          lost: sum((m) => m.lost),
          conversionRate: percent(won, created),
          revenue,
          averageTicket: average(revenue, won),
        },
      } satisfies TeamReport;
    });
  };

  return { getConversionFunnel, getPipelineSnapshot, getTeamPerformance };
}

/** Dias inteiros entre a criacao e agora. Nunca negativo. */
export function daysBetween(isoStart: string, now: Date): number {
  const started = Date.parse(isoStart);
  if (Number.isNaN(started)) return 0;
  return Math.max(0, Math.floor((now.getTime() - started) / MS_PER_DAY));
}
