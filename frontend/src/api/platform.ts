import type {
  BillingResponse,
  CreateTenantRequest,
  ListTenantsResponse,
  PaginationQuery,
  TenantSummary,
} from '@crm-lab/shared';
import { http } from './client';
import type { QueryParams } from './client';

/**
 * Console da plataforma (`/platform/*`) — docs/frontend/PAGES.md §11.
 *
 * É um domínio ISOLADO: só `platform_operator` chega aqui, e por requisito
 * NÃO existe endpoint de conversa, paciente ou canal interno de lab nesta
 * superfície. Nada aqui é filtrado por `tenant_id` do usuário — o operador
 * enxerga a lista de tenants, e essa é justamente a exceção auditada.
 */
export const platformApi = {
  tenants: (query: PaginationQuery = {}) =>
    http.get<ListTenantsResponse>('/platform/tenants', query as QueryParams),

  createTenant: (body: CreateTenantRequest) =>
    http.post<TenantSummary>('/platform/tenants', body),

  billing: () => http.get<BillingResponse>('/platform/billing'),
};
