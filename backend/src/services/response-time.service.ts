/**
 * Relatorio de tempo de resposta do WhatsApp (CRMLAB-83, D-257 — SERVICES.md §9).
 * SO LEITURA. Gestor e admin; atendente recebe FORBIDDEN, como `/analytics/team`.
 *
 * O repositorio traz um bloco por linha (inicio da espera, resposta, quem
 * respondeu). Aqui cada espera vira MINUTOS UTEIS com o `businessMinutesBetween`
 * do alerta (D-254): so o expediente de `tenant_settings.business_hours`, sem
 * feriados nacionais nem os cadastrados. Laboratorio sem expediente = sempre
 * aberto (D-212 item 1), menos os feriados.
 *
 * Atribuicao: quem RESPONDEU (`messages.sender_id`), nao a dona da conversa.
 * Resposta do celular (`agent` sem `sender_id`) vira a linha "Celular". Bloco
 * sem resposta nao tem quem responsabilizar: entra so no total.
 *
 * Periodo: datas LOCAIS do fuso do expediente (um bloco das 22h de Sao Paulo e
 * do dia local, nao do dia UTC seguinte), ate `RESPONSE_TIME_MAX_PERIOD_DAYS`.
 * Sem cache no servidor: o relatorio mostra blocos "aguardando", que mudam a
 * cada resposta; a tela segura o resultado pelo `staleTime` do TanStack Query.
 */
import {
  RESPONSE_TIME_BUCKET_LIMITS,
  RESPONSE_TIME_MAX_PERIOD_DAYS,
  RESPONSE_TIME_PHONE_ID,
  businessMinutesBetween,
  localDateOf,
  zonedToUtc,
  type BusinessHours,
  type IsoDate,
  type ResponseTimeBuckets,
  type ResponseTimeDay,
  type ResponseTimeFigures,
  type ResponseTimeQuery,
  type ResponseTimeReport,
  type ResponseTimeResponder,
  type ResponseTimeSummary,
  type ResponseTimeTotalDay,
} from '@crm-lab/shared';
import type { DbClient } from '../db/types.js';
import type { TenantContext } from '../http/context.js';
import { BusinessError } from '../http/errors.js';
import * as holidayRepo from '../repositories/holiday.repository.js';
import * as repo from '../repositories/response-time.repository.js';
import { resolvePeriod } from './analytics.service.js';
import { readBusinessHours } from './channel-settings.service.js';

const TEAM_ROLES = ['manager', 'admin'] as const;
const MS_PER_DAY = 86_400_000;
const PHONE_NAME = 'Celular';

export interface ResponseTimeService {
  getReport(ctx: TenantContext, query: ResponseTimeQuery): Promise<ResponseTimeReport>;
}

export interface ResponseTimeServiceDeps {
  db: DbClient;
  /** Injetavel para teste: o periodo padrao e os ultimos 30 dias. */
  now?: () => Date;
}

/** Uma espera respondida, ja em minutos uteis. */
export interface AnsweredWait {
  minutes: number;
  opens: boolean;
  date: IsoDate;
}

// ---------------------------------------------------------------------------
// Aritmetica — pura, exportada para teste
// ---------------------------------------------------------------------------

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Media e mediana com 1 casa; lista vazia → `null` nos dois. */
export function figuresOf(minutes: readonly number[]): ResponseTimeFigures {
  if (minutes.length === 0) return { answered: 0, averageMinutes: null, medianMinutes: null };
  const sorted = [...minutes].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? (sorted[middle] ?? 0)
      : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  const sum = sorted.reduce((total, value) => total + value, 0);
  return { answered: sorted.length, averageMinutes: round1(sum / sorted.length), medianMinutes: round1(median) };
}

/** Faixas inclusivas: 5 min cai em "ate 5"; 6 em "ate 15"; 61 em "acima de 60". */
export function bucketsOf(minutes: readonly number[]): ResponseTimeBuckets {
  const [five, fifteen, sixty] = RESPONSE_TIME_BUCKET_LIMITS;
  const buckets: ResponseTimeBuckets = { upTo5: 0, upTo15: 0, upTo60: 0, over60: 0 };
  for (const value of minutes) {
    if (value <= five) buckets.upTo5 += 1;
    else if (value <= fifteen) buckets.upTo15 += 1;
    else if (value <= sixty) buckets.upTo60 += 1;
    else buckets.over60 += 1;
  }
  return buckets;
}

export function summaryOf(waits: readonly AnsweredWait[]): ResponseTimeSummary {
  const minutes = waits.map((w) => w.minutes);
  return {
    ...figuresOf(minutes),
    buckets: bucketsOf(minutes),
    firstResponse: figuresOf(waits.filter((w) => w.opens).map((w) => w.minutes)),
  };
}

/** Todas as datas de `start` a `end` (inclusive), `YYYY-MM-DD`. */
export function datesBetween(start: IsoDate, end: IsoDate): IsoDate[] {
  const out: IsoDate[] = [];
  for (let ms = Date.parse(`${start}T00:00:00Z`); ms <= Date.parse(`${end}T00:00:00Z`); ms += MS_PER_DAY) {
    out.push(new Date(ms).toISOString().slice(0, 10));
  }
  return out;
}

