import type { IsoDate, IsoDateTime, PaginationMeta, PaginationQuery } from './api.types.js';

export type SubscriptionPlan = 'starter' | 'pro' | 'enterprise';

/** Console da plataforma: SEM acesso a conversas, pacientes ou canais internos dos labs. */
export interface TenantSummary {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  subscriptionPlan: SubscriptionPlan;
  subscriptionUntil: IsoDate | null;
  userCount: number;
  createdAt: IsoDateTime;
}

/**
 * Query de `GET /platform/tenants` (API_CONTRACTS.md §5b).
 *
 * FONTE UNICA: backend e frontend importam DAQUI. Antes existiam duas copias
 * do mesmo shape — `ListTenantsQuery` no service e `TenantFilters` na tela —
 * que podiam divergir do contrato sem que nada quebrasse.
 *
 * `search` casa nome ou slug (max. 255); `limit` max. 100 (default 20).
 */
export interface ListTenantsQuery extends PaginationQuery {
  search?: string;
  isActive?: boolean;
  plan?: SubscriptionPlan;
}

export interface ListTenantsResponse {
  tenants: TenantSummary[];
  pagination: PaginationMeta;
}

export interface CreateTenantRequest {
  name: string;
  slug: string;
  plan: SubscriptionPlan;
  adminEmail: string;
  adminName: string;
  adminPassword: string;
}

/**
 * `201` de `POST /platform/tenants` — o `TenantSummary` CRU, sem envelope (D-070).
 * Ate a Onda 5 a resposta vinha em `{ tenant }`, a unica escrita de recurso unico
 * envelopada do projeto; a regra de envelope de API_CONTRACTS.md ("Envelope de
 * resposta") a alinhou com `POST /users` e `POST /exams`.
 */
export type CreateTenantResponse = TenantSummary;

export interface TenantUsage {
  tenantId: string;
  tenantName: string;
  plan: SubscriptionPlan;
  messagesIncluded: number;
  messagesUsed: number;
  extraMessages: number;
  proposalCount: number;
  monthlyPrice: number;
}

export interface BillingResponse {
  usage: TenantUsage[];
  totals: { mrr: number; tenants: number; messages: number };
}
