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
    // Nao ha tabela de leitura por usuario no schema: o contador nasce em 0.
    // Ver D-044 em docs/DECISIONS.md.
    unreadCount: 0,
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

export async function listChannels(tx: DbTx): Promise<Channel[]> {
  const result = await tx.query<ChannelRow>(
    `SELECT ch.id, ch.key, ch.name, ch.kind,
            (SELECT MAX(m.created_at) FROM internal_messages m WHERE m.channel_id = ch.id)
              AS last_message_at
       FROM internal_channels ch
      ORDER BY ch.kind ASC, ch.key ASC`,
  );
  return result.rows.map(mapChannel);
}

export async function findChannelById(tx: DbTx, id: string): Promise<Channel | null> {
  const result = await tx.query<ChannelRow>(
    `SELECT ch.id, ch.key, ch.name, ch.kind,
            (SELECT MAX(m.created_at) FROM internal_messages m WHERE m.channel_id = ch.id)
              AS last_message_at
       FROM internal_channels ch
      WHERE ch.id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? mapChannel(row) : null;
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

/** Pagina de mensagens em ordem cronologica (a mais antiga primeiro). */
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

  const offset = (page.page - 1) * page.limit;
  const result = await tx.query<MessageRow>(
    `${SELECT_MESSAGE} WHERE m.channel_id = $1
      ORDER BY m.created_at ASC, m.id ASC
      LIMIT $2 OFFSET $3`,
    [channelId, page.limit, offset],
  );
  return { rows: result.rows.map(mapMessage), total };
}
