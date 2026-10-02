import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMessageAlertsStore } from '@/stores';
import { EnableNotificationsBanner } from './EnableNotificationsBanner';

/**
 * CRMLAB-72 (D-241 item 5): a permissão só é pedida no clique, nunca no
 * carregamento; o aviso some com qualquer resposta.
 */

const requestPermission = vi.fn<() => Promise<NotificationPermission>>();
let permission: NotificationPermission = 'default';

beforeEach(() => {
  permission = 'default';
  requestPermission.mockReset();
  vi.stubGlobal('Notification', {
    get permission() {
      return permission;
    },
    requestPermission,
  });
  useMessageAlertsStore.setState({ notificationsEnabled: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('EnableNotificationsBanner', () => {
  it('não pede permissão ao montar; pede no clique e some com a resposta', async () => {
    requestPermission.mockImplementation(async () => {
      permission = 'granted';
      return 'granted';
    });
    render(<EnableNotificationsBanner />);

    expect(requestPermission).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Ativar notificações' }));

    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Ativar notificações' })).not.toBeInTheDocument();
  });

  it('permissão negada no clique: o aviso some e nada quebra', async () => {
    requestPermission.mockResolvedValue('denied');
    render(<EnableNotificationsBanner />);
    await userEvent.click(screen.getByRole('button', { name: 'Ativar notificações' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('permissão já decidida: não aparece', () => {
    permission = 'denied';
    render(<EnableNotificationsBanner />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('notificação desligada na preferência: não aparece', () => {
    useMessageAlertsStore.setState({ notificationsEnabled: false });
    render(<EnableNotificationsBanner />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('navegador sem a API Notification: não aparece', () => {
    vi.stubGlobal('Notification', undefined);
    render(<EnableNotificationsBanner />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('religar a preferência mostra o aviso de novo', () => {
    useMessageAlertsStore.setState({ notificationsEnabled: false });
    render(<EnableNotificationsBanner />);
    act(() => useMessageAlertsStore.setState({ notificationsEnabled: true }));
    expect(screen.getByRole('button', { name: 'Ativar notificações' })).toBeInTheDocument();
  });
});
