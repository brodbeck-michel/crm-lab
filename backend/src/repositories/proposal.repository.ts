/**
 * Acesso a dados de `proposals`, `proposal_items` e `proposal_status_history`.
 *
 * SEM regra de negocio (CONVENTIONS.md "Backend"): alcada, matriz de transicoes
 * e calculo vivem no `ProposalService`. Aqui so ha SQL.
 *
 * Todos os metodos recebem um `DbTx` — o escopo (`db.withTenant`) e decidido
 * pelo service, que precisa gravar proposta + itens + historico na MESMA
 * transacao. Nenhum caminho usa `withoutTenant()`: proposta e dado de
 * laboratorio e o RLS falha fechado sem contexto de tenant.
 *
 * `proposal_items.tenant_id` e NOT NULL (pedido do Agent-DB em STATUS.md): todo
 * insert de item repete o tenant da proposta pai.
 */
import type {
  ApprovalStatus,
  LossReason,
  Proposal,
  ProposalDetail,
  ProposalItem,
  ProposalStageHistoryEntry,
  ProposalStatus,
} from '@crm-lab/shared';
import type { DbTx } from '../db/types.js';
import { toIso, toIsoOrNull, toNumber } from './row-mappers.js';

// ---------------------------------------------------------------------------
// Linhas e mapeamento
// ---------------------------------------------------------------------------

export interface ProposalRow {
  id: string;
  /** Numero sequencial POR TENANT (migracao 011) — rastreamento citavel. */
  proposal_number: unknown;
  tenant_id: string;
  conversation_id: string;
  created_by: string;
  created_by_name: string | null;
  patient_name: string | null;
  patient_phone: string | null;
  status: string;
  discount_percent: unknown;
  total_price: unknown;
  reason_lost: string | null;
  approval_status: string;
  approved_by: string | null;
  approved_by_name: string | null;
  approved_at: unknown;
  sent_at: unknown;
  closed_at: unknown;
  created_at: unknown;
  updated_at: unknown;
  /** Convenio da proposta. `null` = particular (Onda 7). Imutavel apos a criacao. */
  insurance_id: string | null;
}

interface ProposalItemRow {
  id: string;
  exam_id: string;
  exam_name: string;
  quantity: unknown;
  unit_price: unknown;
  /** Origem do snapshot de preco (Onda 7). */
  price_source: string;
}

interface HistoryRow {
  status: string;
  changed_at: unknown;
  changed_by: string | null;
  changed_by_name: string | null;
}

/**
 * SELECT canonico. Os nomes de paciente e de autor vem por JOIN — nunca sao
 * duplicados em `proposals` (BUSINESS_RULES §5: um numero, uma origem).
 */
const SELECT_PROPOSAL = `
  SELECT p.id, p.proposal_number, p.tenant_id, p.conversation_id, p.created_by,
         u.name AS created_by_name,
         c.patient_name, c.patient_phone,
         p.status, p.discount_percent, p.total_price, p.reason_lost,
         p.approval_status, p.approved_by, a.name AS approved_by_name,
         p.approved_at, p.sent_at, p.closed_at, p.created_at, p.updated_at,
         p.insurance_id
    FROM proposals p
    JOIN conversations c ON c.id = p.conversation_id
    LEFT JOIN users u ON u.id = p.created_by
    LEFT JOIN users a ON a.id = p.approved_by`;

/** Linha -> `Proposal` (shape de listagem/pipeline de `@crm-lab/shared`). */
export function mapProposal(row: ProposalRow): Proposal {
  return {
    id: row.id,
    proposalNumber: toNumber(row.proposal_number),
    conversationId: row.conversation_id,
    patientName: row.patient_name,
    status: row.status as ProposalStatus,
    discountPercent: toNumber(row.discount_percent),
    totalPrice: toNumber(row.total_price),
    createdBy: row.created_by,
    createdByName: row.created_by_name ?? '',
    approvalStatus: row.approval_status as ApprovalStatus,
    reasonLost: (row.reason_lost as LossReason | null) ?? null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    closedAt: toIsoOrNull(row.closed_at),
    insuranceId: row.insurance_id,
  };
}

