/**
 * BitlabProposalService — SERVICES.md §26 (CRMLAB-57, D-195/D-196).
 *
 * Cria a proposta de origem `bitlab` a partir do orcamento do LIS. Sem rota e
 * sem estado, como o LisReconcileService: roda DENTRO da transacao do chunk de
 * `LisImportService.ingestRows`, depois do upsert e antes da conciliacao (a
 * proposta criada ja entra na conciliacao do mesmo chunk, que grava
 * `lis_budgets.proposal_id` e espelha a requisicao).
 *
 * Quem chama anuncia com `announceBitlabProposals` DEPOIS do commit: um WS
 * emitido dentro da transacao anunciaria um cartao que um rollback desfaria.
 */
import type { DbTx } from '../db/types.js';
import { saoPauloDateTime } from '../lib/bitlab-client.js';
import type { CacheService } from '../lib/cache.js';
import { logger } from '../lib/logger.js';
import type { WsHub } from '../lib/ws-hub.js';
import * as auditRepo from '../repositories/audit.repository.js';
import { insertBitlabProposal, insertHistory } from '../repositories/proposal.repository.js';
import { toNumber } from '../repositories/row-mappers.js';
import { cachePrefix as analyticsCachePrefix } from './analytics.service.js';
import { isBitlabOriginEnabled } from './bitlab-origin-gate.js';

/**
 * Marca do tenant (D-196 item 2): o dia de Brasilia a partir do qual orcamento
 * emitido vira proposta. Gravada UMA vez (`COALESCE`), na primeira chamada com
 * a regra ligada — e o que impede o historico ja gravado de virar cartao.
 */
async function ensureSince(tx: DbTx, tenantId: string, today: string): Promise<string> {
  const result = await tx.query<{ since: string }>(
    `INSERT INTO tenant_settings (tenant_id, bitlab_proposals_since)
     VALUES ($1, $2::date)
     ON CONFLICT (tenant_id) DO UPDATE
       SET bitlab_proposals_since = COALESCE(tenant_settings.bitlab_proposals_since,
                                             EXCLUDED.bitlab_proposals_since)
     RETURNING to_char(bitlab_proposals_since, 'YYYY-MM-DD') AS since`,
    [tenantId, today],
  );
  return result.rows[0]?.since ?? today;
}

interface CandidateRow {
  number: string;
  total_value: unknown;
  insurance_id: string | null;
  owner_id: string | null;
}

/**
 * Cria as propostas dos orcamentos de `numbers` que ainda nao tem proposta.
 * Devolve os ids criados. Idempotente: orcamento com proposta nao e candidato,
 * e o `ON CONFLICT DO NOTHING` absorve a corrida com outra transacao.
 */
export async function createBitlabProposals(
  tx: DbTx,
  tenantId: string,
  numbers: readonly string[],
  now: Date = new Date(),
): Promise<string[]> {
  if (numbers.length === 0) return [];
  if (!(await isBitlabOriginEnabled(tx, tenantId))) return [];

  const since = await ensureSince(tx, tenantId, saoPauloDateTime(now).slice(0, 10));

  // Responsavel provisorio: o login ligado ao atendente do Bitlab, se ativo (D-195 item 5).
  const candidates = await tx.query<CandidateRow>(
    `SELECT b.number, b.total_value, b.insurance_id,
            CASE WHEN u.is_active THEN a.user_id END AS owner_id
       FROM lis_budgets b
       LEFT JOIN attendants a ON a.id = b.attendant_id
       LEFT JOIN users u ON u.id = a.user_id
      WHERE b.tenant_id = $1
        AND b.number = ANY($2::text[])
        AND b.issued_on IS NOT NULL
        AND b.issued_on >= $3::date
        AND NOT EXISTS (
              SELECT 1 FROM proposals p
               WHERE p.tenant_id = b.tenant_id AND p.lis_budget_number = b.number)
      ORDER BY b.issued_on, b.number`,
    [tenantId, [...numbers], since],
  );

  const created: string[] = [];
  for (const row of candidates.rows) {
    const totalPrice = toNumber(row.total_value);
    const id = await insertBitlabProposal(tx, {
      tenantId,
      lisBudgetNumber: row.number,
      createdBy: row.owner_id,
      totalPrice,
      insuranceId: row.insurance_id,
    });
    if (id === null) continue;
    await insertHistory(tx, { tenantId, proposalId: id, status: 'novo_contato', changedBy: null });
    await auditRepo.insert(tx, {
      tenantId,
      userId: null,
      action: 'create_proposal',
      entityType: 'proposal',
      entityId: id,
      newValues: { origin: 'bitlab', lisBudgetNumber: row.number, totalPrice, status: 'novo_contato' },
    });
    created.push(id);
  }
  return created;
}

/**
 * Depois do commit: WS `proposal.created` por proposta criada (o cartao
 * aparece no Kanban sem recarregar) e invalidacao do cache de analytics (o
 * funil e o pipeline mudaram). Falha de cache nao derruba nada.
 */
export async function announceBitlabProposals(
  deps: { wsHub: WsHub; cache: CacheService },
  tenantId: string,
  proposalIds: readonly string[],
): Promise<void> {
  if (proposalIds.length === 0) return;
  for (const proposalId of proposalIds) {
    deps.wsHub.emitToTenant(tenantId, 'proposal.created', { proposalId });
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
