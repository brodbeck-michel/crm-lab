/**
 * Apoio dos testes de analytics.
 *
 * As factories de `tests/helpers/factories.ts` nao expoem `created_at` nem
 * `closed_at` — e o AnalyticsService vive justamente dessas duas datas. Em vez
 * de editar a factory (que e de outro dominio), o cenario e montado com a
 * factory e as datas sao fixadas aqui, com um UPDATE explicito.
 *
 * As colunas sao TIMESTAMP sem timezone e o sistema inteiro as le como UTC
 * (`row-mappers.toIso` acrescenta o `Z`). Por isso os testes escrevem strings
 * literais `YYYY-MM-DD HH:MM:SS` em vez de `new Date()`: assim a borda de
 * periodo e testada em UTC de verdade, e nao no fuso da maquina que roda a
 * suite.
 */
import type { DbClient } from '../../src/db/types.js';
import { createProposal, type CreateProposalInput } from '../helpers/factories.js';
import { getTestDb } from '../helpers/test-db.js';

export interface DatedProposalInput extends CreateProposalInput {
  /** `YYYY-MM-DD HH:MM:SS` em UTC. */
  createdAt?: string;
  /** `YYYY-MM-DD HH:MM:SS` em UTC. Estagio terminal deveria sempre ter. */
  closedAt?: string | null;
}

/** Fixa `created_at` / `closed_at` de uma proposta ja criada. */
export async function setProposalDates(
  db: DbClient,
  proposalId: string,
  dates: { createdAt?: string; closedAt?: string | null },
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (dates.createdAt !== undefined) {
    params.push(dates.createdAt);
    sets.push(`created_at = $${params.length}::timestamp`);
  }
  if (dates.closedAt !== undefined) {
    params.push(dates.closedAt);
    sets.push(`closed_at = ${dates.closedAt === null ? 'NULL' : `$${params.length}::timestamp`}`);
    if (dates.closedAt === null) params.pop();
  }
  if (sets.length === 0) return;
  params.push(proposalId);
  await db.withoutTenant((tx) =>
    tx.query(`UPDATE proposals SET ${sets.join(', ')} WHERE id = $${params.length}`, params),
  );
}

/** `createProposal` + datas fixas, que e o que todo cenario daqui precisa. */
export async function createDatedProposal(input: DatedProposalInput): Promise<{ id: string }> {
  const db = input.db ?? (await getTestDb());
  const proposal = await createProposal({ ...input, db });
  await setProposalDates(db, proposal.id, {
    ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
    ...(input.closedAt !== undefined ? { closedAt: input.closedAt } : {}),
  });
  return { id: proposal.id };
}

/** Contexto de teste no formato que os services recebem. */
export function ctxOf(user: {
  id: string;
  tenantId: string;
  role: import('@crm-lab/shared').UserRole;
  discountLimit?: number;
}): import('../../src/http/context.js').TenantContext {
  return {
    userId: user.id,
    tenantId: user.tenantId,
    role: user.role,
    discountLimit: user.discountLimit ?? 15,
    ip: '127.0.0.1',
    userAgent: 'vitest',
  };
}
