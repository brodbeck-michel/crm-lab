/**
 * Auxiliares comuns as suites de conversas/mensagens.
 *
 * `seedMessage` escreve direto na tabela (via `withoutTenant`, como as demais
 * factories) porque o cenario precisa existir ANTES do teste — e justamente o
 * RLS e o recorte por papel que o teste vai exercitar depois, pela API.
 */
import { randomUUID } from 'node:crypto';
import type { DbClient } from '../../src/db/types.js';
import { getTestDb } from '../helpers/test-db.js';

export interface SeedMessageInput {
  tenantId: string;
  conversationId: string;
  senderType?: 'patient' | 'agent' | 'system';
  senderId?: string | null;
  content?: string;
  status?: 'sent' | 'delivered' | 'read' | 'failed';
  externalMessageId?: string | null;
  db?: DbClient;
}

export async function seedMessage(input: SeedMessageInput): Promise<{ id: string }> {
  const db = input.db ?? (await getTestDb());
  const id = randomUUID();
  await db.withoutTenant((tx) =>
    tx.query(
      `INSERT INTO messages (id, tenant_id, conversation_id, sender_type, sender_id, content,
                             message_type, status, external_message_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'text', $7, $8)`,
      [
        id,
        input.tenantId,
        input.conversationId,
        input.senderType ?? 'patient',
        input.senderId ?? null,
        input.content ?? 'mensagem de teste',
        input.status ?? 'delivered',
        input.externalMessageId ?? null,
      ],
    ),
  );
  return { id };
}

/** Ajusta o contador de nao lidas sem passar pela API. */
export async function setUnreadCount(
  conversationId: string,
  unread: number,
  db?: DbClient,
): Promise<void> {
  const client = db ?? (await getTestDb());
  await client.withoutTenant((tx) =>
    tx.query('UPDATE conversations SET unread_count = $2 WHERE id = $1', [conversationId, unread]),
  );
}

/** Le a conversa crua (sem RLS) — usado para checar efeito no banco. */
export async function readConversationRow(
  conversationId: string,
  db?: DbClient,
): Promise<{ unread_count: number; assigned_to: string | null; status: string } | undefined> {
  const client = db ?? (await getTestDb());
  const result = await client.withoutTenant((tx) =>
    tx.query<{ unread_count: number; assigned_to: string | null; status: string }>(
      'SELECT unread_count, assigned_to, status FROM conversations WHERE id = $1',
      [conversationId],
    ),
  );
  return result.rows[0];
}

/** Conta mensagens de um tenant — a prova de que o webhook nao tocou no banco. */
export async function countMessages(tenantId: string, db?: DbClient): Promise<number> {
  const client = db ?? (await getTestDb());
  const result = await client.withoutTenant((tx) =>
    tx.query<{ total: number }>(
      'SELECT COUNT(*)::int AS total FROM messages WHERE tenant_id = $1',
      [tenantId],
    ),
  );
  return Number(result.rows[0]?.total ?? 0);
}

export async function countConversations(tenantId: string, db?: DbClient): Promise<number> {
  const client = db ?? (await getTestDb());
  const result = await client.withoutTenant((tx) =>
    tx.query<{ total: number }>(
      'SELECT COUNT(*)::int AS total FROM conversations WHERE tenant_id = $1',
      [tenantId],
    ),
  );
  return Number(result.rows[0]?.total ?? 0);
}
