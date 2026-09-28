/**
 * MessageService — SERVICES.md §3.
 *
 * ============================================================================
 * INFRAESTRUTURA COMPARTILHADA — outros services criam EVENTOS DE SISTEMA aqui
 * ============================================================================
 *
 * `createSystemEvent` e a bolha cinza da conversa ("Orcamento #123 enviado",
 * "Conversa transferida de A para B", "Proposta ganha"). Quem dispara e o dono
 * do fato — ProposalService, ApprovalService, ConversationService.
 *
 * Assinatura (a de SERVICES.md §3, sem contexto autenticado — o autor e o
 * SISTEMA, nao um usuario):
 *
 *     createSystemEvent(
 *       tenantId: string,
 *       conversationId: string,
 *       content: string,
 *     ): Promise<Message>
 *
 * Como instanciar dentro do seu `ApiModuleFactory`:
 *
 *     import { createMessageService } from '../services/message.service.js';
 *
 *     export function proposalModule(deps: ApiModuleDeps): ApiModule {
 *       const messages = createMessageService(deps);
 *       // ... await messages.createSystemEvent(ctx.tenantId, conversationId, texto);
 *     }
 *
 * O evento ja emite `conversation.new_message` no WebSocket e ja sobe o
 * `last_message_at` da conversa. Ele NAO incrementa `unread_count` (o contador
 * conta mensagem de paciente) e NAO passa pelo canal externo — o paciente nao
 * recebe eventos internos (BUSINESS_RULES §7: interno nunca vaza para o
 * paciente). Conversa encerrada ACEITA evento de sistema: o fato aconteceu e o
 * historico precisa registra-lo; o que a conversa encerrada recusa e mensagem
 * NOVA do atendente (`CONVERSATION_ARCHIVED`, nome mantido — D-174).
 *
 * ============================================================================
 * Regras
 * ============================================================================
 * - TODA criacao emite `conversation.new_message` na room do tenant — e so na
 *   dela (`emitToTenant(tenantId, ...)`, com o tenantId do token, nunca do
 *   cliente). O payload leva so ids: o evento e notificacao, nao transporte
 *   (FRONTEND_BACKEND.md "Real-time").
 * - `createFromAgent` envia pelo canal externo e reflete o resultado em
 *   `status`. Esgotado o retry: `status = 'failed'` e `MESSAGE_SEND_FAILED`
 *   (502) — a mensagem FICA gravada como falha, para o atendente ver e
 *   reenviar, em vez de sumir.
 * - `createFromPatient` incrementa `unread_count` e sobe `last_message_at` na
 *   MESMA transacao do INSERT (ver `MessageRepository.insert`). Conversa
 *   encerrada REABRE antes, na fila livre (D-174).
 */
import type {
  CreateMessageRequest,
  Message,
  MessageStatus,
  MessageType,
  MessageCursors,
  PaginationMeta,
} from '@crm-lab/shared';
import type { ApiModuleDeps } from '../http/api-module.js';
import { BusinessError, notFound } from '../http/errors.js';
import { logger } from '../lib/logger.js';
import type { WsHub } from '../lib/ws-hub.js';
import { ConversationRepository } from '../repositories/conversation.repository.js';
import { MessageRepository, type MessageRef } from '../repositories/message.repository.js';
import { isUniqueViolation } from '../repositories/quick-reply.repository.js';
import { createAuditService, type AuditService } from './audit.service.js';
import {
  createWhatsAppService,
  type QuotedRef,
  type SendOptions,
  type WhatsAppService,
} from './whatsapp.service.js';

/** `image/jpeg` -> `'image'`; `audio/*` -> `'audio'`; `application/pdf` -> `'pdf'`; resto -> `'doc'`. */
function messageTypeFromMime(mimeType: string): MessageType {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType === 'application/pdf') return 'pdf';
  return 'doc';
}

/** Anexo do atendente — o mesmo DTO que `MediaService.storeOutbound` produziu. */
export interface OutboundAttachmentInput {
  fileName: string;
  mimeType: string;
  attachmentUrl: string;
  buffer: Buffer;
  /** Responder citando (CRMLAB-66, D-221). */
  quotedMessageId?: string | null;
}

