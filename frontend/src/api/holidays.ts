import type {
  BusinessCalendarResponse,
  CreateHolidayRequest,
  Holiday,
  HolidaysResponse,
} from '@crm-lab/shared';
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
  /** §6e (CRMLAB-84): expediente + feriados da janela do alerta de tempo de resposta. */
  calendar: () => http.get<BusinessCalendarResponse>('/settings/business-calendar'),
};

/**
 * Calendário útil do alerta de tempo de resposta (D-254). Todo perfil lê. Só
 * busca com a regra ligada; 5 min de `staleTime` — muda raramente, e a janela
 * já cobre amanhã para a aba que atravessa a meia-noite.
 */
export function useBusinessCalendar(options: { enabled: boolean }) {
  return useQuery({
    queryKey: queryKeys.businessCalendar(),
    queryFn: () => holidaysApi.calendar(),
    staleTime: 5 * 60_000,
    enabled: options.enabled,
  });
}

/** Feriado mudou: a lista do ano E o calendário do alerta. */
async function invalidateHolidays(queryClient: ReturnType<typeof useQueryClient>): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['settings', 'holidays'] }),
    queryClient.invalidateQueries({ queryKey: queryKeys.businessCalendar() }),
  ]);
}

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
    onSuccess: () => invalidateHolidays(queryClient),
  });
}

export function useDeleteHoliday() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => holidaysApi.remove(id),
    onSuccess: () => invalidateHolidays(queryClient),
  });
}