function dailyOf(dates: readonly IsoDate[], waits: readonly AnsweredWait[]): ResponseTimeDay[] {
  const byDate = new Map<IsoDate, number[]>();
  for (const w of waits) {
    const list = byDate.get(w.date) ?? [];
    list.push(w.minutes);
    byDate.set(w.date, list);
  }
  return dates.map((date) => ({ date, ...figuresOf(byDate.get(date) ?? []) }));
}

/** Instante UTC da meia-noite local de `date` no fuso do expediente. */
function localMidnight(date: IsoDate, timezone: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  return zonedToUtc(y ?? 1970, m ?? 1, d ?? 1, '00:00', timezone);
}

function nextDay(date: IsoDate): IsoDate {
  return new Date(Date.parse(`${date}T00:00:00Z`) + MS_PER_DAY).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

function assertTeamRole(ctx: TenantContext): void {
  if (ctx.role !== 'manager' && ctx.role !== 'admin') {
    throw new BusinessError('FORBIDDEN', { requiredRoles: [...TEAM_ROLES] });
  }
}

interface ResponderAcc {
  responderId: string;
  name: string;
  kind: 'user' | 'phone';
  waits: AnsweredWait[];
}

export function createResponseTimeService(deps: ResponseTimeServiceDeps): ResponseTimeService {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  return {
    async getReport(ctx, query) {
      assertTeamRole(ctx);
      const current = now();
      const period = resolvePeriod(query, current);
      const days =
        (Date.parse(`${period.endDate}T00:00:00Z`) - Date.parse(`${period.startDate}T00:00:00Z`)) / MS_PER_DAY + 1;
      if (days > RESPONSE_TIME_MAX_PERIOD_DAYS) {
        throw new BusinessError('VALIDATION_ERROR', {
          fields: { endDate: `Período máximo de ${RESPONSE_TIME_MAX_PERIOD_DAYS} dias` },
        });
      }

      const { hours, rows, holidays } = await db.withTenant(ctx.tenantId, async (tx) => {
        const businessHours: BusinessHours = await readBusinessHours(tx, ctx.tenantId);
        const tz = businessHours.timezone;
        const startUtc = localMidnight(period.startDate, tz).toISOString();
        const endUtc = localMidnight(nextDay(period.endDate), tz).toISOString();
        const blocks = await repo.listBlocks(tx, ctx.tenantId, startUtc, endUtc);
        // Feriados cadastrados do inicio do periodo ate a resposta mais tardia
        // (ou hoje): a espera de um bloco pode atravessar o fim do periodo.
        const lastReply = blocks.reduce<string>(
          (latest, b) => (b.replied_at !== null && b.replied_at > latest ? b.replied_at : latest),
          current.toISOString(),
        );
        const custom = await holidayRepo.listDates(
          tx,
          ctx.tenantId,
          period.startDate,
          localDateOf(new Date(lastReply), tz),
        );
        return { hours: businessHours, rows: blocks, holidays: custom };
      });

      const tz = hours.timezone;
      const dates = datesBetween(period.startDate, period.endDate);
      const unansweredByDate = new Map<IsoDate, number>();
      const unansweredConversations = new Set<string>();
      const all: AnsweredWait[] = [];
      const responders = new Map<string, ResponderAcc>();
      let waiting = 0;
      let closed = 0;

      for (const row of rows) {
        const since = new Date(row.waiting_since);
        const date = localDateOf(since, tz);
        if (row.closed_unanswered || row.replied_at === null) {
          if (row.closed_unanswered) closed += 1;
          else waiting += 1;
          unansweredByDate.set(date, (unansweredByDate.get(date) ?? 0) + 1);
          unansweredConversations.add(row.conversation_id);
          continue;
        }

        const wait: AnsweredWait = {
          minutes: businessMinutesBetween(since, new Date(row.replied_at), hours, holidays),
          opens: row.opens,
          date,
        };
        all.push(wait);

        const key = row.responder_id ?? RESPONSE_TIME_PHONE_ID;
        let acc = responders.get(key);
        if (!acc) {
          acc =
            row.responder_id === null
              ? { responderId: RESPONSE_TIME_PHONE_ID, name: PHONE_NAME, kind: 'phone', waits: [] }
              : { responderId: row.responder_id, name: row.responder_name ?? 'Usuário', kind: 'user', waits: [] };
          responders.set(key, acc);
        }
        acc.waits.push(wait);
      }

      const ranking: ResponseTimeResponder[] = [...responders.values()].map((acc) => ({
        responderId: acc.responderId,
        name: acc.name,
        kind: acc.kind,
        ...summaryOf(acc.waits),
        daily: dailyOf(dates, acc.waits),
      }));
      ranking.sort(
        (a, b) =>
          (a.medianMinutes ?? Number.POSITIVE_INFINITY) - (b.medianMinutes ?? Number.POSITIVE_INFINITY) ||
          b.answered - a.answered ||
          a.name.localeCompare(b.name, 'pt-BR'),
      );

      const totalDaily: ResponseTimeTotalDay[] = dailyOf(dates, all).map((day) => ({
        ...day,
        unanswered: unansweredByDate.get(day.date) ?? 0,
      }));

      return {
        period: { startDate: period.startDate, endDate: period.endDate },
        timezone: tz,
        total: {
          ...summaryOf(all),
          unanswered: { waiting, closed, conversations: unansweredConversations.size },
          daily: totalDaily,
        },
        responders: ranking,
      };
    },
  };
}
