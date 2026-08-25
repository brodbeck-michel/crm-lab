/**
 * Acesso de LEITURA a `conversations` e `proposals` para o OperationService
 * (SERVICES.md §14). Nenhum INSERT/UPDATE/DELETE mora aqui — e nao deve passar
 * a morar.
 *
 * ============================================================================
 * NENHUMA TABELA NOVA, NENHUM CONTADOR MATERIALIZADO (BUSINESS_RULES §5)
 * ============================================================================
 * Fila, carga e decisoes pendentes sao AGREGACOES sobre as duas tabelas que ja
 * existem. Nao ha coluna de contador, nao ha tabela de resumo, nao ha cache.
 *
 * ============================================================================
 * TEMPO E CALCULADO NO SQL, EM SEGUNDOS (D-021 / D-067)
 * ============================================================================
 *   EXTRACT(EPOCH FROM (NOW() AT TIME ZONE 'UTC' - COALESCE(last_message_at, created_at)))::int
 *
 * As colunas sao `TIMESTAMP` sem timezone guardando UTC. Se a subtracao
 * acontecesse em JavaScript, o driver interpretaria a coluna no fuso da MAQUINA
 * e a espera sairia com horas de erro numa maquina em UTC-3 — o mesmo defeito
 * que a D-021 registrou em `daysOpen`. A formatacao ("ha 12 min") e do
 * frontend; daqui saem inteiros de segundos.
 *
 * `NOW()` em Postgres e o instante de INICIO DA TRANSACAO, e todas as funcoes
 * abaixo rodam dentro do mesmo `withTenant`. E isso que faz `generatedAt`,
 * fila, carga e decisoes serem literalmente o mesmo instante (D-067) sem
 * precisar passar um timestamp de fora.
 */
import type { DbTx } from '../db/types.js';
import { toIso, toIsoOrNull, toNumber } from './row-mappers.js';

/** Formato ISO-UTC gerado pelo proprio banco. */
const ISO_UTC = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/** Segundos de espera de uma conversa. Ver cabecalho. */
/**
 * `NOW() AT TIME ZONE 'UTC'` e nao `NOW()` (D-078): `last_message_at`/`created_at`
 * sao `TIMESTAMP` SEM fuso, e gravadas em UTC. Subtrair um `timestamptz` de um
 * `timestamp` faz o Postgres converter a coluna pelo `TimeZone` da SESSAO — num
 * servidor em `America/Sao_Paulo` a espera sairia 10.800 s errada. Convertendo
 * `NOW()` para o relogio de parede UTC os dois lados sao a mesma escala, e a
 * conta fica correta qualquer que seja o fuso da sessao. A conexao tambem fixa
 * `timezone=UTC` (`pg-driver.ts`) — cinto e suspensorio, de proposito.
 */
const CONVERSATION_WAIT =
  "EXTRACT(EPOCH FROM (NOW() AT TIME ZONE 'UTC' - COALESCE(c.last_message_at, c.created_at)))::int";

/**
 * A FILA: ativa e sem dono, OU ativa, com dono e com mensagem nao lida.
 * "Em espera" e `unread_count > 0` de proposito — o mesmo numero do badge do
 * inbox (D-067). Uma segunda definicao criaria duas origens para o mesmo dado.
 */
const QUEUE_PREDICATE = `c.tenant_id = $1
      AND c.status = 'active'
      AND (c.assigned_to IS NULL OR c.unread_count > 0)`;

// ---------------------------------------------------------------------------
// generatedAt
// ---------------------------------------------------------------------------

/**
 * Instante do retrato, em UTC. `NOW()` e timestamptz (absoluto);
 * `AT TIME ZONE 'UTC'` o converte para o relogio de parede UTC antes de
 * formatar — correto qualquer que seja o fuso da sessao do banco.
 */
export async function snapshotInstant(tx: DbTx): Promise<string> {
  const result = await tx.query<{ generated_at: unknown }>(
    `SELECT to_char(NOW() AT TIME ZONE 'UTC', ${ISO_UTC}) AS generated_at`,
  );
  return toIso(result.rows[0]?.generated_at);
}

// ---------------------------------------------------------------------------
// Fila
// ---------------------------------------------------------------------------

export interface QueueTotalsRow {
  unassigned: number;
  waiting: number;
  /** Maior espera da fila INTEIRA. `null` com a fila vazia. */
  oldestWaitSeconds: number | null;
}

/**
 * Contagens e a maior espera da fila INTEIRA — nao dos itens devolvidos por
 * `queueLimit`. Sao perguntas diferentes: o cabecalho da tela mostra o total, a
 * lista mostra o topo. Derivar `oldestWaitSeconds` dos itens listados daria o
 * numero certo por acidente enquanto a fila coubesse no limite.
 */
