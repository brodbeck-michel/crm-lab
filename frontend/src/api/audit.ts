import type { ListAuditQuery, ListAuditResponse } from '@crm-lab/shared';
import { useQuery } from '@tanstack/react-query';
import { http } from './client';
import { queryKeys } from './query-keys';
import type { QueryParams } from './client';

/**
 * `/audit` — aba "Log de auditoria" de `/settings/users` (admin).
 * Somente leitura: quem escreve auditoria é o backend (CLAUDE.md §7).
 */
export const auditApi = {
  list: (query: ListAuditQuery = {}) => http.get<ListAuditResponse>('/audit', query as QueryParams),
};

/* ── React Query Hooks ──────────────────────────────────────────────────── */

export function useAuditList(filters?: ListAuditQuery) {
  return useQuery({
    queryKey: queryKeys.audit(filters),
    queryFn: async () => {
      const res = await auditApi.list(filters);
      return res;
    },
    staleTime: 60000, // 1 minuto
  });
}
