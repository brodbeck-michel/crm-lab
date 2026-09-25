/**
 * LisReconcileService — SERVICES.md §25 (CRMLAB-52, D-119).
 *
 * Casa `lis_budgets` com `proposals` pelo numero do orcamento do LIS e aplica
 * as regras de D-119. Nao tem rota: e chamado por
 * `ProposalService.setLisReference` e pelo hook por chunk de
 * `LisImportService.ingestRows`, SEMPRE dentro da transacao de quem chama
 * (`db.withTenant` nao aninha).
 *
 * Devolve os ids das propostas que foram a `ganho`. Quem chama anuncia com
 * `announceLisWins` DEPOIS do commit: um WS emitido dentro da transacao
 * anunciaria um `ganho` que um rollback desfaria.
 */
import { TERMINAL_STATUSES, type ProposalStatus } from '@crm-lab/shared';
import type { DbTx } from '../db/types.js';
import type { CacheService } from '../lib/cache.js';
import { logger } from '../lib/logger.js';
import type { WsHub } from '../lib/ws-hub.js';
import * as auditRepo from '../repositories/audit.repository.js';
import { toNumber } from '../repositories/row-mappers.js';
import { cachePrefix as analyticsCachePrefix } from './analytics.service.js';
import { markWonFromLis } from './proposal.service.js';

interface ReconcileRow {
  proposal_id: string;
  status: string;
  lis_budget_number: string;
  lis_requisition_number: string | null;
  lis_paid_value: unknown;
  lis_paid_on: string | null;
  budget_id: string;
  budget_proposal_id: string | null;
  requisition_number: string | null;
  paid_value: unknown;
  paid_on: string | null;
}

function moneyOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : toNumber(value);
}

async function reconcileRows(tx: DbTx, tenantId: string, rows: ReconcileRow[]): Promise<string[]> {
  const won: string[] = [];
  for (const row of rows) {
    const requisition = row.requisition_number;
    const paidValue = moneyOrNull(row.paid_value);

    if (row.budget_proposal_id !== row.proposal_id) {
      await tx.query('UPDATE lis_budgets SET proposal_id = $2 WHERE id = $1', [
        row.budget_id,
        row.proposal_id,
      ]);
    }

    // `perdido` nao reabre (item 5). O conflito e auditado uma vez so: quando a
    // requisicao ainda nao estava espelhada na proposta.
    if (
      requisition !== null &&
      row.status === 'perdido' &&
      row.lis_requisition_number !== requisition
    ) {
      await auditRepo.insert(tx, {
        tenantId,
        userId: null,
        action: 'lis_reconcile_conflict',
        entityType: 'proposal',
        entityId: row.proposal_id,
        newValues: { lisBudgetNumber: row.lis_budget_number, lisRequisitionNumber: requisition },
      });
    }

    // Espelho do orcamento, qualquer que seja o status (item 6), so se mudou (item 7).
    if (
      row.lis_requisition_number !== requisition ||
      moneyOrNull(row.lis_paid_value) !== paidValue ||
      row.lis_paid_on !== row.paid_on
    ) {
      await tx.query(
        `UPDATE proposals
            SET lis_requisition_number = $2, lis_paid_value = $3, lis_paid_on = $4::date,
                updated_at = NOW()
          WHERE id = $1`,
        [row.proposal_id, requisition, paidValue, row.paid_on],
      );
    }

    if (requisition !== null && !TERMINAL_STATUSES.includes(row.status as ProposalStatus)) {
      if (await markWonFromLis(tx, tenantId, row.proposal_id)) won.push(row.proposal_id);
    }
  }
  return won;
}

const SELECT_JOIN = `
  SELECT p.id AS proposal_id, p.status, p.lis_budget_number, p.lis_requisition_number,
         p.lis_paid_value, to_char(p.lis_paid_on, 'YYYY-MM-DD') AS lis_paid_on,
         b.id AS budget_id, b.proposal_id AS budget_proposal_id,
         NULLIF(b.requisition_number, '') AS requisition_number,
         b.paid_value, to_char(b.paid_on, 'YYYY-MM-DD') AS paid_on
    FROM proposals p
    JOIN lis_budgets b ON b.tenant_id = p.tenant_id AND b.number = p.lis_budget_number
   WHERE p.tenant_id = $1`;

/** Os orcamentos de `numbers` que tem proposta vinculada. Devolve as que foram a `ganho`. */
export async function reconcileBudgets(
  tx: DbTx,
  tenantId: string,
  numbers: readonly string[],
): Promise<string[]> {
  if (numbers.length === 0) return [];
  const result = await tx.query<ReconcileRow>(
    `${SELECT_JOIN} AND p.lis_budget_number = ANY($2::text[])
     ORDER BY p.id FOR UPDATE OF p`,
    [tenantId, [...numbers]],
  );
  return reconcileRows(tx, tenantId, result.rows);
}

/** Uma proposta, contra o orcamento do numero dela (se ja existir). `true` = foi a `ganho`. */
export async function reconcileProposal(
  tx: DbTx,
  tenantId: string,
  proposalId: string,
): Promise<boolean> {
  const result = await tx.query<ReconcileRow>(`${SELECT_JOIN} AND p.id = $2 FOR UPDATE OF p`, [
    tenantId,
    proposalId,
  ]);
  const won = await reconcileRows(tx, tenantId, result.rows);
  return won.length > 0;
}

/**
 * Depois do commit: WS `proposal.status_changed` por proposta ganha e
 * invalidacao do cache de analytics (o funil e o `realized` mudaram). Falha de
 * cache nao derruba nada — mesma regra de `ProposalService.invalidateAnalytics`.
 */
export async function announceLisWins(
  deps: { wsHub: WsHub; cache: CacheService },
  tenantId: string,
  proposalIds: readonly string[],
): Promise<void> {
  if (proposalIds.length === 0) return;
  for (const proposalId of proposalIds) {
    deps.wsHub.emitToTenant(tenantId, 'proposal.status_changed', { proposalId, status: 'ganho' });
  }
  try {
    await deps.cache.delByPrefix(analyticsCachePrefix(tenantId));
  } catch (err) {
    logger.warn('analytics.cache_invalidation_failed', {
      tenantId,
      detail: err instanceof Error ? err.message : 'erro desconhecido',
    });
  }
}
