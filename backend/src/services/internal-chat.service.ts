/**
 * InternalChatService — SERVICES.md §7, WORKFLOWS.md §6.
 *
 * Canais e mensagens internas do laboratorio. Duas coisas importam aqui:
 *
 * 1. **O canal `#aprovacoes` e a caixa de entrada do ApprovalService.** Toda
 *    proposta que cai em `pending` vira um post de sistema com a proposta
 *    anexada (WORKFLOWS §3). O post e criado por `createSystemPost`, que nao
 *    recebe `TenantContext` porque quem escreve e o sistema, nao um usuario.
 *
 * 2. **O console de plataforma NAO acessa canais de laboratorio** (PAGES.md §11
 *    e SECURITY.md): `platform_operator` e recusado no service, alem do
 *    `denyPlatformOperator()` da rota. "A UI esconde, o servidor recusa."
 *
 * Os canais padrao (`#geral`, `#aprovacoes`) nascem no onboarding do tenant
 * (WORKFLOWS §7). Como o onboarding ainda nao existe como servico, este service
 * os cria sob demanda de forma idempotente — ver D-043.
 */
import type {
  Channel,
  InternalMessage,
  ListInternalMessagesResponse,
  PaginationMeta,
} from '@crm-lab/shared';
import type { DbClient, DbTx } from '../db/types.js';
import type { TenantContext } from '../http/context.js';
import type { WsHub } from '../lib/ws-hub.js';
import { BusinessError, notFound } from '../http/errors.js';
import * as chatRepo from '../repositories/internal-chat.repository.js';
import { DEFAULT_CHANNELS } from '../repositories/internal-chat.repository.js';

export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;
export const MAX_CONTENT_LENGTH = 4000;

export interface Pagination {
  page?: number;
  limit?: number;
}

export interface SendInternalMessageInput {
  content: string;
  attachedProposalId?: string | null;
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/** Console de plataforma tem chat PROPRIO — sem porta para canais de labs. */
function assertLabMember(ctx: TenantContext): void {
  if (ctx.role === 'platform_operator') {
    throw new BusinessError('FORBIDDEN', {
      requiredRoles: ['attendant', 'manager', 'admin'],
    });
  }
}

export class InternalChatService {
  constructor(
    private readonly db: DbClient,
    private readonly wsHub: WsHub,
  ) {}

  /** Canais do tenant, garantindo que os padrao existam. */
  async listChannels(ctx: TenantContext): Promise<Channel[]> {
    assertLabMember(ctx);
    return this.db.withTenant(ctx.tenantId, async (tx) => {
      await ensureDefaultChannels(tx, ctx.tenantId);
      return chatRepo.listChannels(tx);
    });
  }

  async listMessages(
    ctx: TenantContext,
    channelId: string,
    page: Pagination = {},
  ): Promise<ListInternalMessagesResponse> {
    assertLabMember(ctx);
    const pageNumber = clamp(page.page, DEFAULT_PAGE, 1, Number.MAX_SAFE_INTEGER);
    const limit = clamp(page.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);

    return this.db.withTenant(ctx.tenantId, async (tx) => {
      // Canal de outro tenant fica invisivel pelo RLS -> NOT_FOUND, nunca 403.
      const channel = await chatRepo.findChannelById(tx, channelId);
      if (!channel) throw notFound({ resource: 'channel', id: channelId });

      const result = await chatRepo.listMessages(tx, channelId, { page: pageNumber, limit });
      const pagination: PaginationMeta = {
        page: pageNumber,
        limit,
        total: result.total,
        totalPages: result.total === 0 ? 0 : Math.ceil(result.total / limit),
      };
      return { messages: result.rows, pagination };
    });
  }

  /** Mensagem de usuario. `attachedProposalId` precisa existir NESTE tenant. */
  async send(
    ctx: TenantContext,
    channelId: string,
    dto: SendInternalMessageInput,
  ): Promise<InternalMessage> {
    assertLabMember(ctx);
    const content = dto.content.trim();
    if (content.length === 0 || content.length > MAX_CONTENT_LENGTH) {
      throw new BusinessError('VALIDATION_ERROR', {
        fields: { content: 'Conteudo obrigatorio (1..4000 caracteres)' },
      });
    }

    const message = await this.db.withTenant(ctx.tenantId, async (tx) => {
      const channel = await chatRepo.findChannelById(tx, channelId);
      if (!channel) throw notFound({ resource: 'channel', id: channelId });

      const attachedProposalId = dto.attachedProposalId ?? null;
      if (attachedProposalId !== null) {
        // FKs nao respeitam RLS: sem esta checagem, anexar proposta de outro
        // tenant passaria pelo banco. Checar aqui e parte do isolamento.
        const found = await tx.query<{ id: string }>(
          'SELECT id FROM proposals WHERE id = $1',
          [attachedProposalId],
        );
        if (found.rows.length === 0) {
          throw notFound({ resource: 'proposal', id: attachedProposalId });
        }
      }

      return chatRepo.insertMessage(tx, {
        tenantId: ctx.tenantId,
        channelId,
        senderId: ctx.userId,
        content,
        attachedProposalId,
        isSystem: false,
      });
    });

    this.wsHub.emitToTenant(ctx.tenantId, 'internal_chat.new_message', {
      channelId,
      messageId: message.id,
    });
    return message;
  }

  /**
   * Post do SISTEMA num canal identificado pela chave (`geral`, `aprovacoes`).
   * Sem `TenantContext` de proposito: quem escreve e o sistema (SERVICES.md §7).
   * Cria o canal se ainda nao existir (onboarding nao implementado — D-043).
   */
  async createSystemPost(
    tenantId: string,
    channelKey: string,
    content: string,
    attachedProposalId?: string,
  ): Promise<InternalMessage> {
    const message = await this.db.withTenant(tenantId, async (tx) => {
      const channel = await ensureChannel(tx, tenantId, channelKey);
      return chatRepo.insertMessage(tx, {
        tenantId,
        channelId: channel.id,
        senderId: null,
        content,
        attachedProposalId: attachedProposalId ?? null,
        isSystem: true,
      });
    });

    this.wsHub.emitToTenant(tenantId, 'internal_chat.new_message', {
      channelId: message.channelId,
      messageId: message.id,
    });
    return message;
  }
}

/** Idempotente: devolve o canal existente ou cria com o nome padrao. */
export async function ensureChannel(
  tx: DbTx,
  tenantId: string,
  key: string,
): Promise<Channel> {
  const existing = await chatRepo.findChannelByKey(tx, key);
  if (existing) return existing;
  const preset = DEFAULT_CHANNELS.find((channel) => channel.key === key);
  return chatRepo.insertChannel(tx, {
    tenantId,
    key,
    name: preset?.name ?? `#${key}`,
  });
}

export async function ensureDefaultChannels(tx: DbTx, tenantId: string): Promise<void> {
  for (const channel of DEFAULT_CHANNELS) {
    await ensureChannel(tx, tenantId, channel.key);
  }
}

export function createInternalChatService(db: DbClient, wsHub: WsHub): InternalChatService {
  return new InternalChatService(db, wsHub);
}
