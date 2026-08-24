/**
 * Factories de teste.
 *
 * Todas escrevem via `withoutTenant()` — de proposito. As factories rodam como
 * dono das tabelas (fora do RLS) porque precisam montar o cenario de DOIS
 * tenants ANTES do teste; e justamente o RLS que o teste vai exercitar depois,
 * pelo `withTenant()`. Isso permite escrever um teste de isolamento em 3 linhas:
 *
 *   const a = await createTenant();
 *   const b = await createTenant();
 *   await createConversation({ tenantId: b.id });
 *   // dentro de withTenant(a.id) nenhuma conversa de B aparece
 *
 * Todas aceitam overrides parciais e devolvem a linha inserida (camelCase).
 */
import { randomUUID } from 'node:crypto';
import type { UserRole } from '@crm-lab/shared';
import { DEFAULT_DISCOUNT_LIMIT } from '@crm-lab/shared';
import { hashPassword } from '../../src/lib/password.js';
import type { DbClient } from '../../src/db/types.js';
import { getTestDb } from './test-db.js';

let counter = 0;
const seq = (): number => (counter += 1);

async function client(db?: DbClient): Promise<DbClient> {
  return db ?? (await getTestDb());
}

// ---------------------------------------------------------------------------
// tenants
// ---------------------------------------------------------------------------

export interface TenantRecord {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
}

export interface CreateTenantInput {
  id?: string;
  name?: string;
  slug?: string;
  isActive?: boolean;
  subscriptionPlan?: string;
  db?: DbClient;
}

export async function createTenant(input: CreateTenantInput = {}): Promise<TenantRecord> {
  const db = await client(input.db);
  const n = seq();
  const id = input.id ?? randomUUID();
  const name = input.name ?? `Lab Teste ${n}`;
  const slug = input.slug ?? `lab-teste-${n}`;
  const isActive = input.isActive ?? true;

  await db.withoutTenant((tx) =>
    tx.query(
      `INSERT INTO tenants (id, name, slug, is_active, subscription_plan)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, name, slug, isActive, input.subscriptionPlan ?? 'pro'],
    ),
  );
  return { id, name, slug, isActive };
}

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

export const DEFAULT_TEST_PASSWORD = 'senha-de-teste-123';

export interface UserRecord {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  role: UserRole;
  discountLimit: number;
  isActive: boolean;
  /** Senha em texto claro usada no hash — para `loginAs`. Nunca existe em prod. */
  password: string;
}

export interface CreateUserInput {
  id?: string;
  tenantId: string;
  email?: string;
  name?: string;
  /** Hasheada de verdade com bcrypt (custo 4 em teste). */
  password?: string;
  role?: UserRole;
  discountLimit?: number;
  isActive?: boolean;
  db?: DbClient;
}

export async function createUser(input: CreateUserInput): Promise<UserRecord> {
  const db = await client(input.db);
  const n = seq();
  const id = input.id ?? randomUUID();
  const role: UserRole = input.role ?? 'attendant';
  const email = input.email ?? `user${n}@teste.local`;
  const name = input.name ?? `Usuario ${n}`;
  const password = input.password ?? DEFAULT_TEST_PASSWORD;
  const discountLimit = input.discountLimit ?? DEFAULT_DISCOUNT_LIMIT[role];
  const isActive = input.isActive ?? true;
  const passwordHash = await hashPassword(password);

  await db.withoutTenant((tx) =>
    tx.query(
      `INSERT INTO users (id, tenant_id, email, password_hash, name, role,
                          discount_limit_percent, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, input.tenantId, email, passwordHash, name, role, discountLimit, isActive],
    ),
  );

  return { id, tenantId: input.tenantId, email, name, role, discountLimit, isActive, password };
}

// ---------------------------------------------------------------------------
// conversations
// ---------------------------------------------------------------------------

export interface ConversationRecord {
  id: string;
  tenantId: string;
  patientPhone: string;
  patientName: string;
  assignedTo: string | null;
  status: string;
}

export interface CreateConversationInput {
  id?: string;
  tenantId: string;
  patientPhone?: string;
  patientName?: string;
  patientEmail?: string;
  assignedTo?: string | null;
  channel?: string;
  status?: 'active' | 'archived' | 'closed';
  db?: DbClient;
}

