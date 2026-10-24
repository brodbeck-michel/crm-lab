/**
 * Relatorio de lembretes por atendente (CRMLAB-103, D-279 — SERVICES.md §34).
 * SO LEITURA. Gestor e admin; atendente recebe FORBIDDEN, como
 * `/analytics/team` e `/analytics/response-time`.
 *
 * Atribuicao: a RESPONSAVEL pela proposta (`proposals.created_by`, a mesma de
 * `isCardOwner`), nao quem resolveu. Proposta sem responsavel → linha
 * "Sem responsavel".
 *
 * Duas janelas:
 * - vencidos em aberto = foto de AGORA, mesma regra de `isReminderDue` (dia de
 *   Brasilia por `saoPauloToday`, passado ao SQL) — independe do periodo;
 * - resolvidos no periodo = `resolved_at` entre as meias-noites LOCAIS do fuso
 *   do expediente, a convencao do tempo de resposta (D-257). Sem teto de dias:
 *   e uma contagem agregada, barata.
 */
import {
  PROPOSAL_REMINDER_REPORT_NO_OWNER_LABEL,
  saoPauloToday,
  type ProposalReminderReport,
  type ProposalReminderReportCounts,
  type ProposalReminderReportQuery,
  type ProposalReminderReportRow,
} from '@crm-lab/shared';
import type { DbClient } from '../db/types.js';
import type { TenantContext } from '../http/context.js';
import { BusinessError } from '../http/errors.js';
import * as reminderRepo from '../repositories/proposal-reminder.repository.js';
import { resolvePeriod } from './analytics.service.js';
import { readBusinessHours } from './channel-settings.service.js';
import { localMidnight, nextDay } from './response-time.service.js';

const TEAM_ROLES = ['manager', 'admin'] as const;

export interface ProposalReminderReportService {
  getReport(ctx: TenantContext, query: ProposalReminderReportQuery): Promise<ProposalReminderReport>;
}

export interface ProposalReminderReportServiceDeps {
  db: DbClient;
  /** Injetavel para teste: "hoje" e o periodo padrao (ultimos 30 dias). */
  now?: () => Date;
}

function emptyCounts(): ProposalReminderReportCounts {
  return { overdueOpen: 0, won: 0, lost: 0, rescheduled: 0, autoClosed: 0, resolved: 0 };
}

export function createProposalReminderReportService(
  deps: ProposalReminderReportServiceDeps,
): ProposalReminderReportService {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  return {
    async getReport(ctx, query) {
      if (ctx.role !== 'manager' && ctx.role !== 'admin') {
        throw new BusinessError('FORBIDDEN', { requiredRoles: [...TEAM_ROLES] });
      }
      const current = now();
      const period = resolvePeriod(query, current);
      const today = saoPauloToday(current);

      const { timezone, raw } = await db.withTenant(ctx.tenantId, async (tx) => {
        const tz = (await readBusinessHours(tx, ctx.tenantId)).timezone;
        const startUtc = localMidnight(period.startDate, tz).toISOString();
        const endUtc = localMidnight(nextDay(period.endDate), tz).toISOString();
        const counted = await reminderRepo.countByOwner(tx, ctx.tenantId, today, startUtc, endUtc);
        return { timezone: tz, raw: counted };
      });

      const total = emptyCounts();
      const rows: ProposalReminderReportRow[] = raw.map((r) => {
        const resolved = r.won + r.lost + r.rescheduled + r.autoClosed;
        total.overdueOpen += r.overdueOpen;
        total.won += r.won;
        total.lost += r.lost;
        total.rescheduled += r.rescheduled;
        total.autoClosed += r.autoClosed;
        total.resolved += resolved;
        return {
          userId: r.ownerId,
          name: r.ownerId === null ? PROPOSAL_REMINDER_REPORT_NO_OWNER_LABEL : (r.ownerName ?? 'Usuário'),
          overdueOpen: r.overdueOpen,
          won: r.won,
          lost: r.lost,
          rescheduled: r.rescheduled,
          autoClosed: r.autoClosed,
          resolved,
        };
      });
      rows.sort(
        (a, b) =>
          b.overdueOpen - a.overdueOpen || b.resolved - a.resolved || a.name.localeCompare(b.name, 'pt-BR'),
      );

      return {
        period: { startDate: period.startDate, endDate: period.endDate },
        timezone,
        today,
        rows,
        total,
      };
    },
  };
}
