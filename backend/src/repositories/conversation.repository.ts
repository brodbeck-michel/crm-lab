/**
 * Acesso a dados de `conversations`. SEM regra de negocio (CONVENTIONS.md):
 * quem decide permissao, conflito de atribuicao e mensagem de sistema e o
 * `ConversationService`.
 *
 * Todo metodo abre `db.withTenant(tenantId, ...)` — camada 3 do isolamento
 * (SECURITY.md). Nenhum caminho usa `withoutTenant()`: conversa e dado de
 * laboratorio e o RLS falha fechado sem contexto de tenant.
 *
 * ---------------------------------------------------------------------------
 * BUSCA — a mesma expressao do indice
 * ---------------------------------------------------------------------------
 * A migracao 001 cria
 *
 *   CREATE INDEX idx_conversations_patient_name
 *     ON conversations USING GIN (to_tsvector('portuguese', COALESCE(patient_name, '')));
 *
 * Indice por EXPRESSAO so e usado quando a query repete a expressao carater a
 * carater. Por isso `SEARCH_NAME_EXPRESSION` existe como constante unica: se
 * alguem escrever `to_tsvector('portuguese', patient_name)` (sem o COALESCE) a
 * busca continua correta mas passa a varrer a tabela inteira.
 *
 * ---------------------------------------------------------------------------
 * COUNTS — derivados da MESMA query (BUSINESS_RULES §5)
 * ---------------------------------------------------------------------------
 * `counts.mine` e `counts.unassigned` sao os numeros dos chips de filtro da
 * tela de Atendimento. Eles saem de `COUNT(*) FILTER (...)` sobre exatamente o
 * mesmo `WHERE` da listagem — nunca de contador mantido a parte. Assim e
 * impossivel o chip dizer "Minhas 5" e a lista mostrar 4.
 */
import type {
  Conversation,
  ConversationChannel,
  ConversationDetail,
  ConversationStatus,
} from '@crm-lab/shared';
import type { DbClient, DbTx } from '../db/types.js';
import { upsertPatientByPhone } from './patient.repository.js';
import { toIso, toIsoOrNull, toNumber } from './row-mappers.js';

/** Colunas ordenaveis expostas na query string -> coluna real (whitelist). */
const SORTABLE_COLUMNS = {
  lastMessageAt: 'c.last_message_at',
  createdAt: 'c.created_at',
  unreadCount: 'c.unread_count',
  patientName: 'c.patient_name',
} as const;

export type ConversationSortBy = keyof typeof SORTABLE_COLUMNS;
export type SortOrder = 'asc' | 'desc';

export function isConversationSortBy(value: string): value is ConversationSortBy {
  return Object.prototype.hasOwnProperty.call(SORTABLE_COLUMNS, value);
}

/**
 * A expressao indexada por `idx_conversations_patient_name`. Precisa casar
 * literalmente com a da migracao 001 para o GIN ser usado.
 */
export const SEARCH_NAME_EXPRESSION = `to_tsvector('portuguese', COALESCE(c.patient_name, ''))`;

/** So digitos: o usuario digita "(11) 98765-4321", o banco guarda "+5511987654321". */
export function phoneDigits(value: string): string {
  return value.replace(/\D/g, '');
}

/** Normalizacao de telefone em SQL — precisa casar com `phoneDigits`. */
const phoneDigitsSql = (column: string): string => `regexp_replace(${column}, '[^0-9]', '', 'g')`;

interface ConversationRow {
  id: string;
  patient_id: string | null;
  patient_name: string | null;
  patient_phone: string;
  patient_email: string | null;
  assigned_to: string | null;
  assigned_to_name: string | null;
  channel: string | null;
  status: string;
  unread_count: number | string | null;
  last_message_at: Date | string | null;
  last_message_preview: string | null;
  tags: unknown;
  custom_fields: unknown;
  created_at: Date | string;
}

