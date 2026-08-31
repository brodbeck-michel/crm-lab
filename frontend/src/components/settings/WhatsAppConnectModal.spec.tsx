import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WhatsAppQrResponse } from '@crm-lab/shared';
import { mutationIdle, queryLoading, querySuccess } from '@/test/query-mocks';
import { ToastProvider } from '@/components/ui';
import { WhatsAppConnectModal } from './WhatsAppConnectModal';
import type { WhatsAppConnectModalProps } from './WhatsAppConnectModal';

/**
 * `@/api/channels` mockado por inteiro: o modal só fala com `useWhatsAppConnect`
 * e `useWhatsAppQr`, e os dois precisam de shape TIPADO (`query-mocks.ts`) para
 * uma divergência de contrato virar erro de compilação, não teste verde
 * mentindo (mesma disciplina de `UserModal.spec.tsx`).
 *
 * O helper do brief (`renderWithProviders`) não existe no repo — o modal usa
 * `useToast`, que lança fora de `<ToastProvider>`, então o render local aqui
 * embrulha nisso. `QueryClientProvider` não é necessário: os hooks de
 * `@/api/channels` estão 100% mockados, o componente nunca chama React Query
 * de verdade.
 */
vi.mock('@/api/channels');

function renderModal(props: WhatsAppConnectModalProps) {
  return render(
    <ToastProvider>
      <WhatsAppConnectModal {...props} />
    </ToastProvider>,
  );
}

function rerenderModal(
  rerender: (ui: React.ReactElement) => void,
  props: WhatsAppConnectModalProps,
) {
  rerender(
    <ToastProvider>
      <WhatsAppConnectModal {...props} />
    </ToastProvider>,
  );
}

describe('WhatsAppConnectModal', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { useWhatsAppConnect, useWhatsAppQr } = await import('@/api/channels');
    vi.mocked(useWhatsAppConnect).mockReturnValue(mutationIdle());
    // Antes de "Conectar", `enabled: false` — sem dado nenhum ainda.
    vi.mocked(useWhatsAppQr).mockReturnValue(queryLoading());
  });

  it('botão Conectar fica desabilitado até marcar o aceite do termo de risco', async () => {
    const user = userEvent.setup();
    renderModal({ open: true, onClose: () => {} });

    expect(screen.getByText(/risco de banimento/i)).toBeInTheDocument();
    const connectButton = screen.getByRole('button', { name: /conectar/i });
    expect(connectButton).toBeDisabled();

    await user.click(screen.getByRole('checkbox', { name: /aceito/i }));
    expect(connectButton).toBeEnabled();
  });

  it('quando o termo já foi aceito antes (reconexão), não exige o checkbox', () => {
    renderModal({ open: true, onClose: () => {}, acceptedTermsAt: '2026-08-01T00:00:00.000Z' });

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /conectar/i })).toBeEnabled();
  });

  it('após conectar, mostra o QR e faz polling até status connected', async () => {
    const user = userEvent.setup();
    const { useWhatsAppConnect, useWhatsAppQr } = await import('@/api/channels');
    vi.mocked(useWhatsAppConnect).mockReturnValue(mutationIdle(vi.fn()));

    /**
     * Sequência CONTROLADA, não fake timers: `qrData` muda quando o teste
     * decide (simulando o próximo tick do polling real) e um `rerender`
     * força o componente a ler o novo valor — determinístico, sem depender
     * de quantos re-renders incidentais acontecem entre o clique no
     * checkbox e o clique em "Conectar".
     */
    let qrData: WhatsAppQrResponse = {
      qrcode: 'data:image/png;base64,AAA',
      status: 'pairing',
      expiresInSeconds: 20,
    };
    vi.mocked(useWhatsAppQr).mockImplementation(
      ((options?: { enabled: boolean }) =>
        options?.enabled ? querySuccess(qrData) : queryLoading()) as typeof useWhatsAppQr,
    );

    const onClose = vi.fn();
    const { rerender } = renderModal({ open: true, onClose });
    await user.click(screen.getByRole('checkbox', { name: /aceito/i }));
    await user.click(screen.getByRole('button', { name: /conectar/i }));

    expect(await screen.findByAltText(/qr code/i)).toBeInTheDocument();

    // Próximo tick do polling: o gateway confirma o pareamento.
    qrData = { qrcode: null, status: 'connected', expiresInSeconds: null };
    rerenderModal(rerender, { open: true, onClose });

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/conectado/i)).toBeInTheDocument();
  });

  it('mostra botão "Gerar novamente" quando o QR expira (disconnected após pairing)', async () => {
    const user = userEvent.setup();
    const { useWhatsAppConnect, useWhatsAppQr } = await import('@/api/channels');
    const mutate = vi.fn();
    vi.mocked(useWhatsAppConnect).mockReturnValue(mutationIdle(mutate));

    let qrData: WhatsAppQrResponse = {
      qrcode: 'data:image/png;base64,AAA',
      status: 'pairing',
      expiresInSeconds: 5,
    };
    vi.mocked(useWhatsAppQr).mockImplementation(
      ((options?: { enabled: boolean }) =>
        options?.enabled ? querySuccess(qrData) : queryLoading()) as typeof useWhatsAppQr,
    );

    const onClose = vi.fn();
    const { rerender } = renderModal({ open: true, onClose });
    await user.click(screen.getByRole('checkbox', { name: /aceito/i }));
    await user.click(screen.getByRole('button', { name: /conectar/i }));
    await screen.findByAltText(/qr code/i);

    // O QR expirou sem parear: o gateway devolve disconnected de novo.
    qrData = { qrcode: null, status: 'disconnected', expiresInSeconds: null };
    rerenderModal(rerender, { open: true, onClose });

    const again = await screen.findByRole('button', { name: /gerar novamente/i });
    expect(again).toBeInTheDocument();

    await user.click(again);
    // "Gerar novamente" chama connect de novo (mesmo payload de aceite).
    expect(mutate).toHaveBeenCalledTimes(2);
  });

  it('mostra mensagem honesta quando o gateway de QR está indisponível (503 CHANNEL_QR_UNAVAILABLE)', async () => {
    const user = userEvent.setup();
    const { ApiError } = await import('@/api/client');
    const { useWhatsAppConnect, useWhatsAppQr } = await import('@/api/channels');

    const mutate = vi.fn(
      (_body: unknown, opts?: { onError?: (error: unknown) => void }) => {
        opts?.onError?.(new ApiError('CHANNEL_QR_UNAVAILABLE', 'Gateway indisponível', 503));
      },
    ) as unknown as ReturnType<typeof useWhatsAppConnect>['mutate'];
    vi.mocked(useWhatsAppConnect).mockReturnValue(mutationIdle(mutate));
    vi.mocked(useWhatsAppQr).mockReturnValue(queryLoading());

    renderModal({ open: true, onClose: vi.fn() });
    await user.click(screen.getByRole('checkbox', { name: /aceito/i }));
    await user.click(screen.getByRole('button', { name: /conectar/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/indispon/i);
    // Nunca um spinner que não resolve: sem QR nenhum na tela.
    expect(screen.queryByAltText(/qr code/i)).not.toBeInTheDocument();
  });
});
