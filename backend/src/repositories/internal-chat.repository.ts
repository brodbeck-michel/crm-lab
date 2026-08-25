/**
 * Acesso a dados de `internal_channels` e `internal_messages` (SERVICES.md §7).
 *
 * Como no resto do backend, todo metodo recebe um `DbTx`: o escopo
 * (`db.withTenant`) e do service. Chat interno e dado de laboratorio — nenhum
 * caminho aqui usa `withoutTenant()`.
 */
import type { Channel, InternalMessage } from '@crm-lab/shared';
import type { DbTx } from '../db/types.js';
import { toIso, toIsoOrNull } from './row-mappers.js';

/** Canais padrao do onboarding (WORKFLOWS.md §6 e §7). */
export const DEFAULT_CHANNELS = [
  { key: 'geral', name: '#geral' },
  { key: 'aprovacoes', name: '#aprovacoes' },
] as const;

export type DefaultChannelKey = (typeof DEFAULT_CHANNELS)[number]['key'];

interface ChannelRow {
  id: string;
  key: string;
  name: string;
  kind: string;
  last_message_at: unknown;
  /** Ausente nas leituras internas (`ensureChannel`), que nao servem a tela. */
  last_read_at?: unknown;
  unread_count?: number | string | null;
}

interface MessageRow {
  id: string;
  channel_id: string;
  sender_id: string | null;
  sender_name: string | null;
  content: string;
  attached_proposal_id: string | null;
  is_system: boolean;
  created_at: unknown;
}

export function mapChannel(row: ChannelRow): Channel {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    kind: row.kind === 'dm' ? 'dm' : 'channel',
    // Derivado de `channel_reads` a cada leitura, nunca materializado
    // (D-068 / SCHEMA.md §17 — supera o `0` fixo de D-044).
    unreadCount: Number(row.unread_count ?? 0),
    lastReadAt: toIsoOrNull(row.last_read_at ?? null),
    lastMessageAt: toIsoOrNull(row.last_message_at),
  };
}

export function mapMessage(row: MessageRow): InternalMessage {
  return {
    id: row.id,
    channelId: row.channel_id,
    senderId: row.sender_id,
    senderName: row.is_system ? 'Sistema' : (row.sender_name ?? 'Usuario removido'),
    content: row.content,
    attachedProposalId: row.attached_proposal_id,
    isSystem: row.is_system,
    createdAt: toIso(row.created_at),
  };
}

/**
 * SELECT canonico do canal PARA UM USUARIO (SCHEMA.md §17, D-068).
 *
 * `$1` e o id do usuario que pergunta: `last_read_at` vem da linha DELE em
 * `channel_reads` (ausente = nunca abriu -> `-infinity`, tudo conta) e o
 * `unread_count` ignora o que ele mesmo escreveu. Mensagem de sistema
 * (`sender_id IS NULL`) CONTA de proposito — o pedido de aprovacao em
 * `#aprovacoes` e justamente o que precisa piscar.
 *
 * `IS DISTINCT FROM` (e nao `<>`) porque `sender_id` e anulavel: com `<>` a
 * comparacao viraria NULL na mensagem de sistema e ela deixaria de contar.
 */
const SELECT_CHANNEL_FOR_USER = `
  SELECT ch.id, ch.key, ch.name, ch.kind,
         MAX(m.created_at) AS last_message_at,
         r.last_read_at,
         COUNT(*) FILTER (
           WHERE m.created_at > COALESCE(r.last_read_at, '-infinity'::timestamp)
             AND m.sender_id IS DISTINCT FROM $1::uuid
         )::int AS unread_count
    FROM internal_channels ch
    LEFT JOIN channel_reads r ON r.channel_id = ch.id AND r.user_id = $1::uuid
    LEFT JOIN internal_messages m ON m.channel_id = ch.id`;

const GROUP_CHANNEL = 'GROUP BY ch.id, ch.key, ch.name, ch.kind, r.last_read_at';

export async function listChannels(tx: DbTx, userId: string): Promise<Channel[]> {
  const result = await tx.query<ChannelRow>(
    `${SELECT_CHANNEL_FOR_USER}
     ${GROUP_CHANNEL}
     ORDER BY ch.kind ASC, ch.key ASC`,
    [userId],
  );
  return result.rows.map(mapChannel);
}

export async function findChannelById(
  tx: DbTx,
  id: string,
  userId: string,
): Promise<Channel | null> {
  const result = await tx.query<ChannelRow>(
    `${SELECT_CHANNEL_FOR_USER}
      WHERE ch.id = $2
     ${GROUP_CHANNEL}`,
    [userId, id],
  );
  const row = result.rows[0];
  return row ? mapChannel(row) : null;
}