const LIST_COLUMNS = `c.id, c.patient_id, c.patient_name, c.patient_phone, c.patient_email, c.assigned_to,
       u.name AS assigned_to_name, c.channel, c.status, c.unread_count, c.last_message_at,
       c.tags, c.custom_fields, c.created_at, lm.content AS last_message_preview`;

/**
 * `LEFT JOIN LATERAL` traz a ultima mensagem em UMA passada. Sem isso a lista
 * de 20 conversas viraria 20 queries (N+1) so para a previa de 1 linha.
 */
const LIST_FROM = `FROM conversations c
     LEFT JOIN users u ON u.id = c.assigned_to
     LEFT JOIN LATERAL (
       SELECT m.content
       FROM messages m
       WHERE m.conversation_id = c.id
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT 1
     ) lm ON TRUE`;

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function toStringArray(value: unknown): string[] {
  const parsed = typeof value === 'string' ? safeJson(value) : value;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is string => typeof item === 'string');
}

function toStringRecord(value: unknown): Record<string, string> {
  const parsed = typeof value === 'string' ? safeJson(value) : value;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof item === 'string') out[key] = item;
    else if (typeof item === 'number' || typeof item === 'boolean') out[key] = String(item);
  }
  return out;
}

const CHANNELS: ConversationChannel[] = ['whatsapp', 'sms', 'web', 'direct'];
const STATUSES: ConversationStatus[] = ['active', 'archived', 'closed'];

function toChannel(value: string | null): ConversationChannel {
  return CHANNELS.includes(value as ConversationChannel)
    ? (value as ConversationChannel)
    : 'whatsapp';
}

function toStatus(value: string): ConversationStatus {
  return STATUSES.includes(value as ConversationStatus) ? (value as ConversationStatus) : 'active';
}

export function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    // Porta de entrada da Ficha do Paciente (D-079). `null` em conversa anterior
    // ao backfill da 003 que ainda nao passou por `findOrCreateByPhone` (D-072).
    patientId: row.patient_id,
    patientName: row.patient_name,
    patientPhone: row.patient_phone,
    assignedTo: row.assigned_to,
    assignedToName: row.assigned_to_name,
    channel: toChannel(row.channel),
    status: toStatus(row.status),
    unreadCount: toNumber(row.unread_count, 0),
    lastMessagePreview: row.last_message_preview,
    lastMessageAt: toIsoOrNull(row.last_message_at),
    tags: toStringArray(row.tags),
    createdAt: toIso(row.created_at),
  };
}

export function toConversationDetail(row: ConversationRow): ConversationDetail {
  return {
    ...toConversation(row),
    patientEmail: row.patient_email,
    customFields: toStringRecord(row.custom_fields),
  };
}

/** Recorte de visibilidade + filtros. O service traduz papel -> `visibleTo`. */
export interface ConversationListCriteria {
  /** `null` = ve todas (gestor/admin). String = so as proprias + as livres. */
  visibleTo: string | null;
  /** Usuario logado — origem de `counts.mine`. */
  userId: string;
  scope: 'mine' | 'unassigned' | 'all';
  status?: ConversationStatus;
  search?: string;
  page: number;
  limit: number;
  sortBy: ConversationSortBy;
  order: SortOrder;
}

export interface ConversationPage {
  rows: Conversation[];
  total: number;
  counts: { mine: number; unassigned: number };
}

export interface ConversationInsert {
  patientPhone: string;
  patientName?: string | null;
  patientEmail?: string | null;
  channel?: ConversationChannel;
}

interface CountRow {
  total: number | string;
  mine: number | string;
  unassigned: number | string;
}

export class ConversationRepository {
  constructor(private readonly db: DbClient) {}

