import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { USER_IDLE_AFTER_MS } from '@crm-lab/shared';
import { useAuthStore } from '@/stores';
import { IDLE_CHECK_INTERVAL_MS, LAST_ACTIVITY_STORAGE_KEY, useIdlePresence } from './useIdlePresence';

const mutate = vi.fn();
vi.mock('@/api', () => ({ useUpdateMyPresence: () => ({ mutate }) }));

function loginAs(role: 'attendant' | 'platform_operator'): void {
  useAuthStore.setState({
    user: { id: 'u-1', email: 'ana@lab.com', name: 'Ana', role, discountLimit: 15 },
  } as Partial<ReturnType<typeof useAuthStore.getState>>);
}

describe('useIdlePresence (CRMLAB-120, D-286 item 4)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mutate.mockClear();
    window.localStorage.clear();
    loginAs('attendant');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('30 min parada avisa idle uma vez; mexer avisa a volta na hora', () => {
    renderHook(() => useIdlePresence());

    vi.advanceTimersByTime(USER_IDLE_AFTER_MS - IDLE_CHECK_INTERVAL_MS);
    expect(mutate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(IDLE_CHECK_INTERVAL_MS * 3);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenLastCalledWith({ idle: true });

    window.dispatchEvent(new Event('keydown'));
    expect(mutate).toHaveBeenCalledTimes(2);
    expect(mutate).toHaveBeenLastCalledWith({ idle: false });
  });

  it('atividade em OUTRA aba (localStorage) mantém esta ativa', () => {
    renderHook(() => useIdlePresence());

    for (let elapsed = 0; elapsed < USER_IDLE_AFTER_MS * 2; elapsed += 60_000) {
      vi.advanceTimersByTime(60_000);
      window.localStorage.setItem(LAST_ACTIVITY_STORAGE_KEY, String(Date.now()));
    }
    expect(mutate).not.toHaveBeenCalled();
  });

  it('operador da plataforma não participa', () => {
    loginAs('platform_operator');
    renderHook(() => useIdlePresence());
    vi.advanceTimersByTime(USER_IDLE_AFTER_MS * 2);
    expect(mutate).not.toHaveBeenCalled();
  });
});
