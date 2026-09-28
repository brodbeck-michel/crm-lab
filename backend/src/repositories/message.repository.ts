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
import {
  QUOTED_PREVIEW_MAX,
  type Message,
  type MessageReaction,
  type MessageStatus,
  type MessageType,
  type QuotedMessageSummary,
  type ReactorType,
  type SenderType,
} from '@crm-lab/shared';
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
  // CRMLAB-66 (D-220/D-221/D-222)
  quoted_message_id: string | null;
  quoted_external_id: string | null;
  edited_at: Date | string | null;
  deleted_at: Date | string | null;
  q_id: string | null;
  q_sender_type: string | null;
  q_sender_name: string | null;
  q_preview: string | null;
  q_message_type: string | null;
  q_deleted_at: Date | string | null;
  reactions: unknown;
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

/** ISO-UTC montado no banco (D-021/D-078), para a data dentro do JSON das reacoes. */
const ISO_UTC = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/**
 * Autor de uma mensagem a partir de `<alias>.sender_type`/`sender_id`. O mesmo
 * CASE serve a mensagem e a citada (D-221) — nao duplique a regra.
 */
function senderNameSql(alias: string, userAlias: string): string {
  return `CASE
         WHEN ${alias}.sender_type = 'agent' AND ${alias}.sender_id IS NULL THEN '${PHONE_SENDER_NAME}'
         WHEN ${alias}.sender_type = 'agent' THEN ${userAlias}.name
         WHEN ${alias}.sender_type = 'patient' THEN c.patient_name
         ELSE NULL
       END`;
}

const COLUMNS = `m.id, m.conversation_id, m.sender_type, m.sender_id, m.content,
       m.message_type, m.attachment_url, m.status, m.read_at, m.created_at,
       ${senderNameSql('m', 'u')} AS sender_name,
       m.quoted_message_id, m.quoted_external_id, m.edited_at, m.deleted_at,
       q.id AS q_id, q.sender_type AS q_sender_type, q.sender_name AS q_sender_name,
       left(q.content, ${QUOTED_PREVIEW_MAX}) AS q_preview, q.message_type AS q_message_type,
       q.deleted_at AS q_deleted_at,
       COALESCE((
         SELECT json_agg(json_build_object(
                  'emoji', r.emoji,
                  'reactorType', r.reactor_type,
                  'userId', r.user_id,
                  'userName', ru.name,
                  'reactedAt', to_char(r.updated_at AT TIME ZONE 'UTC', ${ISO_UTC}))
                ORDER BY r.reactor_type DESC)
           FROM message_reactions r
           LEFT JOIN users ru ON ru.id = r.user_id
          WHERE r.message_id = m.id
       ), '[]'::json) AS reactions`;

/**
 * A citada (D-221) e resolvida NA LEITURA: pela id interna quando a original ja
 * estava no CRM ao gravar, senao pelo `stanzaId` na mesma conversa — assim a
 * original que chega depois da resposta aparece sem backfill. `LATERAL` + `LIMIT
 * 1` porque o `external_message_id` e unico por tenant (019), e o RLS ja
 * recorta o tenant.
 */
const FROM = `FROM messages m
     LEFT JOIN users u ON u.id = m.sender_id
     LEFT JOIN conversations c ON c.id = m.conversation_id
     LEFT JOIN LATERAL (
       SELECT q.id, q.sender_type, q.content, q.message_type, q.deleted_at,
              ${senderNameSql('q', 'qu')} AS sender_name
         FROM messages q
         LEFT JOIN users qu ON qu.id = q.sender_id
        WHERE q.conversation_id = m.conversation_id
          AND (q.id = m.quoted_message_id
               OR (m.quoted_message_id IS NULL
                   AND m.quoted_external_id IS NOT NULL
                   AND q.external_message_id = m.quoted_external_id))
        LIMIT 1
     ) q ON TRUE`;