  /**
   * Uma pagina + o total + os counts dos chips. TUDO do mesmo `WHERE`:
   * o COUNT usa os mesmos filtros e a mesma clausula de visibilidade da
   * listagem, e o recorte de escopo entra como `FILTER` — nunca como uma
   * segunda query com condicoes proprias.
   */
  async list(tenantId: string, criteria: ConversationListCriteria): Promise<ConversationPage> {
    const params: unknown[] = [];
    const where: string[] = [];

    // Visibilidade por papel: atendente ve as proprias + a fila livre.
    if (criteria.visibleTo !== null) {
      params.push(criteria.visibleTo);
      where.push(`(c.assigned_to = $${params.length} OR c.assigned_to IS NULL)`);
    }
    if (criteria.status !== undefined) {
      params.push(criteria.status);
      where.push(`c.status = $${params.length}`);
    }
    if (criteria.search !== undefined && criteria.search.length > 0) {
      const digits = phoneDigits(criteria.search);
      params.push(criteria.search);
      const term = `$${params.length}::text`;
      const clauses = [`${SEARCH_NAME_EXPRESSION} @@ plainto_tsquery('portuguese', ${term})`];
      if (digits.length >= 3) {
        params.push(`%${digits}%`);
        clauses.push(`${phoneDigitsSql('c.patient_phone')} LIKE $${params.length}`);
      }
      where.push(`(${clauses.join(' OR ')})`);
    }

    // Ate aqui `where` tem so os filtros comuns as duas queries (visibilidade,
    // status, busca). Os counts usam EXATAMENTE este recorte — e por isso que
    // o chip e a lista nao podem divergir.
    const countsWhereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const countsParams = [...params, criteria.userId];
    const me = `$${countsParams.length}`;

    // O escopo entra so na listagem (e, como FILTER, no `total`): o chip nao
    // clicado precisa continuar mostrando o proprio numero.
    if (criteria.scope === 'mine') {
      params.push(criteria.userId);
      where.push(`c.assigned_to = $${params.length}`);
    } else if (criteria.scope === 'unassigned') {
      where.push('c.assigned_to IS NULL');
    }
    const scopeCondition =
      criteria.scope === 'mine'
        ? `c.assigned_to = ${me}`
        : criteria.scope === 'unassigned'
          ? 'c.assigned_to IS NULL'
          : 'TRUE';

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const direction = criteria.order === 'desc' ? 'DESC' : 'ASC';
    const nulls = direction === 'DESC' ? 'NULLS LAST' : 'NULLS FIRST';
    // `id` como desempate: sem ele a paginacao pode repetir/pular linhas.
    const orderSql = `ORDER BY ${SORTABLE_COLUMNS[criteria.sortBy]} ${direction} ${nulls}, c.id ASC`;

    return this.db.withTenant(tenantId, async (tx) => {
      const counted = await tx.query<CountRow>(
        `SELECT COUNT(*) FILTER (WHERE ${scopeCondition})::int AS total,
                COUNT(*) FILTER (WHERE c.assigned_to = ${me})::int AS mine,
                COUNT(*) FILTER (WHERE c.assigned_to IS NULL)::int AS unassigned
         FROM conversations c ${countsWhereSql}`,
        countsParams,
      );
      const counts = counted.rows[0];

      const offset = (criteria.page - 1) * criteria.limit;
      const paged = await tx.query<ConversationRow>(
        `SELECT ${LIST_COLUMNS} ${LIST_FROM} ${whereSql} ${orderSql}
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, criteria.limit, offset],
      );

      return {
        rows: paged.rows.map(toConversation),
        total: toNumber(counts?.total, 0),
        counts: {
          mine: toNumber(counts?.mine, 0),
          unassigned: toNumber(counts?.unassigned, 0),
        },
      };
    });
  }

  /** `null` quando o id nao existe NESTE tenant — o service converte em 404. */
  async findById(tenantId: string, id: string): Promise<ConversationDetail | null> {
    return this.db.withTenant(tenantId, (tx) => selectDetail(tx, id));
  }

  async findByPhone(tenantId: string, phone: string): Promise<ConversationDetail | null> {
    return this.db.withTenant(tenantId, async (tx) => {
      const id = await selectIdByPhone(tx, phone);
      return id ? selectDetail(tx, id) : null;
    });
  }

  /**
   * Acha pelo telefone ou cria. Roda dentro de UMA transacao: entre o SELECT e
   * o INSERT nao ha janela para duas mensagens do mesmo paciente criarem duas
   * conversas.
   *
   * -------------------------------------------------------------------------
   * PACIENTE E CONVERSA NASCEM JUNTOS (D-059/D-072)
   * -------------------------------------------------------------------------
   * Antes desta mudanca so o backfill da migracao 003 preenchia
   * `conversations.patient_id`: toda conversa criada pelo webhook DEPOIS da
   * migracao ficava com `patient_id NULL` e o paciente nunca aparecia em
   * `/patients/:id`.
   *
   * A ligacao acontece na MESMA transacao que cria a conversa — por isso a
   * chamada e a `upsertPatientByPhone(tx, ...)` (funcao de repositorio sobre a
   * transacao aberta) e nao a `PatientService`/`PatientRepository`, que abririam
   * um segundo `withTenant`: transacao nao aninha e o driver de teste tem uma
   * conexao so (D-008). Mesmo caminho ja adotado em
   * `proposal.repository.findConversation`.
   *
   * Conversa PREEXISTENTE sem `patient_id` tambem e religada aqui: e o unico
   * ponto por onde o canal passa, e deixar a ligacao so no backfill repetiria o
   * bug para toda base migrada antes de um contato novo.
   */
  async findOrCreateByPhone(
    tenantId: string,
    data: ConversationInsert,
  ): Promise<{ conversation: ConversationDetail; created: boolean }> {
    return this.db.withTenant(tenantId, async (tx) => {
      const found = await selectByPhone(tx, data.patientPhone);
      if (found) {
        // O telefone do cadastro sai da PROPRIA conversa, nao do payload: a
        // busca casa por digitos ("+55 11 9..." acha "5511 9..."), e usar a
        // string crua do canal criaria um segundo paciente para o mesmo numero.
        const patient = await upsertPatientByPhone(
          tx,
          tenantId,
          found.patientPhone,
          data.patientName ?? null,
        );
        await tx.query(
          `UPDATE conversations SET patient_id = $1
            WHERE id = $2 AND patient_id IS DISTINCT FROM $1`,
          [patient.id, found.id],
        );
        const conversation = await selectDetail(tx, found.id);
        if (!conversation) throw new Error('conversa desapareceu dentro da transacao');
        return { conversation, created: false };
      }

      const patient = await upsertPatientByPhone(
        tx,
        tenantId,
        data.patientPhone,
        data.patientName ?? null,
      );

      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO conversations
           (tenant_id, patient_id, patient_phone, patient_name, patient_email, channel, status,
            unread_count, last_message_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'active', 0, NOW())
         RETURNING id`,
        [
          tenantId,
          patient.id,
          data.patientPhone,
          data.patientName ?? null,
          data.patientEmail ?? null,
          data.channel ?? 'whatsapp',
        ],
      );
      const id = inserted.rows[0]?.id;
      if (!id) throw new Error('INSERT em conversations nao retornou linha');
      const conversation = await selectDetail(tx, id);
      if (!conversation) throw new Error('conversa recem-criada nao pode ser lida');
      return { conversation, created: true };
    });
  }

