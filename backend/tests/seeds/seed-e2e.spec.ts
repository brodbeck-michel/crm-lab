/**
 * Testes do seed E2E (`npm run seed:e2e`).
 *
 * O Agent-QA escreve asserções do Playwright contra as constantes de
 * `src/db/seeds/e2e-fixtures.ts`. Estes testes garantem que essas constantes
 * descrevem o banco de verdade — se alguém mudar o seed sem mudar a constante
 * (ou vice-versa), quebra aqui e não no meio da suíte de e2e.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { calculateTotal } from '@crm-lab/shared';
import { verifyPassword } from '../../src/lib/password.js';
import { runSeeds } from '../../src/db/seeds/index.js';
import {
  E2E_APPROVAL_POST,
  E2E_CHANNEL_READS,
  E2E_CHANNEL_UNREAD,
  E2E_CONVERSATIONS,
  E2E_EXAMS,
  E2E_PASSWORD,
  E2E_PATIENTS,
  E2E_PROPOSALS,
  E2E_TENANT_CHANNELS,
  E2E_TENANT_SETTINGS,
  E2E_TENANT_WITHOUT_SETTINGS,
  E2E_TENANTS,
  E2E_USERS,
} from '../../src/db/seeds/e2e-fixtures.js';
import { getTestDb } from '../helpers/test-db.js';
import type { DbClient } from '../../src/db/types.js';

const NOW = new Date('2026-08-23T12:00:00.000Z');

let db: DbClient;

async function ids(table: string): Promise<string[]> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ id: string }>(`SELECT id FROM ${table} ORDER BY id`),
  );
  return result.rows.map((row) => row.id);
}

describe('seed e2e', () => {
  beforeAll(async () => {
    db = await getTestDb();
    await runSeeds(db, { e2e: true, now: NOW, print: false });
  }, 120_000);

  it('é determinístico: rodar duas vezes produz os mesmos IDs', async () => {
    const tables = [
      'tenants',
      'users',
      'exam_catalog',
      'conversations',
      'messages',
      'proposals',
      'proposal_items',
      'proposal_status_history',
      'internal_channels',
      'internal_messages',
      'patients',
      'tenant_channels',
    ];
    const before: Record<string, string[]> = {};
    for (const table of tables) before[table] = await ids(table);

    await runSeeds(db, { e2e: true, now: NOW, print: false });

    for (const table of tables) {
      expect(await ids(table), `IDs de ${table} mudaram entre execuções`).toEqual(before[table]);
    }
  }, 120_000);

  it('cria os dois tenants fixos com temas distintos', async () => {
    const result = await db.withoutTenant((tx) =>
      tx.query<{ id: string; slug: string; accent: string }>(
        `SELECT t.id, t.slug, th.accent FROM tenants t
           JOIN themes th ON th.tenant_id = t.id ORDER BY t.slug`,
      ),
    );
    expect(result.rows).toHaveLength(2);
    const alfa = result.rows.find((r) => r.slug === E2E_TENANTS.alfa.slug);
    const beta = result.rows.find((r) => r.slug === E2E_TENANTS.beta.slug);
    expect(alfa?.id).toBe(E2E_TENANTS.alfa.id);
    expect(beta?.id).toBe(E2E_TENANTS.beta.id);
    expect(alfa?.accent).toBe(E2E_TENANTS.alfa.accent);
    expect(beta?.accent).toBe(E2E_TENANTS.beta.accent);
  });

  it('cria os usuários de E2E_USERS com a senha de E2E_PASSWORD', async () => {
    for (const user of Object.values(E2E_USERS)) {
      const result = await db.withoutTenant((tx) =>
        tx.query<{
          id: string;
          tenant_id: string;
          role: string;
          discount_limit_percent: number;
          password_hash: string;
        }>(
          `SELECT id, tenant_id, role, discount_limit_percent, password_hash
             FROM users WHERE email = $1`,
          [user.email],
        ),
      );
      const row = result.rows[0];
      expect(row, `usuário ${user.email} não semeado`).toBeDefined();
      expect(row?.id).toBe(user.id);
      expect(row?.tenant_id).toBe(user.tenantId);
      expect(row?.role).toBe(user.role);
      expect(Number(row?.discount_limit_percent)).toBe(user.discountLimit);
      expect(await verifyPassword(E2E_PASSWORD, row?.password_hash as string)).toBe(true);
    }
  }, 60_000);

  it('cria as propostas de E2E_PROPOSALS com o total de calculateTotal', async () => {
    for (const proposal of Object.values(E2E_PROPOSALS)) {
      // A constante do fixture é honesta: bate com a função canônica (BR §1).
      expect(calculateTotal([...proposal.items], proposal.discountPercent)).toBe(
        proposal.expectedTotal,
      );

      const result = await db.withoutTenant((tx) =>
        tx.query<{
          tenant_id: string;
          status: string;
          discount_percent: number;
          total_price: number;
          approval_status: string;
          reason_lost: string | null;
        }>(
          `SELECT tenant_id, status, discount_percent, total_price, approval_status, reason_lost
             FROM proposals WHERE id = $1`,
          [proposal.id],
        ),
      );
      const row = result.rows[0];
      expect(row, `proposta ${proposal.id} não semeada`).toBeDefined();
      expect(row?.tenant_id).toBe(proposal.tenantId);
      expect(row?.status).toBe(proposal.status);
      expect(Number(row?.discount_percent)).toBe(proposal.discountPercent);
      expect(Number(row?.total_price)).toBe(proposal.expectedTotal);
      expect(row?.approval_status).toBe(proposal.approvalStatus);
      expect(row?.reason_lost).toBe(proposal.reasonLost);
    }
  });

  it('deixa a proposta de 25% pendente, acima da alçada do atendente', async () => {
    const result = await db.withoutTenant((tx) =>
      tx.query<{ discount_percent: number; limit: number; approval_status: string }>(
        `SELECT p.discount_percent, u.discount_limit_percent AS "limit", p.approval_status
           FROM proposals p JOIN users u ON u.id = p.created_by WHERE p.id = $1`,
        [E2E_PROPOSALS.pendenteAprovacao.id],
      ),
    );
    const row = result.rows[0];
    expect(Number(row?.discount_percent)).toBe(25);
    expect(Number(row?.limit)).toBe(15);
    expect(row?.approval_status).toBe('pending');
  });

  it('publica o pedido de aprovação em #aprovacoes com a proposta anexada', async () => {
    const result = await db.withoutTenant((tx) =>
      tx.query<{ content: string; attached_proposal_id: string; is_system: boolean }>(
        `SELECT m.content, m.attached_proposal_id, m.is_system
           FROM internal_messages m JOIN internal_channels c ON c.id = m.channel_id
          WHERE c.key = 'aprovacoes' AND c.tenant_id = $1`,
        [E2E_TENANTS.alfa.id],
      ),
    );
    const row = result.rows[0];
    expect(row?.content).toBe(E2E_APPROVAL_POST);
    expect(row?.attached_proposal_id).toBe(E2E_PROPOSALS.pendenteAprovacao.id);
    expect(row?.is_system).toBe(true);
  });

  it('tem conversa atribuída e conversa na fila livre no tenant Alfa', async () => {
    const result = await db.withoutTenant((tx) =>
      tx.query<{ id: string; assigned_to: string | null; unread_count: number }>(
        `SELECT id, assigned_to, unread_count FROM conversations WHERE tenant_id = $1`,
        [E2E_TENANTS.alfa.id],
      ),
    );
    const byId = new Map(result.rows.map((row) => [row.id, row]));
    expect(byId.get(E2E_CONVERSATIONS.atribuida.id)?.assigned_to).toBe(E2E_USERS.alfaAttendant.id);
    expect(byId.get(E2E_CONVERSATIONS.naoAtribuida.id)?.assigned_to).toBeNull();
    expect(Number(byId.get(E2E_CONVERSATIONS.naoAtribuida.id)?.unread_count)).toBeGreaterThan(0);
  });

  it('cria os pacientes de E2E_PATIENTS e liga TODA conversa ao seu cadastro', async () => {
    const patients = await db.withoutTenant((tx) =>
      tx.query<{ id: string; tenant_id: string; phone: string; name: string | null }>(
        `SELECT id, tenant_id, phone, name FROM patients ORDER BY id`,
      ),
    );
    const expected = Object.values(E2E_PATIENTS);
    expect(patients.rows.map((r) => r.id)).toEqual(
      [...expected].map((p) => p.id).sort((a, b) => (a < b ? -1 : 1)),
    );
    const byId = new Map(patients.rows.map((r) => [r.id, r]));
    for (const patient of expected) {
      expect(byId.get(patient.id)?.phone, patient.id).toBe(patient.phone);
      expect(byId.get(patient.id)?.name, patient.id).toBe(patient.name);
      expect(byId.get(patient.id)?.tenant_id, patient.id).toBe(patient.tenantId);
    }

    // Nenhuma conversa orfa, e o vinculo bate tenant E telefone.
    const bad = await db.withoutTenant((tx) =>
      tx.query<{ id: string }>(
        `SELECT c.id FROM conversations c
           LEFT JOIN patients p ON p.id = c.patient_id
          WHERE c.patient_id IS NULL
             OR p.tenant_id <> c.tenant_id
             OR p.phone <> c.patient_phone`,
      ),
    );
    expect(bad.rows).toEqual([]);
  });

  it('conecta um canal por tenant, com o segredo gravado (D-064)', async () => {
    const rows = await db.withoutTenant((tx) =>
      tx.query<{ tenant_id: string; channel: string; api_token: string; webhook_secret: string }>(
        `SELECT tenant_id, channel, api_token, webhook_secret FROM tenant_channels ORDER BY tenant_id`,
      ),
    );
    expect(rows.rows).toHaveLength(2);
    for (const fixture of Object.values(E2E_TENANT_CHANNELS)) {
      const row = rows.rows.find((r) => r.tenant_id === fixture.tenantId);
      expect(row?.channel, fixture.id).toBe(fixture.channel);
      expect(row?.api_token, fixture.id).toBe(fixture.apiToken);
      expect(row?.webhook_secret, fixture.id).toBe(fixture.webhookSecret);
      // O mascarado que a API vai devolver deriva do token real, nao de outra fonte.
      expect(`••••••••${fixture.apiToken.slice(-4)}`).toBe(fixture.expectedApiTokenMasked);
    }
  });

  it('grava tenant_settings só do Alfa; o Beta fica sem linha (defaults de D-065)', async () => {
    const rows = await db.withoutTenant((tx) =>
      tx.query<{ tenant_id: string; distribution_mode: string; greeting_enabled: boolean }>(
        `SELECT tenant_id, distribution_mode, greeting_enabled FROM tenant_settings`,
      ),
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.tenant_id).toBe(E2E_TENANT_SETTINGS.alfa.tenantId);
    expect(rows.rows[0]?.distribution_mode).toBe('round_robin');
    expect(rows.rows[0]?.greeting_enabled).toBe(true);
    expect(rows.rows.some((r) => r.tenant_id === E2E_TENANT_WITHOUT_SETTINGS)).toBe(false);
  });

  it('o unreadCount derivado bate com E2E_CHANNEL_UNREAD (badge != 0 antes do read)', async () => {
    expect(E2E_CHANNEL_READS.length).toBeGreaterThan(0);

    for (const [key, scenario] of Object.entries(E2E_CHANNEL_UNREAD)) {
      const result = await db.withoutTenant((tx) =>
        tx.query<{ unread: number }>(
          `SELECT COUNT(*) FILTER (
                    WHERE m.created_at > COALESCE(r.last_read_at, '-infinity'::timestamp)
                      AND m.sender_id IS DISTINCT FROM $3
                  )::int AS unread
             FROM internal_channels ch
             LEFT JOIN internal_messages m ON m.channel_id = ch.id
             LEFT JOIN channel_reads r ON r.channel_id = ch.id AND r.user_id = $3
            WHERE ch.tenant_id = $1 AND ch.key = $2`,
          [scenario.tenantId, scenario.channelKey, scenario.userId],
        ),
      );
      expect(Number(result.rows[0]?.unread), key).toBe(scenario.expected);
    }

    // Pelo menos um caso NAO ZERO — sem ele o E2E do badge nao teria o que zerar.
    expect(Object.values(E2E_CHANNEL_UNREAD).some((s) => s.expected > 0)).toBe(true);
  });

  it('isola os dois tenants: o Alfa não enxerga nada do Beta', async () => {
    const seen = await db.withTenant(E2E_TENANTS.alfa.id, async (tx) => {
      const conversations = await tx.query<{ id: string }>(`SELECT id FROM conversations`);
      const proposals = await tx.query<{ id: string }>(`SELECT id FROM proposals`);
      const exams = await tx.query<{ id: string }>(`SELECT id FROM exam_catalog`);
      const tenants = await tx.query<{ id: string }>(`SELECT id FROM tenants`);
      const patients = await tx.query<{ id: string }>(`SELECT id FROM patients`);
      const channels = await tx.query<{ id: string }>(`SELECT id FROM tenant_channels`);
      return {
        conversations: conversations.rows.map((r) => r.id),
        proposals: proposals.rows.map((r) => r.id),
        exams: exams.rows.map((r) => r.id),
        tenants: tenants.rows.map((r) => r.id),
        patients: patients.rows.map((r) => r.id),
        tenantChannels: channels.rows.map((r) => r.id),
      };
    });

    expect(seen.tenants).toEqual([E2E_TENANTS.alfa.id]);
    expect(seen.conversations).not.toContain(E2E_CONVERSATIONS.betaSecreta.id);
    expect(seen.proposals).not.toContain(E2E_PROPOSALS.betaSecreta.id);
    expect(seen.conversations).toContain(E2E_CONVERSATIONS.atribuida.id);
    expect(seen.exams).toContain(E2E_EXAMS.hemograma.id);

    // Onda 6: o cadastro e o canal do Beta tambem ficam invisiveis — e o do
    // Alfa continua visivel (controle positivo: sem ele, tabela vazia passaria).
    expect(seen.patients).not.toContain(E2E_PATIENTS.betaSecreto.id);
    expect(seen.patients).toContain(E2E_PATIENTS.carla.id);
    expect(seen.tenantChannels).not.toContain(E2E_TENANT_CHANNELS.betaWhatsapp.id);
    expect(seen.tenantChannels).toContain(E2E_TENANT_CHANNELS.alfaWhatsapp.id);
  });
});
