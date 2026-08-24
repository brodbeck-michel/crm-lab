/**
 * Testes do seed de desenvolvimento.
 *
 * O que estes testes protegem: um seed incoerente e pior que nenhum seed — ele
 * faz todo mundo desenvolver contra dados que o backend nunca produziria. Por
 * isso aqui nao se verifica so "rodou": verifica-se que os dados semeados
 * OBEDECEM as mesmas regras que os services vao obedecer.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ALLOWED_TRANSITIONS,
  calculateTotal,
  LOSS_REASONS,
  PROPOSAL_STATUSES,
  TERMINAL_STATUSES,
  type LossReason,
  type ProposalStatus,
} from '@crm-lab/shared';
import { runSeeds } from '../../src/db/seeds/index.js';
import { getTestDb } from '../helpers/test-db.js';
import type { DbClient } from '../../src/db/types.js';

/** `now` fixo: com ele o dataset inteiro fica deterministico (IDs e datas). */
const NOW = new Date('2026-08-23T12:00:00.000Z');

let db: DbClient;

async function count(table: string): Promise<number> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${table}`),
  );
  return result.rows[0]?.n ?? 0;
}

const DATA_TABLES = [
  'tenants',
  'users',
  'themes',
  'exam_catalog',
  'conversations',
  'messages',
  'proposals',
  'proposal_items',
  'proposal_status_history',
  'internal_channels',
  'internal_messages',
  'audit_logs',
] as const;

describe('seed de desenvolvimento', () => {
  beforeAll(async () => {
    db = await getTestDb();
    await runSeeds(db, { now: NOW, print: false });
  }, 120_000);

  it('roda em banco limpo e popula todas as tabelas de dados', async () => {
    for (const table of DATA_TABLES) {
      expect(await count(table), `tabela ${table} vazia`).toBeGreaterThan(0);
    }
  });

  it('roda duas vezes sem duplicar nem quebrar (idempotente)', async () => {
    const before: Record<string, number> = {};
    for (const table of DATA_TABLES) before[table] = await count(table);

    await runSeeds(db, { now: NOW, print: false });

    for (const table of DATA_TABLES) {
      expect(await count(table), `tabela ${table} duplicou`).toBe(before[table]);
    }

    // Nenhum e-mail repetido dentro do mesmo tenant.
    const dup = await db.withoutTenant((tx) =>
      tx.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM (
           SELECT tenant_id, email FROM users GROUP BY tenant_id, email HAVING COUNT(*) > 1
         ) d`,
      ),
    );
    expect(dup.rows[0]?.n).toBe(0);
  }, 120_000);

  it('cria os dois laboratórios com temas diferentes', async () => {
    const result = await db.withoutTenant((tx) =>
      tx.query<{ slug: string; name: string; accent: string }>(
        `SELECT t.slug, th.name, th.accent
           FROM tenants t JOIN themes th ON th.tenant_id = t.id
          WHERE t.slug IN ('lab-vida', 'lab-central')
          ORDER BY t.slug`,
      ),
    );
    expect(result.rows).toHaveLength(2);
    const [central, vida] = result.rows;
    expect(vida?.slug).toBe('lab-vida');
    expect(vida?.name).toBe('Terracota & Sálvia');
    expect(central?.slug).toBe('lab-central');
    expect(central?.name).toBe('Azul Jaleco');
    expect(vida?.accent).not.toBe(central?.accent);
  });

  it('cria os 4 papéis com os limites de DEFAULT_DISCOUNT_LIMIT', async () => {
    const result = await db.withoutTenant((tx) =>
      tx.query<{ email: string; role: string; discount_limit_percent: number }>(
        `SELECT email, role, discount_limit_percent FROM users ORDER BY email`,
      ),
    );
    const byEmail = new Map(result.rows.map((row) => [row.email, row]));
    expect(byEmail.get('admin@labvida.com.br')).toMatchObject({
      role: 'admin',
      discount_limit_percent: 100,
    });
    expect(byEmail.get('gestor@labvida.com.br')).toMatchObject({
      role: 'manager',
      discount_limit_percent: 30,
    });
    expect(byEmail.get('maria@labvida.com.br')).toMatchObject({
      role: 'attendant',
      discount_limit_percent: 15,
    });
    expect(byEmail.get('joao@labvida.com.br')).toMatchObject({
      role: 'attendant',
      discount_limit_percent: 15,
    });
    expect(byEmail.get('operador@crmlab.com.br')?.role).toBe('platform_operator');
  });

  it('tem mais de 50 exames no catálogo do tenant principal, com convênio < particular', async () => {
    const result = await db.withoutTenant((tx) =>
      tx.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM exam_catalog e
           JOIN tenants t ON t.id = e.tenant_id WHERE t.slug = 'lab-vida'`,
      ),
    );
    expect(result.rows[0]?.n ?? 0).toBeGreaterThanOrEqual(50);

    const invalid = await db.withoutTenant((tx) =>
      tx.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM exam_catalog WHERE price_insurance >= price_private`,
      ),
    );
    expect(invalid.rows[0]?.n).toBe(0);
  });

  it('cria os canais #geral e #aprovacoes em cada laboratório', async () => {
    const result = await db.withoutTenant((tx) =>
      tx.query<{ slug: string; key: string }>(
        `SELECT t.slug, c.key FROM internal_channels c
           JOIN tenants t ON t.id = c.tenant_id
          WHERE t.slug IN ('lab-vida', 'lab-central') ORDER BY t.slug, c.key`,
      ),
    );
    expect(result.rows.map((r) => `${r.slug}:${r.key}`)).toEqual([
      'lab-central:aprovacoes',
      'lab-central:geral',
      'lab-vida:aprovacoes',
      'lab-vida:geral',
    ]);
  });

  it('tem conversas não atribuídas, não lidas e mensagens dos 3 tipos', async () => {
    const unassigned = await db.withoutTenant((tx) =>
      tx.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM conversations WHERE assigned_to IS NULL`,
      ),
    );
    expect(unassigned.rows[0]?.n ?? 0).toBeGreaterThan(0);

    const unread = await db.withoutTenant((tx) =>
      tx.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM conversations WHERE unread_count > 0`,
      ),
    );
    expect(unread.rows[0]?.n ?? 0).toBeGreaterThan(0);

    const types = await db.withoutTenant((tx) =>
      tx.query<{ sender_type: string }>(
        `SELECT DISTINCT sender_type FROM messages ORDER BY sender_type`,
      ),
    );
    expect(types.rows.map((r) => r.sender_type)).toEqual(['agent', 'patient', 'system']);
  });

  it('preenche os 6 estágios do pipeline', async () => {
    const result = await db.withoutTenant((tx) =>
      tx.query<{ status: ProposalStatus }>(`SELECT DISTINCT status FROM proposals`),
    );
    const present = new Set(result.rows.map((r) => r.status));
    for (const status of PROPOSAL_STATUSES) {
      expect(present.has(status), `nenhuma proposta em '${status}'`).toBe(true);
    }
  });

  it('mantém o funil coerente: conversas > propostas > ganhos (BR §6)', async () => {
    const conversations = await count('conversations');
    const proposals = await count('proposals');
    const won = await db.withoutTenant((tx) =>
      tx.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM proposals WHERE status = 'ganho'`),
    );
    const wonCount = won.rows[0]?.n ?? 0;

    expect(conversations).toBeGreaterThan(proposals);
    expect(proposals).toBeGreaterThan(wonCount);
    // "Taxa de ganho anormalmente alta" é o alarme da própria regra §6.
    expect(wonCount / proposals).toBeLessThan(0.5);
    expect(wonCount).toBeGreaterThan(0);
  });

  it('espalha created_at no tempo (datas relativas fazem sentido)', async () => {
    const result = await db.withoutTenant((tx) =>
      tx.query<{ dias: number }>(
        `SELECT COUNT(DISTINCT DATE(created_at))::int AS dias FROM conversations`,
      ),
    );
    expect(result.rows[0]?.dias ?? 0).toBeGreaterThan(20);
  });

  it('deriva todo total_price de calculateTotal(items, discount) (BR §1)', async () => {
    const proposals = await db.withoutTenant((tx) =>
      tx.query<{ id: string; discount_percent: number; total_price: number }>(
        `SELECT id, discount_percent, total_price FROM proposals`,
      ),
    );
    const items = await db.withoutTenant((tx) =>
      tx.query<{ proposal_id: string; unit_price: number; quantity: number }>(
        `SELECT proposal_id, unit_price, quantity FROM proposal_items`,
      ),
    );
    const byProposal = new Map<string, Array<{ unitPrice: number; quantity: number }>>();
    for (const item of items.rows) {
      const list = byProposal.get(item.proposal_id) ?? [];
      list.push({ unitPrice: Number(item.unit_price), quantity: Number(item.quantity) });
      byProposal.set(item.proposal_id, list);
    }

    expect(proposals.rows.length).toBeGreaterThan(0);
    for (const proposal of proposals.rows) {
      const list = byProposal.get(proposal.id);
      expect(list, `proposta ${proposal.id} sem itens`).toBeDefined();
      const expected = calculateTotal(
        list as Array<{ unitPrice: number; quantity: number }>,
        Number(proposal.discount_percent),
      );
      expect(Number(proposal.total_price), `total da proposta ${proposal.id}`).toBe(expected);
    }
  });

  it('exige reason_lost válido em perdido e nenhum fora dele (BR §3)', async () => {
    const result = await db.withoutTenant((tx) =>
      tx.query<{ status: ProposalStatus; reason_lost: string | null }>(
        `SELECT status, reason_lost FROM proposals`,
      ),
    );
    const reasons = new Set<string>();
    for (const row of result.rows) {
      if (row.status === 'perdido') {
        expect(row.reason_lost, 'proposta perdida sem motivo').not.toBeNull();
        expect(LOSS_REASONS).toContain(row.reason_lost as LossReason);
        reasons.add(row.reason_lost as string);
      } else {
        expect(row.reason_lost, `reason_lost em status ${row.status}`).toBeNull();
      }
    }
    // O gráfico de motivos de perda precisa de distribuição, não de um valor só.
    for (const reason of LOSS_REASONS) {
      expect(reasons.has(reason), `nenhuma perda com motivo '${reason}'`).toBe(true);
    }
  });

  it('fecha closed_at exatamente nos estágios terminais', async () => {
    const result = await db.withoutTenant((tx) =>
      tx.query<{ id: string; status: ProposalStatus; closed_at: Date | null }>(
        `SELECT id, status, closed_at FROM proposals`,
      ),
    );
    for (const row of result.rows) {
      if (TERMINAL_STATUSES.includes(row.status)) {
        expect(row.closed_at, `proposta terminal ${row.id} sem closed_at`).not.toBeNull();
      } else {
        expect(row.closed_at, `proposta ${row.status} com closed_at`).toBeNull();
      }
    }
  });

  it('grava histórico só com transições de ALLOWED_TRANSITIONS (BR §3)', async () => {
    const history = await db.withoutTenant((tx) =>
      tx.query<{ proposal_id: string; status: ProposalStatus; changed_at: Date }>(
        `SELECT proposal_id, status, changed_at FROM proposal_status_history
          ORDER BY proposal_id, changed_at`,
      ),
    );
    const current = await db.withoutTenant((tx) =>
      tx.query<{ id: string; status: ProposalStatus }>(`SELECT id, status FROM proposals`),
    );
    const currentStatus = new Map(current.rows.map((r) => [r.id, r.status]));

    const grouped = new Map<string, ProposalStatus[]>();
    for (const row of history.rows) {
      const list = grouped.get(row.proposal_id) ?? [];
      list.push(row.status);
      grouped.set(row.proposal_id, list);
    }

    expect(grouped.size).toBe(current.rows.length);
    for (const [proposalId, path] of grouped) {
      expect(path[0], `histórico de ${proposalId} não começa em novo_contato`).toBe('novo_contato');
      for (let i = 1; i < path.length; i += 1) {
        const from = path[i - 1] as ProposalStatus;
        const to = path[i] as ProposalStatus;
        expect(
          ALLOWED_TRANSITIONS[from],
          `transição ilegal ${from} → ${to} em ${proposalId}`,
        ).toContain(to);
      }
      expect(path[path.length - 1], `último histórico ≠ status atual em ${proposalId}`).toBe(
        currentStatus.get(proposalId),
      );
    }
  });

  it('tem uma proposta pendente com desconto acima da alçada do criador (BR §2)', async () => {
    const result = await db.withoutTenant((tx) =>
      tx.query<{ id: string; discount_percent: number; limit: number }>(
        `SELECT p.id, p.discount_percent, u.discount_limit_percent AS "limit"
           FROM proposals p JOIN users u ON u.id = p.created_by
          WHERE p.approval_status = 'pending'`,
      ),
    );
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(Number(row.discount_percent)).toBeGreaterThan(Number(row.limit));
    }

    // ... e o post correspondente no canal #aprovacoes.
    const post = await db.withoutTenant((tx) =>
      tx.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM internal_messages m
           JOIN internal_channels c ON c.id = m.channel_id
          WHERE c.key = 'aprovacoes' AND m.attached_proposal_id IS NOT NULL AND m.is_system`,
      ),
    );
    expect(post.rows[0]?.n ?? 0).toBeGreaterThan(0);
  });

  it('audita as ações críticas que o seed simula (BR §9)', async () => {
    const result = await db.withoutTenant((tx) =>
      tx.query<{ action: string }>(`SELECT DISTINCT action FROM audit_logs ORDER BY action`),
    );
    const actions = result.rows.map((r) => r.action);
    expect(actions).toContain('create_proposal');
    expect(actions).toContain('update_proposal_status');
    expect(actions).toContain('reject_discount');
  });

  describe('isolamento entre tenants', () => {
    /** Toda FK que aponta para uma tabela com tenant_id: os dois lados batem? */
    const CROSS_TENANT_FKS: ReadonlyArray<[child: string, column: string, parent: string]> = [
      ['conversations', 'assigned_to', 'users'],
      ['messages', 'conversation_id', 'conversations'],
      ['messages', 'sender_id', 'users'],
      ['proposals', 'conversation_id', 'conversations'],
      ['proposals', 'created_by', 'users'],
      ['proposals', 'approved_by', 'users'],
      ['proposal_items', 'proposal_id', 'proposals'],
      ['proposal_items', 'exam_id', 'exam_catalog'],
      ['proposal_status_history', 'proposal_id', 'proposals'],
      ['proposal_status_history', 'changed_by', 'users'],
      ['internal_messages', 'channel_id', 'internal_channels'],
      ['internal_messages', 'sender_id', 'users'],
      ['internal_messages', 'attached_proposal_id', 'proposals'],
      ['audit_logs', 'user_id', 'users'],
    ];

    it('nenhuma linha de um tenant referencia entidade de outro', async () => {
      for (const [child, column, parent] of CROSS_TENANT_FKS) {
        const result = await db.withoutTenant((tx) =>
          tx.query<{ n: number }>(
            `SELECT COUNT(*)::int AS n
               FROM ${child} c JOIN ${parent} p ON p.id = c.${column}
              WHERE c.tenant_id <> p.tenant_id`,
          ),
        );
        expect(result.rows[0]?.n, `${child}.${column} → ${parent} cruza tenants`).toBe(0);
      }
    });

    it('cada laboratório tem dados próprios e o RLS os separa', async () => {
      const tenants = await db.withoutTenant((tx) =>
        tx.query<{ id: string; slug: string }>(
          `SELECT id, slug FROM tenants WHERE slug IN ('lab-vida', 'lab-central')`,
        ),
      );
      expect(tenants.rows).toHaveLength(2);

      for (const tenant of tenants.rows) {
        const visible = await db.withTenant(tenant.id, async (tx) => {
          const conversations = await tx.query<{ n: number }>(
            `SELECT COUNT(*)::int AS n FROM conversations`,
          );
          const foreign = await tx.query<{ n: number }>(
            `SELECT COUNT(*)::int AS n FROM conversations WHERE tenant_id <> $1`,
            [tenant.id],
          );
          const proposals = await tx.query<{ n: number }>(
            `SELECT COUNT(*)::int AS n FROM proposals`,
          );
          return {
            conversations: conversations.rows[0]?.n ?? 0,
            foreign: foreign.rows[0]?.n ?? 0,
            proposals: proposals.rows[0]?.n ?? 0,
          };
        });
        expect(visible.conversations, `${tenant.slug} sem conversas`).toBeGreaterThan(0);
        expect(visible.proposals, `${tenant.slug} sem propostas`).toBeGreaterThan(0);
        expect(visible.foreign, `${tenant.slug} enxerga conversa de outro tenant`).toBe(0);
      }
    });
  });
});