export async function queueTotals(tx: DbTx, tenantId: string): Promise<QueueTotalsRow> {
  const result = await tx.query<{
    unassigned: unknown;
    waiting: unknown;
    oldest_wait_seconds: unknown;
  }>(
    `SELECT COUNT(*) FILTER (WHERE c.assigned_to IS NULL)::int AS unassigned,
            COUNT(*) FILTER (WHERE c.assigned_to IS NOT NULL AND c.unread_count > 0)::int
              AS waiting,
            MAX(${CONVERSATION_WAIT}) AS oldest_wait_seconds
       FROM conversations c
      WHERE ${QUEUE_PREDICATE}`,
    [tenantId],
  );
  const row = result.rows[0];
  const oldest = row?.oldest_wait_seconds;
  return {
    unassigned: toNumber(row?.unassigned),
    waiting: toNumber(row?.waiting),
    oldestWaitSeconds: oldest === null || oldest === undefined ? null : toNumber(oldest),
  };
}

export interface QueueItemRow {
  conversationId: string;
  patientId: string | null;
  patientName: string | null;
  channel: string | null;
  reason: string;
  assignedTo: string | null;
  assignedToName: string | null;
  unreadCount: number;
  waitingSeconds: number;
  lastMessageAt: string | null;
}

/**
 * Topo da fila, `waitingSeconds DESC, conversationId ASC` (API_CONTRACTS §7).
 * O desempate por id existe para a ordem ser estavel entre dois polls quando
 * duas conversas tem a mesma espera.
 */
export async function queueItems(
  tx: DbTx,
  tenantId: string,
  limit: number,
): Promise<QueueItemRow[]> {
  const result = await tx.query<{
    conversation_id: string;
    patient_id: string | null;
    patient_name: string | null;
    channel: string | null;
    reason: string;
    assigned_to: string | null;
    assigned_to_name: string | null;
    unread_count: unknown;
    waiting_seconds: unknown;
    last_message_at: unknown;
  }>(
    `SELECT c.id AS conversation_id,
            c.patient_id,
            c.patient_name,
            c.channel,
            CASE WHEN c.assigned_to IS NULL THEN 'unassigned' ELSE 'waiting' END AS reason,
            c.assigned_to,
            u.name AS assigned_to_name,
            COALESCE(c.unread_count, 0)::int AS unread_count,
            ${CONVERSATION_WAIT} AS waiting_seconds,
            to_char(c.last_message_at, ${ISO_UTC}) AS last_message_at
       FROM conversations c
       LEFT JOIN users u ON u.id = c.assigned_to
      WHERE ${QUEUE_PREDICATE}
      ORDER BY waiting_seconds DESC, c.id ASC
      LIMIT $2`,
    [tenantId, limit],
  );

  return result.rows.map((row) => ({
    conversationId: row.conversation_id,
    patientId: row.patient_id,
    patientName: row.patient_name,
    channel: row.channel,
    reason: row.reason,
    assignedTo: row.assigned_to,
    assignedToName: row.assigned_to_name,
    unreadCount: toNumber(row.unread_count),
    waitingSeconds: toNumber(row.waiting_seconds),
    lastMessageAt: toIsoOrNull(row.last_message_at),
  }));
}

// ---------------------------------------------------------------------------
// Carga por atendente
// ---------------------------------------------------------------------------

export interface WorkloadRowData {
  userId: string;
  name: string;
  role: string;
  activeConversations: number;
  unreadMessages: number;
  openProposals: number;
  pendingApprovals: number;
}

/**
 * Uma linha por usuario ATIVO de papel de laboratorio, `name ASC` — inclusive
 * quem nao tem carga nenhuma, que aparece ZERADO. Sumir da tabela e pior que
 * aparecer com zero: esconde exatamente quem esta ocioso, que e metade da
 * pergunta que a tela responde.
 *
 * As duas fontes entram como subconsultas AGREGADAS, nao como dois `LEFT JOIN`
 * de linhas: juntar conversas e propostas na mesma varredura multiplicaria uma
 * pela outra e inflaria os dois numeros.
 */
