import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { vi } from 'vitest';

/**
 * Resultados COMPLETOS e TIPADOS de TanStack Query para uso em teste.
 *
 * Por que existe: os specs mockavam hooks com `{ data, isLoading } as any`. O
 * `as any` desliga a fronteira exatamente onde ela importa — em
 * `UserModal.spec.tsx` duas metades do mesmo arquivo devolviam `data: [...]` e
 * `data: { users, pagination }` para o MESMO hook, shapes incompatíveis, e nada
 * reclamava. Aqui o `data` é `T`: se a tela e o mock discordarem, é erro de
 * compilação, não teste verde mentindo.
 *
 * Nenhum campo é inventado: o objeto é o `UseQueryResult` / `UseMutationResult`
 * inteiro. Se o TanStack Query mudar o shape, `npm run typecheck` acusa aqui —
 * num arquivo só, não em dezoito.
 */

/** Estado de sucesso de `useQuery`, com `data` do tipo real do hook. */
export function querySuccess<T>(data: T): UseQueryResult<T, Error> {
  return {
    data,
    dataUpdatedAt: Date.now(),
    error: null,
    errorUpdatedAt: 0,
    failureCount: 0,
    failureReason: null,
    errorUpdateCount: 0,
    isError: false,
    isFetched: true,
    isFetchedAfterMount: true,
    isFetching: false,
    isInitialLoading: false,
    isLoading: false,
    isLoadingError: false,
    isPaused: false,
    isPending: false,
    isPlaceholderData: false,
    isRefetchError: false,
    isRefetching: false,
    isStale: false,
    isSuccess: true,
    isEnabled: true,
    status: 'success',
    fetchStatus: 'idle',
    refetch: vi.fn(),
  };
}

/** Estado de carregamento de `useQuery` (`data` ainda `undefined`). */
export function queryLoading<T>(): UseQueryResult<T, Error> {
  return {
    data: undefined,
    dataUpdatedAt: 0,
    error: null,
    errorUpdatedAt: 0,
    failureCount: 0,
    failureReason: null,
    errorUpdateCount: 0,
    isError: false,
    isFetched: false,
    isFetchedAfterMount: false,
    isFetching: true,
    isInitialLoading: true,
    isLoading: true,
    isLoadingError: false,
    isPaused: false,
    isPending: true,
    isPlaceholderData: false,
    isRefetchError: false,
    isRefetching: false,
    isStale: true,
    isSuccess: false,
    isEnabled: true,
    status: 'pending',
    fetchStatus: 'fetching',
    refetch: vi.fn(),
  };
}

/**
 * `useMutation` OCIOSO — o que as telas leem daqui e `mutate` / `mutateAsync`.
 */
export function mutationIdle<TData, TVariables>(
  mutate: UseMutationResult<TData, Error, TVariables, unknown>['mutate'] = vi.fn(),
): UseMutationResult<TData, Error, TVariables, unknown> {
  return {
    data: undefined,
    error: null,
    variables: undefined,
    context: undefined,
    failureCount: 0,
    failureReason: null,
    isError: false,
    isIdle: true,
    isPaused: false,
    isPending: false,
    isSuccess: false,
    status: 'idle',
    submittedAt: 0,
    mutate,
    mutateAsync: vi.fn(async () => undefined as TData),
    reset: vi.fn(),
  };
}

/**
 * `useMutation` EM VOO (`isPending: true`) — o estado que desabilita o botao
 * de submit. `variables` e obrigatorio de proposito: uma mutation pendente sem
 * as variaveis que a dispararam nao existe no runtime real.
 */
export function mutationPending<TData, TVariables>(
  variables: TVariables,
  mutate: UseMutationResult<TData, Error, TVariables, unknown>['mutate'] = vi.fn(),
): UseMutationResult<TData, Error, TVariables, unknown> {
  return {
    data: undefined,
    error: null,
    variables,
    context: undefined,
    failureCount: 0,
    failureReason: null,
    isError: false,
    isIdle: false,
    isPaused: false,
    isPending: true,
    isSuccess: false,
    status: 'pending',
    submittedAt: Date.now(),
    mutate,
    mutateAsync: vi.fn(async () => undefined as TData),
    reset: vi.fn(),
  };
}
