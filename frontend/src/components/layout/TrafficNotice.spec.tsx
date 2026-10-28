import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionWaitScreen, TrafficNotice } from './TrafficNotice';
import { createTabPresence, type TabPresence } from '@/lib/tab-presence';
import { http, resetApiClient } from '@/api/client';

/** CRMLAB-122 (D-288): aviso discreto de várias abas e de 429 em espera. */

function presenceWith(others: number): TabPresence {
  const presence = createTabPresence({ channel: null });
  for (let i = 0; i < others; i += 1) {
    presence.receive({ type: 'hello', id: `t-${i}`, startedAt: i, visible: true });
  }
  return presence;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetApiClient();
});

describe('TrafficNotice', () => {
  it('uma aba só e sem 429: não mostra nada', () => {
    render(<TrafficNotice presence={presenceWith(0)} />);
    expect(screen.queryByTestId('traffic-notice')).toBeNull();
  });

  it('avisa quando o CRM está aberto em mais de uma aba', () => {
    render(<TrafficNotice presence={presenceWith(2)} />);
    expect(screen.getByRole('status')).toHaveTextContent('O CRM está aberto em 3 abas');
  });

  it('"Entendi" esconde o aviso até abrir mais uma aba', async () => {
    const presence = presenceWith(1);
    render(<TrafficNotice presence={presence} />);
    await userEvent.click(screen.getByRole('button', { name: 'Entendi' }));
    expect(screen.queryByTestId('traffic-notice')).toBeNull();

    act(() => presence.receive({ type: 'hello', id: 'nova', startedAt: 9, visible: true }));
    expect(screen.getByRole('status')).toHaveTextContent('3 abas');
  });

  it('429: mostra "aguarde" enquanto o client espera e some sozinho depois', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        n += 1;
        return {
          ok: n > 1,
          status: n > 1 ? 200 : 429,
          headers: new Headers({ 'Retry-After': '2' }),
          text: () =>
            Promise.resolve(
              n > 1
                ? '{}'
                : '{"error":{"code":"RATE_LIMIT_EXCEEDED","message":"x","statusCode":429}}',
            ),
        } as unknown as Response;
      }),
    );

    render(<TrafficNotice presence={presenceWith(0)} />);
    let done = false;
    void http.get('/conversations').then(() => {
      done = true;
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Aguarde alguns segundos');
    expect(screen.queryByRole('button', { name: 'Entendi' })).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_200);
    });
    expect(done).toBe(true);
    expect(screen.queryByTestId('traffic-notice')).toBeNull();
  });

  it('carga da página em 429 (SessionWaitScreen): aviso em vez de tela em branco', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 429,
        headers: new Headers({ 'Retry-After': '2' }),
        text: () => Promise.resolve('{}'),
      })),
    );
    const { container } = render(<SessionWaitScreen />);
    expect(container).toBeEmptyDOMElement(); // sem 429: o branco instantâneo de sempre

    void http.post('/auth/login', {}, { auth: false }).catch(() => undefined);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId('session-wait')).toHaveTextContent('não precisa recarregar');
  });
});
