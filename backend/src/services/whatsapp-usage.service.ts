/**
 * Uso e custo ESTIMADO da Cloud API no mes (CRMLAB-141, D-312, API_CONTRACTS §6.2,
 * SERVICES §35). Nao e a fatura da Meta: e o que o CRM consegue conferir.
 *
 * - Conta so o que o CRM enviou pela Cloud API e saiu (`sent` ou posterior);
 * - franquia: as `WHATSAPP_FREE_SERVICE_MONTHLY` primeiras `service` do mes
 *   civil (America/Sao_Paulo). Um numero da Meta por laboratorio, entao a
 *   franquia "por numero" e a do laboratorio;
 * - preco = linha de `whatsapp_price_table` vigente na data de cada mensagem;
 *   `unitPrice` mostra o vigente no fim do mes (ou hoje, no mes corrente).
 */
import {
  WHATSAPP_PRICING_CATEGORIES,
  type WhatsAppUsageCategory,
  type WhatsAppUsageResponse,
} from '@crm-lab/shared';
import { env } from '../config/env.js';
import type { DbClient } from '../db/types.js';
import type { TenantContext } from '../http/context.js';
import { BusinessError } from '../http/errors.js';
import { WhatsAppUsageRepository } from '../repositories/whatsapp-usage.repository.js';

const TIMEZONE = 'America/Sao_Paulo';
const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** Data civil (YYYY-MM-DD) em America/Sao_Paulo. */
function localDate(instant: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function lastDayOf(month: string): string {
  const [year, mm] = month.split('-').map(Number);
  // Dia 0 do mes seguinte = ultimo dia deste (UTC, sem fuso envolvido).
  const day = new Date(Date.UTC(year ?? 0, mm ?? 1, 0)).getUTCDate();
  return `${month}-${String(day).padStart(2, '0')}`;
}

export interface WhatsAppUsageService {
  monthly(ctx: TenantContext, month?: string): Promise<WhatsAppUsageResponse>;
}

export function createWhatsAppUsageService(deps: {
  db: DbClient;
  now?: () => Date;
  freeAllowance?: number;
}): WhatsAppUsageService {
  const repo = new WhatsAppUsageRepository(deps.db);
  const now = deps.now ?? (() => new Date());

  return {
    async monthly(ctx, month) {
      if (ctx.role !== 'manager' && ctx.role !== 'admin') {
        throw new BusinessError('FORBIDDEN', { requiredRoles: ['manager', 'admin'] });
      }
      const today = localDate(now());
      const current = today.slice(0, 7);
      const target = month ?? current;
      if (!MONTH_PATTERN.test(target)) {
        throw new BusinessError('VALIDATION_ERROR', { fields: { month: 'Use o formato AAAA-MM' } });
      }
      if (target > current) {
        throw new BusinessError('VALIDATION_ERROR', { fields: { month: 'Mês futuro' } });
      }

      const allowance = deps.freeAllowance ?? env.WHATSAPP_FREE_SERVICE_MONTHLY;
      const priceDate = target === current ? today : lastDayOf(target);
      const [rows, prices] = await Promise.all([
        repo.monthly(ctx.tenantId, `${target}-01`, allowance),
        repo.pricesAt(ctx.tenantId, priceDate),
      ]);

      const categories: WhatsAppUsageCategory[] = WHATSAPP_PRICING_CATEGORIES.map((category) => {
        const row = rows.find((r) => r.category === category);
        return {
          category,
          count: row?.count ?? 0,
          freeCount: row?.freeCount ?? 0,
          unitPrice: prices.find((p) => p.category === category)?.price ?? 0,
          cost: round2(row?.cost ?? 0),
        };
      });

      return {
        month: target,
        currency: 'BRL',
        freeServiceAllowance: allowance,
        categories,
        totalCost: round2(categories.reduce((sum, c) => sum + c.cost, 0)),
        isEstimate: true,
      };
    },
  };
}
