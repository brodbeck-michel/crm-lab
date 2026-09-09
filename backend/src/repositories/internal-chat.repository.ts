/**
 * Acesso a dados de `internal_channels` e `internal_messages` (SERVICES.md §7).
 *
 * Como no resto do backend, todo metodo recebe um `DbTx`: o escopo
 * (`db.withTenant`) e do service. Chat interno e dado de laboratorio — nenhum
 * caminho aqui usa `withoutTenant()`.
 */
import type { Channel, ChatDirectoryUser, InternalMessage, UserRole } from '@crm-lab/shared';
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
  /** So preenchidos em `kind = 'dm'` (D-101, migracao 010). */
  dm_user_a_id?: string | null;
  dm_user_b_id?: string | null;
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

/**
 * `otherUserName` vem de fora (segunda consulta em lote — ver `resolveOtherUserNames`
 * abaixo) para nao complicar o `GROUP BY` de `SELECT_CHANNEL_FOR_USER` com um join a
 * mais. `otherUserId` e derivado das colunas da propria linha: e SEMPRE o participante
 * que NAO e `viewerUserId` (D-101) — nunca o proprio usuario que pergunta.
 */
export function mapChannel(
  row: ChannelRow,
  viewerUserId: string,
  otherUserName: string | null = null,
): Channel {
  const isDm = row.kind === 'dm';
  const otherUserId = isDm
    ? (row.dm_user_a_id === viewerUserId ? row.dm_user_b_id : row.dm_user_a_id) ?? null
    : null;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    kind: isDm ? 'dm' : 'channel',
    // Derivado de `channel_reads` a cada leitura, nunca materializado
    // (D-068 / SCHEMA.md §17 — supera o `0` fixo de D-044).
    unreadCount: Number(row.unread_count ?? 0),
    lastReadAt: toIsoOrNull(row.last_read_at ?? null),
    lastMessageAt: toIsoOrNull(row.last_message_at),
    otherUserId,
    otherUserName: isDm ? otherUserName : null,
  };
}

/**
 * Resolve em LOTE o nome do outro participante de cada DM da lista (D-101) — uma
 * segunda consulta simples, em vez de complicar o `GROUP BY` de
 * `SELECT_CHANNEL_FOR_USER` com mais um join. Devolve um mapa `userId -> name`.
 */
