/**
 * LisReconcileService — SERVICES.md §25 (CRMLAB-52, D-119).
 *
 * Casa `lis_budgets` com `proposals` pelo numero do orcamento do LIS e aplica
 * a regua de fatos (D-252, substitui D-119 item 4 e D-204). Nao tem rota: e chamado por
 * `ProposalService.setLisReference` e pelo hook por chunk de
 * `LisImportService.ingestRows`, SEMPRE dentro da transacao de quem chama
 * (`db.withTenant` nao aninha).
 *
 * Qualquer origem (`crm` ou `bitlab`): pagamento -> `ganho`, requisicao ->
 * `negociacao`, cada uma pela regra das Regras (D-252).
 *
 * Devolve as transicoes de sistema feitas (`SystemTransition`). Quem chama
 * anuncia com `announceLisWins` DEPOIS do commit: um WS emitido dentro da
 * transacao anunciaria um estagio que um rollback desfaria.
 */
import { TERMINAL_STATUSES, type FunnelRules, type ProposalStatus } from '@crm-lab/shared';
import type { DbTx } from '../db/types.js';
import type { CacheService } from '../lib/cache.js';
import type { WsHub } from '../lib/ws-hub.js';
import * as auditRepo from '../repositories/audit.repository.js';
import { toNumber } from '../repositories/row-mappers.js';
import { readFunnelRules } from './funnel-rules.service.js';
import {
  announceSystemTransitions,
  applySystemTransition,
  proposalRef,
  type SystemTransition,
} from './proposal.service.js';

interface ReconcileRow {
  proposal_id: string;
  status: string;
  origin: string;
  total_price: unknown;
  insurance_id: string | null;
  lis_budget_number: string;
  lis_requisition_number: string | null;
  lis_paid_value: unknown;
  lis_paid_on: string | null;
  budget_id: string;
  budget_proposal_id: string | null;
  requisition_number: string | null;
  paid_value: unknown;
  paid_on: string | null;
  budget_total_value: unknown;
  budget_insurance_id: string | null;
}

function moneyOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : toNumber(value);
}

/**
 * Regua de fatos do LIS (D-252, CRMLAB-60), para qualquer origem: pagamento
 * (`paid_on` derivado do extrato, D-188) -> `ganho` de qualquer estagio aberto;
 * requisicao em `orcamento_enviado`/`follow_up` -> `negociacao`. Cada uma so
 * com a regra das Regras ligada. Requisicao sozinha nunca leva a `ganho`.
 */
async function applyLisFactsRule(
  tx: DbTx,
  tenantId: string,
  row: ReconcileRow,
  rules: FunnelRules,
): Promise<SystemTransition | null> {
  const ref = proposalRef(row.proposal_id);
  if (row.paid_on !== null && rules.automation.paymentToWon.enabled) {
    return applySystemTransition(tx, tenantId, row.proposal_id, {
      to: 'ganho',
      source: 'lis_payment',
      systemMessage: `Proposta #${ref} ganha — pagamento registrado no LIS 🎉`,
      lisReconciled: true,
    });
  }
  if (
    row.requisition_number !== null &&
    (row.status === 'orcamento_enviado' || row.status === 'follow_up') &&
    rules.automation.requisitionToNegotiation.enabled
  ) {
    return applySystemTransition(tx, tenantId, row.proposal_id, {
      to: 'negociacao',
      source: 'lis_requisition',
      systemMessage: `Proposta #${ref} em negociação — requisição aberta no LIS`,
    });
  }
  return null;
}

