/**
 * Apoio das suites de proposta/aprovacao/chat interno.
 *
 * Monta a MESMA arvore de services que a rota monta (`createProposalServices`),
 * para que teste de service e teste de endpoint exercitem o mesmo grafo de
 * dependencias — sem mock de regra de negocio.
 */
import type { UserRole } from '@crm-lab/shared';
import type { DbClient } from '../../src/db/types.js';
import type { TenantContext } from '../../src/http/context.js';
import { MemoryCache } from '../../src/lib/cache.js';
import { createProposalServices } from '../../src/controllers/proposal.routes.js';
import type { ProposalModuleServices } from '../../src/controllers/proposal.routes.js';
import { createInternalChatService } from '../../src/services/internal-chat.service.js';
import type { InternalChatService } from '../../src/services/internal-chat.service.js';
import { createAuditService, type AuditService } from '../../src/services/audit.service.js';
import { ExamRepository } from '../../src/repositories/exam.repository.js';
import { ExamCatalogService } from '../../src/services/exam-catalog.service.js';
import { FakeWsHub } from '../helpers/fake-ws.js';

export interface UserLike {
  id: string;
  tenantId: string;
  role: UserRole;
  discountLimit: number;
}

/** `TenantContext` equivalente ao que `requireAuth` monta a partir do JWT. */
export function ctxOf(user: UserLike, overrides: Partial<TenantContext> = {}): TenantContext {
  return {
    userId: user.id,
    tenantId: user.tenantId,
    role: user.role,
    discountLimit: user.discountLimit,
    ip: '10.0.0.1',
    userAgent: 'vitest',
    ...overrides,
  };
}

export interface Harness extends ProposalModuleServices {
  db: DbClient;
  wsHub: FakeWsHub;
  cache: MemoryCache;
  chat: InternalChatService;
  audit: AuditService;
  examCatalog: ExamCatalogService;
}

export function buildHarness(db: DbClient, wsHub: FakeWsHub = new FakeWsHub()): Harness {
  const cache = new MemoryCache();
  const services = createProposalServices({ db, cache, wsHub });
  return {
    ...services,
    db,
    wsHub,
    cache,
    chat: createInternalChatService(db, wsHub),
    audit: createAuditService(db),
    examCatalog: new ExamCatalogService(new ExamRepository(db), cache),
  };
}

/** Le as acoes de auditoria gravadas para uma entidade (fora do RLS, so leitura). */
export async function auditActionsFor(db: DbClient, entityId: string): Promise<string[]> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ action: string }>(
      'SELECT action FROM audit_logs WHERE entity_id = $1 ORDER BY timestamp ASC',
      [entityId],
    ),
  );
  return result.rows.map((row) => row.action);
}

/** Mensagens de sistema gravadas numa conversa. */
export async function systemMessagesOf(
  db: DbClient,
  conversationId: string,
): Promise<string[]> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ content: string }>(
      `SELECT content FROM messages
        WHERE conversation_id = $1 AND sender_type = 'system'
        ORDER BY created_at ASC`,
      [conversationId],
    ),
  );
  return result.rows.map((row) => row.content);
}

/** Posts do canal interno, por chave de canal. */
export async function channelPosts(
  db: DbClient,
  tenantId: string,
  key: string,
): Promise<Array<{ content: string; attachedProposalId: string | null; isSystem: boolean }>> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ content: string; attached_proposal_id: string | null; is_system: boolean }>(
      `SELECT m.content, m.attached_proposal_id, m.is_system
         FROM internal_messages m
         JOIN internal_channels c ON c.id = m.channel_id
        WHERE c.tenant_id = $1 AND c.key = $2
        ORDER BY m.created_at ASC`,
      [tenantId, key],
    ),
  );
  return result.rows.map((row) => ({
    content: row.content,
    attachedProposalId: row.attached_proposal_id,
    isSystem: row.is_system,
  }));
}

/** Muda o preco do catalogo direto no banco — simula "o preco mudou depois". */
export async function setExamPrice(
  db: DbClient,
  examId: string,
  pricePrivate: number,
): Promise<void> {
  await db.withoutTenant((tx) =>
    tx.query('UPDATE exam_catalog SET price_private = $1 WHERE id = $2', [pricePrivate, examId]),
  );
}
