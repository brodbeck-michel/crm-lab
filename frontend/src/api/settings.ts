import type { ChannelSettingsResponse, UpdateChannelSettingsRequest } from '@crm-lab/shared';
import { http } from './client';

/**
 * `GET /settings/channels` · `PATCH /settings/channels`
 * (docs/api/API_CONTRACTS.md §6 — Canais & Equipe).
 *
 * UMA chamada devolve os cinco blocos da tela (`channels`, `distributionMode`,
 * `autoMessages`, `businessHours`, `team`). A equipe vem embutida de propósito
 * (D-066): assim o gestor lê a tela sem depender de `GET /users`, que é admin
 * e devolveria 403 para ele.
 *
 * SEGREDO: `apiToken` e `webhookSecret` são write-only. A resposta só traz
 * `apiTokenMasked` e `webhookSecretSet` — não existe "revelar token", porque
 * o valor em claro nunca sai do servidor.
 *
 * O `PATCH` devolve o estado completo já mascarado, então a tela semeia o
 * cache com a resposta em vez de disparar um `GET` extra.
 */
export const settingsApi = {
  channels: () => http.get<ChannelSettingsResponse>('/settings/channels'),

  updateChannels: (body: UpdateChannelSettingsRequest) =>
    http.patch<ChannelSettingsResponse>('/settings/channels', body),
};
