/**
 * Acesso a dados de `messages`. SEM regra de negocio (CONVENTIONS.md): quem
 * decide arquivamento, envio externo e evento de WebSocket e o `MessageService`.
 *
 * Todo metodo abre `db.withTenant(tenantId, ...)` — camada 3 do isolamento
 * (SECURITY.md). Uma mensagem que chega por webhook tambem passa por aqui: o
 * tenant e resolvido ANTES (pela credencial do canal) e a escrita acontece
 * dentro do contexto, nunca com `withoutTenant()`.
 *
 * A insercao de mensagem do PACIENTE e a atualizacao de `unread_count` /
 * `last_message_at` acontecem na MESMA transacao: contador e mensagem nao podem
 * divergir (BUSINESS_RULES §5 — um numero, uma origem).
 */
import type { Message, MessageStatus, MessageType, SenderType } from '@crm-lab/shared';
import type { DbClient, DbTx } from '../db/types.js';
import { toIso, toIsoOrNull, toNumber } from './row-mappers.js';

interface MessageRow {
  id: string;
  conversation_id: string;
  sender_type: string;
  sender_id: string | null;
  sender_name: string | null;
  content: string;
  message_type: string | null;
  attachment_url: string | null;
  status: string | null;
  read_at: Date | string | null;
  created_at: Date | string;
}

const MESSAGE_TYPES: MessageType[] = ['text', 'image', 'audio', 'pdf', 'doc'];
const MESSAGE_STATUSES: MessageStatus[] = ['sent', 'delivered', 'read', 'failed'];
const SENDER_TYPES: SenderType[] = ['patient', 'agent', 'system'];

function toMessageType(value: string | null): MessageType {
  return MESSAGE_TYPES.includes(value as MessageType) ? (value as MessageType) : 'text';
}

function toMessageStatus(value: string | null): MessageStatus {
  return MESSAGE_STATUSES.includes(value as MessageStatus) ? (value as MessageStatus) : 'sent';
}

function toSenderType(value: string): SenderType {
  return SENDER_TYPES.includes(value as SenderType) ? (value as SenderType) : 'system';
}

/**
 * `sender_name` nao existe na tabela: vem do JOIN com `users` para o agente e
 * de `conversations.patient_name` para o paciente. Mensagem de sistema nao tem
 * autor — o frontend renderiza a bolha de evento.
 *
 * Agente SEM autor e a mensagem digitada no celular do laboratorio (D-173):
 * so o webhook `fromMe` grava `agent` com `sender_id NULL` — o app nao apaga
 * usuario fisicamente, entao o `ON DELETE SET NULL` nao produz esse par.
 */
export const PHONE_SENDER_NAME = 'Enviada pelo celular';

const COLUMNS = `m.id, m.conversation_id, m.sender_type, m.sender_id, m.content,
       m.message_type, m.attachment_url, m.status, m.read_at, m.created_at,
       CASE
         WHEN m.sender_type = 'agent' AND m.sender_id IS NULL THEN '${PHONE_SENDER_NAME}'
         WHEN m.sender_type = 'agent' THEN u.name
         WHEN m.sender_type = 'patient' THEN c.patient_name
         ELSE NULL
       END AS sender_name`;

const FROM = `FROM messages m
     LEFT JOIN users u ON u.id = m.sender_id
     LEFT JOIN conversations c ON c.id = m.conversation_id`;

export function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderType: toSenderType(row.sender_type),
    senderId: row.sender_id,
    senderName: row.sender_name,
    content: row.content,
    messageType: toMessageType(row.message_type),
    attachmentUrl: row.attachment_url,
    status: toMessageStatus(row.status),
    readAt: toIsoOrNull(row.read_at),
    createdAt: toIso(row.created_at),
  };
}

export interface MessageInsert {
  conversationId: string;
  senderType: SenderType;
  senderId: string | null;
  content: string;
  messageType?: MessageType;
  attachmentUrl?: string | null;
  status?: MessageStatus;
  externalMessageId?: string | null;
}

export interface MessagePage {
  rows: Message[];
  total: number;
}

