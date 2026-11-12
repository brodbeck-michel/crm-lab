import { useQuery } from '@tanstack/react-query';
import { isRealtimeConnected, operationApi, queryKeys, staleTimes } from '@/api';

/**
 * Retrato de Gestão da Operação (PAGES.md §10) usado pelo contador de Decisões
 * na Sidebar e pelo aviso de pedido de aprovação (CRMLAB-146, D-318). Mesma
 * chave de `Operation.tsx` e `Decisions.tsx`: é um cache só, não uma segunda
 * chamada. `approval.*` no WebSocket já invalida; o polling é rede de
 * segurança (CRMLAB-122, D-288). Aba escondida não faz polling.
 */
export function usePendingDecisions(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.operationOverview({}),
    queryFn: () => operationApi.overview({}),
    enabled,
    staleTime: staleTimes.operation,
    refetchInterval: () => (isRealtimeConnected() ? 5 * 60_000 : 60_000),
  });
}
