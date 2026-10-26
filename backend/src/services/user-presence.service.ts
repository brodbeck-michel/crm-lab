/**
 * UserPresenceService — status da atendente (CRMLAB-120, D-286).
 *
 * - O status ESCOLHIDO (online/busy/away) mora em `users.presence_status`.
 * - Conectado e parado moram em memoria no `WsHub` (`connectedUsers`).
 * - O status EFETIVO junta os dois com `effectiveUserPresence` (shared).
 *
 * So informativo: nenhuma regra de negocio le daqui (D-286 item 6).
 */
import type { UpdateMyPresenceRequest, UserPresenceResponse } from '@crm-lab/shared';
import { effectiveUserPresence } from '@crm-lab/shared';
import type { DbClient } from '../db/types.js';
import type { TenantContext } from '../http/context.js';
import { notFound } from '../http/errors.js';
import type { WsHub } from '../lib/ws-hub.js';
import * as userRepo from '../repositories/user.repository.js';

export interface UserPresenceServiceDeps {
  db: DbClient;
  wsHub: WsHub;
}

export interface UserPresenceService {
  list(ctx: TenantContext): Promise<UserPresenceResponse>;
  updateMine(ctx: TenantContext, dto: UpdateMyPresenceRequest): Promise<UserPresenceResponse>;
}

export function createUserPresenceService(deps: UserPresenceServiceDeps): UserPresenceService {
  const { db, wsHub } = deps;

  const list = async (ctx: TenantContext): Promise<UserPresenceResponse> => {
    const users = await db.withTenant(ctx.tenantId, (tx) => userRepo.listPresenceStatuses(tx));
    const connected = wsHub.connectedUsers(ctx.tenantId);
    const me = users.find((u) => u.id === ctx.userId);
    // Desativado com token ainda vivo: nao inventamos o status.
    if (!me) throw notFound({ resource: 'user' });
    return {
      items: users.map((u) => {
        const live = connected.get(u.id);
        return {
          userId: u.id,
          status: effectiveUserPresence({
            connected: live !== undefined,
            chosen: u.presenceStatus,
            idle: live?.idle ?? false,
          }),
        };
      }),
      myStatus: me.presenceStatus,
    };
  };

  const updateMine = async (
    ctx: TenantContext,
    dto: UpdateMyPresenceRequest,
  ): Promise<UserPresenceResponse> => {
    if (dto.status !== undefined) {
      const status = dto.status;
      const updated = await db.withTenant(ctx.tenantId, (tx) =>
        userRepo.updatePresenceStatus(tx, ctx.userId, status),
      );
      if (!updated) throw notFound({ resource: 'user' });
      wsHub.emitToTenant(ctx.tenantId, 'user.presence_changed', { userId: ctx.userId });
    }
    // O hub so emite se o flag mudou e se ela esta conectada.
    if (dto.idle !== undefined) wsHub.setUserIdle(ctx.tenantId, ctx.userId, dto.idle);
    return list(ctx);
  };

  return { list, updateMine };
}