export function mapItem(row: ProposalItemRow): ProposalItem {
  return {
    id: row.id,
    examId: row.exam_id,
    examName: row.exam_name,
    quantity: toNumber(row.quantity, 1),
    unitPrice: toNumber(row.unit_price),
    priceSource: row.price_source as ProposalItem['priceSource'],
  };
}

export function mapHistory(row: HistoryRow): ProposalStageHistoryEntry {
  return {
    status: row.status as ProposalStatus,
    changedAt: toIso(row.changed_at),
    changedBy: row.changed_by,
    changedByName: row.changed_by_name,
  };
}

/** Monta o `ProposalDetail` completo a partir das tres consultas. */
export function mapDetail(
  row: ProposalRow,
  items: ProposalItem[],
  history: ProposalStageHistoryEntry[],
  extra: { subtotal: number; rejectionReason: string | null },
): ProposalDetail {
  return {
    ...mapProposal(row),
    patientPhone: row.patient_phone ?? '',
    items,
    subtotal: extra.subtotal,
    approvedBy: row.approved_by,
    approvedByName: row.approved_by_name,
    approvedAt: toIsoOrNull(row.approved_at),
    rejectionReason: extra.rejectionReason,
    sentAt: toIsoOrNull(row.sent_at),
    history,
  };
}

// ---------------------------------------------------------------------------
// Conversa (leitura minima)
// ---------------------------------------------------------------------------

export interface ConversationRef {
  id: string;
  patientName: string | null;
  patientPhone: string;
  status: string;
}

/**
 * Existencia da conversa NESTE tenant. Dentro de `withTenant`, o RLS ja esconde
 * a conversa de outro laboratorio: `null` significa "inexistente OU de outro
 * tenant", e o service converte para `NOT_FOUND` (CLAUDE.md regra 8).
 *
 * NOTA DE FRONTEIRA: a leitura pertenceria ao `ConversationService`, que ainda
 * nao existe (Onda 3). Enquanto nao existir, esta funcao e a UNICA porta do
 * dominio de propostas para `conversations`, e e so leitura. Pedido registrado
 * em `docs/STATUS.md`.
 */
export async function findConversation(
  tx: DbTx,
  conversationId: string,
): Promise<ConversationRef | null> {
  const result = await tx.query<{
    id: string;
    patient_name: string | null;
    patient_phone: string;
    status: string;
  }>(
    `SELECT id, patient_name, patient_phone, status
       FROM conversations WHERE id = $1`,
    [conversationId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    patientName: row.patient_name,
    patientPhone: row.patient_phone,
    status: row.status,
  };
}

/**
 * Mensagem de sistema na conversa (WORKFLOWS §2 passo 6 e §4).
 * Equivale a `MessageService.createSystemEvent` (SERVICES.md §3), que ainda nao
 * existe; quando existir, o ProposalService passa a chama-lo e esta funcao sai.
 */
export async function insertSystemMessage(
  tx: DbTx,
  input: { tenantId: string; conversationId: string; content: string },
): Promise<string> {
  const result = await tx.query<{ id: string }>(
    `INSERT INTO messages (tenant_id, conversation_id, sender_type, sender_id,
                           content, message_type, status)
     VALUES ($1, $2, 'system', NULL, $3, 'text', 'sent')
     RETURNING id`,
    [input.tenantId, input.conversationId, input.content],
  );
  const row = result.rows[0];
  if (!row) throw new Error('INSERT em messages nao retornou linha');
  return row.id;
}

// ---------------------------------------------------------------------------
// Escrita
// ---------------------------------------------------------------------------

export interface ProposalInsert {
  tenantId: string;
  conversationId: string;
  createdBy: string;
  status: ProposalStatus;
  discountPercent: number;
  totalPrice: number;
  approvalStatus: ApprovalStatus;
  approvedBy: string | null;
  approvedAt: string | null;
  /** Convenio da proposta. `null` = particular (Onda 7). Imutavel apos a criacao. */
  insuranceId: string | null;
}

export interface ProposalItemInsert {
  examId: string;
  examName: string;
  quantity: number;
  unitPrice: number;
  /** Origem do snapshot de preco (Onda 7 — fallback nunca bloqueia). */
  priceSource: ProposalItem['priceSource'];
}

/**
 * Proximo `proposal_number` DESTE tenant (migracao 011). `pg_advisory_xact_lock`
 * serializa concorrentes na MESMA transacao do INSERT que segue — a trava
 * some sozinha no COMMIT/ROLLBACK, sem tabela de contador dedicada. O hash e
 * de texto (nao de UUID) para nao depender de nenhuma extensao alem da ja
 * usada em `gen_random_uuid()`.
 */
async function nextProposalNumber(tx: DbTx, tenantId: string): Promise<number> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [tenantId]);
  const result = await tx.query<{ next: unknown }>(
    'SELECT COALESCE(MAX(proposal_number), 0) + 1 AS next FROM proposals WHERE tenant_id = $1',
    [tenantId],
  );
  return toNumber(result.rows[0]?.next, 1);
}

