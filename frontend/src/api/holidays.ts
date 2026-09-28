import type { CreateHolidayRequest, Holiday, HolidaysResponse } from '@crm-lab/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { http } from './client';
import { queryKeys } from './query-keys';

/**
 * `/settings/holidays` (docs/api/API_CONTRACTS.md §6d, CRMLAB-62) — feriados
 * nacionais (calculados, só leitura) e os do laboratório. `GET` todo perfil,
 * `POST`/`DELETE` manager/admin.
 */
export const holidaysApi = {
  list: (year: number) => http.get<HolidaysResponse>('/settings/holidays', { year }),
  create: (body: CreateHolidayRequest) => http.post<Holiday>('/settings/holidays', body),
  remove: (id: string) => http.delete<void>(`/settings/holidays/${id}`),
};

export function useHolidays(year: number) {
  return useQuery({
    queryKey: queryKeys.holidays(year),
    queryFn: () => holidaysApi.list(year),
    staleTime: 60_000,
  });
}

export function useCreateHoliday() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateHolidayRequest) => holidaysApi.create(body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['settings', 'holidays'] }),
  });
}

export function useDeleteHoliday() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => holidaysApi.remove(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['settings', 'holidays'] }),
  });
}
