import type { CommissionSettings, UpdateCommissionSettingsRequest } from '@crm-lab/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { http } from './client';
import { queryKeys } from './query-keys';

/**
 * `/settings/commissions` (docs/api/API_CONTRACTS.md §6b) — percentuais de
 * comissão sobre venda de exame/check-up (D-113). `GET` manager/admin,
 * `PATCH` admin apenas. Recurso único, cru (D-070) — sem envelope de lista.
 */
export const commissionSettingsApi = {
  get: () => http.get<CommissionSettings>('/settings/commissions'),

  update: (body: UpdateCommissionSettingsRequest) =>
    http.patch<CommissionSettings>('/settings/commissions', body),
};

export function useCommissionSettings() {
  return useQuery({
    queryKey: queryKeys.commissionSettings(),
    queryFn: () => commissionSettingsApi.get(),
  });
}

export function useUpdateCommissionSettings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body: UpdateCommissionSettingsRequest) => commissionSettingsApi.update(body),
    onSuccess: (data) => queryClient.setQueryData(queryKeys.commissionSettings(), data),
  });
}
