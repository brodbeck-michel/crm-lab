import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import type * as ClientModule from '@/api/client';
import { useAuthStore } from '@/stores';

/**
 * CRMLAB-122 (D-288): carga de página com o `/auth/refresh` em 429 não termina
 * o bootstrap sem token (o guard mandaria para `/login`) — tenta de novo.
 */
const refreshMock = vi.hoisted(() => vi.fn<() => Promise<string>>());
vi.mock('@/api/client', async (importOriginal) => {
  const original = await importOriginal<typeof ClientModule>();
  return { ...original, refreshAccessToken: refreshMock };
});

const { useSessionBootstrap } = await import('./useSession');

function Probe() {
  return <span data-testid="ready">{String(useSessionBootstrap())}</span>;
}

beforeEach(() => {
  refreshMock.mockReset();
  useAuthStore.setState({
    user: { id: 'u-1', email: 'a@lab.com', name: 'Ana', role: 'attendant', discountLimit: 15 },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useSessionBootstrap — 429 no refresh', () => {
  it('429 não termina o bootstrap: tenta de novo até o refresh passar', async () => {
    const limited = new ApiError('RATE_LIMIT_EXCEEDED', 'Limite', 429);
    refreshMock
      .mockRejectedValueOnce(limited)
      .mockRejectedValueOnce(limited)
      .mockResolvedValueOnce('access-2');

    await act(async () => {
      render(<Probe />);
    });
    await vi.waitFor(() => expect(screen.getByTestId('ready').textContent).toBe('true'));
    expect(refreshMock).toHaveBeenCalledTimes(3);
  });

  it('401 (cookie vencido) termina o bootstrap na hora, como antes', async () => {
    refreshMock.mockRejectedValueOnce(new ApiError('UNAUTHORIZED', 'x', 401));
    await act(async () => {
      render(<Probe />);
    });
    await vi.waitFor(() => expect(screen.getByTestId('ready').textContent).toBe('true'));
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });
});