export interface ListMessagesCriteria {
  page: number;
  limit: number;
}

export class MessageRepository {
  constructor(private readonly db: DbClient) {}

  /**
   * Uma pagina do historico. A pagina 1 traz as mensagens MAIS RECENTES (e o
   * que a tela de Atendimento abre), mas as linhas voltam em ordem cronologica
   * crescente — o frontend renderiza de cima para baixo sem reordenar.
   */
  async listByConversation(
    tenantId: string,
    conversationId: string,
    criteria: ListMessagesCriteria,
  ): Promise<MessagePage> {
    return this.db.withTenant(tenantId, async (tx) => {
      const counted = await tx.query<{ total: number | string }>(
        'SELECT COUNT(*)::int AS total FROM messages WHERE conversation_id = $1',
        [conversationId],
      );
      const total = toNumber(counted.rows[0]?.total, 0);

      const offset = (criteria.page - 1) * criteria.limit;
      const paged = await tx.query<MessageRow>(
        `SELECT ${COLUMNS} ${FROM}
         WHERE m.conversation_id = $1
         ORDER BY m.created_at DESC, m.id DESC
         LIMIT $2 OFFSET $3`,
        [conversationId, criteria.limit, offset],
      );

      return { rows: paged.rows.map(toMessage).reverse(), total };
    });
  }

  async findById(tenantId: string, id: string): Promise<Message | null> {
    return this.db.withTenant(tenantId, (tx) => selectOne(tx, id));
  }

  /**
   * Insere a mensagem e atualiza a conversa na MESMA transacao.
   *
   * - `last_message_at` sobe sempre (a lista ordena por ele);
   * - `unread_count` so incrementa para mensagem do PACIENTE: o que o atendente
   *   escreve nao pode aparecer como "nao lida" para ele mesmo.
   */
  async insert(tenantId: string, data: MessageInsert): Promise<Message> {
    return this.db.withTenant(tenantId, async (tx) => {
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO messages
           (tenant_id, conversation_id, sender_type, sender_id, content, message_type,
            attachment_url, status, external_message_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [
          tenantId,
          data.conversationId,
          data.senderType,
          data.senderId,
          data.content,
          data.messageType ?? 'text',
          data.attachmentUrl ?? null,
          data.status ?? 'sent',
          data.externalMessageId ?? null,
        ],
      );
      const id = inserted.rows[0]?.id;
      if (!id) throw new Error('INSERT em messages nao retornou linha');

      const bumpUnread = data.senderType === 'patient';
      await tx.query(
        `UPDATE conversations
         SET last_message_at = NOW(),
             unread_count = unread_count + $2,
             updated_at = NOW()
         WHERE id = $1`,
        [data.conversationId, bumpUnread ? 1 : 0],
      );

      const message = await selectOne(tx, id);
      if (!message) throw new Error('mensagem recem-criada nao pode ser lida');
      return message;
    });
  }

  /** Atualiza o status apos o retorno do canal externo (envio ou callback). */
  async setStatus(
    tenantId: string,
    id: string,
    status: MessageStatus,
    externalMessageId?: string | null,
  ): Promise<Message | null> {
    return this.db.withTenant(tenantId, async (tx) => {
      const updated = await tx.query<{ id: string }>(
        `UPDATE messages
         SET status = $1::text,
             external_message_id = COALESCE($2::text, external_message_id),
             read_at = CASE WHEN $1::text = 'read' THEN COALESCE(read_at, NOW()) ELSE read_at END
         WHERE id = $3
         RETURNING id`,
        [status, externalMessageId ?? null, id],
      );
      const changedId = updated.rows[0]?.id;
      return changedId ? selectOne(tx, changedId) : null;
    });
  }

