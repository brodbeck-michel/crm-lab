import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createWsClient } from '@/api';
import { useToast } from '@/components/ui';
import { useAuthStore, selectIsAuthenticated } from '@/stores';

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
    });

    client.connect();
    return () => client.disconnect();
  }, [isAuthenticated, queryClient, toast]);
}