function toReactions(value: unknown): MessageReaction[] {
  const list: unknown = typeof value === 'string' ? safeParse(value) : value;
  if (!Array.isArray(list)) return [];
  const out: MessageReaction[] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.emoji !== 'string') continue;
    out.push({
      emoji: r.emoji,
      reactorType: r.reactorType === 'agent' ? 'agent' : 'patient',
      userId: typeof r.userId === 'string' ? r.userId : null,
      userName: typeof r.userName === 'string' ? r.userName : null,
      reactedAt: toIso(r.reactedAt),
    });
  }
  return out;
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function toQuoted(row: MessageRow): QuotedMessageSummary | null {
  if (!row.quoted_message_id && !row.quoted_external_id) return null;
  if (!row.q_id) {
    // A original nao esta no CRM (anterior a conversa) — D-221 item 3.
    return { id: null, senderType: null, senderName: null, preview: '', messageType: null, deleted: false };
  }
  const deleted = row.q_deleted_at !== null;
  return {
    id: row.q_id,
    senderType: row.q_sender_type ? toSenderType(row.q_sender_type) : null,
    senderName: row.q_sender_name,
    // Citada apagada tambem nao vaza o conteudo escondido (D-220).
    preview: deleted ? '' : (row.q_preview ?? ''),
    messageType: row.q_message_type ? toMessageType(row.q_message_type) : null,
    deleted,
  };
}

/**
 * Linha -> `Message`. Mensagem APAGADA pelo remetente (D-220) sai sem o
 * conteudo: `content` vazio, sem anexo, sem citacao e sem reacoes. A linha e a
 * midia continuam no banco — quem esconde e ESTA funcao, o unico caminho de
 * `messages` ate a API.
 */
export function toMessage(row: MessageRow): Message {
  const deletedAt = toIsoOrNull(row.deleted_at);
  const hidden = deletedAt !== null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderType: toSenderType(row.sender_type),
    senderId: row.sender_id,
    senderName: row.sender_name,
    content: hidden ? '' : row.content,
    messageType: toMessageType(row.message_type),
    attachmentUrl: hidden ? null : row.attachment_url,
    status: toMessageStatus(row.status),
    readAt: toIsoOrNull(row.read_at),
    createdAt: toIso(row.created_at),
    quotedMessageId: hidden ? null : (row.quoted_message_id ?? row.q_id),
    quoted: hidden ? null : toQuoted(row),
    reactions: hidden ? [] : toReactions(row.reactions),
    editedAt: toIsoOrNull(row.edited_at),
    deletedAt,
  };
}

/**
 * O que o service precisa saber de uma mensagem para citar, reagir, apagar ou
 * editar (CRMLAB-66) — inclusive o id externo, que `Message` nao expoe.
 */
export interface MessageRef {
  id: string;
  conversationId: string;
  senderType: SenderType;
  externalMessageId: string | null;
  content: string;
  deleted: boolean;
}

const REF_COLUMNS = `id, conversation_id, sender_type, external_message_id, content, deleted_at`;