async function reconcileRows(
  tx: DbTx,
  tenantId: string,
  rows: ReconcileRow[],
): Promise<SystemTransition[]> {
  const transitions: SystemTransition[] = [];
  // Lidas uma vez por chamada, e so se houver proposta aberta (D-190 item 2).
  let rules: FunnelRules | null = null;
  for (const row of rows) {
    const requisition = row.requisition_number;
    const paidValue = moneyOrNull(row.paid_value);

    if (row.budget_proposal_id !== row.proposal_id) {
      await tx.query('UPDATE lis_budgets SET proposal_id = $2 WHERE id = $1', [
        row.budget_id,
        row.proposal_id,
      ]);
    }

    // `perdido` nao reabre (D-252 item 4). O conflito e auditado uma vez por
    // fato: quando a requisicao ou a data de pagamento ainda nao estava
    // espelhada na proposta.
    const newRequisition = requisition !== null && row.lis_requisition_number !== requisition;
    const newPayment = row.paid_on !== null && row.lis_paid_on !== row.paid_on;
    if (row.status === 'perdido' && (newRequisition || newPayment)) {
      await auditRepo.insert(tx, {
        tenantId,
        userId: null,
        action: 'lis_reconcile_conflict',
        entityType: 'proposal',
        entityId: row.proposal_id,
        newValues: {
          lisBudgetNumber: row.lis_budget_number,
          lisRequisitionNumber: requisition,
          lisPaidOn: row.paid_on,
        },
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

    const open = !TERMINAL_STATUSES.includes(row.status as ProposalStatus);
    const bitlab = row.origin === 'bitlab';

    // Origem `bitlab`: o valor e o convenio sao os do orcamento (D-195 item 2),
    // regravados enquanto a proposta nao fecha, so se mudaram.
    if (bitlab && open) {
      const budgetTotal = toNumber(row.budget_total_value);
      if (toNumber(row.total_price) !== budgetTotal || row.insurance_id !== row.budget_insurance_id) {
        await tx.query(
          `UPDATE proposals SET total_price = $2, insurance_id = $3, updated_at = NOW()
            WHERE id = $1`,
          [row.proposal_id, budgetTotal, row.budget_insurance_id],
        );
      }
    }

    if (!open) continue;
    rules ??= await readFunnelRules(tx, tenantId);
    const transition = await applyLisFactsRule(tx, tenantId, row, rules);
    if (transition) transitions.push(transition);
  }
  return transitions;
}

const SELECT_JOIN = `
  SELECT p.id AS proposal_id, p.status, p.origin, p.total_price, p.insurance_id,
         p.lis_budget_number, p.lis_requisition_number,
         p.lis_paid_value, to_char(p.lis_paid_on, 'YYYY-MM-DD') AS lis_paid_on,
         b.id AS budget_id, b.proposal_id AS budget_proposal_id,
         NULLIF(b.requisition_number, '') AS requisition_number,
         b.paid_value, to_char(b.paid_on, 'YYYY-MM-DD') AS paid_on,
         b.total_value AS budget_total_value, b.insurance_id AS budget_insurance_id
    FROM proposals p
    JOIN lis_budgets b ON b.tenant_id = p.tenant_id AND b.number = p.lis_budget_number
   WHERE p.tenant_id = $1`;

/** Os orcamentos de `numbers` que tem proposta vinculada. Devolve as transicoes de sistema feitas. */
export async function reconcileBudgets(
  tx: DbTx,
  tenantId: string,
  numbers: readonly string[],
): Promise<SystemTransition[]> {
  if (numbers.length === 0) return [];
  const result = await tx.query<ReconcileRow>(
    `${SELECT_JOIN} AND p.lis_budget_number = ANY($2::text[])
     ORDER BY p.id FOR UPDATE OF p`,
    [tenantId, [...numbers]],
  );
  return reconcileRows(tx, tenantId, result.rows);
}

/** Uma proposta, contra o orcamento do numero dela (se ja existir). Devolve as transicoes feitas. */
export async function reconcileProposal(
  tx: DbTx,
  tenantId: string,
  proposalId: string,
): Promise<SystemTransition[]> {
  const result = await tx.query<ReconcileRow>(`${SELECT_JOIN} AND p.id = $2 FOR UPDATE OF p`, [
    tenantId,
    proposalId,
  ]);
  return reconcileRows(tx, tenantId, result.rows);
}

/**
 * Depois do commit: anuncia as transicoes da conciliacao (WS por transicao +
 * cache de analytics). Mantido com este nome para quem ja chamava; o corpo e
 * `announceSystemTransitions` (D-204 item 5).
 */
export async function announceLisWins(
  deps: { wsHub: WsHub; cache: CacheService },
  tenantId: string,
  transitions: readonly SystemTransition[],
): Promise<void> {
  await announceSystemTransitions(deps, tenantId, transitions);
}
