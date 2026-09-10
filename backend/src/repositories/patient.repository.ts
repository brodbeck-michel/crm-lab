/**
 * Acesso a dados de `patients` (SCHEMA.md §14) e da coluna
 * `conversations.patient_id` (D-059). SEM regra de negocio (CONVENTIONS.md):
 * quem decide papel, alcada e conflito e o `PatientService`.
 *
 * Todo metodo abre `db.withTenant(tenantId, ...)` — camada 3 do isolamento
 * (SECURITY.md). Nenhum caminho usa `withoutTenant()`: paciente e dado de
 * laboratorio e o RLS falha fechado sem contexto de tenant.
 *
 * ---------------------------------------------------------------------------
 * DATAS — formatadas como UTC no SQL (D-021)
 * ---------------------------------------------------------------------------
 * As colunas sao `TIMESTAMP` SEM timezone guardando UTC. Devolvidas cruas, o
 * driver as interpreta no fuso da maquina — numa maquina em UTC-3 a timeline
 * sairia com 3 horas a menos e a ordenacao "por dia" mentiria. Por isso todo
 * timestamp que atravessa para o JavaScript passa por `isoUtc()`, e toda
 * comparacao/ordenacao acontece DENTRO do banco, sobre a coluna crua.
 *
 * ---------------------------------------------------------------------------
 * BUSCA — a mesma expressao do indice
 * ---------------------------------------------------------------------------
 * A migracao 003 cria
 *
 *   CREATE INDEX idx_patients_name
 *     ON patients USING GIN (to_tsvector('portuguese', COALESCE(name, '')));
 *
 * Indice por EXPRESSAO so e usado quando a query repete a expressao carater a
 * carater — dai `SEARCH_NAME_EXPRESSION` existir como constante unica.
 *
 * ---------------------------------------------------------------------------
 * RECORTE POR PAPEL (D-060) — `visibleTo`
 * ---------------------------------------------------------------------------
 * `visibleTo = null` -> gestor/admin: enxerga tudo do laboratorio.
 * `visibleTo = <userId>` -> atendente: so pacientes com AO MENOS UMA conversa
 * atribuida a ele ou na fila livre; e os contadores/timeline usam EXATAMENTE o
 * mesmo recorte — senao a ficha viraria caminho lateral para ler a conversa de
 * outro atendente.
 *
 * Nenhum metodo devolve `SELECT *` ao service: projecao explicita, sempre.
 */
import type {
  ConversationChannel,
  MessageType,
  Patient,
  PatientDetail,
  PatientExport,
  PatientListItem,
  PatientTimelineEntry,
  PatientTimelineKind,
  ProposalStatus,
  SenderType,
} from '@crm-lab/shared';
import type { DbClient, DbTx } from '../db/types.js';
import { eraseEntityValues } from './audit.repository.js';
import { toNumber } from './row-mappers.js';

