import type { OperationOverviewQuery, OperationOverviewResponse } from '@crm-lab/shared';
import { http } from './client';

/**
 * `GET /operations/overview` (docs/api/API_CONTRACTS.md §7 — Gestão da Operação).
 *
 * UM endpoint, não três (D-067): fila, carga e decisões pendentes saem do
 * MESMO instante. Três chamadas exibiriam uma fila de 14:03 ao lado de uma
 * carga de 14:05.
 *
 * Tudo é derivado de `conversations` + `proposals` no servidor, sem cache lá —
 * é um painel de "agora".
 */
export const operationApi = {
  overview: (query: OperationOverviewQuery = {}) =>
    http.get<OperationOverviewResponse>('/operations/overview', {
      queueLimit: query.queueLimit,
      decisionsLimit: query.decisionsLimit,
    }),
};
