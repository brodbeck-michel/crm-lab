/**
 * Escritores de baixo nivel do seed — uma funcao por tabela.
 *
 * Todos recebem um `DbTx` que vem de `db.withoutTenant()`: o seed CRIA os
 * tenants, entao no momento da escrita ainda nao existe `app.tenant_id` para
 * setar. Ver `runSeeds()` em `index.ts`, onde a excecao esta comentada.
 *
 * Regras encapsuladas aqui (para que nenhum dataset possa esquece-las):
 *   - `total_price` sai de `calculateTotal()` de `@crm-lab/shared` (BR §1);
 *   - o caminho de `proposal_status_history` e validado contra
 *     `ALLOWED_TRANSITIONS` — um caminho ilegal derruba o seed na hora (BR §3);
 *   - `perdido` exige `reasonLost`; estagio terminal exige `closed_at` (BR §3).
 */
import {
  ALLOWED_TRANSITIONS,
  calculateTotal,
  isTransitionAllowed,
  TERMINAL_STATUSES,
  type ApprovalStatus,
  type ConversationChannel,
  type ConversationStatus,
  type FontId,
  type LossReason,
  type MessageStatus,
  type MessageType,
  type ProposalStatus,
  type RadiusId,
  type SenderType,
  type SubscriptionPlan,
  type UserRole,
} from '@crm-lab/shared';
import type { DbTx } from '../types.js';
import type { SeedExam } from './catalog.js';
import { seedUuid } from './ids.js';
import type { SeedThemePreset } from './themes.js';

const iso = (date: Date): string => date.toISOString();

// ---------------------------------------------------------------------- tenant

export interface SeedTenantInput {
  id: string;
  name: string;
  slug: string;
  plan: SubscriptionPlan;
  subscriptionUntil: Date | null;
  createdAt: Date;
}

export async function insertTenant(tx: DbTx, input: SeedTenantInput): Promise<string> {
  await tx.query(
    `INSERT INTO tenants (id, name, slug, is_active, subscription_plan, subscription_until, created_at, updated_at)
     VALUES ($1, $2, $3, TRUE, $4, $5, $6, $6)`,
    [
      input.id,
      input.name,
      input.slug,
      input.plan,
      input.subscriptionUntil ? iso(input.subscriptionUntil).slice(0, 10) : null,
      iso(input.createdAt),
    ],
  );
  return input.id;
}

// ----------------------------------------------------------------------- theme

export interface SeedThemeInput {
  id: string;
  tenantId: string;
  preset: SeedThemePreset;
  brandName: string;
  fontId: FontId;
  radiusId: RadiusId;
  createdAt: Date;
}

export async function insertTheme(tx: DbTx, input: SeedThemeInput): Promise<string> {
  await tx.query(
    `INSERT INTO themes (id, tenant_id, name, accent, accent_2, bg, surface, text,
                         font_id, radius_id, brand_name, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)`,
    [
      input.id,
      input.tenantId,
      input.preset.name,
      input.preset.accent,
      input.preset.accent2,
      input.preset.bg,
      input.preset.surface,
      input.preset.text,
      input.fontId,
      input.radiusId,
      input.brandName,
      iso(input.createdAt),
    ],
  );
  return input.id;
}

// ------------------------------------------------------------------------ user