export async function createConversation(
  input: CreateConversationInput,
): Promise<ConversationRecord> {
  const db = await client(input.db);
  const n = seq();
  const id = input.id ?? randomUUID();
  const patientPhone = input.patientPhone ?? `+5548999${String(100000 + n).slice(-6)}`;
  const patientName = input.patientName ?? `Paciente ${n}`;
  const assignedTo = input.assignedTo ?? null;
  const status = input.status ?? 'active';

  await db.withoutTenant((tx) =>
    tx.query(
      `INSERT INTO conversations (id, tenant_id, patient_phone, patient_name, patient_email,
                                  assigned_to, channel, status, last_message_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
      [
        id,
        input.tenantId,
        patientPhone,
        patientName,
        input.patientEmail ?? null,
        assignedTo,
        input.channel ?? 'whatsapp',
        status,
      ],
    ),
  );

  return { id, tenantId: input.tenantId, patientPhone, patientName, assignedTo, status };
}

// ---------------------------------------------------------------------------
// exam_catalog
// ---------------------------------------------------------------------------

export interface ExamRecord {
  id: string;
  tenantId: string;
  name: string;
  code: string;
  pricePrivate: number;
  priceInsurance: number;
  isActive: boolean;
}

export interface CreateExamInput {
  id?: string;
  tenantId: string;
  name?: string;
  code?: string;
  pricePrivate?: number;
  priceInsurance?: number;
  isActive?: boolean;
  category?: string;
  turnaroundHours?: number;
  db?: DbClient;
}

export async function createExam(input: CreateExamInput): Promise<ExamRecord> {
  const db = await client(input.db);
  const n = seq();
  const id = input.id ?? randomUUID();
  const name = input.name ?? `Exame ${n}`;
  const code = input.code ?? `EX${String(n).padStart(4, '0')}`;
  const pricePrivate = input.pricePrivate ?? 89.9;
  const priceInsurance = input.priceInsurance ?? 45.5;
  const isActive = input.isActive ?? true;

  await db.withoutTenant((tx) =>
    tx.query(
      `INSERT INTO exam_catalog (id, tenant_id, name, code, price_private, price_insurance,
                                 is_active, category, turnaround_hours)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        input.tenantId,
        name,
        code,
        pricePrivate,
        priceInsurance,
        isActive,
        input.category ?? 'Bioquimica',
        input.turnaroundHours ?? 24,
      ],
    ),
  );

  return { id, tenantId: input.tenantId, name, code, pricePrivate, priceInsurance, isActive };
}

// ---------------------------------------------------------------------------
// proposals (+ items)
// ---------------------------------------------------------------------------

export interface ProposalItemInput {
  examId: string;
  examName: string;
  quantity?: number;
  unitPrice: number;
}

export interface ProposalRecord {
  id: string;
  tenantId: string;
  conversationId: string;
  createdBy: string;
  status: string;
  discountPercent: number;
  totalPrice: number;
  approvalStatus: string;
  itemIds: string[];
}

export interface CreateProposalInput {
  id?: string;
  tenantId: string;
  conversationId?: string;
  createdBy?: string;
  status?: string;
  discountPercent?: number;
  /** Se omitido, deriva de `items` (ou 0 quando nao ha itens). */
  totalPrice?: number;
  approvalStatus?: 'none' | 'pending' | 'approved' | 'rejected';
  reasonLost?: string | null;
  items?: ProposalItemInput[];
  db?: DbClient;
}

/**
 * Cria proposta e, opcionalmente, seus itens. Quando `conversationId` ou
 * `createdBy` faltam, a factory cria as dependencias no mesmo tenant — assim o
 * teste que so quer "uma proposta do tenant X" escreve uma linha.
 */
export async function createProposal(input: CreateProposalInput): Promise<ProposalRecord> {
  const db = await client(input.db);
  const id = input.id ?? randomUUID();
  const tenantId = input.tenantId;

  const createdBy =
    input.createdBy ?? (await createUser({ tenantId, role: 'attendant', db })).id;
  const conversationId =
    input.conversationId ?? (await createConversation({ tenantId, db })).id;

  const items = input.items ?? [];
  const discountPercent = input.discountPercent ?? 0;
  const subtotal = items.reduce((sum, it) => sum + it.unitPrice * (it.quantity ?? 1), 0);
  const totalPrice =
    input.totalPrice ?? Number((subtotal * (1 - discountPercent / 100)).toFixed(2));

  await db.withoutTenant(async (tx) => {
    await tx.query(
      `INSERT INTO proposals (id, tenant_id, conversation_id, created_by, status,
                              discount_percent, total_price, approval_status, reason_lost)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        tenantId,
        conversationId,
        createdBy,
        input.status ?? 'novo_contato',
        discountPercent,
        totalPrice,
        input.approvalStatus ?? 'none',
        input.reasonLost ?? null,
      ],
    );
  });

  const itemIds: string[] = [];
  for (const item of items) {
    const itemId = randomUUID();
    itemIds.push(itemId);
    await db.withoutTenant((tx) =>
      tx.query(
        `INSERT INTO proposal_items (id, tenant_id, proposal_id, exam_id, quantity,
                                     unit_price, exam_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [itemId, tenantId, id, item.examId, item.quantity ?? 1, item.unitPrice, item.examName],
      ),
    );
  }

  return {
    id,
    tenantId,
    conversationId,
    createdBy,
    status: input.status ?? 'novo_contato',
    discountPercent,
    totalPrice,
    approvalStatus: input.approvalStatus ?? 'none',
    itemIds,
  };
}

/** Cenario pronto: tenant + admin + atendente + conversa + exame. */
export async function createTenantScenario(
  overrides: { db?: DbClient } = {},
): Promise<{
  tenant: TenantRecord;
  admin: UserRecord;
  attendant: UserRecord;
  conversation: ConversationRecord;
  exam: ExamRecord;
}> {
  const db = overrides.db;
  const tenant = await createTenant({ db });
  const admin = await createUser({ tenantId: tenant.id, role: 'admin', db });
  const attendant = await createUser({ tenantId: tenant.id, role: 'attendant', db });
  const conversation = await createConversation({
    tenantId: tenant.id,
    assignedTo: attendant.id,
    db,
  });
  const exam = await createExam({ tenantId: tenant.id, db });
  return { tenant, admin, attendant, conversation, exam };
}