export async function insertProposal(tx: DbTx, input: ProposalInsert): Promise<string> {
  const proposalNumber = await nextProposalNumber(tx, input.tenantId);

  const result = await tx.query<{ id: string }>(
    `INSERT INTO proposals (tenant_id, conversation_id, created_by, status,
                            discount_percent, total_price, approval_status,
                            approved_by, approved_at, insurance_id, proposal_number)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      input.tenantId,
      input.conversationId,
      input.createdBy,
      input.status,
      input.discountPercent,
      input.totalPrice,
      input.approvalStatus,
      input.approvedBy,
      input.approvedAt,
      input.insuranceId,
      proposalNumber,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('INSERT em proposals nao retornou linha');
  return row.id;
}

/**
 * Snapshot de nome e preco (D-004). `tenant_id` repetido por exigencia do schema.
 *
 * A ordem em que o atendente montou o orcamento vive em `position` (D-071,
 * migracao 003): o indice do item no array do request, base 0. O deslocamento
 * de 1 microssegundo em `created_at` que existia aqui foi removido — ele usava
 * uma coluna de tempo como coluna de ordem, e `position` agora e o criterio
 * primario de toda leitura (`position ASC, created_at ASC`).
 */
export async function insertItems(
  tx: DbTx,
  tenantId: string,
  proposalId: string,
  items: ProposalItemInsert[],
): Promise<void> {
  let position = 0;
  for (const item of items) {
    await tx.query(
      `INSERT INTO proposal_items (tenant_id, proposal_id, exam_id, quantity,
                                   unit_price, exam_name, "position", price_source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        tenantId,
        proposalId,
        item.examId,
        item.quantity,
        item.unitPrice,
        item.examName,
        position,
        item.priceSource,
      ],
    );
    position += 1;
  }
}

/**
 * Uma linha por transicao ACEITA, inclusive a criacao (`novo_contato`).
 * Invariante combinado com o seed (STATUS.md, pedido do Agent-DB-Seeds).
 */