  /**
   * Atribuicao ATOMICA da fila livre: `WHERE assigned_to IS NULL` faz o banco
   * decidir a corrida. Duas chamadas simultaneas -> a segunda afeta 0 linhas e
   * recebe `null`, que o service traduz em `CONVERSATION_ALREADY_ASSIGNED`.
   *
   * Mais robusto que lock otimista por `updated_at`: nao existe leitura previa
   * cujo valor possa envelhecer entre o SELECT e o UPDATE.
   */
  async claimIfUnassigned(
    tenantId: string,
    id: string,
    userId: string,
  ): Promise<ConversationDetail | null> {
    return this.db.withTenant(tenantId, async (tx) => {
      const updated = await tx.query<{ id: string }>(
        `UPDATE conversations SET assigned_to = $1, updated_at = NOW()
         WHERE id = $2 AND assigned_to IS NULL
         RETURNING id`,
        [userId, id],
      );
      const claimedId = updated.rows[0]?.id;
      return claimedId ? selectDetail(tx, claimedId) : null;
    });
  }

  /** Transferencia/liberacao: sobrescreve a atribuicao (o service ja autorizou). */
  async setAssignee(
    tenantId: string,
    id: string,
    userId: string | null,
  ): Promise<ConversationDetail | null> {
    return this.db.withTenant(tenantId, async (tx) => {
      const updated = await tx.query<{ id: string }>(
        `UPDATE conversations SET assigned_to = $1, updated_at = NOW()
         WHERE id = $2
         RETURNING id`,
        [userId, id],
      );
      const changedId = updated.rows[0]?.id;
      return changedId ? selectDetail(tx, changedId) : null;
    });
  }

