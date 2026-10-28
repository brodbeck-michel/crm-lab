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
import {
  FALLBACK_MEDIA_MIME_TYPE,
  MAX_MEDIA_BYTES,
  internalMessageAuthorActionBlock,
  type Channel,
  type ChatDirectoryUser,
  type CreateInternalAttachmentRequest,
  type InternalMessage,
  type ListInternalMessagesResponse,
  type PaginationMeta,
} from '@crm-lab/shared';
import type { DbClient, DbTx } from '../db/types.js';
import type { TenantContext } from '../http/context.js';
import type { WsHub } from '../lib/ws-hub.js';
import type { AuditService } from './audit.service.js';
import { BusinessError, notFound } from '../http/errors.js';
import { logger } from '../lib/logger.js';
import { readMediaFile, writeMediaFile } from '../lib/media-storage.js';
import { convertImageToJpeg } from './image-to-jpeg.js';
import { assertOutboundMimeAllowed, resolveStoredMimeType } from './media.service.js';
import * as chatRepo from '../repositories/internal-chat.repository.js';
import { DEFAULT_CHANNELS } from '../repositories/internal-chat.repository.js';

export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;
export const MAX_CONTENT_LENGTH = 4000;
/**
 * Teto de `page` (Onda 7, pendencia mecanica — mesmo motivo de
 * `proposal.service.ts`). Sem ele, `?page=9007199254740991` produz um
 * `OFFSET` absurdo na consulta.
 */
