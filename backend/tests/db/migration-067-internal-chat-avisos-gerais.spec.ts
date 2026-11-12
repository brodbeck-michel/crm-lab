/**
 * Migração 067 — chat interno sem aprovação (CRMLAB-146, D-318). Roda o próprio
 * arquivo da migração sobre o estado de antes e confere:
 *  - os posts de sistema com proposta anexada saem de `aprovacoes` e vão para
 *    `internal_messages_approval_archive` (continuam no banco);
 *  - mensagem de pessoa no mesmo canal fica;
 *  - `aprovacoes` vira `avisos` / `Avisos gerais` e `#geral` vira `Geral`;
 *  - a segunda execução não muda nada.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../src/db/types.js';
import {
  createProposal,
  createTenant,
  createUser,
  type TenantRecord,
} from '../helpers/factories.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

const SQL_URL = new URL('../../migrations/067_internal_chat_avisos_gerais.sql', import.meta.url);

let db: DbClient;
let tenant: TenantRecord;

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  tenant = await createTenant({ name: 'Lab A', slug: 'lab-a', db });
});

async function runMigration(): Promise<void> {
  const sql = await readFile(SQL_URL, 'utf8');
  await db.withoutTenant((tx) => tx.exec(sql));
}

async function channel(key: string, name: string): Promise<string> {
  const id = randomUUID();
  await db.withoutTenant((tx) =>
    tx.query(
      `INSERT INTO internal_channels (id, tenant_id, key, name, kind)
       VALUES ($1, $2, $3, $4, 'channel')`,
      [id, tenant.id, key, name],
    ),
  );
  return id;
}

async function message(
  channelId: string,
  input: { senderId: string | null; content: string; proposalId: string | null },
): Promise<string> {
  const id = randomUUID();
  await db.withoutTenant((tx) =>
    tx.query(
      `INSERT INTO internal_messages
         (id, tenant_id, channel_id, sender_id, content, attached_proposal_id, is_system)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, tenant.id, channelId, input.senderId, input.content, input.proposalId, input.senderId === null],
    ),
  );
  return id;
}

async function ids(table: string): Promise<string[]> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ id: string }>(`SELECT id FROM ${table} ORDER BY id`),
  );
  return result.rows.map((r) => r.id);
}

async function channels(): Promise<Array<{ id: string; key: string; name: string }>> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ id: string; key: string; name: string }>(
      'SELECT id, key, name FROM internal_channels ORDER BY key',
    ),
  );
  return result.rows;
}

describe('migração 067', () => {
  it('arquiva os posts de aprovação, renomeia os canais e é idempotente', async () => {
    const attendant = await createUser({ tenantId: tenant.id, role: 'attendant', db });
    const proposal = await createProposal({ tenantId: tenant.id, approvalStatus: 'pending', db });
    const aprovacoes = await channel('aprovacoes', '#aprovacoes');
    const geral = await channel('geral', '#geral');

    const pedido = await message(aprovacoes, {
      senderId: null,
      content: '@gestor Pedido de aprovação de desconto: Ana - R$ 100,00',
      proposalId: proposal.id,
    });
    const decisao = await message(aprovacoes, {
      senderId: null,
      content: 'Desconto de 25% APROVADO na proposta #1.',
      proposalId: proposal.id,
    });
    const conversa = await message(aprovacoes, {
      senderId: attendant.id,
      content: 'Consegue olhar?',
      proposalId: null,
    });
    const doGeral = await message(geral, {
      senderId: attendant.id,
      content: 'Bom dia',
      proposalId: null,
    });

    await runMigration();

    expect(await ids('internal_messages')).toEqual([conversa, doGeral].sort());
    expect(await ids('internal_messages_approval_archive')).toEqual([pedido, decisao].sort());
    expect(await channels()).toEqual([
      { id: aprovacoes, key: 'avisos', name: 'Avisos gerais' },
      { id: geral, key: 'geral', name: 'Geral' },
    ]);

    await runMigration();

    expect(await ids('internal_messages')).toEqual([conversa, doGeral].sort());
    expect(await ids('internal_messages_approval_archive')).toEqual([pedido, decisao].sort());
    expect((await channels()).map((c) => c.name)).toEqual(['Avisos gerais', 'Geral']);
  });

  it('o arquivo respeita o tenant (RLS)', async () => {
    const outro = await createTenant({ name: 'Lab B', slug: 'lab-b', db });
    const proposal = await createProposal({ tenantId: tenant.id, approvalStatus: 'pending', db });
    const aprovacoes = await channel('aprovacoes', '#aprovacoes');
    await message(aprovacoes, { senderId: null, content: 'Pedido', proposalId: proposal.id });

    await runMigration();

    const doOutro = await db.withTenant(outro.id, (tx) =>
      tx.query('SELECT id FROM internal_messages_approval_archive'),
    );
    expect(doOutro.rows).toHaveLength(0);
    const doDono = await db.withTenant(tenant.id, (tx) =>
      tx.query('SELECT id FROM internal_messages_approval_archive'),
    );
    expect(doDono.rows).toHaveLength(1);
  });
});
