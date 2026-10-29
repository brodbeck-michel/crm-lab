/**
 * Acesso a dados de `internal_channels` e `internal_messages` (SERVICES.md §7).
 *
 * Como no resto do backend, todo metodo recebe um `DbTx`: o escopo
 * (`db.withTenant`) e do service. Chat interno e dado de laboratorio — nenhum
 * caminho aqui usa `withoutTenant()`.
 */
import type {
  Channel,
  ChatDirectoryUser,
  InternalChannelReader,
  InternalMessage,
  InternalMessageAttachment,
  UserRole,
} from '@crm-lab/shared';
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
  /** LEFT JOIN em `internal_message_attachments` (CRMLAB-101) — nulos sem anexo. */
  attachment_id: string | null;
  attachment_file_name: string | null;
  attachment_mime_type: string | null;
  attachment_byte_size: number | string | null;
  /** Migracao 058 (CRMLAB-117, D-282). */
  edited_at: unknown;
  deleted_at: unknown;
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

/**
 * Apagada pela autora (D-282, como D-220): a linha fica, mas o conteudo, o anexo
 * e a proposta NUNCA saem na API — a tela mostra "Mensagem apagada".
 */
export function mapMessage(row: MessageRow): InternalMessage {
  const deleted = row.deleted_at !== null && row.deleted_at !== undefined;
  return {
    id: row.id,
    channelId: row.channel_id,
    senderId: row.sender_id,
    senderName: row.is_system ? 'Sistema' : (row.sender_name ?? 'Usuario removido'),
    content: deleted ? '' : row.content,
    attachedProposalId: deleted ? null : row.attached_proposal_id,
    attachment: !deleted && row.attachment_id
      ? attachmentOf(row.channel_id, {
          id: row.attachment_id,
          fileName: row.attachment_file_name ?? '',
          mimeType: row.attachment_mime_type ?? '',
          byteSize: Number(row.attachment_byte_size ?? 0),
        })
      : null,
    isSystem: row.is_system,
    createdAt: toIso(row.created_at),
    editedAt: deleted ? null : toIsoOrNull(row.edited_at),
    deletedAt: toIsoOrNull(row.deleted_at),
  };
}

/** URL de download (D-271) — derivada, nunca gravada. */
export function attachmentUrl(channelId: string, attachmentId: string): string {
  return `/api/v1/internal-chat/channels/${channelId}/attachments/${attachmentId}`;
}

