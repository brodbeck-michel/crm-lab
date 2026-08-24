import { QueryClient } from '@tanstack/react-query';
import { isApiError } from './client';

/**
 * QueryClient da aplicação.
 *
 * `retry`: não repete erro de negócio (4xx) — só falha de infraestrutura.
 * `TOKEN_EXPIRED` nunca chega aqui: `client.ts` renova e repete de forma
 * transparente antes de a promise rejeitar.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
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