  async setStatus(
    tenantId: string,
    id: string,
    status: ConversationStatus,
  ): Promise<ConversationDetail | null> {
    return this.db.withTenant(tenantId, async (tx) => {
      const updated = await tx.query<{ id: string }>(
        `UPDATE conversations SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING id`,
        [status, id],
      );
      const changedId = updated.rows[0]?.id;
      return changedId ? selectDetail(tx, changedId) : null;
    });
  }

  async setTags(tenantId: string, id: string, tags: string[]): Promise<ConversationDetail | null> {
    return this.db.withTenant(tenantId, async (tx) => {
      const updated = await tx.query<{ id: string }>(
        `UPDATE conversations SET tags = $1::jsonb, updated_at = NOW() WHERE id = $2 RETURNING id`,
        [JSON.stringify(tags), id],
      );
      const changedId = updated.rows[0]?.id;
      return changedId ? selectDetail(tx, changedId) : null;
    });
  }

  /**
   * Zera `unread_count` e marca as mensagens do PACIENTE como lidas.
   * Devolve quantas mensagens mudaram (0 quando ja estava tudo lido).
   */
  async markAsRead(tenantId: string, id: string): Promise<number> {
    return this.db.withTenant(tenantId, async (tx) => {
      await tx.query(`UPDATE conversations SET unread_count = 0, updated_at = NOW() WHERE id = $1`, [
        id,
      ]);
      const marked = await tx.query<{ id: string }>(
        `UPDATE messages SET status = 'read', read_at = NOW()
         WHERE conversation_id = $1 AND sender_type = 'patient' AND status <> 'read'
         RETURNING id`,
        [id],
      );
      return marked.rows.length;
    });
  }

  /** Existe neste tenant? Usado onde so o id importa. */
  async exists(tenantId: string, id: string): Promise<boolean> {
    return this.db.withTenant(tenantId, async (tx) => {
      const found = await tx.query<{ id: string }>(
        'SELECT id FROM conversations WHERE id = $1 LIMIT 1',
        [id],
      );
      return found.rows.length > 0;
    });
  }
}

async function selectByPhone(
  tx: DbTx,
  phone: string,
): Promise<{ id: string; patientPhone: string } | null> {
  const found = await tx.query<{ id: string; patient_phone: string }>(
    `SELECT id, patient_phone FROM conversations
     WHERE ${phoneDigitsSql('patient_phone')} = $1
     ORDER BY created_at DESC, id ASC
     LIMIT 1`,
    [phoneDigits(phone)],
  );
  const row = found.rows[0];
  return row ? { id: row.id, patientPhone: row.patient_phone } : null;
}

async function selectIdByPhone(tx: DbTx, phone: string): Promise<string | null> {
  return (await selectByPhone(tx, phone))?.id ?? null;
}

/** SELECT de uma conversa completa dentro de uma transacao ja com tenant. */
async function selectDetail(tx: DbTx, id: string): Promise<ConversationDetail | null> {
  const result = await tx.query<ConversationRow>(
    `SELECT ${LIST_COLUMNS} ${LIST_FROM} WHERE c.id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? toConversationDetail(row) : null;
}
