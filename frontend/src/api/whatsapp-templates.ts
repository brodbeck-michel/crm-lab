import { useQuery } from '@tanstack/react-query';
import type { ListWhatsAppTemplatesResponse } from '@crm-lab/shared';
import { http } from './client';
import { queryKeys } from './query-keys';

/**
 * Modelos aprovados da Meta (CRMLAB-136, D-309, API_CONTRACTS §6.2).
 * Laboratório em QR recebe `[]`. O servidor guarda 5 min em cache; a tela
 * acompanha com o mesmo `staleTime`.
 */
export const whatsappTemplatesApi = {
  list: () => http.get<ListWhatsAppTemplatesResponse>('/whatsapp/templates'),
};

export const WHATSAPP_TEMPLATES_STALE_MS = 5 * 60_000;

export function useWhatsAppTemplates(enabled = true) {
  return useQuery({
    queryKey: queryKeys.whatsappTemplates(),
    queryFn: () => whatsappTemplatesApi.list(),
    enabled,
    staleTime: WHATSAPP_TEMPLATES_STALE_MS,
    retry: false,
  });
}