/**
 * Resultado de reacao/edicao/apagamento vindo do webhook (CRMLAB-66).
 * `alvo_desconhecido` = a mensagem nao esta no CRM (vira descarte contavel);
 * `sem_efeito` = achou, mas nao muda nada (reentrega, sistema, ja apagada).
 */
export type TargetOutcome = 'aplicado' | 'alvo_desconhecido' | 'sem_efeito';

export const DEFAULT_MESSAGE_PAGE = 1;
export const DEFAULT_MESSAGE_LIMIT = 50;
export const MAX_MESSAGE_LIMIT = 100;

export interface MessagePagination {
  page?: number;
  limit?: number;
  /** Cursor (D-237) — excludente com `page` (o controller valida). */
  before?: string;
}

export interface ListMessagesResult {
  messages: Message[];
  pagination: PaginationMeta;
  cursors: MessageCursors;
}

/** Mensagem que chega do canal externo (webhook). */
export interface InboundMessageInput {
  content: string;
  messageType?: Message['messageType'];
  attachmentUrl?: string | null;
  /** Id do canal — dedupe de reentrega (SECURITY.md "Webhooks"). */
  externalId?: string | null;
  patientName?: string | null;
  /** `contextInfo.stanzaId` — a mensagem que o remetente citou (D-221). */
  quotedExternalId?: string | null;
}

function clampPage(value: number | undefined): number {
  const n = Number(value ?? DEFAULT_MESSAGE_PAGE);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_MESSAGE_PAGE;
}

function clampLimit(value: number | undefined): number {
  const n = Number(value ?? DEFAULT_MESSAGE_LIMIT);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MESSAGE_LIMIT;
  return Math.min(Math.floor(n), MAX_MESSAGE_LIMIT);
}

/**
 * Espera pelo envio em voo antes de decidir que um `fromMe` desconhecido veio
 * do celular (D-173). 8 s cobre o envio normal com folga (o eco costuma chegar
 * centenas de ms antes do `sendText` responder); o que passar disso cai na rede
 * de seguranca de `MessageRepository.confirmSent`. Injetavel para o teste da
 * corrida rodar em milissegundos.
 */
export interface EchoWaitOptions {
  timeoutMs: number;
  pollMs: number;
  sleep: (ms: number) => Promise<void>;
}

