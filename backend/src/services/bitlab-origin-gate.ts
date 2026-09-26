/**
 * Liga/desliga da proposta que nasce do orcamento do Bitlab (CRMLAB-57, D-196
 * item 1): a regra "Nascer do orcamento do Bitlab" da pagina de Regras
 * (CRMLAB-56, `origin.fromBitlab`).
 *
 * Roda dentro da transacao do chunk de ingestao (`db.withTenant` nao aninha):
 * a leitura da regra tem que usar o `tx` recebido.
 */
import type { DbTx } from '../db/types.js';
import { readFunnelRules } from './funnel-rules.service.js';

export async function isBitlabOriginEnabled(tx: DbTx, tenantId: string): Promise<boolean> {
  return (await readFunnelRules(tx, tenantId)).origin.fromBitlab;
}