/** Timestamp -> ISO 8601 UTC dentro do SQL (D-021). */
const isoUtc = (column: string): string =>
  `to_char(${column}, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/** Expressao indexada por `idx_patients_name` (migracao 003). */
export const SEARCH_NAME_EXPRESSION = `to_tsvector('portuguese', COALESCE(p.name, ''))`;

/** So digitos — o usuario digita "(11) 98765-4321", o banco guarda o que o canal mandou. */
export function phoneDigits(value: string): string {
  return value.replace(/\D/g, '');
}

const phoneDigitsSql = (column: string): string => `regexp_replace(${column}, '[^0-9]', '', 'g')`;

/** Placeholder de anonimizacao (D-063) — preserva NOT NULL e a unicidade. */
const ANON_PHONE_SQL = `'anon-' || substring(id::text, 1, 8)`;

/** Colunas ordenaveis expostas na query string -> expressao real (whitelist). */
const SORTABLE_COLUMNS = {
  name: 'p.name',
  lastInteractionAt: 'ci.last_interaction_at',
  createdAt: 'p.created_at',
  updatedAt: 'p.updated_at',
} as const;

export type PatientSortBy = keyof typeof SORTABLE_COLUMNS;
export type SortOrder = 'asc' | 'desc';

export function isPatientSortBy(value: string): value is PatientSortBy {
  return Object.prototype.hasOwnProperty.call(SORTABLE_COLUMNS, value);
}

/** Colunas do cadastro. `birth_date` e DATE pura — nunca vira timestamp. */
const PATIENT_COLUMNS = `p.id, p.phone, p.name, p.email,
       to_char(p.birth_date, 'YYYY-MM-DD') AS birth_date,
       p.document, p.notes, p.tags, p.custom_fields,
       ${isoUtc('p.anonymized_at')} AS anonymized_at,
       ${isoUtc('p.created_at')} AS created_at,
       ${isoUtc('p.updated_at')} AS updated_at`;

interface PatientRow {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  birth_date: string | null;
  document: string | null;
  notes: string | null;
  tags: unknown;
  custom_fields: unknown;
  anonymized_at: string | null;
  created_at: string;
  updated_at: string;
}

interface PatientListRow extends PatientRow {
  last_interaction_at: string | null;
}

interface PatientDetailRow extends PatientListRow {
  conversation_count: number | string | null;
  proposal_count: number | string | null;
}

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

export function toPatient(row: PatientRow): Patient {
  return {
    id: row.id,
    phone: row.phone,
    name: row.name,
    email: row.email,
    birthDate: row.birth_date,
    document: row.document,
    notes: row.notes,
    tags: toStringArray(row.tags),
    customFields: toStringRecord(row.custom_fields),
    anonymizedAt: row.anonymized_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toListItem(row: PatientListRow): PatientListItem {
  return { ...toPatient(row), lastInteractionAt: row.last_interaction_at };
}

function toDetail(row: PatientDetailRow): PatientDetail {
  return {
    ...toPatient(row),
    conversationCount: toNumber(row.conversation_count, 0),
    proposalCount: toNumber(row.proposal_count, 0),
    lastInteractionAt: row.last_interaction_at,
  };
}

const CHANNELS: ConversationChannel[] = ['whatsapp', 'sms', 'web', 'direct'];
const SENDER_TYPES: SenderType[] = ['patient', 'agent', 'system'];
const MESSAGE_TYPES: MessageType[] = ['text', 'image', 'audio', 'pdf', 'doc'];
const PROPOSAL_STATUSES: ProposalStatus[] = [
  'novo_contato',
  'orcamento_enviado',
  'follow_up',
  'negociacao',
  'ganho',
  'perdido',
];

function toChannel(value: string | null): ConversationChannel {
  return CHANNELS.includes(value as ConversationChannel)
    ? (value as ConversationChannel)
    : 'whatsapp';
}

function toSenderType(value: string | null): SenderType {
  return SENDER_TYPES.includes(value as SenderType) ? (value as SenderType) : 'system';
}

function toMessageType(value: string | null): MessageType {
  return MESSAGE_TYPES.includes(value as MessageType) ? (value as MessageType) : 'text';
}

function toProposalStatus(value: string | null): ProposalStatus {
  return PROPOSAL_STATUSES.includes(value as ProposalStatus)
    ? (value as ProposalStatus)
    : 'novo_contato';
}

/** Recorte de visibilidade resolvido pelo service (papel -> `visibleTo`). */
export interface PatientVisibility {
  /** `null` = gestor/admin (ve tudo). String = atendente (id do usuario). */
  visibleTo: string | null;
}

export interface PatientListCriteria extends PatientVisibility {
  search?: string;
  page: number;
  limit: number;
  sortBy: PatientSortBy;
  order: SortOrder;
}

export interface PatientPage {
  rows: PatientListItem[];
  total: number;
}

export interface PatientTimelineCriteria extends PatientVisibility {
  kind?: PatientTimelineKind;
  page: number;
  limit: number;
  order: SortOrder;
}

export interface PatientTimelinePage {
  entries: PatientTimelineEntry[];
  total: number;
}

/** Campos aceitos por `PATCH /patients/:id` (ja normalizados pelo service). */
export interface PatientUpdate {
  /** D-106: nunca `null` — apagar telefone deixaria o paciente sem chave de dedupe. */
  phone?: string;
  name?: string | null;
  email?: string | null;
  birthDate?: string | null;
  document?: string | null;
  notes?: string | null;
  tags?: string[];
  customFields?: Record<string, string>;
}

/** Coluna real de cada campo do PATCH — whitelist: nada e interpolado do cliente. */
const UPDATABLE_COLUMNS: Record<keyof PatientUpdate, { column: string; cast?: string }> = {
  phone: { column: 'phone' },
  name: { column: 'name' },
  email: { column: 'email' },
  birthDate: { column: 'birth_date', cast: '::date' },
  document: { column: 'document' },
  notes: { column: 'notes' },
  tags: { column: 'tags', cast: '::jsonb' },
  customFields: { column: 'custom_fields', cast: '::jsonb' },
};

/** SQLSTATE de violacao de unicidade — o service converte em `CONFLICT` (D-106). */
export const UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const candidate = err as { code?: unknown; cause?: unknown };
  if (candidate.code === UNIQUE_VIOLATION) return true;
  // PGlite embrulha o erro do servidor em `cause` em alguns caminhos.
  return isUniqueViolation(candidate.cause);
}

interface TimelineRow {
  entry_id: string;
  kind: string;
  at: string;
  conversation_id: string | null;
  channel: string | null;
  sender_type: string | null;
  sender_name: string | null;
  message_type: string | null;
  preview: string | null;
  proposal_id: string | null;
  status: string | null;
  discount_percent: number | string | null;
  total_price: number | string | null;
  created_by_name: string | null;
  from_status: string | null;
  to_status: string | null;
  changed_by_name: string | null;
}

function toTimelineEntry(row: TimelineRow): PatientTimelineEntry {
  switch (row.kind) {
    case 'message':
      return {
        id: row.entry_id,
        kind: 'message',
        at: row.at,
        conversationId: row.conversation_id ?? '',
        senderType: toSenderType(row.sender_type),
        senderName: row.sender_name,
        messageType: toMessageType(row.message_type),
        preview: row.preview ?? '',
      };
    case 'proposal_created':
      return {
        id: row.entry_id,
        kind: 'proposal_created',
        at: row.at,
        proposalId: row.proposal_id ?? '',
        status: toProposalStatus(row.status),
        discountPercent: toNumber(row.discount_percent, 0),
        totalPrice: toNumber(row.total_price, 0),
        createdByName: row.created_by_name ?? '',
      };
    case 'proposal_stage_changed':
      return {
        id: row.entry_id,
        kind: 'proposal_stage_changed',
        at: row.at,
        proposalId: row.proposal_id ?? '',
        // `null` na primeira linha do historico (a criacao em `novo_contato`).
        from: row.from_status === null ? null : toProposalStatus(row.from_status),
        to: toProposalStatus(row.to_status),
        changedByName: row.changed_by_name,
      };
    default:
      return {
        id: row.entry_id,
        kind: 'conversation_started',
        at: row.at,
        conversationId: row.conversation_id ?? '',
        channel: toChannel(row.channel),
      };
  }
}

/**
 * Acumulador de parametros posicionais. Existe para que nenhuma query monte
 * `$N` na mao — trocar a ordem de um filtro nao pode desalinhar os binds.
 */
class Params {
  private readonly values: unknown[] = [];

  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }

  all(): unknown[] {
    return [...this.values];
  }
}

export class PatientRepository {
  constructor(private readonly db: DbClient) {}

  /**
   * Uma pagina + o total. `lastInteractionAt` e `conversation_count` saem do
   * MESMO `LATERAL` que aplica o recorte por papel — nunca de coluna
   * materializada (BUSINESS_RULES §5).
   */
  async list(tenantId: string, criteria: PatientListCriteria): Promise<PatientPage> {
    const params = new Params();
    const conversationsCte = conversationAggregate(params, criteria.visibleTo);
    const where: string[] = [];

    // Atendente so enxerga paciente com ao menos uma conversa visivel a ele.
    if (criteria.visibleTo !== null) where.push('ci.conversation_count > 0');

    if (criteria.search !== undefined && criteria.search.length > 0) {
      const digits = phoneDigits(criteria.search);
      const term = `${params.add(criteria.search)}::text`;
      const clauses = [`${SEARCH_NAME_EXPRESSION} @@ plainto_tsquery('portuguese', ${term})`];
      if (digits.length >= 3) {
        clauses.push(`${phoneDigitsSql('p.phone')} LIKE ${params.add(`%${digits}%`)}`);
        clauses.push(`p.document LIKE ${params.add(`${digits}%`)}`);
      }
      where.push(`(${clauses.join(' OR ')})`);
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const from = `FROM patients p LEFT JOIN LATERAL (${conversationsCte}) ci ON TRUE ${whereSql}`;

    const direction = criteria.order === 'asc' ? 'ASC' : 'DESC';
    const nulls = direction === 'DESC' ? 'NULLS LAST' : 'NULLS FIRST';
    // `p.id` como desempate: sem ele a paginacao pode repetir/pular linhas.
    const orderSql = `ORDER BY ${SORTABLE_COLUMNS[criteria.sortBy]} ${direction} ${nulls}, p.id ASC`;

    const listParams = params.all();
    const offset = (criteria.page - 1) * criteria.limit;

    return this.db.withTenant(tenantId, async (tx) => {
      const counted = await tx.query<{ total: number | string }>(
        `SELECT COUNT(*)::int AS total ${from}`,
        listParams,
      );
      const paged = await tx.query<PatientListRow>(
        `SELECT ${PATIENT_COLUMNS}, ${isoUtc('ci.last_interaction_at')} AS last_interaction_at
         ${from} ${orderSql}
         LIMIT $${listParams.length + 1} OFFSET $${listParams.length + 2}`,
        [...listParams, criteria.limit, offset],
      );
      return {
        rows: paged.rows.map(toListItem),
        total: toNumber(counted.rows[0]?.total, 0),
      };
    });
  }

  /**
   * Cadastro + contadores no recorte de quem pergunta. `null` quando o id nao
   * existe NESTE tenant ou esta fora da visibilidade — o service converte os
   * dois casos no MESMO 404 (CLAUDE.md regra 8).
   */
  async findDetail(
    tenantId: string,
    id: string,
    visibility: PatientVisibility,
  ): Promise<PatientDetail | null> {
    return this.db.withTenant(tenantId, (tx) => selectDetail(tx, id, visibility));
  }

  /**
   * Existe neste tenant? Usado pelos caminhos de LGPD, que sao `admin` e
   * ignoram o recorte por papel (D-062) mas continuam presos ao tenant.
   */
  async findAnyById(tenantId: string, id: string): Promise<Patient | null> {
    return this.db.withTenant(tenantId, async (tx) => {
      const found = await tx.query<PatientRow>(
        `SELECT ${PATIENT_COLUMNS} FROM patients p WHERE p.id = $1`,
        [id],
      );
      const row = found.rows[0];
      return row ? toPatient(row) : null;
    });
  }

  /**
   * Aplica o PATCH e devolve a ficha ja no recorte do solicitante.
   * `undefined` (campo ausente) preserva; `null` apaga — a semantica do
   * contrato mora aqui, no `UPDATE ... SET` montado so com os campos enviados.
   *
   * NAO toca em `conversations.patient_name/phone/email` (D-059): elas sao o
   * registro do que o canal informou, nao o cadastro.
   */
  async update(
    tenantId: string,
    id: string,
    patch: PatientUpdate,
    visibility: PatientVisibility,
  ): Promise<PatientDetail | null> {
    const assignments: string[] = [];
    const values: unknown[] = [];

    for (const [field, spec] of Object.entries(UPDATABLE_COLUMNS)) {
      const key = field as keyof PatientUpdate;
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
      const raw = patch[key];
      const value =
        key === 'tags' || key === 'customFields'
          ? raw === undefined || raw === null
            ? null
            : JSON.stringify(raw)
          : (raw ?? null);
      values.push(value);
      assignments.push(`${spec.column} = $${values.length}${spec.cast ?? ''}`);
    }
    if (assignments.length === 0) return this.findDetail(tenantId, id, visibility);

    return this.db.withTenant(tenantId, async (tx) => {
      const updated = await tx.query<{ id: string }>(
        `UPDATE patients SET ${assignments.join(', ')} WHERE id = $${values.length + 1}
         RETURNING id`,
        [...values, id],
      );
      if (updated.rows.length === 0) return null;
      return selectDetail(tx, id, visibility);
    });
  }

  /**
   * Timeline: uniao das QUATRO origens numa unica query paginada. Fazer quatro
   * consultas e juntar em memoria daria `total` errado e paginacao instavel —
   * a pagina 2 nao existe fora do conjunto ordenado.
   */
  async timeline(
    tenantId: string,
    id: string,
    criteria: PatientTimelineCriteria,
  ): Promise<PatientTimelinePage> {
    const params = new Params();
    const patientParam = params.add(id);
    const cte = timelineCte(params, patientParam, criteria.visibleTo);

    const where: string[] = [];
    if (criteria.kind !== undefined) where.push(`e.kind = ${params.add(criteria.kind)}`);
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const direction = criteria.order === 'asc' ? 'ASC' : 'DESC';
    // `at` cru (nao formatado) na ordenacao: comparacao acontece no banco (D-021).
    const orderSql = `ORDER BY e.at ${direction}, e.entry_id ${direction}`;

    const baseParams = params.all();
    const offset = (criteria.page - 1) * criteria.limit;

    return this.db.withTenant(tenantId, async (tx) => {
      const counted = await tx.query<{ total: number | string }>(
        `${cte} SELECT COUNT(*)::int AS total FROM entries e ${whereSql}`,
        baseParams,
      );
      const paged = await tx.query<TimelineRow>(
        `${cte}
         SELECT e.entry_id, e.kind, ${isoUtc('e.at')} AS at, e.conversation_id, e.channel,
                e.sender_type, e.sender_name, e.message_type, e.preview, e.proposal_id,
                e.status, e.discount_percent, e.total_price, e.created_by_name,
                e.from_status, e.to_status, e.changed_by_name
         FROM entries e ${whereSql} ${orderSql}
         LIMIT $${baseParams.length + 1} OFFSET $${baseParams.length + 2}`,
        [...baseParams, criteria.limit, offset],
      );
      return {
        entries: paged.rows.map(toTimelineEntry),
        total: toNumber(counted.rows[0]?.total, 0),
      };
    });
  }

  /**
   * Dump LGPD (D-062): TUDO do titular no tenant, sem recorte por papel.
   * As tres leituras rodam na mesma transacao — um export nao pode misturar
   * dois instantes do banco.
   */
  async exportData(tenantId: string, patient: Patient): Promise<PatientExport> {
    return this.db.withTenant(tenantId, async (tx) => {
      const conversations = await tx.query<{
        id: string;
        channel: string | null;
        status: string;
        created_at: string;
      }>(
        `SELECT c.id, c.channel, c.status, ${isoUtc('c.created_at')} AS created_at
         FROM conversations c WHERE c.patient_id = $1
         ORDER BY c.created_at ASC, c.id ASC`,
        [patient.id],
      );

      const messages = await tx.query<{
        id: string;
        conversation_id: string;
        sender_type: string;
        sender_name: string | null;
        content: string;
        message_type: string | null;
        created_at: string;
      }>(
        `SELECT m.id, m.conversation_id, m.sender_type, m.content, m.message_type,
                ${isoUtc('m.created_at')} AS created_at,
                CASE
                  WHEN m.sender_type = 'agent' THEN u.name
                  WHEN m.sender_type = 'patient' THEN c.patient_name
                  ELSE NULL
                END AS sender_name
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         LEFT JOIN users u ON u.id = m.sender_id
         WHERE c.patient_id = $1
         ORDER BY m.created_at ASC, m.id ASC`,
        [patient.id],
      );

      // `approvalStatus`, alcada e quem aprovou NAO entram: sao dado do
      // laboratorio, nao do titular (D-062).
      const proposals = await tx.query<{
        id: string;
        status: string;
        discount_percent: number | string;
        total_price: number | string;
        created_at: string;
      }>(
        `SELECT pr.id, pr.status, pr.discount_percent, pr.total_price,
                ${isoUtc('pr.created_at')} AS created_at
         FROM proposals pr
         JOIN conversations c ON c.id = pr.conversation_id
         WHERE c.patient_id = $1
         ORDER BY pr.created_at ASC, pr.id ASC`,
        [patient.id],
      );

      const items = await tx.query<{
        proposal_id: string;
        exam_name: string;
        quantity: number | string | null;
        unit_price: number | string;
      }>(
        `SELECT pi.proposal_id, pi.exam_name, pi.quantity, pi.unit_price
         FROM proposal_items pi
         JOIN proposals pr ON pr.id = pi.proposal_id
         JOIN conversations c ON c.id = pr.conversation_id
         WHERE c.patient_id = $1
         ORDER BY pi."position" ASC, pi.created_at ASC`,
        [patient.id],
      );

      const messagesByConversation = new Map<string, PatientExport['conversations'][number]['messages']>();
      for (const row of messages.rows) {
        const bucket = messagesByConversation.get(row.conversation_id) ?? [];
        bucket.push({
          id: row.id,
          senderType: toSenderType(row.sender_type),
          senderName: row.sender_name,
          content: row.content,
          messageType: toMessageType(row.message_type),
          createdAt: row.created_at,
        });
        messagesByConversation.set(row.conversation_id, bucket);
      }

      const itemsByProposal = new Map<string, PatientExport['proposals'][number]['items']>();
      for (const row of items.rows) {
        const bucket = itemsByProposal.get(row.proposal_id) ?? [];
        bucket.push({
          examName: row.exam_name,
          quantity: toNumber(row.quantity, 1),
          unitPrice: toNumber(row.unit_price, 0),
        });
        itemsByProposal.set(row.proposal_id, bucket);
      }

      return {
        generatedAt: new Date().toISOString(),
        patient,
        conversations: conversations.rows.map((row) => ({
          id: row.id,
          channel: toChannel(row.channel),
          status: row.status,
          createdAt: row.created_at,
          messages: messagesByConversation.get(row.id) ?? [],
        })),
        proposals: proposals.rows.map((row) => ({
          id: row.id,
          status: toProposalStatus(row.status),
          discountPercent: toNumber(row.discount_percent, 0),
          totalPrice: toNumber(row.total_price, 0),
          items: itemsByProposal.get(row.id) ?? [],
          createdAt: row.created_at,
        })),
      };
    });
  }

  /**
   * Anonimizacao LGPD (D-063) — cadastro E copias denormalizadas na MESMA
   * transacao. Deixar `conversations.patient_name` intacto tornaria a
   * anonimizacao decorativa: o nome continuaria na lista do inbox.
   *
   * Idempotente pelo proprio `WHERE anonymized_at IS NULL`: a segunda chamada
   * afeta 0 linhas, nao mexe em conversa nenhuma e devolve o mesmo estado.
   *
   * ALCANCE COMPLETO (D-075, emenda a D-063) — tudo na MESMA transacao:
   *   1. `patients`            — cadastro zerado, `phone` -> `anon-<hex>`;
   *   2. `conversations`       — copias denormalizadas (D-059);
   *   3. `messages.attachment_url` -> NULL: a foto e o PDF de exame do titular
   *      NAO sao "conteudo de mensagem" no sentido de D-063; sao arquivo
   *      pessoal e a URL continuava apontando para ele;
   *   4. `audit_logs`          — o VALOR dos campos pessoais em
   *      `old_values`/`new_values` vira `"[ERASED]"`, as chaves ficam. Sem
   *      isso, `GET /audit?entityType=patient&entityId=<id>` devolvia CPF,
   *      nome, e-mail, nascimento e a anotacao interna depois do apagamento.
   *
   * `proposals` e `proposal_items` continuam INTACTOS: sao registro financeiro
   * do laboratorio, e `Proposal.patientName` ja e anulavel.
   */
  async anonymize(
    tenantId: string,
    id: string,
  ): Promise<{ patient: Patient; conversationsAffected: number; changed: boolean } | null> {
    return this.db.withTenant(tenantId, async (tx) => {
      const updated = await tx.query<{ id: string }>(
        `UPDATE patients
            SET name = NULL, email = NULL, birth_date = NULL, document = NULL, notes = NULL,
                tags = '[]'::jsonb, custom_fields = '{}'::jsonb,
                phone = ${ANON_PHONE_SQL},
                anonymized_at = NOW()
          WHERE id = $1 AND anonymized_at IS NULL
          RETURNING id`,
        [id],
      );
      const changed = updated.rows.length > 0;

      let conversationsAffected = 0;
      if (changed) {
        const conversations = await tx.query<{ id: string }>(
          `UPDATE conversations
              SET patient_name = NULL, patient_email = NULL,
                  patient_phone = (SELECT phone FROM patients WHERE id = $1)
            WHERE patient_id = $1
            RETURNING id`,
          [id],
        );
        conversationsAffected = conversations.rows.length;

        // Anexo do titular: a URL aponta para o arquivo (foto, PDF de exame).
        // O TEXTO da mensagem continua intacto — essa e a limitacao declarada
        // em D-063; o arquivo nunca esteve coberto por ela.
        await tx.query(
          `UPDATE messages
              SET attachment_url = NULL
            WHERE attachment_url IS NOT NULL
              AND conversation_id IN (SELECT id FROM conversations WHERE patient_id = $1)`,
          [id],
        );

        // A UNICA escrita nao-append em `audit_logs` do projeto (D-075).
        await eraseEntityValues(tx, 'patient', id);
      }

      const found = await tx.query<PatientRow>(
        `SELECT ${PATIENT_COLUMNS} FROM patients p WHERE p.id = $1`,
        [id],
      );
      const row = found.rows[0];
      if (!row) return null;
      return { patient: toPatient(row), conversationsAffected, changed };
    });
  }
}

/**
 * Cria ou reaproveita o paciente do telefone, sobre uma transacao JA ABERTA.
 *
 * E o UNICO caminho de producao que faz nascer paciente: chamado por
 * `ConversationRepository.findOrCreateByPhone` (webhook), porque paciente e
 * conversa precisam nascer na MESMA transacao — aquele metodo ja esta dentro de
 * um `db.withTenant`, e chamar dali um service/repository que abre outro
 * `withTenant` travaria no driver de teste, que tem uma conexao so (D-008).
 * Mesmo caminho que `proposal.repository.findConversation` adotou. Por isso nao
 * existe metodo `findOrCreateByPhone` em `PatientRepository`/`PatientService`:
 * um wrapper que abre transacao propria nao teria consumidor.
 *
 * A corrida entre duas mensagens simultaneas do mesmo telefone e resolvida pelo
 * banco, no `ON CONFLICT (tenant_id, phone)`: nao existe janela entre SELECT e
 * INSERT.
 *
 * REGRAS DE NOME (D-072):
 *   - o nome do canal NUNCA sobrescreve um nome ja cadastrado — quem edita o
 *     cadastro e o atendente, o perfil do WhatsApp e apelido de terceiro;
 *   - ele PREENCHE o nome quando o cadastro ainda nao tem nenhum;
 *   - paciente anonimizado (LGPD, D-063) nao recebe nome nenhum de volta: o
 *     `CASE` abaixo e o cinto de seguranca do fato de a anonimizacao ja trocar
 *     o telefone por `anon-<id>`, o que sozinho ja impede o `ON CONFLICT` de
 *     encontrar a linha morta.
 */
/** `patients.phone VARCHAR(20)` / `patients.name VARCHAR(255)` (SCHEMA.md §3). */
const PHONE_MAX = 20;
const NAME_MAX = 255;

/**
 * Erro de dado do canal, ANTES do banco.
 *
 * Sem isto, um `from` com mais de 20 caracteres virava erro 22001 do Postgres
 * dentro do handler do webhook, o `safeHandle` respondia `200 {received:true}`
 * e a mensagem do paciente sumia em silencio — o canal nao reentrega o que ele
 * considera entregue. Agora o motivo e explicito no log
 * (`whatsapp.inbound_message_rejected`) e as OUTRAS mensagens do lote seguem.
 */
export class InboundPatientDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InboundPatientDataError';
  }
}

/**
 * Telefone do canal pronto para a coluna. Nao reformata (o valor e a chave de
 * deduplicacao `(tenant_id, phone)`: mexer nele fundiria ou duplicaria
 * cadastro) — so recusa o que nao cabe.
 */
export function normalizeInboundPhone(raw: string): string {
  const phone = raw.trim();
  if (phone.length === 0) {
    throw new InboundPatientDataError('telefone do canal vazio');
  }
  if (phone.length > PHONE_MAX) {
    throw new InboundPatientDataError(
      `telefone do canal excede ${PHONE_MAX} caracteres (${phone.length})`,
    );
  }
  return phone;
}

/**
 * Nome do perfil do canal pronto para a coluna: TRUNCADO, nunca recusado.
 * O nome e enfeite escolhido por terceiro (D-072) — perder o fim de um apelido
 * de 300 caracteres e melhor que perder a mensagem.
 */
export function normalizeInboundName(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const name = raw.trim();
  if (name.length === 0) return null;
  return name.length > NAME_MAX ? name.slice(0, NAME_MAX) : name;
}

export async function upsertPatientByPhone(
  tx: DbTx,
  tenantId: string,
  rawPhone: string,
  rawName?: string | null,
): Promise<Patient> {
  const phone = normalizeInboundPhone(rawPhone);
  const name = normalizeInboundName(rawName);

  // O `RETURNING` devolve as colunas direto do INSERT em vez de um
  // `WITH ... SELECT FROM patients`: a parte principal de uma query com CTE
  // enxerga o snapshot ANTERIOR ao statement, entao o JOIN de volta na tabela
  // nao encontraria a linha recem-inserida (so a do caminho DO UPDATE).
  const result = await tx.query<PatientRow>(
    `INSERT INTO patients AS p (tenant_id, phone, name)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, phone) DO UPDATE
       SET name = CASE
                    WHEN p.anonymized_at IS NOT NULL THEN p.name
                    ELSE COALESCE(p.name, EXCLUDED.name)
                  END,
           updated_at = NOW()
     RETURNING ${PATIENT_COLUMNS}`,
    [tenantId, phone, name],
  );
  const row = result.rows[0];
  if (!row) throw new Error('INSERT em patients nao retornou linha');
  return toPatient(row);
}

/**
 * Agregado de conversas VISIVEIS de um paciente. Uma unica subconsulta serve
 * `lastInteractionAt`, `conversationCount` e o proprio teste de visibilidade —
 * assim e impossivel o contador dizer 4 e a listagem enxergar 2.
 */
function conversationAggregate(params: Params, visibleTo: string | null): string {
  const visibility =
    visibleTo === null
      ? ''
      : `AND (c.assigned_to = ${params.add(visibleTo)} OR c.assigned_to IS NULL)`;
  return `SELECT MAX(c.last_message_at) AS last_interaction_at,
                 COUNT(*)::int AS conversation_count
            FROM conversations c
           WHERE c.patient_id = p.id ${visibility}`;
}

/** Propostas visiveis do paciente (D-042: atendente so ve as que criou). */
function proposalAggregate(params: Params, visibleTo: string | null): string {
  const visibility = visibleTo === null ? '' : `AND pr.created_by = ${params.add(visibleTo)}`;
  return `SELECT COUNT(*)::int AS proposal_count
            FROM proposals pr
            JOIN conversations c2 ON c2.id = pr.conversation_id
           WHERE c2.patient_id = p.id ${visibility}`;
}

async function selectDetail(
  tx: DbTx,
  id: string,
  visibility: PatientVisibility,
): Promise<PatientDetail | null> {
  const params = new Params();
  const idParam = params.add(id);
  const conversations = conversationAggregate(params, visibility.visibleTo);
  const proposals = proposalAggregate(params, visibility.visibleTo);
  const visible = visibility.visibleTo !== null ? 'AND ci.conversation_count > 0' : '';

  const result = await tx.query<PatientDetailRow>(
    `SELECT ${PATIENT_COLUMNS},
            ${isoUtc('ci.last_interaction_at')} AS last_interaction_at,
            ci.conversation_count, pc.proposal_count
       FROM patients p
       LEFT JOIN LATERAL (${conversations}) ci ON TRUE
       LEFT JOIN LATERAL (${proposals}) pc ON TRUE
      WHERE p.id = ${idParam} ${visible}`,
    params.all(),
  );
  const row = result.rows[0];
  return row ? toDetail(row) : null;
}

/**
 * CTE da timeline: as quatro origens de D-060 normalizadas numa unica relacao.
 *
 * A primeira perna do `UNION ALL` fixa os tipos das colunas — as demais podem
 * usar `NULL` cru. `preview` e truncado com `left(content, 160)` NO SQL: trazer
 * 50 mensagens inteiras para cortar em memoria e trazer o que nao se usa
 * (SERVICES.md §12).
 */
function timelineCte(params: Params, patientParam: string, visibleTo: string | null): string {
  const conversationVisibility =
    visibleTo === null
      ? ''
      : `AND (c.assigned_to = ${params.add(visibleTo)} OR c.assigned_to IS NULL)`;
  const proposalVisibility =
    visibleTo === null ? '' : `AND pr.created_by = ${params.add(visibleTo)}`;

  return `WITH vc AS (
    SELECT c.id, c.channel, c.created_at, c.patient_name
      FROM conversations c
     WHERE c.patient_id = ${patientParam} ${conversationVisibility}
  ), vp AS (
    SELECT pr.id, pr.status, pr.discount_percent, pr.total_price, pr.created_at, pr.created_by
      FROM proposals pr
      JOIN conversations c ON c.id = pr.conversation_id
     WHERE c.patient_id = ${patientParam} ${proposalVisibility}
  ), hist AS (
    SELECT h.id, h.proposal_id, h.status, h.changed_by, h.changed_at,
           LAG(h.status) OVER (
             PARTITION BY h.proposal_id ORDER BY h.changed_at ASC, h.id ASC
           ) AS prev_status
      FROM proposal_status_history h
      JOIN vp ON vp.id = h.proposal_id
  ), entries AS (
    SELECT 'conversation_started'::text AS kind,
           ('conversation_started:' || vc.id::text) AS entry_id,
           vc.created_at AS at,
           vc.id AS conversation_id,
           vc.channel::text AS channel,
           NULL::text AS sender_type,
           NULL::text AS sender_name,
           NULL::text AS message_type,
           NULL::text AS preview,
           NULL::uuid AS proposal_id,
           NULL::text AS status,
           NULL::numeric AS discount_percent,
           NULL::numeric AS total_price,
           NULL::text AS created_by_name,
           NULL::text AS from_status,
           NULL::text AS to_status,
           NULL::text AS changed_by_name
      FROM vc
    UNION ALL
    SELECT 'message', ('message:' || m.id::text), m.created_at, m.conversation_id, NULL,
           m.sender_type::text,
           CASE
             WHEN m.sender_type = 'agent' THEN u.name
             WHEN m.sender_type = 'patient' THEN vc.patient_name
             ELSE NULL
           END,
           m.message_type::text, left(m.content, 160),
           NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
      FROM messages m
      JOIN vc ON vc.id = m.conversation_id
      LEFT JOIN users u ON u.id = m.sender_id
    UNION ALL
    SELECT 'proposal_created', ('proposal_created:' || vp.id::text), vp.created_at,
           NULL, NULL, NULL, NULL, NULL, NULL,
           vp.id, vp.status::text, vp.discount_percent, vp.total_price, u.name,
           NULL, NULL, NULL
      FROM vp
      LEFT JOIN users u ON u.id = vp.created_by
    UNION ALL
    SELECT 'proposal_stage_changed', ('proposal_stage_changed:' || hist.id::text),
           hist.changed_at, NULL, NULL, NULL, NULL, NULL, NULL,
           hist.proposal_id, NULL, NULL, NULL, NULL,
           hist.prev_status::text, hist.status::text, u.name
      FROM hist
      LEFT JOIN users u ON u.id = hist.changed_by
  )`;
}