export const DEFAULT_ECHO_WAIT: EchoWaitOptions = {
  timeoutMs: 8_000,
  pollMs: 250,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface MessageServiceDeps {
  messages: MessageRepository;
  conversations: ConversationRepository;
  wsHub: WsHub;
  /** Ausente => nenhum envio externo (usado por testes de unidade). */
  whatsapp?: WhatsAppService;
  echoWait?: Partial<EchoWaitOptions>;
  /** Registra a reabertura pelo paciente (D-174). Ausente => sem audit (testes de unidade). */
  audit?: AuditService;
}

export class MessageService {
  private readonly messages: MessageRepository;
  private readonly conversations: ConversationRepository;
  private readonly wsHub: WsHub;
  private readonly whatsapp: WhatsAppService | undefined;
  private readonly echoWait: EchoWaitOptions;
  private readonly audit: AuditService | undefined;

  constructor(deps: MessageServiceDeps) {
    this.messages = deps.messages;
    this.conversations = deps.conversations;
    this.wsHub = deps.wsHub;
    this.whatsapp = deps.whatsapp;
    this.echoWait = { ...DEFAULT_ECHO_WAIT, ...deps.echoWait };
    this.audit = deps.audit;
  }

  async listByConversation(
    tenantId: string,
    conversationId: string,
    page: MessagePagination = {},
  ): Promise<ListMessagesResult> {
    // Conversa de outro tenant e invisivel pelo RLS -> 404, nunca 403
    // (CLAUDE.md regra 8: nao vazar existencia).
    const exists = await this.conversations.exists(tenantId, conversationId);
    if (!exists) throw notFound({ resource: 'conversation', id: conversationId });

    // Com cursor, `page` nao se aplica: volta 1 (D-237 item 5).
    const criteria = {
      page: page.before !== undefined ? DEFAULT_MESSAGE_PAGE : clampPage(page.page),
      limit: clampLimit(page.limit),
      ...(page.before !== undefined ? { before: page.before } : {}),
    };
    const result = await this.messages.listByConversation(tenantId, conversationId, criteria);
    // Cursor de outra conversa/tenant ou inexistente: 404, nunca lista vazia —
    // a tela leria "fim do historico" (D-237 item 3).
    if (!result) throw notFound({ resource: 'message', id: page.before });

    return {
      messages: result.rows,
      pagination: {
        page: criteria.page,
        limit: criteria.limit,
        total: result.total,
        totalPages: result.total === 0 ? 0 : Math.ceil(result.total / criteria.limit),
      },
      cursors: {
        before: result.hasOlder ? (result.rows[0]?.id ?? null) : null,
        after: null,
      },
    };
  }

  /**
   * Mensagem do atendente. Persiste, notifica e SO ENTAO tenta o canal externo:
   * assim uma falha de rede nunca faz a mensagem desaparecer da tela.
   */
  async createFromAgent(
    tenantId: string,
    conversationId: string,
    senderId: string,
    dto: CreateMessageRequest,
  ): Promise<Message> {
    const conversation = await this.conversations.findById(tenantId, conversationId);
    if (!conversation) throw notFound({ resource: 'conversation', id: conversationId });
    if (conversation.status !== 'active') {
      throw new BusinessError('CONVERSATION_ARCHIVED', { status: conversation.status });
    }
    const quote = await this.resolveQuote(tenantId, conversationId, dto.quotedMessageId);

    const message = await this.messages.insert(tenantId, {
      conversationId,
      senderType: 'agent',
      senderId,
      content: dto.content,
      messageType: dto.messageType ?? 'text',
      attachmentUrl: dto.attachmentUrl ?? null,
      status: 'sent',
      quotedMessageId: quote?.id ?? null,
      quotedExternalId: quote?.externalMessageId ?? null,
    });
    this.emitNewMessage(tenantId, conversationId, message.id);

    // Canal `direct`/`web` nao tem gateway externo: nada a enviar.
    if (!this.whatsapp || conversation.channel !== 'whatsapp') return message;

    try {
      const { externalId } = await this.whatsapp.send(
        tenantId,
        conversation.patientPhone,
        dto.content,
        sendOptionsFor(quote),
      );
      return await this.confirmSent(tenantId, conversationId, message, externalId);
    } catch (err) {
      // Retry ja esgotado dentro do adapter (3 tentativas, backoff exponencial).
      await this.messages.setStatus(tenantId, message.id, 'failed');
      logger.error('whatsapp.send_failed', {
        tenantId,
        conversationId,
        messageId: message.id,
        reason: err instanceof Error ? err.message : String(err),
      });
      throw new BusinessError('MESSAGE_SEND_FAILED', { messageId: message.id });
    }
  }

  /**
   * Anexo do atendente (Onda 8 §4.3) — mesma disciplina de `createFromAgent`,
   * mas o corpo enviado ao canal é o BUFFER da mídia, não texto.
   */
  async createAttachmentFromAgent(
    tenantId: string,
    conversationId: string,
    senderId: string,
    dto: OutboundAttachmentInput,
  ): Promise<Message> {
    const conversation = await this.conversations.findById(tenantId, conversationId);
    if (!conversation) throw notFound({ resource: 'conversation', id: conversationId });
    if (conversation.status !== 'active') {
      throw new BusinessError('CONVERSATION_ARCHIVED', { status: conversation.status });
    }
    const quote = await this.resolveQuote(tenantId, conversationId, dto.quotedMessageId);

    const message = await this.messages.insert(tenantId, {
      conversationId,
      senderType: 'agent',
      senderId,
      content: dto.fileName,
      messageType: messageTypeFromMime(dto.mimeType),
      attachmentUrl: dto.attachmentUrl,
      status: 'sent',
      quotedMessageId: quote?.id ?? null,
      quotedExternalId: quote?.externalMessageId ?? null,
    });
    this.emitNewMessage(tenantId, conversationId, message.id);

    if (!this.whatsapp || conversation.channel !== 'whatsapp') return message;

    try {
      const { externalId } = await this.whatsapp.sendMedia(
        tenantId,
        conversation.patientPhone,
        { buffer: dto.buffer, mimeType: dto.mimeType, fileName: dto.fileName },
        sendOptionsFor(quote),
      );
      return await this.confirmSent(tenantId, conversationId, message, externalId);
    } catch (err) {
      await this.messages.setStatus(tenantId, message.id, 'failed');
      logger.error('whatsapp.send_media_failed', {
        tenantId,
        conversationId,
        messageId: message.id,
        reason: err instanceof Error ? err.message : String(err),
      });
      throw new BusinessError('MESSAGE_SEND_FAILED', { messageId: message.id });
    }
  }

  /**
   * Mensagem do paciente (webhook). Incrementa `unread_count` e sobe
   * `last_message_at` — feito na mesma transacao do INSERT pelo repositorio.
   *
   * Dedupe: se o `externalId` ja existe neste tenant, devolve a mensagem
   * existente SEM inserir e SEM emitir de novo. O canal reentrega o mesmo POST
   * quando nao recebe 200 a tempo (SECURITY.md "Webhooks").
   */
  async createFromPatient(
    tenantId: string,
    conversationId: string,
    dto: InboundMessageInput,
  ): Promise<Message> {
    const exists = await this.conversations.exists(tenantId, conversationId);
    if (!exists) throw notFound({ resource: 'conversation', id: conversationId });

    if (dto.externalId) {
      const known = await this.messages.findByExternalId(tenantId, dto.externalId);
      if (known) return known;
    }

    await this.reopenForPatient(tenantId, conversationId);

    const insert = (): Promise<Message> =>
      this.messages.insert(tenantId, {
        conversationId,
        senderType: 'patient',
        senderId: null,
        content: dto.content,
        messageType: dto.messageType ?? 'text',
        attachmentUrl: dto.attachmentUrl ?? null,
        // Entrou no sistema: para o paciente, ja foi entregue.
        status: 'delivered',
        externalMessageId: dto.externalId ?? null,
        quotedExternalId: dto.quotedExternalId ?? null,
      });

    let message: Message;
    try {
      message = await insert();
    } catch (err) {
      // A leitura acima nao segura nada entre o SELECT e o INSERT, e o gateway
      // reentrega o MESMO evento ate 10 vezes (migracao 019). Duas reentregas
      // concorrentes passam as duas pela leitura; quem perder a corrida cai
      // aqui. Isso e sucesso idempotente, nao falha: a mensagem do paciente
      // esta gravada, e propagar o erro faria o webhook logar
      // `erro_no_processamento` para algo que deu certo.
      if (!isUniqueViolation(err) || !dto.externalId) throw err;
      const known = await this.messages.findByExternalId(tenantId, dto.externalId);
      if (!known) throw err;
      return known;
    }
    this.emitNewMessage(tenantId, conversationId, message.id);
    return message;
  }

  /**
   * Mensagem que o laboratorio mandou pelo PROPRIO celular (webhook `fromMe`,
   * D-173). Aparece do lado do atendimento, sem autor, e nao conta como nao
   * lida (`insert` so incrementa `unread_count` para paciente).
   *
   * `null` = era o ECO de um envio do CRM (ou reentrega): o `externalId` ja
   * esta gravado, ou foi gravado enquanto esperavamos o envio em voo nesta
   * conversa terminar. Nada e inserido nem emitido.
   *
   * `echoChecked: true` = o chamador ja rodou `isOutboundEcho` — o webhook faz
   * isso ANTES de gravar a midia, senao o eco de um anexo do CRM deixaria
   * arquivo orfao. Evita esperar o envio em voo duas vezes.
   */
  async createFromPhone(
    tenantId: string,
    conversationId: string,
    dto: InboundMessageInput,
    options: { echoChecked?: boolean } = {},
  ): Promise<Message | null> {
    const exists = await this.conversations.exists(tenantId, conversationId);
    if (!exists) throw notFound({ resource: 'conversation', id: conversationId });

    const externalId = dto.externalId ?? null;
    if (
      externalId &&
      !options.echoChecked &&
      (await this.isOutboundEcho(tenantId, conversationId, externalId))
    ) {
      return null;
    }

    try {
      const message = await this.messages.insert(tenantId, {
        conversationId,
        senderType: 'agent',
        senderId: null,
        content: dto.content,
        messageType: dto.messageType ?? 'text',
        attachmentUrl: dto.attachmentUrl ?? null,
        status: 'sent',
        externalMessageId: externalId,
        quotedExternalId: dto.quotedExternalId ?? null,
      });
      this.emitNewMessage(tenantId, conversationId, message.id);
      return message;
    } catch (err) {
      // Reentrega concorrente, ou o envio do CRM gravou o id entre a ultima
      // checagem e o INSERT: nos dois casos a linha certa ja existe.
      if (!isUniqueViolation(err) || !externalId) throw err;
      return null;
    }
  }

  /**
   * `true` quando `externalId` ja e de uma mensagem gravada — agora, ou depois
   * de esperar o envio em voo desta conversa gravar o id que o gateway
   * devolveu. O eco do `sendText` pode chegar ANTES da resposta do proprio
   * `sendText`; sem a espera, ele viraria mensagem do celular duplicada.
   */
  async isOutboundEcho(
    tenantId: string,
    conversationId: string,
    externalId: string,
  ): Promise<boolean> {
    const deadline = Date.now() + this.echoWait.timeoutMs;
    for (;;) {
      if (await this.messages.findByExternalId(tenantId, externalId)) return true;
      if (!(await this.messages.hasPendingOutbound(tenantId, conversationId))) return false;
      if (Date.now() >= deadline) {
        logger.warn('whatsapp.echo_wait_timeout', { tenantId, conversationId, externalId });
        return false;
      }
      await this.echoWait.sleep(this.echoWait.pollMs);
    }
  }

  /**
   * Grava o id externo do envio. Se o eco ja tinha virado copia "do celular"
   * (envio mais lento que a espera de `isOutboundEcho`), o repositorio apaga a copia e
   * o WS e reemitido para a tela refazer a lista sem ela.
   */
  private async confirmSent(
    tenantId: string,
    conversationId: string,
    message: Message,
    externalId: string,
  ): Promise<Message> {
    const { message: updated, removedPhoneCopy } = await this.messages.confirmSent(
      tenantId,
      message.id,
      externalId,
    );
    if (removedPhoneCopy) {
      logger.warn('whatsapp.echo_copy_removed', {
        tenantId,
        conversationId,
        messageId: message.id,
      });
      this.emitNewMessage(tenantId, conversationId, message.id);
    }
    return updated ?? message;
  }

  /**
   * Evento de sistema — a interface que ProposalService/ApprovalService usam.
   * Ver o cabecalho deste arquivo.
   */
  async createSystemEvent(
    tenantId: string,
    conversationId: string,
    content: string,
  ): Promise<Message> {
    const exists = await this.conversations.exists(tenantId, conversationId);
    if (!exists) throw notFound({ resource: 'conversation', id: conversationId });

    const message = await this.messages.insert(tenantId, {
      conversationId,
      senderType: 'system',
      senderId: null,
      content,
      messageType: 'text',
      status: 'delivered',
    });
    this.emitNewMessage(tenantId, conversationId, message.id);
    return message;
  }

  /**
   * Paciente escreveu numa conversa ENCERRADA (D-174): volta para a fila livre,
   * sem dona, com o evento de sistema ANTES da mensagem dele — quem abrir a
   * conversa le "reaberto" e logo abaixo o que o paciente mandou.
   *
   * Depois do dedupe de `createFromPatient`: reentrega nao reabre. Conversa
   * ativa e no-op (o `UPDATE ... WHERE status = 'closed'` afeta 0 linhas).
   */
  private async reopenForPatient(tenantId: string, conversationId: string): Promise<void> {
    const reopened = await this.conversations.reopenIfClosed(tenantId, conversationId, null);
    if (!reopened) return;
    await this.createSystemEvent(tenantId, conversationId, 'Atendimento reaberto pelo paciente');
    await this.audit?.log({
      tenantId,
      userId: null,
      action: 'update_conversation_status',
      entityType: 'conversation',
      entityId: conversationId,
      oldValues: { status: 'closed' },
      newValues: { status: 'active', assignedTo: null },
    });
  }

  // -------------------------------------------------------------------------
  // CRMLAB-66 — citacao, reacao, apagada/editada pelo remetente
  // -------------------------------------------------------------------------

  /**
   * Citada pelo atendente (D-221): mensagem DESTA conversa, nao apagada e nao
   * de sistema. Qualquer outro caso e `NOT_FOUND` — de outro tenant o RLS ja
   * devolve `null`, e de outra conversa nao se distingue de inexistente.
   */
  private async resolveQuote(
    tenantId: string,
    conversationId: string,
    quotedMessageId: string | null | undefined,
  ): Promise<MessageRef | null> {
    if (!quotedMessageId) return null;
    const ref = await this.messages.findRef(tenantId, quotedMessageId);
    if (!ref || ref.conversationId !== conversationId || ref.deleted || ref.senderType === 'system') {
      throw notFound({ resource: 'message', id: quotedMessageId });
    }
    return ref;
  }

  /**
   * Reacao do laboratorio pelo CRM (D-222). `emoji: null` remove. Sai para o
   * WhatsApp ANTES de gravar: falhou, nada muda e a tela recebe
   * `MESSAGE_SEND_FAILED`. Devolve a mensagem atualizada.
   */
  async setAgentReaction(
    tenantId: string,
    conversationId: string,
    messageId: string,
    userId: string,
    emoji: string | null,
  ): Promise<Message | null> {
    const conversation = await this.conversations.findById(tenantId, conversationId);
    if (!conversation) throw notFound({ resource: 'conversation', id: conversationId });
    if (conversation.status !== 'active') {
      throw new BusinessError('CONVERSATION_ARCHIVED', { status: conversation.status });
    }
    const ref = await this.messages.findRef(tenantId, messageId);
    if (!ref || ref.conversationId !== conversationId || ref.deleted || ref.senderType === 'system') {
      throw notFound({ resource: 'message', id: messageId });
    }

    // Remover o que nao existe e no-op: nem vai ao canal.
    if (emoji === null && !(await this.messages.hasReaction(tenantId, messageId, 'agent'))) {
      return this.messages.findById(tenantId, messageId);
    }

    if (this.whatsapp && conversation.channel === 'whatsapp' && ref.externalMessageId) {
      try {
        await this.whatsapp.sendReaction(
          tenantId,
          conversation.patientPhone,
          { externalId: ref.externalMessageId, fromMe: ref.senderType === 'agent' },
          emoji ?? '',
        );
      } catch (err) {
        logger.error('whatsapp.send_reaction_failed', {
          tenantId,
          conversationId,
          messageId,
          reason: err instanceof Error ? err.message : String(err),
        });
        throw new BusinessError('MESSAGE_SEND_FAILED', { messageId });
      }
    }

    if (emoji === null) {
      await this.messages.deleteReaction(tenantId, messageId, 'agent');
    } else {
      await this.messages.upsertReaction(tenantId, {
        messageId,
        reactorType: 'agent',
        userId,
        emoji,
      });
    }
    this.emitMessageUpdated(tenantId, conversationId, messageId);
    return this.messages.findById(tenantId, messageId);
  }

  /**
   * Reacao que chegou pelo webhook (D-222). `fromMe` = celular do laboratorio
   * (ou o eco da reacao feita pelo CRM, que preserva o autor se o emoji e o
   * mesmo). `emoji: ''` remove.
   */
  async applyInboundReaction(
    tenantId: string,
    input: { targetExternalId: string; fromMe: boolean; emoji: string },
  ): Promise<TargetOutcome> {
    const ref = await this.messages.findRefByExternalId(tenantId, input.targetExternalId);
    if (!ref) return 'alvo_desconhecido';
    if (ref.deleted || ref.senderType === 'system') return 'sem_efeito';

    const reactorType = input.fromMe ? 'agent' : 'patient';
    if (input.emoji.length === 0) {
      const removed = await this.messages.deleteReaction(tenantId, ref.id, reactorType);
      if (!removed) return 'sem_efeito';
    } else {
      await this.messages.upsertReaction(tenantId, {
        messageId: ref.id,
        reactorType,
        userId: null,
        emoji: input.emoji,
        keepUserOnSameEmoji: input.fromMe,
      });
    }
    this.emitMessageUpdated(tenantId, ref.conversationId, ref.id);
    return 'aplicado';
  }

  /**
   * "Apagar para todos" pelo remetente (D-220): ESCONDE (`deleted_at`), nunca
   * apaga. `deleted_by` e o lado da original — no WhatsApp so o autor apaga para
   * todos. Audit log sem o texto.
   */
  async applySenderDelete(tenantId: string, targetExternalId: string): Promise<TargetOutcome> {
    const ref = await this.messages.findRefByExternalId(tenantId, targetExternalId);
    if (!ref) return 'alvo_desconhecido';
    if (ref.senderType === 'system') return 'sem_efeito';
    const deletedBy = ref.senderType === 'patient' ? 'patient' : 'agent';

    const deletedAt = await this.messages.markDeleted(tenantId, ref.id, deletedBy);
    if (!deletedAt) return 'sem_efeito';

    await this.audit?.log({
      tenantId,
      userId: null,
      action: 'message_deleted_by_sender',
      entityType: 'message',
      entityId: ref.id,
      oldValues: { deletedAt: null },
      newValues: { deletedAt, deletedBy, externalId: targetExternalId },
    });
    this.emitMessageUpdated(tenantId, ref.conversationId, ref.id);
    return 'aplicado';
  }

  /**
   * Edicao pelo remetente (D-220): texto novo em `content`, o anterior em
   * `message_edits`. Audit log sem o texto (so o id da versao guardada).
   */
  async applySenderEdit(
    tenantId: string,
    targetExternalId: string,
    newContent: string,
  ): Promise<TargetOutcome> {
    const ref = await this.messages.findRefByExternalId(tenantId, targetExternalId);
    if (!ref) return 'alvo_desconhecido';
    if (ref.senderType === 'system') return 'sem_efeito';
    const editedBy = ref.senderType === 'patient' ? 'patient' : 'agent';

    const edit = await this.messages.applyEdit(tenantId, ref.id, newContent, editedBy);
    if (!edit) return 'sem_efeito';

    await this.audit?.log({
      tenantId,
      userId: null,
      action: 'message_edited_by_sender',
      entityType: 'message',
      entityId: ref.id,
      newValues: { editedAt: edit.editedAt, editedBy, editId: edit.editId, externalId: targetExternalId },
    });
    this.emitMessageUpdated(tenantId, ref.conversationId, ref.id);
    return 'aplicado';
  }

  /** Status vindo do callback do canal. `null` = id externo de outro tenant. */
  async applyExternalStatus(
    tenantId: string,
    externalId: string,
    status: MessageStatus,
  ): Promise<Message | null> {
    return this.messages.setStatusByExternalId(tenantId, externalId, status);
  }

  /**
   * Room = tenantId, SEMPRE. Emitir para outra room seria vazar a existencia de
   * uma conversa para um laboratorio que nao e o dono dela.
   */
  private emitNewMessage(tenantId: string, conversationId: string, messageId: string): void {
    this.wsHub.emitToTenant(tenantId, 'conversation.new_message', { conversationId, messageId });
  }

  /** Reacao/edicao/apagamento (D-223) — nunca `new_message`, que conta como nova. */
  private emitMessageUpdated(tenantId: string, conversationId: string, messageId: string): void {
    this.wsHub.emitToTenant(tenantId, 'conversation.message_updated', { conversationId, messageId });
  }
}

/** Citada -> opcoes do driver. Sem id externo, sai sem citacao para o canal (D-221 item 4). */
function sendOptionsFor(quote: MessageRef | null): SendOptions {
  if (!quote?.externalMessageId) return {};
  const quoted: QuotedRef = {
    externalId: quote.externalMessageId,
    fromMe: quote.senderType !== 'patient',
    content: quote.content,
  };
  return { quoted };
}

/**
 * Monta o MessageService a partir das dependencias do kernel — o caminho que
 * os outros modulos de API usam para conseguir `createSystemEvent`.
 *
 *   const messages = createMessageService(deps);
 *   await messages.createSystemEvent(ctx.tenantId, conversationId, 'Orcamento enviado');
 *
 * `whatsapp` e opcional: quem so precisa de evento de sistema nao carrega o
 * adapter do canal externo.
 */
export function createMessageService(
  deps: ApiModuleDeps,
  overrides: { whatsapp?: WhatsAppService } = {},
): MessageService {
  return new MessageService({
    messages: new MessageRepository(deps.db),
    conversations: new ConversationRepository(deps.db),
    wsHub: deps.wsHub,
    whatsapp: overrides.whatsapp ?? createWhatsAppService(deps.db),
    audit: createAuditService(deps.db),
  });
}
