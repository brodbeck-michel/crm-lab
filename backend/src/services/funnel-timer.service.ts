/**
 * FunnelTimerService — motor de tempo do funil. SERVICES.md §27 (CRMLAB-59,
 * D-205..D-209).
 *
 * Cartoes parados andam sozinhos pelos prazos das Regras (`automation`), cada
 * regra so se ligada, e o "Novo orcamento" parado gera um alerta (sem mover).
 *
 * O relogio e a ULTIMA linha de `proposal_status_history` com o estagio atual:
 * toda transicao grava uma linha, entao qualquer movimento zera o prazo sem
 * estado extra (D-205 item 1). O prazo e recalculado a cada tique com a regra
 * vigente (D-209).
 *
 * Fato vence tempo (D-206): cartao com pagamento nunca e movido aqui; com
 * requisicao, nao vai de `orcamento_enviado`/`follow_up` para `follow_up`/
 * `perdido`. A condicao e conferida de novo sob `FOR UPDATE` em
 * `applyTimerTransition` (a `applySystemTransition` com `guard`, D-210), o que torna a ordem com a regua de fatos irrelevante
 * para a consistencia.
 *
 * Uma transacao por cartao: um cartao problematico nao desfaz os outros, e o
 * WS/invalidacao saem so depois do commit daquele cartao.
 */
import {
  TIMER_STEPS,
  buildAllowedTransitions,
  describeStageAutomation,
  hoursSince,
  isDelayElapsed,
  isStaleNewBudget,
  PROPOSAL_STATUS_LABELS,
  type FunnelRules,
  type StageAutomation,
  type TimerStep,
} from '@crm-lab/shared';
import type { DbClient, DbTx } from '../db/types.js';
import type { CacheService } from '../lib/cache.js';
import { logger } from '../lib/logger.js';
import type { WsHub } from '../lib/ws-hub.js';
import { readFunnelRules } from './funnel-rules.service.js';
import {
  announceSystemTransitions,
  applySystemTransition,
  proposalRef,
  type SystemTransition,
} from './proposal.service.js';

/** Teto por regra, por laboratorio, por tique (D-205 item 7). */
export const FUNNEL_TIMER_BATCH = 200;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Um tique por vez (D-205 item 5): tique lento nao empilha o seguinte. */
let tickInProgress = false;

export interface FunnelTimerTenantResult {
  tenantId: string;
  moved: number;
  alerted: number;
}

export interface FunnelTimerTickResult {
  /** `true` quando o tique foi ignorado porque o anterior ainda rodava. */
  skipped: boolean;
  tenants: FunnelTimerTenantResult[];
}

export interface FunnelTimerService {
  runTick(): Promise<FunnelTimerTickResult>;
  runForTenant(tenantId: string): Promise<FunnelTimerTenantResult>;
}

export interface FunnelTimerServiceDeps {
  db: DbClient;
  wsHub: WsHub;
  cache: CacheService;
  now?: () => Date;
}

/**
 * Fatos que impedem cada passo (D-206 item 1). `negociacao` e literalmente
 * "sem pagamento": requisicao sem pagamento anda.
 */
function factsBlock(step: TimerStep): { requisition: boolean } {
  return { requisition: step.rule !== 'negotiationToFollowUp' };
}

function factsSql(step: TimerStep, alias: string): string {
  const base = `${alias}.lis_paid_on IS NULL`;
  return factsBlock(step).requisition ? `${base} AND ${alias}.lis_requisition_number IS NULL` : base;
}

function systemMessageFor(proposalId: string, step: TimerStep, automation: StageAutomation): string {
  const label = describeStageAutomation(automation);
  const reason = label.charAt(0).toLowerCase() + label.slice(1);
  return `Proposta #${proposalRef(proposalId)} movida para ${PROPOSAL_STATUS_LABELS[step.to]} pela regra: ${reason}.`;
}

/**
 * A transicao do motor (D-208), na transacao de quem chama: a
 * `applySystemTransition` com as travas do tique (D-210). Devolve `null` (e
 * nao grava nada) quando o cartao nao esta mais na condicao lida: saiu do
 * estagio, reentrou nele (outra linha de entrada) ou ganhou um fato. WS e
 * invalidacao de analytics ficam com quem chama, depois do commit
 * (`announceSystemTransitions`).
 */