function toRef(row: {
  id: string;
  conversation_id: string;
  sender_type: string;
  external_message_id: string | null;
  content: string;
  deleted_at: unknown;
}): MessageRef {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderType: toSenderType(row.sender_type),
    externalMessageId: row.external_message_id,
    content: row.content,
    deleted: row.deleted_at !== null && row.deleted_at !== undefined,
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
  /** Citada (D-221) — id interna, quando conhecida. */
  quotedMessageId?: string | null;
  /** `stanzaId` do webhook / id externo da citada. Sem `quotedMessageId`, resolve pela conversa. */
  quotedExternalId?: string | null;
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
            attachment_url, status, external_message_id, quoted_external_id, quoted_message_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text,
                 COALESCE($11::uuid, (SELECT q.id FROM messages q
                                       WHERE $10::text IS NOT NULL
                                         AND q.conversation_id = $2
                                         AND q.external_message_id = $10::text
                                       LIMIT 1)))
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
          data.quotedExternalId ?? null,
          data.quotedMessageId ?? null,
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

  /** Referencia por id interna (citar/reagir pela API). `null` = inexistente ou de outro tenant. */
  async findRef(tenantId: string, id: string): Promise<MessageRef | null> {
    return this.db.withTenant(tenantId, async (tx) => {
      const found = await tx.query<Parameters<typeof toRef>[0]>(
        `SELECT ${REF_COLUMNS} FROM messages WHERE id = $1`,
        [id],
      );
      const row = found.rows[0];
      return row ? toRef(row) : null;
    });
  }

  /** Referencia pelo id externo (reacao/edicao/apagamento que chega pelo webhook). */
  async findRefByExternalId(tenantId: string, externalMessageId: string): Promise<MessageRef | null> {
    return this.db.withTenant(tenantId, async (tx) => {
      const found = await tx.query<Parameters<typeof toRef>[0]>(
        `SELECT ${REF_COLUMNS} FROM messages WHERE external_message_id = $1 LIMIT 1`,
        [externalMessageId],
      );
      const row = found.rows[0];
      return row ? toRef(row) : null;
    });
  }

  /** `true` quando o lado ja tem reacao nesta mensagem (D-222). */
  async hasReaction(tenantId: string, messageId: string, reactorType: ReactorType): Promise<boolean> {
    return this.db.withTenant(tenantId, async (tx) => {
      const found = await tx.query<{ id: string }>(
        'SELECT id FROM message_reactions WHERE message_id = $1 AND reactor_type = $2',
        [messageId, reactorType],
      );
      return found.rows.length > 0;
    });
  }

  /**
   * Grava/substitui a reacao do lado (D-222). `keepUserOnSameEmoji` e o eco
   * `fromMe` da reacao feita pelo CRM: mesmo emoji preserva quem reagiu; emoji
   * diferente (reagiu pelo celular) grava o `userId` informado (nulo).
   */
  async upsertReaction(
    tenantId: string,
    input: {
      messageId: string;
      reactorType: ReactorType;
      userId: string | null;
      emoji: string;
      keepUserOnSameEmoji?: boolean;
    },
  ): Promise<void> {
    await this.db.withTenant(tenantId, (tx) =>
      tx.query(
        `INSERT INTO message_reactions (tenant_id, message_id, reactor_type, user_id, emoji)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, message_id, reactor_type)
         DO UPDATE SET
           user_id = CASE
             WHEN $6::boolean AND message_reactions.emoji = EXCLUDED.emoji
               THEN message_reactions.user_id
             ELSE EXCLUDED.user_id
           END,
           emoji = EXCLUDED.emoji,
           updated_at = now()`,
        [
          tenantId,
          input.messageId,
          input.reactorType,
          input.userId,
          input.emoji,
          input.keepUserOnSameEmoji === true,
        ],
      ),
    );
  }

  /** Remove a reacao do lado. `true` = havia reacao. Reacao nao e conteudo (D-222). */
  async deleteReaction(tenantId: string, messageId: string, reactorType: ReactorType): Promise<boolean> {
    return this.db.withTenant(tenantId, async (tx) => {
      const removed = await tx.query<{ id: string }>(
        'DELETE FROM message_reactions WHERE message_id = $1 AND reactor_type = $2 RETURNING id',
        [messageId, reactorType],
      );
      return removed.rows.length > 0;
    });
  }

  /**
   * Apagada pelo remetente (D-220): ESCONDE, nunca apaga. `null` = ja estava
   * apagada (reentrega) — nada muda. Devolve o instante gravado.
   */
  async markDeleted(
    tenantId: string,
    id: string,
    deletedBy: 'patient' | 'agent',
  ): Promise<string | null> {
    return this.db.withTenant(tenantId, async (tx) => {
      const updated = await tx.query<{ deleted_at: unknown }>(
        `UPDATE messages
            SET deleted_at = now(), deleted_by = $2
          WHERE id = $1 AND deleted_at IS NULL
          RETURNING deleted_at`,
        [id, deletedBy],
      );
      const row = updated.rows[0];
      return row ? toIsoOrNull(row.deleted_at) : null;
    });
  }

  /**
   * Editada pelo remetente (D-220): guarda a versao ANTERIOR em `message_edits`
   * e troca o texto, na mesma transacao. `null` = nada a fazer (apagada, ou o
   * texto e o mesmo — reentrega).
   */
  async applyEdit(
    tenantId: string,
    id: string,
    newContent: string,
    editedBy: 'patient' | 'agent',
  ): Promise<{ editId: string; editedAt: string | null } | null> {
    return this.db.withTenant(tenantId, async (tx) => {
      const current = await tx.query<{ content: string; deleted_at: unknown }>(
        'SELECT content, deleted_at FROM messages WHERE id = $1 FOR UPDATE',
        [id],
      );
      const row = current.rows[0];
      if (!row || (row.deleted_at !== null && row.deleted_at !== undefined)) return null;
      if (row.content === newContent) return null;

      const edit = await tx.query<{ id: string }>(
        `INSERT INTO message_edits (tenant_id, message_id, previous_content, edited_by)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [tenantId, id, row.content, editedBy],
      );
      const updated = await tx.query<{ edited_at: unknown }>(
        'UPDATE messages SET content = $2, edited_at = now() WHERE id = $1 RETURNING edited_at',
        [id, newContent],
      );
      const editId = edit.rows[0]?.id;
      if (!editId) throw new Error('INSERT em message_edits nao retornou linha');
      return { editId, editedAt: toIsoOrNull(updated.rows[0]?.edited_at) };
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
