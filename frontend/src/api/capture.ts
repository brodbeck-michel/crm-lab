import type {
  CapturePairRequest,
  CaptureSession,
  CreateScanRequest,
  CreateScanResponse,
} from '@crm-lab/shared';
import { http } from './client';
import type { RequestOptions } from './client';

/**
 * Captura do celular pareado — `/digitalizar` (PAGES.md §24, API_CONTRACTS §15.2, D-326).
 *
 * Não é sessão de usuário: SEM Bearer e SEM o interceptor de refresh
 * (`auth: false`). A credencial do dispositivo é o cookie httpOnly
 * `crm_capture`, por isso `credentials: 'include'`. Um 401
 * `CAPTURE_DEVICE_UNPAIRED` só volta a página para a tela do código.
 */
const CAPTURE: RequestOptions = { auth: false, credentials: 'include' };

export const captureApi = {
  /** "Estou pareado?" — 401 `CAPTURE_DEVICE_UNPAIRED` = não. */
  session: () => http.get<CaptureSession>('/capture/session', undefined, CAPTURE),

  pair: (body: CapturePairRequest) => http.post<CaptureSession>('/capture/pair', body, CAPTURE),

  /** Uma foto por requisição (várias = em sequência, D-233). */
  uploadScan: (body: CreateScanRequest) =>
    http.post<CreateScanResponse>('/capture/scans', body, CAPTURE),
};