function attachmentOf(
  channelId: string,
  data: Omit<InternalMessageAttachment, 'url'>,
): InternalMessageAttachment {
  return { ...data, url: attachmentUrl(channelId, data.id) };
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
 * Apagada pela autora (`deleted_at`, D-282) nao conta: quem nao leu a tempo
 * nao fica com um badge apontando para "Mensagem apagada".
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
             AND m.deleted_at IS NULL
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
export interface MarkChannelReadOutcome {
  /** A leitura passou de mensagem de OUTRA pessoa (nao apagada) — D-301. */
  advanced: boolean;
  /** `created_at` da mensagem mais recente ate esta leitura (mesma regra de `listChannelReaders`). */
  readUpTo: string | null;
  /** O `last_read_at` gravado agora. */
  lastReadAt: string;
}

export async function markChannelRead(
  tx: DbTx,
  input: { tenantId: string; channelId: string; userId: string },
): Promise<MarkChannelReadOutcome> {
  // CRMLAB-123 (D-301): no MESMO comando, diz se a leitura passou de alguma
  // mensagem de OUTRA pessoa (nao apagada) — so entao o ✓✓ de alguem pode virar
  // e vale avisar por WS — e devolve o "lido ate" desta pessoa, que vai no
  // payload do evento (a tela atualiza o cache sem refazer GET). Todas as CTEs
  // veem o mesmo snapshot: `previous` e a leitura de ANTES do upsert.
  const result = await tx.query<{ advanced: boolean; read_up_to: unknown; last_read_at: unknown }>(
    `WITH previous AS (
       SELECT last_read_at FROM channel_reads
        WHERE tenant_id = $1 AND channel_id = $2 AND user_id = $3
     ), upsert AS (
       INSERT INTO channel_reads (tenant_id, channel_id, user_id, last_read_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (channel_id, user_id) DO UPDATE SET last_read_at = NOW()
       RETURNING last_read_at
     )
     SELECT u.last_read_at,
            EXISTS (
              SELECT 1 FROM internal_messages m
               WHERE m.tenant_id = $1 AND m.channel_id = $2
                 AND m.sender_id IS NOT NULL AND m.sender_id <> $3
                 AND m.deleted_at IS NULL
                 AND m.created_at > COALESCE((SELECT last_read_at FROM previous), '-infinity'::timestamp)
                 AND m.created_at <= u.last_read_at
            ) AS advanced,
            (SELECT MAX(m.created_at) FROM internal_messages m
              WHERE m.tenant_id = $1 AND m.channel_id = $2
                AND m.created_at <= u.last_read_at) AS read_up_to
       FROM upsert u`,
    [input.tenantId, input.channelId, input.userId],
  );
  const row = result.rows[0];
  return {
    advanced: row?.advanced === true,
    readUpTo: toIsoOrNull(row?.read_up_to),
    lastReadAt: toIso(row?.last_read_at),
  };
}

interface ReaderRow {
  user_id: string;
  name: string;
  last_read_at: unknown;
  read_up_to: unknown;
}

/**
 * Leitura dos OUTROS membros do canal (CRMLAB-123, D-300) — UMA consulta por
 * canal, nunca por mensagem. `read_up_to` e o `created_at` da mensagem mais
 * recente ate a leitura da pessoa: a comparacao de horario acontece aqui, entre
 * duas colunas `TIMESTAMP` do banco, e a tela so compara valores da MESMA coluna
 * (`internal_messages.created_at`) passados pelo MESMO `toIso`. O `MAX` com
 * `<=` desce pelo indice `(channel_id, created_at DESC)`.
 *
 * Membros: DM = o outro participante (mesmo inativo — e uma conversa a dois);
 * canal = usuarios ATIVOS do tenant, sem `platform_operator` (D-300).
 */
export async function listChannelReaders(
  tx: DbTx,
  input: { tenantId: string; channel: Pick<Channel, 'id' | 'kind' | 'otherUserId'>; viewerUserId: string },
): Promise<InternalChannelReader[]> {
  const { channel } = input;
  if (channel.kind === 'dm' && !channel.otherUserId) return [];
  const membership =
    channel.kind === 'dm'
      ? 'u.id = $4::uuid'
      : "u.is_active = true AND u.role <> 'platform_operator'";
  const params: unknown[] = [input.tenantId, channel.id, input.viewerUserId];
  if (channel.kind === 'dm') params.push(channel.otherUserId);

  const result = await tx.query<ReaderRow>(
    `SELECT u.id AS user_id, u.name, r.last_read_at,
            (SELECT MAX(m.created_at) FROM internal_messages m
              WHERE m.tenant_id = $1 AND m.channel_id = $2
                AND m.created_at <= r.last_read_at) AS read_up_to
       FROM users u
       LEFT JOIN channel_reads r
              ON r.tenant_id = $1 AND r.channel_id = $2 AND r.user_id = u.id
      WHERE u.tenant_id = $1 AND u.id <> $3::uuid AND ${membership}
      ORDER BY u.name ASC, u.id ASC`,
    params,
  );
  return result.rows.map((row) => ({
    userId: row.user_id,
    name: row.name,
    readUpTo: toIsoOrNull(row.read_up_to),
    lastReadAt: toIsoOrNull(row.last_read_at),
  }));
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
         m.attached_proposal_id, m.is_system, m.created_at, m.edited_at, m.deleted_at,
         a.id AS attachment_id, a.file_name AS attachment_file_name,
         a.mime_type AS attachment_mime_type, a.byte_size AS attachment_byte_size
    FROM internal_messages m
    LEFT JOIN users u ON u.id = m.sender_id
    LEFT JOIN internal_message_attachments a ON a.message_id = m.id`;

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

/**
 * Linha do anexo (CRMLAB-101, D-271). Chamado na MESMA transacao que inseriu a
 * mensagem; o `id` devolvido e o nome do arquivo em disco.
 */
export async function insertAttachment(
  tx: DbTx,
  input: { tenantId: string; messageId: string; mimeType: string; fileName: string; byteSize: number },
): Promise<string> {
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO internal_message_attachments (tenant_id, message_id, mime_type, file_name, byte_size)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [input.tenantId, input.messageId, input.mimeType, input.fileName, input.byteSize],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw new Error('INSERT em internal_message_attachments nao retornou linha');
  return id;
}

/**
 * Anexo de uma mensagem DESTE canal (D-271). Anexo de outro canal devolve
 * `null` — quem chama ja conferiu o acesso ao canal, e este filtro impede
 * baixar o anexo de uma DM alheia trocando so o `:id` da URL.
 * Mensagem apagada pela autora (D-282) tambem: o arquivo fica no disco, mas
 * nao sai mais pela API.
 */
export async function findAttachment(
  tx: DbTx,
  channelId: string,
  attachmentId: string,
): Promise<{ id: string; mimeType: string; fileName: string } | null> {
  const result = await tx.query<{ id: string; mime_type: string; file_name: string }>(
    `SELECT a.id, a.mime_type, a.file_name
       FROM internal_message_attachments a
       JOIN internal_messages m ON m.id = a.message_id
      WHERE a.id = $1 AND m.channel_id = $2 AND m.deleted_at IS NULL`,
    [attachmentId, channelId],
  );
  const row = result.rows[0];
  return row ? { id: row.id, mimeType: row.mime_type, fileName: row.file_name } : null;
}

/**
 * Trava a linha da mensagem ate o fim da transacao (D-282): editar e apagar
 * concorrentes da mesma autora nao se cruzam (a segunda ve o estado novo).
 */
export async function lockMessage(tx: DbTx, id: string): Promise<void> {
  await tx.query('SELECT id FROM internal_messages WHERE id = $1 FOR UPDATE', [id]);
}

/**
 * Edicao da autora (D-282): guarda a versao ANTERIOR em `internal_message_edits`
 * e troca o texto, na mesma transacao. Apagada nao edita (`null`).
 */
export async function applyEdit(
  tx: DbTx,
  input: { tenantId: string; messageId: string; content: string; editedBy: string },
): Promise<{ editId: string; editedAt: string } | null> {
  const edit = await tx.query<{ id: string }>(
    `INSERT INTO internal_message_edits (tenant_id, message_id, previous_content, edited_by)
     SELECT $1, id, content, $3 FROM internal_messages
      WHERE id = $2 AND deleted_at IS NULL
     RETURNING id`,
    [input.tenantId, input.messageId, input.editedBy],
  );
  const editId = edit.rows[0]?.id;
  if (!editId) return null;
  const updated = await tx.query<{ edited_at: unknown }>(
    `UPDATE internal_messages SET content = $2, edited_at = now()
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING edited_at`,
    [input.messageId, input.content],
  );
  const row = updated.rows[0];
  if (!row) return null;
  return { editId, editedAt: toIso(row.edited_at) };
}

/** "Apagar para todos" (D-282): ESCONDE, nunca apaga. `null` = ja estava apagada. */
export async function markDeleted(tx: DbTx, messageId: string): Promise<string | null> {
  const result = await tx.query<{ deleted_at: unknown }>(
    `UPDATE internal_messages SET deleted_at = now()
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING deleted_at`,
    [messageId],
  );
  const row = result.rows[0];
  return row ? toIso(row.deleted_at) : null;
}
