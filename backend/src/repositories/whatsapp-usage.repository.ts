/**
 * Uso da Cloud API por mes (CRMLAB-141, D-312, API_CONTRACTS §6.2).
 *
 * O custo e CALCULADO NA LEITURA (D-312 item 4): a franquia depende da ordem
 * das mensagens no mes e o preco pode ganhar linha nova em `whatsapp_price_table`.
 *
 * Fuso: `messages.created_at` e `TIMESTAMP` sem fuso guardando UTC (D-078). O
 * mes e o civil de America/Sao_Paulo, entao os limites viram UTC no SQL e a data
 * local de cada mensagem escolhe o preco vigente.
 */
import type { WhatsAppPricingCategory } from '@crm-lab/shared';
import type { DbClient } from '../db/types.js';

export interface UsageRow {
  category: WhatsAppPricingCategory;
  count: number;
  freeCount: number;
  /** BRL, sem arredondar (soma mensagem a mensagem). */
  cost: number;
}

export interface PriceRow {
  category: WhatsAppPricingCategory;
  price: number;
}

export class WhatsAppUsageRepository {
  constructor(private readonly db: DbClient) {}

  /**
   * Mensagens enviadas pelo CRM em `cloud_api` (`pricing_category` preenchida),
   * status `sent` ou posterior, no mes `monthStart` (YYYY-MM-01, local).
   * As `freeAllowance` primeiras `service` (por `created_at`) sao gratis.
   */
  async monthly(tenantId: string, monthStart: string, freeAllowance: number): Promise<UsageRow[]> {
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{
        category: WhatsAppPricingCategory;
        count: number;
        free_count: number;
        cost: string;
      }>(
        `WITH bounds AS (
           SELECT ($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'UTC' AS start_utc,
                  (($2::date + INTERVAL '1 month')::timestamp AT TIME ZONE 'America/Sao_Paulo')
                    AT TIME ZONE 'UTC' AS end_utc
         ),
         sent AS (
           SELECT m.pricing_category AS category,
                  ((m.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date AS local_date,
                  ROW_NUMBER() OVER (PARTITION BY m.pricing_category ORDER BY m.created_at, m.id) AS seq
             FROM messages m, bounds b
            WHERE m.tenant_id = $1
              AND m.pricing_category IS NOT NULL
              AND m.sender_type IN ('agent', 'system')
              AND m.status IN ('sent', 'delivered', 'read')
              AND m.created_at >= b.start_utc
              AND m.created_at < b.end_utc
         )
         SELECT s.category,
                COUNT(*)::int AS count,
                COUNT(*) FILTER (WHERE s.category = 'service' AND s.seq <= $3)::int AS free_count,
                COALESCE(SUM(CASE WHEN s.category = 'service' AND s.seq <= $3 THEN 0
                                  ELSE COALESCE(p.price_brl, 0) END), 0)::text AS cost
           FROM sent s
           LEFT JOIN LATERAL (
             SELECT w.price_brl FROM whatsapp_price_table w
              WHERE w.category = s.category AND w.effective_from <= s.local_date
              ORDER BY w.effective_from DESC
              LIMIT 1
           ) p ON TRUE
          GROUP BY s.category`,
        [tenantId, monthStart, freeAllowance],
      );
      return result.rows.map((row) => ({
        category: row.category,
        count: Number(row.count),
        freeCount: Number(row.free_count),
        cost: Number(row.cost),
      }));
    });
  }

  /** Preco vigente em `date` (YYYY-MM-DD) por categoria. Tabela global, so leitura. */
  async pricesAt(tenantId: string, date: string): Promise<PriceRow[]> {
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{ category: WhatsAppPricingCategory; price_brl: string }>(
        `SELECT DISTINCT ON (category) category, price_brl::text AS price_brl
           FROM whatsapp_price_table
          WHERE effective_from <= $1::date
          ORDER BY category, effective_from DESC`,
        [date],
      );
      return result.rows.map((row) => ({ category: row.category, price: Number(row.price_brl) }));
    });
  }
}