async function resolveOtherUserNames(
  tx: DbTx,
  rows: ChannelRow[],
  viewerUserId: string,
): Promise<Map<string, string>> {
  const ids = rows
    .filter((row) => row.kind === 'dm')
    .map((row) => (row.dm_user_a_id === viewerUserId ? row.dm_user_b_id : row.dm_user_a_id))
    .filter((id): id is string => Boolean(id));
  if (ids.length === 0) return new Map();

  const result = await tx.query<{ id: string; name: string }>(
    'SELECT id, name FROM users WHERE id = ANY($1::uuid[])',
    [ids],
  );
  return new Map(result.rows.map((row) => [row.id, row.name]));
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
 *
 * `ch.dm_user_a_id`/`dm_user_b_id` entram no SELECT sem entrar no `GROUP BY`: sao
 * funcionalmente dependentes de `ch.id` (chave primaria de `internal_channels`, ja
 * agrupada), o Postgres aceita por essa dependencia funcional. O `WHERE` de
 * visibilidade (D-101) e o que torna uma DM invisivel/inacessivel para quem nao e
 * um dos dois participantes — canal comum (`kind = 'channel'`) continua publico
 * para todo mundo do tenant, como sempre foi.
 */
const SELECT_CHANNEL_FOR_USER = `
  SELECT ch.id, ch.key, ch.name, ch.kind, ch.dm_user_a_id, ch.dm_user_b_id,
         MAX(m.created_at) AS last_message_at,
         r.last_read_at,
         COUNT(*) FILTER (
           WHERE m.created_at > COALESCE(r.last_read_at, '-infinity'::timestamp)
             AND m.sender_id IS DISTINCT FROM $1::uuid
         )::int AS unread_count
    FROM internal_channels ch
    LEFT JOIN channel_reads r ON r.channel_id = ch.id AND r.user_id = $1::uuid
    LEFT JOIN internal_messages m ON m.channel_id = ch.id
   WHERE (ch.kind = 'channel' OR $1::uuid IN (ch.dm_user_a_id, ch.dm_user_b_id))`;

const GROUP_CHANNEL = 'GROUP BY ch.id, ch.key, ch.name, ch.kind, r.last_read_at';

export async function listChannels(tx: DbTx, userId: string): Promise<Channel[]> {
  const result = await tx.query<ChannelRow>(
    `${SELECT_CHANNEL_FOR_USER}
     ${GROUP_CHANNEL}
     ORDER BY ch.kind ASC, ch.key ASC`,
    [userId],
  );
  const otherNames = await resolveOtherUserNames(tx, result.rows, userId);
  return result.rows.map((row) => {
    if (row.kind !== 'dm') return mapChannel(row, userId, null);
    const otherId = row.dm_user_a_id === userId ? row.dm_user_b_id : row.dm_user_a_id;
    return mapChannel(row, userId, otherId ? (otherNames.get(otherId) ?? null) : null);
  });
}

export async function findChannelById(
  tx: DbTx,
  id: string,
  userId: string,
): Promise<Channel | null> {
  const result = await tx.query<ChannelRow>(
    `${SELECT_CHANNEL_FOR_USER}
      AND ch.id = $2
     ${GROUP_CHANNEL}`,
    [userId, id],
  );
  const row = result.rows[0];
  if (!row) return null;
  const otherNames = await resolveOtherUserNames(tx, [row], userId);
  const otherId =
    row.kind === 'dm'
      ? (row.dm_user_a_id === userId ? row.dm_user_b_id : row.dm_user_a_id) ?? null
      : null;
  return mapChannel(row, userId, otherId ? (otherNames.get(otherId) ?? null) : null);
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

/**
 * `viewerUserId` so importa para canal `kind = 'dm'` (resolve `otherUserId`); os
 * usos atuais (`ensureChannel`, canais fixos `#geral`/`#aprovacoes`) nunca passam
 * por uma DM, entao o valor default e inofensivo ali. `otherUserName` NAO e
 * resolvido aqui de proposito (chamador que precisar dele busca a parte — evita
 * uma query extra nos caminhos que so querem confirmar existencia do canal).
 */
export async function findChannelByKey(
  tx: DbTx,
  key: string,
  viewerUserId = '',
): Promise<Channel | null> {
  const result = await tx.query<ChannelRow>(
    `SELECT ch.id, ch.key, ch.name, ch.kind, ch.dm_user_a_id, ch.dm_user_b_id,
            NULL AS last_message_at
       FROM internal_channels ch WHERE ch.key = $1`,
    [key],
  );
  const row = result.rows[0];
  return row ? mapChannel(row, viewerUserId) : null;
}

/** Só cria canal comum (`kind = 'channel'`) — DM tem seu próprio `getOrCreateDirectChannel`. */
export async function insertChannel(
  tx: DbTx,
  input: { tenantId: string; key: string; name: string },
): Promise<Channel> {
  const result = await tx.query<ChannelRow>(
    `INSERT INTO internal_channels (tenant_id, key, name, kind)
     VALUES ($1, $2, $3, 'channel')
     RETURNING id, key, name, kind, dm_user_a_id, dm_user_b_id, NULL AS last_message_at`,
    [input.tenantId, input.key, input.name],
  );
  const row = result.rows[0];
  if (!row) throw new Error('INSERT em internal_channels nao retornou linha');
  return mapChannel(row, '');
}

export interface DirectoryUserRow {
  id: string;
  name: string;
  role: string;
}

/** `GET /internal-chat/users` (D-101): diretorio de quem da para abrir DM. */
export async function listDirectoryUsers(
  tx: DbTx,
  excludeUserId: string,
): Promise<ChatDirectoryUser[]> {
  const result = await tx.query<DirectoryUserRow>(
    `SELECT id, name, role FROM users
      WHERE is_active = true AND id <> $1
      ORDER BY name ASC`,
    [excludeUserId],
  );
  return result.rows.map((row) => ({ id: row.id, name: row.name, role: row.role as UserRole }));
}

/** Existencia + nome do destinatario de uma DM, antes de criar o canal (D-101). */
export async function findActiveUserById(
  tx: DbTx,
  id: string,
): Promise<{ id: string; name: string } | null> {
  const result = await tx.query<{ id: string; name: string }>(
    'SELECT id, name FROM users WHERE id = $1 AND is_active = true',
    [id],
  );
  return result.rows[0] ?? null;
}

/**
 * Get-or-create idempotente da DM entre dois usuarios (D-101). `ON CONFLICT (tenant_id,
 * key) DO NOTHING` seguido de fallback por `key` e o que evita duas linhas para o
 * mesmo par sem precisar de uma transacao com `SELECT ... FOR UPDATE` a mais.
 *
 * `otherUserName` chega pronto do chamador (que ja validou o destinatario com
 * `findActiveUserById` antes de chegar aqui) — evita mais uma query so pra repetir um
 * nome que quem chamou acabou de ler.
 */
export async function getOrCreateDirectChannel(
  tx: DbTx,
  input: {
    tenantId: string;
    key: string;
    name: string;
    dmUserAId: string;
    dmUserBId: string;
    viewerUserId: string;
    otherUserName: string;
  },
): Promise<Channel> {
  const inserted = await tx.query<ChannelRow>(
    `INSERT INTO internal_channels (tenant_id, key, name, kind, dm_user_a_id, dm_user_b_id)
     VALUES ($1, $2, $3, 'dm', $4, $5)
     ON CONFLICT (tenant_id, key) DO NOTHING
     RETURNING id, key, name, kind, dm_user_a_id, dm_user_b_id, NULL AS last_message_at`,
    [input.tenantId, input.key, input.name, input.dmUserAId, input.dmUserBId],
  );
  const insertedRow = inserted.rows[0];
  if (insertedRow) return mapChannel(insertedRow, input.viewerUserId, input.otherUserName);

  // Conflito: outra chamada (ou a mesma pessoa clicando duas vezes) ja criou a DM.
  const existing = await findChannelByKey(tx, input.key, input.viewerUserId);
  if (!existing) throw new Error('DM nao encontrada apos INSERT com conflito');
  return { ...existing, otherUserName: input.otherUserName };
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
