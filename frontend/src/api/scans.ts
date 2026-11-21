import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CapturePairingCode,
  CreateCaptureDeviceRequest,
  CreateCaptureDeviceResponse,
  ListCaptureDevicesResponse,
  ListScansResponse,
} from '@crm-lab/shared';
import { http } from './client';
import { queryKeys, queryScopes } from './query-keys';

/**
 * Digitalizações — fila e dispositivos de captura (CRMLAB-184, D-327,
 * API_CONTRACTS §15.1 e §15.3). A captura do celular (sem login) fica em
 * `capture.ts`.
 *
 * As respostas de listagem são o envelope do contrato montado com os tipos de
 * `shared/` (`{ <chave>: T[], pagination }`).
 */

export const scansApi = {
  list: () => http.get<ListScansResponse>('/scans'),
  /** Descartar (204). */
  remove: (id: string) => http.delete<void>(`/scans/${id}`),
};

export const captureDevicesApi = {
  list: () => http.get<ListCaptureDevicesResponse>('/settings/capture-devices'),
  create: (body: CreateCaptureDeviceRequest) =>
    http.post<CreateCaptureDeviceResponse>('/settings/capture-devices', body),
  /** Código novo — o anterior deixa de valer; serve também para parear de novo. */
  renewPairingCode: (id: string) =>
    http.post<CapturePairingCode>(`/settings/capture-devices/${id}/pairing-code`),
  /** Revoga (204, idempotente). */
  revoke: (id: string) => http.delete<void>(`/settings/capture-devices/${id}`),
};

/* ── Hooks ──────────────────────────────────────────────────────────────── */

/** Fila do laboratório. Sem WS: `staleTime: 0` + montada só com o seletor aberto = recarrega ao abrir. */
export function useScanList() {
  return useQuery({
    queryKey: queryKeys.scans(),
    queryFn: () => scansApi.list(),
    staleTime: 0,
    refetchOnMount: 'always',
  });
}

export function useDiscardScan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => scansApi.remove(id),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryScopes.scans }),
  });
}

export function useCaptureDevices(options?: { enabled: boolean }) {
  return useQuery({
    queryKey: queryKeys.captureDevices(),
    queryFn: () => captureDevicesApi.list(),
    enabled: options?.enabled ?? true,
  });
}

function useInvalidateDevices() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.captureDevices() });
}

export function useCreateCaptureDevice() {
  const invalidate = useInvalidateDevices();
  return useMutation({
    mutationFn: (body: CreateCaptureDeviceRequest) => captureDevicesApi.create(body),
    onSuccess: invalidate,
  });
}

export function useRenewPairingCode() {
  const invalidate = useInvalidateDevices();
  return useMutation({
    mutationFn: (id: string) => captureDevicesApi.renewPairingCode(id),
    onSuccess: invalidate,
  });
}

export function useRevokeCaptureDevice() {
  const invalidate = useInvalidateDevices();
  return useMutation({
    mutationFn: (id: string) => captureDevicesApi.revoke(id),
    onSuccess: invalidate,
  });
}