export async function applyTimerTransition(
  tx: DbTx,
  input: {
    tenantId: string;
    proposalId: string;
    step: TimerStep;
    automation: StageAutomation;
    /** A linha de entrada no estagio que o tique leu. */
    enteredHistoryId: string;
    now: Date;
  },
): Promise<SystemTransition | null> {
  const { tenantId, proposalId, step, automation, now } = input;
  return applySystemTransition(tx, tenantId, proposalId, {
    to: step.to,
    from: step.from,
    source: 'rule',
    systemMessage: systemMessageFor(proposalId, step, automation),
    reasonLost: 'silencio',
    automation,
    at: now,
    auditExtra: { rule: automation.rule, days: automation.days, dayCounting: automation.dayCounting },
    guard: async (locked) => {
      if (locked.lisPaidOn !== null) return false;
      if (factsBlock(step).requisition && locked.lisRequisitionNumber !== null) return false;
      const entry = await tx.query<{ id: string }>(
        `SELECT id FROM proposal_status_history
          WHERE proposal_id = $1 AND status = $2
          ORDER BY changed_at DESC, id DESC LIMIT 1`,
        [proposalId, step.from],
      );
      return entry.rows[0]?.id === input.enteredHistoryId;
    },
  });
}

interface CandidateRow {
  id: string;
  history_id: string;
  entered_at: string;
  created_by: string | null;
}

/** Cartoes do estagio cuja entrada e anterior a `cutoff`, do mais antigo para o mais novo. */
async function selectCandidates(
  tx: DbTx,
  tenantId: string,
  status: string,
  cutoff: Date,
  extraWhere: string,
): Promise<CandidateRow[]> {
  const result = await tx.query<CandidateRow>(
    `SELECT p.id, p.created_by, h.id AS history_id,
            to_char(h.changed_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS entered_at
       FROM proposals p
       JOIN LATERAL (
            SELECT hh.id, hh.changed_at, hh.stale_alerted_at
              FROM proposal_status_history hh
             WHERE hh.proposal_id = p.id AND hh.status = p.status
             ORDER BY hh.changed_at DESC, hh.id DESC
             LIMIT 1
       ) h ON TRUE
      WHERE p.tenant_id = $1 AND p.status = $2
        AND h.changed_at <= $3::timestamp
        AND ${extraWhere}
      ORDER BY h.changed_at ASC, p.id ASC
      LIMIT $4`,
    [tenantId, status, cutoff.toISOString(), FUNNEL_TIMER_BATCH],
  );
  return result.rows;
}

/** Quem recebe o alerta (D-207 item 2): o responsavel ativo; senao gestores e admins ativos. */
async function alertRecipients(tx: DbTx, tenantId: string, createdBy: string | null): Promise<string[]> {
  if (createdBy !== null) {
    const owner = await tx.query<{ id: string }>(
      `SELECT id FROM users WHERE id = $1 AND tenant_id = $2 AND is_active = TRUE`,
      [createdBy, tenantId],
    );
    if (owner.rows.length > 0) return [createdBy];
  }
  const managers = await tx.query<{ id: string }>(
    `SELECT id FROM users
      WHERE tenant_id = $1 AND is_active = TRUE AND role IN ('manager', 'admin')
      ORDER BY id`,
    [tenantId],
  );
  return managers.rows.map((r) => r.id);
}

