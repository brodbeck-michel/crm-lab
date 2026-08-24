import type { ListAuditQuery, ListAuditResponse } from '@crm-lab/shared';
import { http } from './client';
import type { QueryParams } from './client';

/**
 * `/audit` — aba "Log de auditoria" de `/settings/users` (admin).
 * Somente leitura: quem escreve auditoria é o backend (CLAUDE.md §7).
 */
export const auditApi = {
  list: (query: ListAuditQuery = {}) => http.get<ListAuditResponse>('/audit', query as QueryParams),
};
