import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LisIntegrationSettings, LisSyncRunResult, UserRole } from '@crm-lab/shared';
import { mutationIdle, querySuccess } from '@/test/query-mocks';
import { ToastProvider } from '@/components/ui';
import { useAuthStore } from '@/stores/auth.store';
import LisIntegration from './LisIntegration';
import * as lisIntegrationApi from '@/api/lis-integration';

vi.mock('@/api/lis-integration', async () => {
  const actual = await vi.importActual('@/api/lis-integration');
  return {
    ...actual,
    useLisIntegration: vi.fn(),
    useUpdateLisIntegration: vi.fn(),
    useRunLisSync: vi.fn(),
  };
});

const useLisIntegration = vi.mocked(lisIntegrationApi.useLisIntegration);
const useUpdateLisIntegration = vi.mocked(lisIntegrationApi.useUpdateLisIntegration);
const useRunLisSync = vi.mocked(lisIntegrationApi.useRunLisSync);

const OFF: LisIntegrationSettings = {
  enabled: false,
  apiKeySet: false,
  apiKeyMasked: null,
  watermark: null,
  lastRunAt: null,
  lastSuccessAt: null,
  lastError: null,
  running: false,
  intervalMinutes: 30,
};

const ON: LisIntegrationSettings = {
  ...OFF,
  enabled: true,
  apiKeySet: true,
  apiKeyMasked: '••••••••6y6M',
  watermark: '2026-09-25T13:30:00.000Z',
  lastRunAt: '2026-09-25T14:00:00.000Z',
  lastSuccessAt: '2026-09-25T14:00:00.000Z',
};

function signIn(role: UserRole) {
  useAuthStore.setState({
    user: { id: 'user-9', email: 'quem@lab.com.br', name: 'Quem', role, discountLimit: 10 },
  });
}

function renderPage() {
  return render(
    <ToastProvider>
      <MemoryRouter>
        <LisIntegration />
      </MemoryRouter>
    </ToastProvider>,
  );
}

describe('LisIntegration (/settings/lis-integration)', () => {
  const mockUpdate = vi.fn();
  const mockSync = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    useLisIntegration.mockReturnValue(querySuccess(OFF));
    useUpdateLisIntegration.mockReturnValue(mutationIdle(mockUpdate));
    useRunLisSync.mockReturnValue(mutationIdle(mockSync));
  });

  afterEach(() => {
    useAuthStore.setState({ user: null });
  });

  it('desligada e sem chave: interruptor e "Sincronizar agora" bloqueados', () => {
    signIn('admin');
    renderPage();

    expect(screen.getByText('Desligada')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Sincronizar automaticamente' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Sincronizar agora' })).toBeDisabled();
    expect(screen.getByText('Salve uma chave primeiro.')).toBeInTheDocument();
  });

  it('admin salva a chave e o campo nunca mostra o valor gravado', async () => {
    signIn('admin');
    useLisIntegration.mockReturnValue(querySuccess(ON));
    renderPage();

    const field = screen.getByLabelText('Chave de acesso do Bitlab');
    expect(field).toHaveValue('');
    expect(field).toHaveAttribute('placeholder', '••••••••6y6M');

    await userEvent.type(field, 'sante_orcamento_nova');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar chave' }));

    expect(mockUpdate).toHaveBeenCalledWith({ apiKey: 'sante_orcamento_nova' }, expect.anything());
  });

  it('ligada: mostra intervalo, marca d agua pelos componentes e sincroniza', async () => {
    signIn('manager');
    useLisIntegration.mockReturnValue(querySuccess(ON));
    renderPage();

    expect(screen.getByText('Sincronizando a cada 30 min')).toBeInTheDocument();
    expect(screen.getByText(/Dados atualizados até: 25\/09\/2026 13:30/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Sincronizar agora' }));
    expect(mockSync).toHaveBeenCalled();
  });

  it('gestor nao ve o campo de chave e nao mexe no interruptor', () => {
    signIn('manager');
    useLisIntegration.mockReturnValue(querySuccess(ON));
    renderPage();

    expect(screen.queryByLabelText('Chave de acesso do Bitlab')).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Sincronizar automaticamente' })).toBeDisabled();
  });

  it('erro da ultima rodada aparece em destaque', () => {
    signIn('admin');
    useLisIntegration.mockReturnValue(
      querySuccess({ ...ON, enabled: false, lastError: 'O Bitlab recusou a chave de acesso.' }),
    );
    renderPage();

    expect(screen.getByRole('alert')).toHaveTextContent('O Bitlab recusou a chave de acesso.');
  });

  it('resultado com falha vira toast com a mensagem do servidor', async () => {
    signIn('admin');
    useLisIntegration.mockReturnValue(querySuccess(ON));
    const failed: LisSyncRunResult = {
      status: 'failed',
      received: 0,
      importId: null,
      rowsAccepted: 0,
      proposalsWon: 0,
      watermark: null,
      error: { kind: 'unavailable', message: 'O Bitlab não respondeu.' },
      settings: ON,
    };
    mockSync.mockImplementation((_vars: unknown, options?: { onSuccess?: (r: LisSyncRunResult) => void }) =>
      options?.onSuccess?.(failed),
    );
    renderPage();

    await userEvent.click(screen.getByRole('button', { name: 'Sincronizar agora' }));

    expect(await screen.findByText('O Bitlab não respondeu.')).toBeInTheDocument();
  });
});
