import { QueryClient } from '@tanstack/react-query';
import { isApiError } from './client';

/**
 * QueryClient da aplicação.
 *
 * `retry`: não repete erro de negócio (4xx) — só falha de infraestrutura.
 * `RATE_LIMIT_EXCEEDED` (429) também não repete aqui: `client.ts` já esperou
 * o `Retry-After` e repetiu (D-288).
 * `TOKEN_EXPIRED` nunca chega aqui: `client.ts` renova e repete de forma
 * transparente antes de a promise rejeitar.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        // CRMLAB-122 (D-288): o mesmo dado montado por telas/componentes
        // diferentes em sequência (navegar e voltar, Sidebar + tela) não refaz
        // o GET dentro de 10 s. Quem precisa de dado novo já é avisado pelo WS
        // (`invalidateQueries` ignora `staleTime`).
        staleTime: 10_000,
        // Explícito: polling NUNCA roda com a aba em segundo plano.
        refetchIntervalInBackground: false,
        retry: (failureCount, error) => {
          if (isApiError(error) && error.statusCode >= 400 && error.statusCode < 500) return false;
          return failureCount < 2;
        },
      },
      mutations: { retry: false },
    },
  });
}

export const queryClient = createQueryClient();
