import { describe, expect, it } from 'vitest';
import type { WhatsAppQrResponse } from '@crm-lab/shared';
import { qrRefetchInterval } from './channels';

/**
 * `qrRefetchInterval` é a peça que decide se o modal de conexão continua
 * fazendo polling de `GET /settings/channels/whatsapp/qr`. Testada isolada de
 * `useQuery` de propósito: a garantia "para num estado terminal e nunca sai
 * do 503 dando polling pra sempre" precisa ser provada em função pura, não
 * inferida de como o React Query se comporta por trás.
 */
describe('qrRefetchInterval', () => {
  function stateWith(data?: WhatsAppQrResponse, error?: unknown) {
    return { state: { data, error } };
  }

  it('repete em 2s enquanto o status é pairing', () => {
    const query = stateWith({ qrcode: 'data:image/png;base64,AAA', status: 'pairing', expiresInSeconds: 20 });
    expect(qrRefetchInterval(query)).toBe(2000);
  });

  it('para quando o status vira connected', () => {
    const query = stateWith({ qrcode: null, status: 'connected', expiresInSeconds: null });
    expect(qrRefetchInterval(query)).toBe(false);
  });

  it('para quando o status vira disconnected (QR expirado ou nunca iniciado)', () => {
    const query = stateWith({ qrcode: null, status: 'disconnected', expiresInSeconds: null });
    expect(qrRefetchInterval(query)).toBe(false);
  });

  it('para quando a última tentativa falhou (ex.: 503 CHANNEL_QR_UNAVAILABLE) mesmo com data antigo em pairing', () => {
    const query = stateWith(
      { qrcode: 'data:image/png;base64,AAA', status: 'pairing', expiresInSeconds: 20 },
      new Error('gateway indisponível'),
    );
    expect(qrRefetchInterval(query)).toBe(false);
  });

  it('para quando ainda não há dado nenhum', () => {
    expect(qrRefetchInterval(stateWith(undefined))).toBe(false);
  });
});
