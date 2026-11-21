/**
 * Quem alcanca o que na Visitacao Medica — CRMLAB-189, D-329 (SECURITY.md
 * "Visitacao Medica — escopo por carteira").
 *
 *  - perfil: so `representative`, `manager` e `admin` (a atendente recebe 403);
 *  - gestor/admin: tudo do laboratorio (`portfolioOwner` -> `undefined`);
 *  - representante: so a propria carteira (`portfolioOwner` -> o id dele), que
 *    os repositorios aplicam no SQL. Fora do escopo -> 404 (nunca 403).
 *
 * As rotas ja barram o perfil com `requireRoles(...VISITATION_ROLES)`; os
 * services conferem de novo ("a UI esconde, o servidor recusa" — e o service
 * tambem e chamado sem middleware).
 */
import { seesAllVisitation, VISITATION_ROLES } from '@crm-lab/shared';
import type { TenantContext } from '../http/context.js';
import { BusinessError } from '../http/errors.js';

export function assertVisitationRole(ctx: TenantContext): void {
  if (!(VISITATION_ROLES as readonly string[]).includes(ctx.role)) {
    throw new BusinessError('FORBIDDEN', { requiredRoles: [...VISITATION_ROLES] });
  }
}

/** Gestor/admin. Use para o que so eles fazem (carteiras, transferencia). */
export function assertSeesAllVisitation(ctx: TenantContext): void {
  if (!seesAllVisitation(ctx.role)) {
    throw new BusinessError('FORBIDDEN', { requiredRoles: ['manager', 'admin'] });
  }
}

/** Dono da carteira para o recorte: o representante; `undefined` = sem recorte. */
export function portfolioOwner(ctx: TenantContext): string | undefined {
  return seesAllVisitation(ctx.role) ? undefined : ctx.userId;
}
