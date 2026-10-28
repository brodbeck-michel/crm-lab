import { useEffect } from 'react';
import { hashKey, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { createWsClient, queryKeys } from '@/api';
import { useToast } from '@/components/ui';
import { useAuthStore, selectIsAuthenticated } from '@/stores';
import { ALERTS_QUERY } from './useNewMessageAlerts';

/**
 * CRMLAB-122 (D-288): janela do lote de invalidações. Meio segundo é
 * imperceptível na tela e junta a rajada típica (várias mensagens seguidas do
 * paciente + os tiques de entrega/leitura) num refetch só.
 */
export const WS_INVALIDATE_BATCH_MS = 500;

const BACKGROUND_LIVE_KEYS = new Set([
  hashKey(queryKeys.conversations(ALERTS_QUERY)),
  hashKey(queryKeys.internalChannels()),
]);

/**
 * O que continua vivo com a aba escondida (só na aba eleita — lib/tab-presence):
 * as duas listas de que o aviso de mensagem nova precisa (CRMLAB-72/116) — a
 * notificação do navegador existe justamente para a aba em segundo plano.
 */
export function isBackgroundLiveKey(queryKey: QueryKey): boolean {
  return BACKGROUND_LIVE_KEYS.has(hashKey(queryKey));
}

/**
 * Mantém UMA conexão WebSocket enquanto houver sessão.
 * Os eventos só invalidam queries (`api/ws.ts`) — nenhum patch de cache.
 */
export function useAppWebSocket(): void {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const isAuthenticated = useAuthStore(selectIsAuthenticated);

  useEffect(() => {
    if (!isAuthenticated) return;

    const client = createWsClient({
      queryClient,
      toast: (message, tone) => toast(message, { tone: tone ?? 'positive' }),
      invalidateBatchMs: WS_INVALIDATE_BATCH_MS,
      isBackgroundLive: isBackgroundLiveKey,
    });

    client.connect();
    return () => client.disconnect();
  }, [isAuthenticated, queryClient, toast]);
}
