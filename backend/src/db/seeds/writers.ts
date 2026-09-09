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
  type BusinessHours,
  type ConversationChannel,
  type ConversationStatus,
  type DistributionMode,
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

/**
 * Grava o exame e, na MESMA transação, os sinônimos (`exam.synonyms`, Onda 7 —
 * Apêndice C do spec). `tussCode`/`ambCode` são `null` quando a pesquisa do
 * seed não confirmou o código — nunca inventados (D-081). `source` sempre
 * `'manual'` no seed: nenhum exame nasce do LIS nesta onda.
 */
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
                               is_active, category, tuss_code, amb_code, material,
                               source, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, $10, $11, $12, $13, 'manual', $14, $14)`,
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
      exam.tussCode ?? null,
      exam.ambCode ?? null,
      exam.material ?? null,
      iso(input.createdAt),
    ],
  );

  for (const synonym of exam.synonyms ?? []) {
    await insertExamSynonym(tx, {
      tenantId: input.tenantId,
      examId: input.id,
      synonym,
      createdAt: input.createdAt,
    });
  }

  return input.id;
}

// ------------------------------------------------------------------ insurance

export interface SeedInsuranceInput {
  id: string;
  tenantId: string;
  name: string;
  officialName: string | null;
  ansCode: string | null;
  type: 'cooperativa' | 'medicina_grupo' | 'seguradora' | 'autogestao' | 'especial';
  createdAt: Date;
}

export async function insertInsurance(tx: DbTx, input: SeedInsuranceInput): Promise<string> {
  await tx.query(
    `INSERT INTO insurances (id, tenant_id, name, official_name, ans_code, type,
                             is_active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7, $7)`,
    [
      input.id,
      input.tenantId,
      input.name,
      input.officialName,
      input.ansCode,
      input.type,
      iso(input.createdAt),
    ],
  );
  return input.id;
}

// ------------------------------------------------------------------ exam_price

export interface SeedExamPriceInput {
  tenantId: string;
  examId: string;
  insuranceId: string;
  price: number;
  createdAt: Date;
}

export async function insertExamPrice(tx: DbTx, input: SeedExamPriceInput): Promise<void> {
  await tx.query(
    `INSERT INTO exam_prices (tenant_id, exam_id, insurance_id, price, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5)`,
    [input.tenantId, input.examId, input.insuranceId, input.price, iso(input.createdAt)],
  );
}

// --------------------------------------------------------------- exam_synonym

export interface SeedExamSynonymInput {
  tenantId: string;
  examId: string;
  synonym: string;
  createdAt: Date;
}

export async function insertExamSynonym(tx: DbTx, input: SeedExamSynonymInput): Promise<void> {
  await tx.query(
    `INSERT INTO exam_synonyms (tenant_id, exam_id, synonym, created_at) VALUES ($1, $2, $3, $4)`,
    [input.tenantId, input.examId, input.synonym, iso(input.createdAt)],
  );
}

// --------------------------------------------------------------------- patient

export interface SeedPatientInput {
  id: string;
  tenantId: string;
  /** Identidade do paciente no tenant — UNIQUE (tenant_id, phone) (D-059). */
  phone: string;
  name: string | null;
  email: string | null;
  birthDate: string | null; // 'YYYY-MM-DD'
  document: string | null; // CPF, so digitos
  notes: string | null;
  tags: string[];
  createdAt: Date;
}

export async function insertPatient(tx: DbTx, input: SeedPatientInput): Promise<string> {
  if (input.document && !/^\d{11}$/.test(input.document)) {
    throw new Error(`Paciente ${input.id}: document precisa ser CPF só dígitos (11).`);
  }
  await tx.query(
    `INSERT INTO patients (id, tenant_id, phone, name, email, birth_date, document, notes,
                           tags, custom_fields, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '{}'::jsonb, $10, $10)`,
    [
      input.id,
      input.tenantId,
      input.phone,
      input.name,
      input.email,
      input.birthDate,
      input.document,
      input.notes,
      JSON.stringify(input.tags),
      iso(input.createdAt),
    ],
  );
  return input.id;
}

// -------------------------------------------------------------- tenant_channel

export interface SeedTenantChannelInput {
  id: string;
  tenantId: string;
  channel: ConversationChannel;
  displayName: string;
  phoneNumberId: string;
  phoneNumber: string;
  /** SEGREDO: nunca sai do backend (D-064). Aqui e valor de dev/teste. */
  apiToken: string;
  webhookSecret: string;
  isActive: boolean;
  connectedAt: Date;
  createdAt: Date;
}

export async function insertTenantChannel(
  tx: DbTx,
  input: SeedTenantChannelInput,
): Promise<string> {
  await tx.query(
    `INSERT INTO tenant_channels (id, tenant_id, channel, display_name, phone_number_id,
                                  phone_number, api_token, webhook_secret, is_active,
                                  connected_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)`,
    [
      input.id,
      input.tenantId,
      input.channel,
      input.displayName,
      input.phoneNumberId,
      input.phoneNumber,
      input.apiToken,
      input.webhookSecret,
      input.isActive,
      iso(input.connectedAt),
      iso(input.createdAt),
    ],
  );
  return input.id;
}

// ------------------------------------------------------------- tenant_settings

export interface SeedTenantSettingsInput {
  tenantId: string;
  distributionMode: DistributionMode;
  greeting: { enabled: boolean; message: string | null };
  offHours: { enabled: boolean; message: string | null };
  businessHours: BusinessHours;
  createdAt: Date;
}

/**
 * LINHA AUSENTE = DEFAULTS (D-065). O seed so grava para o tenant que precisa
 * DIVERGIR do default — semear a linha em todos escondera o caminho "sem linha",
 * que e o normal em producao.
 */
export async function insertTenantSettings(
  tx: DbTx,
  input: SeedTenantSettingsInput,
): Promise<string> {
  if (input.greeting.enabled && !input.greeting.message) {
    throw new Error(`Settings ${input.tenantId}: saudação ligada exige mensagem.`);
  }
  if (input.offHours.enabled && !input.offHours.message) {
    throw new Error(`Settings ${input.tenantId}: mensagem de fora de horário ligada exige texto.`);
  }
  await tx.query(
    `INSERT INTO tenant_settings (tenant_id, distribution_mode, greeting_enabled, greeting_message,
                                  offhours_enabled, offhours_message, business_hours,
                                  created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $8)`,
    [
      input.tenantId,
      input.distributionMode,
      input.greeting.enabled,
      input.greeting.message,
      input.offHours.enabled,
      input.offHours.message,
      JSON.stringify(input.businessHours),
      iso(input.createdAt),
    ],
  );
  return input.tenantId;
}

// --------------------------------------------------------------- channel_reads

export interface SeedChannelReadInput {
  tenantId: string;
  channelId: string;
  userId: string;
  lastReadAt: Date;
}

/**
 * Estado de leitura por usuario (D-068). AUSENCIA de linha e significativa:
 * "nunca abriu o canal" => `lastReadAt: null` e `unreadCount` conta tudo que
 * nao e do proprio usuario. Por isso o seed deixa combinacoes de proposito sem
 * linha — e assim que o badge do chat interno nasce diferente de zero.
 */
export async function insertChannelRead(tx: DbTx, input: SeedChannelReadInput): Promise<void> {
  await tx.query(
    `INSERT INTO channel_reads (tenant_id, channel_id, user_id, last_read_at, updated_at)
     VALUES ($1, $2, $3, $4, $4)`,
    [input.tenantId, input.channelId, input.userId, iso(input.lastReadAt)],
  );
}

// ---------------------------------------------------------------- conversation

export interface SeedConversationInput {
  id: string;
  tenantId: string;
  patientName: string;
  patientPhone: string;
  patientEmail: string | null;
  /**
   * D-059: liga a conversa ao cadastro. `null` e legitimo (linha anterior ao
   * backfill), mas o seed sempre preenche — dataset com conversa orfa esconderia
   * bug de ficha do paciente.
   */
  patientId: string | null;
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
                                patient_id, assigned_to, channel, status, last_message_at,
                                unread_count, tags, custom_fields, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $13, $6, $7, $8, $9, $10, $11, '{}'::jsonb, $12, $12)`,
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
      input.patientId,
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
  /** Numero sequencial DESTE tenant (migracao 011) — quem chama controla a ordem. */
  proposalNumber: number;
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
    `INSERT INTO proposals (id, tenant_id, proposal_number, conversation_id, created_by, status,
                            discount_percent, total_price, reason_lost,
                            approval_status, approved_by, approved_at,
                            sent_at, closed_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
    [
      input.id,
      input.tenantId,
      input.proposalNumber,
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
                                   unit_price, exam_name, "position", created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        deriveItemId(input.id, index),
        input.tenantId, // D-002: sempre o tenant da proposta pai
        input.id,
        item.examId,
        item.quantity,
        item.unitPrice,
        item.examName,
        index, // D-071: ordem em que o atendente montou o orcamento (base 0)
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
