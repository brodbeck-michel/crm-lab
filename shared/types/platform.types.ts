import type { IsoDate, IsoDateTime, PaginationMeta } from './api.types.js';

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
