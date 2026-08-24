import type { Theme, UpdateThemeRequest } from '@crm-lab/shared';
import { http } from './client';

/**
 * `GET /themes/current` · `PATCH /themes/current`
 * (docs/domain/WORKFLOWS.md §9 — Fluxo de Personalização).
 *
 * ATENÇÃO: o bootstrap NÃO usa `current()`. O tema chega dentro do
 * `LoginResponse.tenant.theme` e é aplicado por `applyTheme()`
 * (docs/contracts/FRONTEND_BACKEND.md: "O tema vem no login — o frontend NÃO
 * faz request extra de tema no bootstrap"). `current()` existe para a tela de
 * Personalização recarregar o tema salvo.
 */
export const themesApi = {
  current: () => http.get<Theme>('/themes/current'),

  update: (body: UpdateThemeRequest) => http.patch<Theme>('/themes/current', body),
};
