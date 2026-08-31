/**
 * Barril da camada de API. Telas importam SEMPRE daqui (`@/api`) —
 * `fetch` fora desta pasta é proibido (docs/guides/CONVENTIONS.md).
 */
export { ApiError, isApiError, http, request, refreshAccessToken } from './client';
export { setSessionBridge, setUnauthenticatedHandler, resetApiClient } from './client';
export { apiBaseUrl, buildQueryString } from './client';
export type {
  HttpMethod,
  QueryParams,
  QueryValue,
  RequestOptions,
  SessionBridge,
} from './client';

export {
  createApiErrorHandler,
  mapFieldErrors,
  toHandledError,
} from './error-handler';
export type {
  ApiErrorHandler,
  ErrorHandlerDeps,
  HandledApiError,
  ToastFn,
} from './error-handler';

export { queryKeys, queryScopes, staleTimes } from './query-keys';

export { createWsClient, applyWsEvent, parseWsEvent, wsBaseUrl } from './ws';
export type { WsClient, WsClientOptions, WebSocketLike } from './ws';

export { authApi } from './auth';
export { conversationsApi } from './conversations';
export { proposalsApi } from './proposals';
export type {
  ApproveProposalResponse,
  UpdateProposalDiscountResponse,
  UpdateProposalStatusResponse,
} from './proposals';
export { examsApi } from './exams';
export { analyticsApi } from './analytics';
export { themesApi } from './themes';
export { usersApi, useUserList, useCreateUser, useUpdateUser } from './users';
export { internalChatApi } from './internal-chat';
export { auditApi, useAuditList } from './audit';
export { platformApi } from './platform';
export { settingsApi } from './settings';
export { operationApi } from './operation';
export { patientsApi } from './patients';
export {
  channelsApi,
  qrRefetchInterval,
  useWhatsAppConnect,
  useWhatsAppQr,
  useWhatsAppStatus,
  useWhatsAppDisconnect,
} from './channels';

import { analyticsApi } from './analytics';
import { channelsApi } from './channels';
import { auditApi } from './audit';
import { authApi } from './auth';
import { conversationsApi } from './conversations';
import { examsApi } from './exams';
import { internalChatApi } from './internal-chat';
import { operationApi } from './operation';
import { patientsApi } from './patients';
import { platformApi } from './platform';
import { settingsApi } from './settings';
import { proposalsApi } from './proposals';
import { themesApi } from './themes';
import { usersApi } from './users';

/** Fachada única: `api.proposals.list(filters)` (docs/guides/CONVENTIONS.md). */
export const api = {
  auth: authApi,
  conversations: conversationsApi,
  proposals: proposalsApi,
  exams: examsApi,
  analytics: analyticsApi,
  themes: themesApi,
  users: usersApi,
  internalChat: internalChatApi,
  audit: auditApi,
  platform: platformApi,
  settings: settingsApi,
  operation: operationApi,
  patients: patientsApi,
  channels: channelsApi,
} as const;