export const MAX_PAGE = 10_000;

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
    /** Opcional so para quem posta como sistema (ApprovalService); a rota sempre passa. */
    private readonly audit?: AuditService,
  ) {}

  /** Canais do tenant, garantindo que os padrao existam. */
  async listChannels(ctx: TenantContext): Promise<Channel[]> {
    assertLabMember(ctx);
    return this.db.withTenant(ctx.tenantId, async (tx) => {
      await ensureDefaultChannels(tx, ctx.tenantId);
      // `unreadCount`/`lastReadAt` sao DO USUARIO que pergunta (D-068): dois
      // usuarios do mesmo tenant recebem numeros diferentes, e isso e o contrato.
      return chatRepo.listChannels(tx, ctx.userId);
    });
  }

  async listMessages(
    ctx: TenantContext,
    channelId: string,
    page: Pagination = {},
  ): Promise<ListInternalMessagesResponse> {
    assertLabMember(ctx);
    const pageNumber = clamp(page.page, DEFAULT_PAGE, 1, MAX_PAGE);
    const limit = clamp(page.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);

    return this.db.withTenant(ctx.tenantId, async (tx) => {
      // Canal de outro tenant fica invisivel pelo RLS -> NOT_FOUND, nunca 403.
      const channel = await chatRepo.findChannelById(tx, channelId, ctx.userId);
      if (!channel) throw notFound({ resource: 'channel', id: channelId });

      // NAO marca como lido de proposito (D-068): ler pagina antiga do
      // historico nao e ter visto a mensagem nova. Diferenca deliberada para
      // `GET /conversations/:id` (D-035), onde a pagina 1 E o fim da conversa.
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
      const channel = await chatRepo.findChannelById(tx, channelId, ctx.userId);
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
   * Zera o `unreadCount` do canal para o usuario do contexto (D-068).
   *
   * Idempotente: um `INSERT ... ON CONFLICT DO UPDATE` sem leitura previa —
   * chamar em canal ja lido nao e erro, so move `last_read_at` para agora.
   * Canal inexistente ou de outro tenant (invisivel pelo RLS) -> `NOT_FOUND`,
   * nunca 403. Nao gera audit log: leitura de canal nao e acao critica.
   */
  async markChannelRead(ctx: TenantContext, channelId: string): Promise<void> {
    assertLabMember(ctx);
    await this.db.withTenant(ctx.tenantId, async (tx) => {
      const channel = await chatRepo.findChannelById(tx, channelId, ctx.userId);
      if (!channel) throw notFound({ resource: 'channel', id: channelId });
      await chatRepo.markChannelRead(tx, {
        tenantId: ctx.tenantId,
        channelId,
        userId: ctx.userId,
      });
    });
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

  /**
   * Mensagem com UM arquivo (CRMLAB-101, D-271). Tipo, tamanho e magic bytes
   * sao conferidos ANTES da transacao, com as regras do anexo do atendimento.
   * Dentro dela: acesso ao canal (DM alheia = NOT_FOUND) -> mensagem -> linha
   * do anexo -> arquivo em disco com o `id` da linha. Se o disco falhar, a
   * transacao desfaz tudo: nada de mensagem com anexo sem arquivo.
   */
  async sendAttachment(
    ctx: TenantContext,
    channelId: string,
    dto: CreateInternalAttachmentRequest,
  ): Promise<InternalMessage> {
    assertLabMember(ctx);
    const content = (dto.content ?? '').trim();
    if (content.length > MAX_CONTENT_LENGTH) {
      throw new BusinessError('VALIDATION_ERROR', {
        fields: { content: 'Conteudo ate 4000 caracteres' },
      });
    }
    assertOutboundMimeAllowed(dto.mimeType);
    const raw = Buffer.from(dto.contentBase64, 'base64');
    if (raw.byteLength === 0 || raw.byteLength > MAX_MEDIA_BYTES) {
      throw new BusinessError('MEDIA_TOO_LARGE', { byteSize: raw.byteLength, max: MAX_MEDIA_BYTES });
    }
    // Divergente do tipo declarado e recusado (como na visita, CRMLAB-88), nao
    // rebaixado em silencio: quem esta na tela fica sabendo (D-271 item 4).
    const resolvedMime = await resolveStoredMimeType(dto.mimeType, raw);
    if (resolvedMime === FALLBACK_MEDIA_MIME_TYPE) {
      throw new BusinessError('VALIDATION_ERROR', {
        fields: { mimeType: 'O conteúdo do arquivo não corresponde ao tipo informado' },
      });
    }
    // Imagem vira JPEG como no Atendimento (CRMLAB-128, D-291).
    const { buffer, mimeType, fileName } = await convertImageToJpeg({
      buffer: raw,
      mimeType: resolvedMime,
      fileName: dto.fileName.trim(),
    });

    const message = await this.db.withTenant(ctx.tenantId, async (tx) => {
      const channel = await chatRepo.findChannelById(tx, channelId, ctx.userId);
      if (!channel) throw notFound({ resource: 'channel', id: channelId });

      const inserted = await chatRepo.insertMessage(tx, {
        tenantId: ctx.tenantId,
        channelId,
        senderId: ctx.userId,
        content,
        attachedProposalId: null,
        isSystem: false,
      });
      const attachmentId = await chatRepo.insertAttachment(tx, {
        tenantId: ctx.tenantId,
        messageId: inserted.id,
        mimeType,
        fileName,
        byteSize: buffer.byteLength,
      });
      await writeMediaFile(attachmentId, buffer);
      const withAttachment = await chatRepo.findMessageById(tx, inserted.id);
      if (!withAttachment) throw new Error('Mensagem interna recem-inserida nao encontrada');
      return withAttachment;
    });

    // Depois do commit e so com ids (D-271 item 6): o evento vai para o tenant
    // inteiro, e o nome do arquivo de uma DM nao pode chegar a quem nao participa.
    this.wsHub.emitToTenant(ctx.tenantId, 'internal_chat.new_message', {
      channelId,
      messageId: message.id,
    });
    return message;
  }

  /**
   * Download (D-271). Canal invisivel para o usuario (outro tenant, DM alheia),
   * anexo de outro canal ou arquivo fora do disco -> `NOT_FOUND`, nunca 403.
   */
  async readAttachment(
    ctx: TenantContext,
    channelId: string,
    attachmentId: string,
  ): Promise<{ buffer: Buffer; mimeType: string; fileName: string }> {
    assertLabMember(ctx);
    const attachment = await this.db.withTenant(ctx.tenantId, async (tx) => {
      const channel = await chatRepo.findChannelById(tx, channelId, ctx.userId);
      if (!channel) throw notFound({ resource: 'channel', id: channelId });
      return chatRepo.findAttachment(tx, channelId, attachmentId);
    });
    if (!attachment) throw notFound({ resource: 'internal_message_attachment', id: attachmentId });

    const buffer = await readMediaFile(attachment.id);
    if (!buffer) {
      logger.warn('internal_chat.attachment_file_missing', {
        tenantId: ctx.tenantId,
        channelId,
        attachmentId,
      });
      throw notFound({ resource: 'internal_message_attachment', id: attachmentId });
    }
    return { buffer, mimeType: attachment.mimeType, fileName: attachment.fileName };
  }

  // -------------------------------------------------------------------------
  // CRMLAB-117 — a autora edita / apaga para todos (D-282)
  // -------------------------------------------------------------------------

  /**
   * Edita o texto da PROPRIA mensagem (D-282). Sem canal externo: grava direto
   * (versao anterior em `internal_message_edits` + `edited_at`), audit
   * `edit_internal_message` com o `userId` e WS `internal_chat.message_updated`.
   */
  async editByAuthor(
    ctx: TenantContext,
    channelId: string,
    messageId: string,
    rawContent: string,
  ): Promise<InternalMessage> {
    assertLabMember(ctx);
    const content = rawContent.trim();
    if (content.length === 0 || content.length > MAX_CONTENT_LENGTH) {
      throw new BusinessError('VALIDATION_ERROR', {
        fields: { content: 'Conteudo obrigatorio (1..4000 caracteres)' },
      });
    }

    const outcome = await this.db.withTenant(ctx.tenantId, async (tx) => {
      const message = await authorTarget(tx, ctx, channelId, messageId, 'edit');
      // Mesmo texto: nada a corrigir — sem versao, sem audit, sem evento.
      if (content === message.content) return { message, edit: null };
      const edit = await chatRepo.applyEdit(tx, {
        tenantId: ctx.tenantId,
        messageId,
        content,
        editedBy: ctx.userId,
      });
      if (!edit) throw new BusinessError('CONFLICT', { reason: 'already_deleted' });
      const updated = await chatRepo.findMessageById(tx, messageId);
      if (!updated) throw notFound({ resource: 'internal_message', id: messageId });
      return { message: updated, edit, previous: message.content };
    });
    if (!outcome.edit) return outcome.message;

    await this.audit?.record(ctx, {
      action: 'edit_internal_message',
      entityType: 'internal_message',
      entityId: messageId,
      oldValues: { content: outcome.previous },
      newValues: { content, editedAt: outcome.edit.editedAt, editId: outcome.edit.editId },
    });
    this.emitMessageUpdated(ctx.tenantId, channelId, messageId);
    return outcome.message;
  }

  /**
   * "Apagar para todos" da autora (D-282): ESCONDE (`deleted_at`), nunca apaga —
   * o texto e o arquivo ficam na linha; o texto vai tambem para o audit.
   */
  async deleteByAuthor(ctx: TenantContext, channelId: string, messageId: string): Promise<void> {
    assertLabMember(ctx);
    const outcome = await this.db.withTenant(ctx.tenantId, async (tx) => {
      const message = await authorTarget(tx, ctx, channelId, messageId, 'delete');
      const deletedAt = await chatRepo.markDeleted(tx, messageId);
      if (!deletedAt) throw new BusinessError('CONFLICT', { reason: 'already_deleted' });
      return { message, deletedAt };
    });

    await this.audit?.record(ctx, {
      action: 'delete_internal_message',
      entityType: 'internal_message',
      entityId: messageId,
      oldValues: {
        content: outcome.message.content,
        attachmentId: outcome.message.attachment?.id ?? null,
        deletedAt: null,
      },
      newValues: { deletedAt: outcome.deletedAt },
    });
    this.emitMessageUpdated(ctx.tenantId, channelId, messageId);
  }

  /**
   * So ids, para o tenant inteiro (mesma regra de `new_message`, D-271 item 6):
   * quem nao ve o canal nao tem o que refazer. Nao e mensagem nova — evento
   * proprio, sem aviso nem badge.
   */
  private emitMessageUpdated(tenantId: string, channelId: string, messageId: string): void {
    this.wsHub.emitToTenant(tenantId, 'internal_chat.message_updated', { channelId, messageId });
  }

  /** Diretorio de quem da para abrir DM — exclui o proprio usuario e inativos (D-101). */
  async listDirectory(ctx: TenantContext): Promise<ChatDirectoryUser[]> {
    assertLabMember(ctx);
    return this.db.withTenant(ctx.tenantId, (tx) => chatRepo.listDirectoryUsers(tx, ctx.userId));
  }

  /**
   * Get-or-create idempotente da DM com `otherUserId` (D-101). Mesmo par de usuarios
   * sempre devolve o MESMO canal — clicar de novo num usuario com quem ja existe DM
   * so abre a conversa, nunca duplica.
   */
  async getOrCreateDirectChannel(ctx: TenantContext, otherUserId: string): Promise<Channel> {
    assertLabMember(ctx);
    if (otherUserId === ctx.userId) {
      throw new BusinessError('VALIDATION_ERROR', {
        fields: { userId: 'Não é possível iniciar uma conversa consigo mesmo' },
      });
    }

    return this.db.withTenant(ctx.tenantId, async (tx) => {
      // Inexistente, inativo OU de outro tenant (RLS ja esconde) — mesma resposta.
      const other = await chatRepo.findActiveUserById(tx, otherUserId);
      if (!other) throw notFound({ resource: 'user', id: otherUserId });

      // Par ordenado canonico (D-101): garante uma unica linha por combinacao de
      // dois usuarios, independente de quem clicou em quem primeiro.
      const [dmUserAId, dmUserBId]: [string, string] =
        ctx.userId < otherUserId ? [ctx.userId, otherUserId] : [otherUserId, ctx.userId];
      const key = `dm:${dmUserAId}:${dmUserBId}`;

      return chatRepo.getOrCreateDirectChannel(tx, {
        tenantId: ctx.tenantId,
        key,
        name: key,
        dmUserAId,
        dmUserBId,
        viewerUserId: ctx.userId,
        otherUserName: other.name,
      });
    });
  }
}

/**
 * Regras de D-282 (`internalMessageAuthorActionBlock`, a mesma da tela) sob a
 * trava da linha. Canal invisivel (outro tenant, DM alheia) ou mensagem de
 * outro canal = `NOT_FOUND`; outra autora = `FORBIDDEN`; prazo/estado =
 * `CONFLICT` com `details.reason`.
 */
async function authorTarget(
  tx: DbTx,
  ctx: TenantContext,
  channelId: string,
  messageId: string,
  action: 'edit' | 'delete',
): Promise<InternalMessage> {
  const channel = await chatRepo.findChannelById(tx, channelId, ctx.userId);
  if (!channel) throw notFound({ resource: 'channel', id: channelId });
  await chatRepo.lockMessage(tx, messageId);
  const message = await chatRepo.findMessageById(tx, messageId);
  if (!message || message.channelId !== channelId) {
    throw notFound({ resource: 'internal_message', id: messageId });
  }
  const block = internalMessageAuthorActionBlock(message, action, ctx.userId);
  if (block === 'not_author') throw new BusinessError('FORBIDDEN', { reason: block });
  if (block) throw new BusinessError('CONFLICT', { reason: block });
  return message;
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

export function createInternalChatService(
  db: DbClient,
  wsHub: WsHub,
  audit?: AuditService,
): InternalChatService {
  return new InternalChatService(db, wsHub, audit);
}