export interface SeedUserInput {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  role: UserRole;
  discountLimit: number;
  passwordHash: string;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export async function insertUser(tx: DbTx, input: SeedUserInput): Promise<string> {
  await tx.query(
    `INSERT INTO users (id, tenant_id, email, password_hash, name, role,
                        discount_limit_percent, is_active, last_login_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8, $9, $9)`,
    [
      input.id,
      input.tenantId,
      input.email,
      input.passwordHash,
      input.name,
      input.role,
      input.discountLimit,
      input.lastLoginAt ? iso(input.lastLoginAt) : null,
      iso(input.createdAt),
    ],
  );
  return input.id;
}

// ------------------------------------------------------------------------ exam

export async function insertExam(
  tx: DbTx,
  input: { id: string; tenantId: string; exam: SeedExam; createdAt: Date },
): Promise<string> {
  const { exam } = input;
  if (exam.priceInsurance >= exam.pricePrivate) {
    throw new Error(
      `Exame ${exam.code}: priceInsurance (${exam.priceInsurance}) precisa ser menor que ` +
        `pricePrivate (${exam.pricePrivate}).`,
    );
  }
  await tx.query(
    `INSERT INTO exam_catalog (id, tenant_id, name, code, description, preparation,
                               turnaround_hours, price_private, price_insurance,
                               is_active, category, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, $10, $11, $11)`,
    [
      input.id,
      input.tenantId,
      exam.name,
      exam.code,
      exam.description,
      exam.preparation,
      exam.turnaroundHours,
      exam.pricePrivate,
      exam.priceInsurance,
      exam.category,
      iso(input.createdAt),
    ],
  );
  return input.id;
}

// ---------------------------------------------------------------- conversation

export interface SeedConversationInput {
  id: string;
  tenantId: string;
  patientName: string;
  patientPhone: string;
  patientEmail: string | null;
  /** `null` = fila "Não atribuídas" do inbox. */
  assignedTo: string | null;
  channel: ConversationChannel;
  status: ConversationStatus;
  unreadCount: number;
  tags: string[];
  lastMessageAt: Date;
  createdAt: Date;
}

export async function insertConversation(tx: DbTx, input: SeedConversationInput): Promise<string> {
  await tx.query(
    `INSERT INTO conversations (id, tenant_id, patient_phone, patient_name, patient_email,
                                assigned_to, channel, status, last_message_at, unread_count,
                                tags, custom_fields, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, '{}'::jsonb, $12, $12)`,
    [
      input.id,
      input.tenantId,
      input.patientPhone,
      input.patientName,
      input.patientEmail,
      input.assignedTo,
      input.channel,
      input.status,
      iso(input.lastMessageAt),
      input.unreadCount,
      JSON.stringify(input.tags),
      iso(input.createdAt),
    ],
  );
  return input.id;
}

// --------------------------------------------------------------------- message

export interface SeedMessageInput {
  id: string;
  tenantId: string;
  conversationId: string;
  senderType: SenderType;
  senderId: string | null;
  content: string;
  messageType: MessageType;
  status: MessageStatus;
  readAt: Date | null;
  createdAt: Date;
}

export async function insertMessage(tx: DbTx, input: SeedMessageInput): Promise<string> {
  if (input.senderType !== 'agent' && input.senderId !== null) {
    throw new Error(`Mensagem ${input.id}: só sender_type 'agent' pode ter sender_id.`);
  }
  await tx.query(
    `INSERT INTO messages (id, conversation_id, tenant_id, sender_type, sender_id, content,
                           message_type, status, read_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      input.id,
      input.conversationId,
      input.tenantId,
      input.senderType,
      input.senderId,
      input.content,
      input.messageType,
      input.status,
      input.readAt ? iso(input.readAt) : null,
      iso(input.createdAt),
    ],
  );
  return input.id;
}

// -------------------------------------------------------------------- proposal

export interface SeedProposalItem {
  examId: string;
  examName: string;
  unitPrice: number;
  quantity: number;
}

export interface SeedStatusStep {
  status: ProposalStatus;
  changedBy: string | null;
  changedAt: Date;
}

export interface SeedProposalInput {
  id: string;
  tenantId: string;
  conversationId: string;
  createdBy: string;
  items: SeedProposalItem[];
  discountPercent: number;
  /**
   * Caminho completo pelos estagios, do `novo_contato` inicial ate o estagio
   * atual. O ultimo passo define `proposals.status`.
   */
  path: SeedStatusStep[];
  approvalStatus: ApprovalStatus;
  approvedBy: string | null;
  approvedAt: Date | null;
  reasonLost: LossReason | null;
  sentAt: Date | null;
  createdAt: Date;
}

export interface SeedProposalResult {
  id: string;
  status: ProposalStatus;
  totalPrice: number;
  closedAt: Date | null;
}

/** Valida o caminho contra a matriz canonica. Erro aqui = seed incoerente. */
export function assertValidPath(path: readonly SeedStatusStep[], proposalId: string): void {
  const first = path[0];
  if (!first) throw new Error(`Proposta ${proposalId}: caminho de estágios vazio.`);
  if (first.status !== 'novo_contato') {
    throw new Error(`Proposta ${proposalId}: o caminho precisa começar em 'novo_contato'.`);
  }
  for (let i = 1; i < path.length; i += 1) {
    const from = path[i - 1] as SeedStatusStep;
    const to = path[i] as SeedStatusStep;
    if (!isTransitionAllowed(from.status, to.status)) {
      throw new Error(
        `Proposta ${proposalId}: transição ilegal ${from.status} → ${to.status}. ` +
          `Permitidas: ${ALLOWED_TRANSITIONS[from.status].join(', ') || '(nenhuma — terminal)'}`,
      );
    }
    if (to.changedAt.getTime() < from.changedAt.getTime()) {
      throw new Error(`Proposta ${proposalId}: histórico fora de ordem cronológica.`);
    }
  }
}

export async function insertProposal(
  tx: DbTx,
  input: SeedProposalInput,
): Promise<SeedProposalResult> {
  assertValidPath(input.path, input.id);

  const last = input.path[input.path.length - 1] as SeedStatusStep;
  const status = last.status;
  const isTerminal = TERMINAL_STATUSES.includes(status);

  if (status === 'perdido' && !input.reasonLost) {
    throw new Error(`Proposta ${input.id}: status 'perdido' exige reasonLost (BR §3).`);
  }
  if (status !== 'perdido' && input.reasonLost) {
    throw new Error(`Proposta ${input.id}: reasonLost só faz sentido em 'perdido'.`);
  }
  if (input.items.length === 0) {
    throw new Error(`Proposta ${input.id}: proposta sem itens.`);
  }

  // BR §1 — o total NUNCA é digitado: vem da função canônica de @crm-lab/shared.
  const totalPrice = calculateTotal(input.items, input.discountPercent);
  const closedAt = isTerminal ? last.changedAt : null;

  await tx.query(
    `INSERT INTO proposals (id, tenant_id, conversation_id, created_by, status,
                            discount_percent, total_price, reason_lost,
                            approval_status, approved_by, approved_at,
                            sent_at, closed_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      input.id,
      input.tenantId,
      input.conversationId,
      input.createdBy,
      status,
      input.discountPercent,
      totalPrice,
      input.reasonLost,
      input.approvalStatus,
      input.approvedBy,
      input.approvedAt ? iso(input.approvedAt) : null,
      input.sentAt ? iso(input.sentAt) : null,
      closedAt ? iso(closedAt) : null,
      iso(input.createdAt),
      iso(last.changedAt),
    ],
  );

  for (const [index, item] of input.items.entries()) {
    await tx.query(
      `INSERT INTO proposal_items (id, tenant_id, proposal_id, exam_id, quantity,
                                   unit_price, exam_name, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        deriveItemId(input.id, index),
        input.tenantId, // D-002: sempre o tenant da proposta pai
        input.id,
        item.examId,
        item.quantity,
        item.unitPrice,
        item.examName,
        iso(input.createdAt),
      ],
    );
  }

  for (const [index, step] of input.path.entries()) {
    await tx.query(
      `INSERT INTO proposal_status_history (id, tenant_id, proposal_id, status, changed_by, changed_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        deriveHistoryId(input.id, index),
        input.tenantId,
        input.id,
        step.status,
        step.changedBy,
        iso(step.changedAt),
      ],
    );
  }

  return { id: input.id, status, totalPrice, closedAt };
}

/** IDs derivados do id da proposta — deterministicos sem precisar de contador. */
function deriveItemId(proposalId: string, index: number): string {
  return seedUuid('proposal-item', proposalId, index);
}
function deriveHistoryId(proposalId: string, index: number): string {
  return seedUuid('proposal-history', proposalId, index);
}

// ------------------------------------------------------------ chat interno

export async function insertChannel(
  tx: DbTx,
  input: {
    id: string;
    tenantId: string;
    key: string;
    name: string;
    kind: 'channel' | 'dm';
    createdAt: Date;
  },
): Promise<string> {
  await tx.query(
    `INSERT INTO internal_channels (id, tenant_id, key, name, kind, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [input.id, input.tenantId, input.key, input.name, input.kind, iso(input.createdAt)],
  );
  return input.id;
}

export async function insertInternalMessage(
  tx: DbTx,
  input: {
    id: string;
    tenantId: string;
    channelId: string;
    senderId: string | null;
    content: string;
    attachedProposalId: string | null;
    isSystem: boolean;
    createdAt: Date;
  },
): Promise<string> {
  if (input.isSystem && input.senderId !== null) {
    throw new Error(`Mensagem interna ${input.id}: mensagem de sistema não tem sender_id.`);
  }
  await tx.query(
    `INSERT INTO internal_messages (id, tenant_id, channel_id, sender_id, content,
                                    attached_proposal_id, is_system, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.id,
      input.tenantId,
      input.channelId,
      input.senderId,
      input.content,
      input.attachedProposalId,
      input.isSystem,
      iso(input.createdAt),
    ],
  );
  return input.id;
}

// ------------------------------------------------------------------- auditoria

export async function insertAuditLog(
  tx: DbTx,
  input: {
    id: string;
    tenantId: string;
    userId: string | null;
    action: string;
    entityType: string;
    entityId: string;
    oldValues: Record<string, unknown> | null;
    newValues: Record<string, unknown> | null;
    timestamp: Date;
  },
): Promise<string> {
  await tx.query(
    `INSERT INTO audit_logs (id, tenant_id, user_id, action, entity_type, entity_id,
                             old_values, new_values, ip_address, user_agent, timestamp)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      input.id,
      input.tenantId,
      input.userId,
      input.action,
      input.entityType,
      input.entityId,
      input.oldValues ? JSON.stringify(input.oldValues) : null,
      input.newValues ? JSON.stringify(input.newValues) : null,
      '127.0.0.1',
      'seed/dev',
      iso(input.timestamp),
    ],
  );
  return input.id;
}