export async function workload(
  tx: DbTx,
  tenantId: string,
  terminalStatuses: readonly string[],
): Promise<WorkloadRowData[]> {
  const params: unknown[] = [tenantId];
  const terminalPlaceholders = terminalStatuses.map((status) => {
    params.push(status);
    return `$${params.length}`;
  });
  // Sem status terminal configurado, "aberta" e qualquer proposta.
  const openFilter =
    terminalPlaceholders.length > 0
      ? `p.status NOT IN (${terminalPlaceholders.join(', ')})`
      : 'TRUE';

  const result = await tx.query<{
    user_id: string;
    name: string;
    role: string;
    active_conversations: unknown;
    unread_messages: unknown;
    open_proposals: unknown;
    pending_approvals: unknown;
  }>(
    `SELECT u.id AS user_id,
            u.name,
            u.role,
            COALESCE(conv.active_conversations, 0)::int AS active_conversations,
            COALESCE(conv.unread_messages, 0)::int AS unread_messages,
            COALESCE(prop.open_proposals, 0)::int AS open_proposals,
            COALESCE(prop.pending_approvals, 0)::int AS pending_approvals
       FROM users u
       LEFT JOIN (
              SELECT c.assigned_to AS user_id,
                     COUNT(*) AS active_conversations,
                     COALESCE(SUM(c.unread_count), 0) AS unread_messages
                FROM conversations c
               WHERE c.tenant_id = $1
                 AND c.status = 'active'
                 AND c.assigned_to IS NOT NULL
               GROUP BY c.assigned_to
            ) conv ON conv.user_id = u.id
       LEFT JOIN (
              SELECT p.created_by AS user_id,
                     COUNT(*) FILTER (WHERE ${openFilter}) AS open_proposals,
                     COUNT(*) FILTER (WHERE p.approval_status = 'pending')
                       AS pending_approvals
                FROM proposals p
               WHERE p.tenant_id = $1
               GROUP BY p.created_by
            ) prop ON prop.user_id = u.id
      WHERE u.tenant_id = $1
        AND u.is_active = TRUE
        AND u.role IN ('attendant', 'manager', 'admin')
      ORDER BY u.name ASC, u.id ASC`,
    params,
  );

  return result.rows.map((row) => ({
    userId: row.user_id,
    name: row.name,
    role: row.role,
    activeConversations: toNumber(row.active_conversations),
    unreadMessages: toNumber(row.unread_messages),
    openProposals: toNumber(row.open_proposals),
    pendingApprovals: toNumber(row.pending_approvals),
  }));
}

// ---------------------------------------------------------------------------
// Decisoes pendentes
// ---------------------------------------------------------------------------

export interface PendingDecisionRow {
  proposalId: string;
  patientName: string | null;
  createdBy: string;
  createdByName: string | null;
  status: string;
  discountPercent: number;
  totalPrice: number;
  createdAt: string;
  waitingSeconds: number;
}

/** Contagem COMPLETA — `total` nao e o tamanho de `items` (API_CONTRACTS §7). */
export async function pendingDecisionsTotal(tx: DbTx, tenantId: string): Promise<number> {
  const result = await tx.query<{ total: unknown }>(
    `SELECT COUNT(*)::int AS total
       FROM proposals p
      WHERE p.tenant_id = $1 AND p.approval_status = 'pending'`,
    [tenantId],
  );
  return toNumber(result.rows[0]?.total);
}

/**
 * Fila de decisao: `createdAt ASC` (a MAIS VELHA primeiro). O gestor decide da
 * mais antiga para a mais nova; ordenar ao contrario esconderia justamente a
 * proposta que ja esperou demais.
 */
export async function pendingDecisions(
  tx: DbTx,
  tenantId: string,
  limit: number,
): Promise<PendingDecisionRow[]> {
  const result = await tx.query<{
    proposal_id: string;
    patient_name: string | null;
    created_by: string;
    created_by_name: string | null;
    status: string;
    discount_percent: unknown;
    total_price: unknown;
    created_at: unknown;
    waiting_seconds: unknown;
  }>(
    `SELECT p.id AS proposal_id,
            c.patient_name,
            p.created_by,
            u.name AS created_by_name,
            p.status,
            p.discount_percent,
            p.total_price,
            to_char(p.created_at, ${ISO_UTC}) AS created_at,
            -- AT TIME ZONE 'UTC': ver CONVERSATION_WAIT (D-078).
            EXTRACT(EPOCH FROM (NOW() AT TIME ZONE 'UTC' - p.created_at))::int AS waiting_seconds
       FROM proposals p
       LEFT JOIN users u ON u.id = p.created_by
       LEFT JOIN conversations c ON c.id = p.conversation_id
      WHERE p.tenant_id = $1 AND p.approval_status = 'pending'
      ORDER BY p.created_at ASC, p.id ASC
      LIMIT $2`,
    [tenantId, limit],
  );

  return result.rows.map((row) => ({
    proposalId: row.proposal_id,
    patientName: row.patient_name,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    status: row.status,
    discountPercent: toNumber(row.discount_percent),
    totalPrice: toNumber(row.total_price),
    createdAt: toIso(row.created_at),
    waitingSeconds: toNumber(row.waiting_seconds),
  }));
}