/**
 * Marca o canal como lido AGORA para o usuario (D-068).
 *
 * Idempotente por construcao: `ON CONFLICT` sem leitura previa. Nao ha
 * `SELECT` antes — duas chamadas simultaneas nao podem duplicar a linha.
 */
export async function markChannelRead(
  tx: DbTx,
  input: { tenantId: string; channelId: string; userId: string },
): Promise<void> {
  await tx.query(
    `INSERT INTO channel_reads (tenant_id, channel_id, user_id, last_read_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (channel_id, user_id) DO UPDATE SET last_read_at = NOW()`,
    [input.tenantId, input.channelId, input.userId],
  );
}

export async function findChannelByKey(tx: DbTx, key: string): Promise<Channel | null> {
  const result = await tx.query<ChannelRow>(
    `SELECT ch.id, ch.key, ch.name, ch.kind, NULL AS last_message_at
       FROM internal_channels ch WHERE ch.key = $1`,
    [key],
  );
  const row = result.rows[0];
  return row ? mapChannel(row) : null;
}

export async function insertChannel(
  tx: DbTx,
  input: { tenantId: string; key: string; name: string; kind?: 'channel' | 'dm' },
): Promise<Channel> {
  const result = await tx.query<ChannelRow>(
    `INSERT INTO internal_channels (tenant_id, key, name, kind)
     VALUES ($1, $2, $3, $4)
     RETURNING id, key, name, kind, NULL AS last_message_at`,
    [input.tenantId, input.key, input.name, input.kind ?? 'channel'],
  );
  const row = result.rows[0];
  if (!row) throw new Error('INSERT em internal_channels nao retornou linha');
  return mapChannel(row);
}

export interface InternalMessageInsert {
  tenantId: string;
  channelId: string;
  senderId: string | null;
  content: string;
  attachedProposalId: string | null;
  isSystem: boolean;
}

export async function insertMessage(
  tx: DbTx,
  input: InternalMessageInsert,
): Promise<InternalMessage> {
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO internal_messages (tenant_id, channel_id, sender_id, content,
                                    attached_proposal_id, is_system)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      input.tenantId,
      input.channelId,
      input.senderId,
      input.content,
      input.attachedProposalId,
      input.isSystem,
    ],
  );
  const id = inserted.rows[0]?.id;
  if (id === undefined) throw new Error('INSERT em internal_messages nao retornou linha');
  const message = await findMessageById(tx, id);
  if (!message) throw new Error('Mensagem interna recem-inserida nao encontrada');
  return message;
}

export async function findMessageById(tx: DbTx, id: string): Promise<InternalMessage | null> {
  const result = await tx.query<MessageRow>(
    `${SELECT_MESSAGE} WHERE m.id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? mapMessage(row) : null;
}

const SELECT_MESSAGE = `
  SELECT m.id, m.channel_id, m.sender_id, u.name AS sender_name, m.content,
         m.attached_proposal_id, m.is_system, m.created_at
    FROM internal_messages m
    LEFT JOIN users u ON u.id = m.sender_id`;

export interface MessagePage {
  rows: InternalMessage[];
  total: number;
}

/**
 * Fatia do historico contada A PARTIR DO FIM (D-069).
 *
 * `page=1` e o bloco das mensagens MAIS RECENTES; `page=2`, o imediatamente
 * anterior. Dentro da pagina os itens seguem em ordem cronologica crescente —
 * a paginacao escolhe QUAL fatia, nao a ordem dos itens.
 *
 * O `OFFSET` bruto e `total - page * limit`. Quando negativo, a pagina esbarra
 * no comeco do historico: o offset vira 0 e o LIMIT encolhe para o resto (a
 * pagina mais antiga e a unica que pode vir com menos itens que `limit`).
 * Pagina alem do fim devolve lista vazia, sem tocar no banco.
 */
export async function listMessages(
  tx: DbTx,
  channelId: string,
  page: { page: number; limit: number },
): Promise<MessagePage> {
  const counted = await tx.query<{ total: number | string }>(
    'SELECT COUNT(*)::int AS total FROM internal_messages WHERE channel_id = $1',
    [channelId],
  );
  const total = Number(counted.rows[0]?.total ?? 0);

  const rawOffset = total - page.page * page.limit;
  const offset = Math.max(0, rawOffset);
  const limit = rawOffset >= 0 ? page.limit : Math.max(0, page.limit + rawOffset);
  if (limit === 0) return { rows: [], total };

  const result = await tx.query<MessageRow>(
    `${SELECT_MESSAGE} WHERE m.channel_id = $1
      ORDER BY m.created_at ASC, m.id ASC
      LIMIT $2 OFFSET $3`,
    [channelId, limit, offset],
  );
  return { rows: result.rows.map(mapMessage), total };
}