export async function insertHistory(
  tx: DbTx,
  input: {
    tenantId: string;
    proposalId: string;
    status: ProposalStatus;
    changedBy: string | null;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO proposal_status_history (tenant_id, proposal_id, status, changed_by)
     VALUES ($1, $2, $3, $4)`,
    [input.tenantId, input.proposalId, input.status, input.changedBy],
  );
}

export interface ProposalPatch {
  status?: ProposalStatus;
  discountPercent?: number;
  totalPrice?: number;
  reasonLost?: LossReason | null;
  approvalStatus?: ApprovalStatus;
  approvedBy?: string | null;
  approvedAt?: string | null;
  sentAt?: string | null;
  closedAt?: string | null;
}

const PATCH_COLUMNS: Record<keyof ProposalPatch, string> = {
  status: 'status',
  discountPercent: 'discount_percent',
  totalPrice: 'total_price',
  reasonLost: 'reason_lost',
  approvalStatus: 'approval_status',
  approvedBy: 'approved_by',
  approvedAt: 'approved_at',
  sentAt: 'sent_at',
  closedAt: 'closed_at',
};

/**
 * Aplica o patch e devolve a linha ja com os JOINs. `null` = id inexistente
 * NESTE tenant (o RLS escondeu a linha) -> o service responde `NOT_FOUND`.
 */
export async function updateProposal(
  tx: DbTx,
  id: string,
  patch: ProposalPatch,
): Promise<ProposalRow | null> {
  const assignments: string[] = [];
  const params: unknown[] = [];

  for (const key of Object.keys(PATCH_COLUMNS) as Array<keyof ProposalPatch>) {
    const value = patch[key];
    if (value === undefined) continue;
    params.push(value);
    assignments.push(`${PATCH_COLUMNS[key]} = $${params.length}`);
  }

  if (assignments.length > 0) {
    params.push(id);
    const updated = await tx.query<{ id: string }>(
      `UPDATE proposals SET ${assignments.join(', ')}, updated_at = NOW()
        WHERE id = $${params.length} RETURNING id`,
      params,
    );
    if (updated.rows.length === 0) return null;
  }

  return findRowById(tx, id);
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

export async function findRowById(tx: DbTx, id: string): Promise<ProposalRow | null> {
  const result = await tx.query<ProposalRow>(`${SELECT_PROPOSAL} WHERE p.id = $1`, [id]);
  return result.rows[0] ?? null;
}

export async function findItems(tx: DbTx, proposalId: string): Promise<ProposalItem[]> {
  const result = await tx.query<ProposalItemRow>(
    `SELECT id, exam_id, exam_name, quantity, unit_price, price_source
       FROM proposal_items WHERE proposal_id = $1
      ORDER BY "position" ASC, created_at ASC, id ASC`,
    [proposalId],
  );
  return result.rows.map(mapItem);
}

export async function findHistory(
  tx: DbTx,
  proposalId: string,
): Promise<ProposalStageHistoryEntry[]> {
  const result = await tx.query<HistoryRow>(
    `SELECT h.status, h.changed_at, h.changed_by, u.name AS changed_by_name
       FROM proposal_status_history h
       LEFT JOIN users u ON u.id = h.changed_by
      WHERE h.proposal_id = $1
      ORDER BY h.changed_at ASC, h.id ASC`,
    [proposalId],
  );
  return result.rows.map(mapHistory);
}

/**
 * Motivo da ultima rejeicao de desconto.
 *
 * `proposals` nao tem coluna para isso (migracao 001, dominio do Agent-DB), mas
 * `ProposalDetail.rejectionReason` faz parte do contrato compartilhado. A
 * origem unica e o audit log da decisao (BUSINESS_RULES §5 e §9) — ver D-041.
 */
export async function findRejectionReason(
  tx: DbTx,
  proposalId: string,
): Promise<string | null> {
  const result = await tx.query<{ reason: string | null }>(
    `SELECT new_values ->> 'rejectionReason' AS reason
       FROM audit_logs
      WHERE entity_type = 'proposal' AND entity_id = $1 AND action = $2
      ORDER BY timestamp DESC
      LIMIT 1`,
    [proposalId, REJECT_ACTION],
  );
  return result.rows[0]?.reason ?? null;
}

/** Acao de auditoria que carrega o motivo da rejeicao. */
export const REJECT_ACTION = 'reject_proposal_discount';

export type ProposalSortBy = 'createdAt' | 'updatedAt' | 'totalPrice' | 'status';

const SORTABLE_COLUMNS: Record<ProposalSortBy, string> = {
  createdAt: 'p.created_at',
  updatedAt: 'p.updated_at',
  totalPrice: 'p.total_price',
  status: 'p.status',
};

export function isProposalSortBy(value: string): value is ProposalSortBy {
  return Object.prototype.hasOwnProperty.call(SORTABLE_COLUMNS, value);
}

export interface ProposalListCriteria {
  statuses?: ProposalStatus[];
  conversationId?: string;
  /** D-060: resolvido por `conversations.patient_id` — proposta nao tem coluna de paciente. */
  patientId?: string;
  createdBy?: string;
  approvalStatus?: ApprovalStatus;
  startDate?: string;
  endDate?: string;
  /** Nome do paciente, case-insensitive. */
  search?: string;
  page: number;
  limit: number;
  sortBy: ProposalSortBy;
  order: 'asc' | 'desc';
}

export interface ProposalPage {
  rows: Proposal[];
  total: number;
}

export async function list(tx: DbTx, criteria: ProposalListCriteria): Promise<ProposalPage> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (criteria.statuses !== undefined && criteria.statuses.length > 0) {
    params.push(criteria.statuses);
    where.push(`p.status = ANY($${params.length}::text[])`);
  }
  if (criteria.conversationId !== undefined) {
    params.push(criteria.conversationId);
    where.push(`p.conversation_id = $${params.length}`);
  }
  if (criteria.patientId !== undefined) {
    // A proposta nasce de uma conversa; o paciente mora la (D-060). O JOIN com
    // `conversations` ja existe nas duas queries abaixo, entao o filtro nao
    // custa nada — e continua dentro do `withTenant`, ou seja, sob RLS.
    params.push(criteria.patientId);
    where.push(`c.patient_id = $${params.length}`);
  }
  if (criteria.createdBy !== undefined) {
    params.push(criteria.createdBy);
    where.push(`p.created_by = $${params.length}`);
  }
  if (criteria.approvalStatus !== undefined) {
    params.push(criteria.approvalStatus);
    where.push(`p.approval_status = $${params.length}`);
  }
  if (criteria.startDate !== undefined) {
    params.push(criteria.startDate);
    where.push(`p.created_at >= $${params.length}::timestamp`);
  }
  if (criteria.endDate !== undefined) {
    params.push(criteria.endDate);
    where.push(`p.created_at <= $${params.length}::timestamp`);
  }
  if (criteria.search !== undefined && criteria.search.trim() !== '') {
    // rangel: ILIKE simples resolve o volume de um laboratorio. Se a tabela
    // crescer a ponto do seq scan doer, o upgrade e um indice trigram (pg_trgm).
    params.push(`%${criteria.search.trim()}%`);
    where.push(`c.patient_name ILIKE $${params.length}`);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const direction = criteria.order === 'asc' ? 'ASC' : 'DESC';
  // `id` como desempate: sem ele a paginacao pode repetir ou pular linhas.
  const orderSql = `ORDER BY ${SORTABLE_COLUMNS[criteria.sortBy]} ${direction}, p.id ASC`;

  const counted = await tx.query<{ total: number | string }>(
    `SELECT COUNT(*)::int AS total
       FROM proposals p
       JOIN conversations c ON c.id = p.conversation_id
       ${whereSql}`,
    params,
  );
  const total = Number(counted.rows[0]?.total ?? 0);

  const offset = (criteria.page - 1) * criteria.limit;
  const paged = await tx.query<ProposalRow>(
    `${SELECT_PROPOSAL} ${whereSql} ${orderSql}
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, criteria.limit, offset],
  );

  return { rows: paged.rows.map(mapProposal), total };
}