export function createFunnelTimerService(deps: FunnelTimerServiceDeps): FunnelTimerService {
  const { db, wsHub } = deps;
  const now = deps.now ?? (() => new Date());

  async function runStep(
    tenantId: string,
    rules: FunnelRules,
    step: TimerStep,
    at: Date,
  ): Promise<number> {
    const rule = rules.automation[step.rule];
    if (!rule.enabled) return 0;
    if (!buildAllowedTransitions(rules.manualMoves)[step.from].includes(step.to)) {
      logger.debug('funnel_timer.step_not_allowed', { tenantId, rule: step.rule, from: step.from, to: step.to });
      return 0;
    }
    const automation: StageAutomation = {
      rule: step.rule,
      days: rule.days,
      dayCounting: rules.automation.dayCounting,
    };
    // Dia util nunca vence antes do corrido: `days × 24 h` e condicao necessaria.
    const cutoff = new Date(at.getTime() - rule.days * DAY_MS);
    const candidates = await db.withTenant(tenantId, (tx) =>
      selectCandidates(tx, tenantId, step.from, cutoff, factsSql(step, 'p')),
    );

    let moved = 0;
    for (const candidate of candidates) {
      // O prazo e monotono na entrada: com a lista em ordem crescente, o
      // primeiro que nao venceu encerra a regra neste tique.
      if (!isDelayElapsed(new Date(candidate.entered_at), at, rule.days, automation.dayCounting)) break;
      const transition = await db.withTenant(tenantId, (tx) =>
        applyTimerTransition(tx, {
          tenantId,
          proposalId: candidate.id,
          step,
          automation,
          enteredHistoryId: candidate.history_id,
          now: at,
        }),
      );
      if (transition === null) continue;
      moved += 1;
      await announceSystemTransitions(deps, tenantId, [transition]);
    }
    return moved;
  }

  async function runStaleAlert(tenantId: string, rules: FunnelRules, at: Date): Promise<number> {
    const rule = rules.automation.staleNewBudgetAlert;
    if (!rule.enabled) return 0;
    const cutoff = new Date(at.getTime() - rule.hours * HOUR_MS);
    const candidates = await db.withTenant(tenantId, (tx) =>
      selectCandidates(
        tx,
        tenantId,
        'novo_contato',
        cutoff,
        'p.lis_paid_on IS NULL AND h.stale_alerted_at IS NULL',
      ),
    );

    let alerted = 0;
    for (const candidate of candidates) {
      if (!isStaleNewBudget('novo_contato', candidate.entered_at, rule, at)) continue;
      const recipients = await db.withTenant(tenantId, async (tx) => {
        const marked = await tx.query<{ id: string }>(
          `UPDATE proposal_status_history h
              SET stale_alerted_at = $3::timestamp
             FROM proposals p
            WHERE h.id = $1 AND h.tenant_id = $2 AND h.stale_alerted_at IS NULL
              AND p.id = h.proposal_id AND p.status = 'novo_contato' AND p.lis_paid_on IS NULL
            RETURNING h.id`,
          [candidate.history_id, tenantId, at.toISOString()],
        );
        if (marked.rows.length === 0) return null;
        return alertRecipients(tx, tenantId, candidate.created_by);
      });
      if (recipients === null) continue;
      alerted += 1;
      const hours = hoursSince(new Date(candidate.entered_at), at);
      for (const userId of recipients) {
        wsHub.emitToUser(tenantId, userId, 'proposal.stale_alert', { proposalId: candidate.id, hours });
      }
      logger.info('funnel_timer.stale_alert', {
        tenantId,
        proposalId: candidate.id,
        hours,
        recipients: recipients.length,
      });
    }
    return alerted;
  }

  async function runForTenant(tenantId: string): Promise<FunnelTimerTenantResult> {
    const at = now();
    const rules = await db.withTenant(tenantId, (tx) => readFunnelRules(tx, tenantId));
    let moved = 0;
    for (const step of TIMER_STEPS) {
      moved += await runStep(tenantId, rules, step, at);
    }
    const alerted = await runStaleAlert(tenantId, rules, at);
    return { tenantId, moved, alerted };
  }

  /** D-205 item 6: fora do contexto de tenant, SO `tenant_id`. */
  async function listTenantIds(): Promise<string[]> {
    return db.withoutTenant(async (tx) => {
      const result = await tx.query<{ tenant_id: string }>(
        `SELECT DISTINCT p.tenant_id
           FROM proposals p
           JOIN tenants t ON t.id = p.tenant_id AND t.is_active = TRUE
          WHERE p.status NOT IN ('ganho', 'perdido')
          ORDER BY p.tenant_id`,
      );
      return result.rows.map((r) => r.tenant_id);
    });
  }

  return {
    runForTenant,

    async runTick() {
      if (tickInProgress) return { skipped: true, tenants: [] };
      tickInProgress = true;
      try {
        let tenantIds: string[];
        try {
          tenantIds = await listTenantIds();
        } catch (error) {
          logger.warn('funnel_timer.tick_failed', {
            message: error instanceof Error ? error.message : String(error),
          });
          return { skipped: false, tenants: [] };
        }
        const results: FunnelTimerTenantResult[] = [];
        // Em serie: um laboratorio por vez nao compete com a tela pelo pool.
        for (const tenantId of tenantIds) {
          try {
            const result = await runForTenant(tenantId);
            results.push(result);
            if (result.moved > 0 || result.alerted > 0) {
              logger.info('funnel_timer.completed', { ...result });
            }
          } catch (error) {
            logger.warn('funnel_timer.tenant_failed', {
              tenantId,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
        if (results.every((r) => r.moved === 0 && r.alerted === 0)) {
          logger.debug('funnel_timer.tick_empty', { tenants: tenantIds.length });
        }
        return { skipped: false, tenants: results };
      } finally {
        tickInProgress = false;
      }
    },
  };
}

/** So para teste: garante que a trava do tique nao sobrou entre casos. */
export function resetFunnelTimerLocksForTest(): void {
  tickInProgress = false;
}