  /**
   * Envio do CRM confirmado pelo canal: grava `status = 'sent'` e o id externo.
   *
   * Rede de seguranca do D-173: se o eco deste envio chegou pelo webhook, a
   * espera por envio em voo (`hasPendingOutbound`) esgotou e ele virou uma
   * copia "enviada pelo celular" com ESTE `externalId`, o UPDATE bateria no
   * indice unico da 019. A copia e apagada antes, na mesma transacao — so
   * linha de agente SEM autor, que e o que o webhook `fromMe` grava; mensagem
   * de paciente ou de outro atendente com o mesmo id nunca e tocada.
   * `removedPhoneCopy` avisa o service para reemitir o WS e a tela refazer a
   * lista sem a duplicata.
   */
  async confirmSent(
    tenantId: string,
    id: string,
    externalMessageId: string,
  ): Promise<{ message: Message | null; removedPhoneCopy: boolean }> {
    return this.db.withTenant(tenantId, async (tx) => {
      const removed = await tx.query<{ id: string }>(
        `DELETE FROM messages
         WHERE external_message_id = $1
           AND sender_type = 'agent'
           AND sender_id IS NULL
           AND id <> $2
         RETURNING id`,
        [externalMessageId, id],
      );
      const updated = await tx.query<{ id: string }>(
        `UPDATE messages
         SET status = 'sent', external_message_id = $1
         WHERE id = $2
         RETURNING id`,
        [externalMessageId, id],
      );
      const changedId = updated.rows[0]?.id;
      return {
        message: changedId ? await selectOne(tx, changedId) : null,
        removedPhoneCopy: removed.rows.length > 0,
      };
    });
  }

  /**
   * Envio do CRM EM VOO nesta conversa (D-173): mensagem de atendente, com
   * autor, ainda `sent` e sem id externo — gravada antes do envio e esperando
   * o gateway responder. E o que diz ao webhook `fromMe` que um `key.id`
   * desconhecido pode ser o eco de um envio que ainda nao gravou o id.
   *
   * 60 s cobre o pior caso do retry (3 x 15 s + backoff, ver
   * `evolution-client.ts`); passado disso a linha e resto de envio antigo
   * (driver sem canal, processo derrubado no meio), nao envio em voo.
   */
  async hasPendingOutbound(tenantId: string, conversationId: string): Promise<boolean> {
    return this.db.withTenant(tenantId, async (tx) => {
      const found = await tx.query<{ id: string }>(
        `SELECT id FROM messages
         WHERE conversation_id = $1
           AND sender_type = 'agent'
           AND sender_id IS NOT NULL
           AND status = 'sent'
           AND external_message_id IS NULL
           AND created_at > NOW() - INTERVAL '60 seconds'
         LIMIT 1`,
        [conversationId],
      );
      return found.rows.length > 0;
    });
  }

  /**
   * Status vindo do callback do canal, que so conhece o id externo.
   * `null` quando o id externo nao pertence a este tenant.
   */
  async setStatusByExternalId(
    tenantId: string,
    externalMessageId: string,
    status: MessageStatus,
  ): Promise<Message | null> {
    return this.db.withTenant(tenantId, async (tx) => {
      const updated = await tx.query<{ id: string }>(
        `UPDATE messages
         SET status = $1::text,
             read_at = CASE WHEN $1::text = 'read' THEN COALESCE(read_at, NOW()) ELSE read_at END
         WHERE external_message_id = $2
         RETURNING id`,
        [status, externalMessageId],
      );
      const changedId = updated.rows[0]?.id;
      return changedId ? selectOne(tx, changedId) : null;
    });
  }

  /**
   * Dedupe do webhook (SECURITY.md "Webhooks"): a mesma mensagem reentregue
   * pelo canal nao pode virar duas linhas nem dois eventos de WS.
   */
  async findByExternalId(tenantId: string, externalMessageId: string): Promise<Message | null> {
    return this.db.withTenant(tenantId, async (tx) => {
      const found = await tx.query<{ id: string }>(
        'SELECT id FROM messages WHERE external_message_id = $1 LIMIT 1',
        [externalMessageId],
      );
      const id = found.rows[0]?.id;
      return id ? selectOne(tx, id) : null;
    });
  }
}

async function selectOne(tx: DbTx, id: string): Promise<Message | null> {
  const result = await tx.query<MessageRow>(`SELECT ${COLUMNS} ${FROM} WHERE m.id = $1`, [id]);
  const row = result.rows[0];
  return row ? toMessage(row) : null;
}
