import type {
  BillingResponse,
  CreateTenantRequest,
  CreateTenantResponse,
  ListTenantsQuery,
  ListTenantsResponse,
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
  tenants: (query: ListTenantsQuery = {}) =>
    http.get<ListTenantsResponse>('/platform/tenants', query as QueryParams),

  /**
   * `201 TenantSummary` — o recurso CRU, **sem envelope** (D-070).
   *
   * Era `{ tenant: TenantSummary }`, o único ponto da API que envelopava um
   * recurso singular; todo o resto (`POST /exams`, `POST /users`, `PATCH
   * /proposals/:id`) já devolvia o objeto direto. `CreateTenantResponse` é hoje
   * um alias de `TenantSummary` em @crm-lab/shared — quem consome lê os campos
   * direto, sem `.tenant`.
   */
  createTenant: (body: CreateTenantRequest) =>
    http.post<CreateTenantResponse>('/platform/tenants', body),

  billing: () => http.get<BillingResponse>('/platform/billing'),
};
