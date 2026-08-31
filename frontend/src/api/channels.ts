import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  WhatsAppQrConnectRequest,
  WhatsAppQrResponse,
  WhatsAppStatusResponse,
} from '@crm-lab/shared';
import { http } from './client';
import { queryKeys, queryScopes } from './query-keys';

/**
 * Conexão WhatsApp por QR (Evolution API, Onda 7 — Bloco B).
 * `docs/api/API_CONTRACTS.md` §6.1. As 4 rotas são **admin apenas**: a UI
 * esconde o botão para quem não é admin (Channels.tsx), o servidor recusa de
 * qualquer forma. As 4 podem responder `503 CHANNEL_QR_UNAVAILABLE` quando o
 * gateway não está configurado — não é um estado transitório de UI, é um
 * estado real que o operador encontra em produção.
 */
export const channelsApi = {
  connectWhatsAppQr: (body: WhatsAppQrConnectRequest) =>
    http.post<WhatsAppQrResponse>('/settings/channels/whatsapp/connect', body),

  whatsAppQr: () => http.get<WhatsAppQrResponse>('/settings/channels/whatsapp/qr'),

  whatsAppStatus: () => http.get<WhatsAppStatusResponse>('/settings/channels/whatsapp/status'),

  disconnectWhatsApp: () => http.post<void>('/settings/channels/whatsapp/disconnect'),
};

/* ── React Query Hooks ──────────────────────────────────────────────────── */

export function useWhatsAppConnect() {
  return useMutation({
    mutationFn: (body: WhatsAppQrConnectRequest) => channelsApi.connectWhatsAppQr(body),
  });
}

/**
 * Decide se `useWhatsAppQr` refaz a requisição. Extraída como função pura
 * (sem `useQuery` por perto) para ser testável sem montar React Query de
 * verdade: a garantia "o modal para de dar polling ao chegar num estado
 * terminal" precisa de prova, não só de leitura de código.
 *
 * `pairing` → repete em ~2s (o gateway pode renovar o QR por trás,
 * `QRCODE_UPDATED`). Qualquer outro status (`connected`, `disconnected`) OU
 * erro na última tentativa → para. Isso cobre o 503 `CHANNEL_QR_UNAVAILABLE`
 * também: um erro nunca deixa `data` como `pairing`, então o polling já pararia
 * por `status`, mas checar `error` explicitamente evita depender de como o
 * React Query trata `data` obsoleto depois de uma falha.
 */
export function qrRefetchInterval(query: {
  state: { data?: WhatsAppQrResponse; error?: unknown };
}): number | false {
  if (query.state.error) return false;
  return query.state.data?.status === 'pairing' ? 2000 : false;
}

/**
 * QR vigente. `enabled: false` por padrão — o modal só liga o polling depois
 * do `connect`. Sai do estado `pairing` (`connected` ou `disconnected`) e o
 * polling para sozinho (`qrRefetchInterval`) — nunca refaz a requisição depois
 * do estado terminal, mesmo com o modal ainda aberto. Ao desmontar o modal, o
 * React Query também para: sem observador, não há intervalo.
 */
export function useWhatsAppQr(options?: { enabled: boolean }) {
  return useQuery({
    queryKey: queryKeys.whatsappQr(),
    queryFn: () => channelsApi.whatsAppQr(),
    enabled: options?.enabled ?? false,
    refetchInterval: qrRefetchInterval,
    // Estado de pareamento não sobrevive a reabertura do modal — nunca serve stale.
    staleTime: 0,
  });
}

export function useWhatsAppStatus() {
  return useQuery({
    queryKey: queryKeys.whatsappStatus(),
    queryFn: () => channelsApi.whatsAppStatus(),
  });
}

export function useWhatsAppDisconnect() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => channelsApi.disconnectWhatsApp(),
    onSuccess: () => {
      // Desconectar não muda `is_active` (dois controles distintos) — só o status ao vivo.
      void queryClient.invalidateQueries({ queryKey: queryKeys.whatsappStatus() });
      void queryClient.invalidateQueries({ queryKey: queryScopes.settings });
    },
  });
}
