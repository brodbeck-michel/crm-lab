/**
 * `/api/v1/settings/funnel-rules` — API_CONTRACTS.md §6c (CRMLAB-56, D-190/D-191).
 *
 * Foco: padroes sem linha, PATCH parcial em qualquer nivel, validacao pelo
 * caminho do campo, papeis (GET todo perfil, PATCH manager/admin), auditoria
 * so quando muda, isolamento entre laboratorios e o merge defensivo da leitura.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_FUNNEL_RULES,
  type ApiErrorBody,
  type FunnelRules,
} from '@crm-lab/shared';
import { funnelRulesModule } from '../../src/controllers/funnel-rules.routes.js';
import type { DbClient } from '../../src/db/types.js';
import { mergeWithDefaults, readFunnelRules } from '../../src/services/funnel-rules.service.js';
import { createTenant, createUser, type TenantRecord, type UserRecord } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

const BASE = '/api/v1/settings/funnel-rules';

let db: DbClient;
let app: TestApp;
let tenantA: TenantRecord;
let tenantB: TenantRecord;
let adminA: UserRecord;
let managerA: UserRecord;
let attendantA: UserRecord;
let managerB: UserRecord;

async function auditRows(tenantId: string): Promise<Array<{ action: string; old_values: unknown; new_values: unknown }>> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ action: string; old_values: unknown; new_values: unknown }>(
      `SELECT action, old_values, new_values FROM audit_logs
        WHERE tenant_id = $1 AND action = 'update_funnel_rules' ORDER BY timestamp ASC`,
      [tenantId],
    ),
  );
  return result.rows;
}

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  app = await createTestApp({ db, modules: [funnelRulesModule] });
  tenantA = await createTenant({ name: 'Lab A', slug: 'lab-a', db });
  tenantB = await createTenant({ name: 'Lab B', slug: 'lab-b', db });
  adminA = await createUser({ tenantId: tenantA.id, role: 'admin', db });
  managerA = await createUser({ tenantId: tenantA.id, role: 'manager', db });
  attendantA = await createUser({ tenantId: tenantA.id, role: 'attendant', db });
  managerB = await createUser({ tenantId: tenantB.id, role: 'manager', db });
});

describe('GET /settings/funnel-rules', () => {
  it('sem linha devolve exatamente os padroes (D-191)', async () => {
    const res = await app.agent.get(BASE).set(app.auth(managerA));
    expect(res.status).toBe(200);
    expect(res.body as FunnelRules).toEqual(DEFAULT_FUNNEL_RULES);
  });

  it('padroes reproduzem o comportamento anterior ao card', () => {
    expect(DEFAULT_FUNNEL_RULES.manualMoves).toEqual({
      reopenClosed: { enabled: false, roles: ['manager'] },
      skipStages: true,
      requireLossReason: true,
      moveOthersCards: true,
    });
    expect(DEFAULT_FUNNEL_RULES.origin).toEqual({ fromBitlab: true, manualInCrm: true });
    expect(DEFAULT_FUNNEL_RULES.automation.followUpToLost.enabled).toBe(false);
  });

  it('atendente le (a tela e o front precisam das travas)', async () => {
    const res = await app.agent.get(BASE).set(app.auth(attendantA));
    expect(res.status).toBe(200);
  });

  it('GET nao grava linha', async () => {
    await app.agent.get(BASE).set(app.auth(managerA));
    const rows = await db.withoutTenant((tx) =>
      tx.query<{ total: number }>('SELECT COUNT(*)::int AS total FROM funnel_rules'),
    );
    expect(rows.rows[0]?.total).toBe(0);
  });

  it('platform_operator recebe FORBIDDEN', async () => {
    const plataforma = await createTenant({ name: 'Plataforma', slug: 'plataforma', db });
    const operator = await createUser({ tenantId: plataforma.id, role: 'platform_operator', db });
    const res = await app.agent.get(BASE).set(app.auth(operator));
    expect(res.status).toBe(403);
  });
});

describe('PATCH /settings/funnel-rules', () => {
  it('gestor: patch parcial aninhado preserva o resto', async () => {
    const res = await app.agent
      .patch(BASE)
      .set(app.auth(managerA))
      .send({
        automation: { sentToFollowUp: { days: 5 }, dayCounting: 'business' },
        manualMoves: { reopenClosed: { enabled: true, roles: ['attendant', 'manager'] } },
      });
    expect(res.status).toBe(200);
    const body = res.body as FunnelRules;
    expect(body.automation.sentToFollowUp).toEqual({ enabled: true, days: 5 });
    expect(body.automation.dayCounting).toBe('business');
    expect(body.automation.negotiationToFollowUp).toEqual({ enabled: true, days: 7 });
    expect(body.manualMoves.reopenClosed).toEqual({ enabled: true, roles: ['attendant', 'manager'] });
    expect(body.manualMoves.skipStages).toBe(true);

    const again = await app.agent.get(BASE).set(app.auth(attendantA));
    expect(again.body).toEqual(body);
  });

  it('admin tambem edita', async () => {
    const res = await app.agent
      .patch(BASE)
      .set(app.auth(adminA))
      .send({ origin: { manualInCrm: false } });
    expect(res.status).toBe(200);
    expect((res.body as FunnelRules).origin).toEqual({ fromBitlab: true, manualInCrm: false });
  });

  it('atendente recebe FORBIDDEN', async () => {
    const res = await app.agent
      .patch(BASE)
      .set(app.auth(attendantA))
      .send({ manualMoves: { skipStages: false } });
    expect(res.status).toBe(403);
    expect((res.body as ApiErrorBody).error.details).toMatchObject({
      requiredRoles: ['manager', 'admin'],
    });
  });

  it('corpo vazio -> VALIDATION_ERROR em _root', async () => {
    const res = await app.agent.patch(BASE).set(app.auth(managerA)).send({});
    expect(res.status).toBe(400);
    expect((res.body as ApiErrorBody).error.details).toEqual({
      fields: { _root: 'Envie ao menos um campo para atualizar' },
    });
  });

  it('campo desconhecido em qualquer nivel, tipo e faixa errados -> fields pelo caminho', async () => {
    const res = await app.agent
      .patch(BASE)
      .set(app.auth(managerA))
      .send({
        extra: 1,
        automation: {
          sentToFollowUp: { days: 0, cor: 'azul' },
          staleNewBudgetAlert: { hours: 1.5 },
          dayCounting: 'lunar',
          paymentToWon: { enabled: 'sim' },
        },
        manualMoves: { reopenClosed: { roles: ['admin'] } },
      });
    expect(res.status).toBe(400);
    const fields = (res.body as ApiErrorBody).error.details?.fields as Record<string, string>;
    expect(Object.keys(fields).sort()).toEqual(
      [
        'extra',
        'automation.sentToFollowUp.days',
        'automation.sentToFollowUp.cor',
        'automation.staleNewBudgetAlert.hours',
        'automation.dayCounting',
        'automation.paymentToWon.enabled',
        'manualMoves.reopenClosed.roles',
      ].sort(),
    );
    expect(fields.extra).toBe('Campo desconhecido');
  });

  it('secao que nao e objeto -> erro no caminho da secao', async () => {
    const res = await app.agent.patch(BASE).set(app.auth(managerA)).send({ origin: true });
    expect(res.status).toBe(400);
    expect((res.body as ApiErrorBody).error.details).toEqual({
      fields: { origin: 'Deve ser um objeto' },
    });
  });

  it('roles repetidos sao recusados', async () => {
    const res = await app.agent
      .patch(BASE)
      .set(app.auth(managerA))
      .send({ manualMoves: { reopenClosed: { roles: ['manager', 'manager'] } } });
    expect(res.status).toBe(400);
  });

  it('as duas origens desligadas -> VALIDATION_ERROR em origin', async () => {
    const res = await app.agent
      .patch(BASE)
      .set(app.auth(managerA))
      .send({ origin: { fromBitlab: false, manualInCrm: false } });
    expect(res.status).toBe(400);
    expect((res.body as ApiErrorBody).error.details).toEqual({
      fields: { origin: 'Deixe ao menos uma origem de proposta ligada' },
    });
  });

  it('modelo com variavel desconhecida -> erro citando as desconhecidas', async () => {
    const res = await app.agent
      .patch(BASE)
      .set(app.auth(managerA))
      .send({ sendMessage: { template: 'Oi {paciente}, {nome} e {cpf}' } });
    expect(res.status).toBe(400);
    const fields = (res.body as ApiErrorBody).error.details?.fields as Record<string, string>;
    expect(fields['sendMessage.template']).toBe('Variável desconhecida: {nome}, {cpf}');
  });

  it('modelo vazio ou longo demais e recusado; valido grava com trim', async () => {
    const vazio = await app.agent
      .patch(BASE)
      .set(app.auth(managerA))
      .send({ sendMessage: { template: '   ' } });
    expect(vazio.status).toBe(400);

    const longo = await app.agent
      .patch(BASE)
      .set(app.auth(managerA))
      .send({ sendMessage: { template: 'x'.repeat(1001) } });
    expect(longo.status).toBe(400);

    const ok = await app.agent
      .patch(BASE)
      .set(app.auth(managerA))
      .send({ sendMessage: { template: '  Olá {paciente}, total {valor}  ' } });
    expect(ok.status).toBe(200);
    expect((ok.body as FunnelRules).sendMessage.template).toBe('Olá {paciente}, total {valor}');
  });

  it('erro de validacao nao grava nada', async () => {
    await app.agent
      .patch(BASE)
      .set(app.auth(managerA))
      .send({ manualMoves: { skipStages: false }, automation: { sentToFollowUp: { days: 999 } } });
    const res = await app.agent.get(BASE).set(app.auth(managerA));
    expect((res.body as FunnelRules).manualMoves.skipStages).toBe(true);
  });

  it('audita update_funnel_rules com antes x depois, e so quando algo muda', async () => {
    await app.agent.patch(BASE).set(app.auth(managerA)).send({ manualMoves: { skipStages: false } });
    // mesmo valor de novo: nao audita
    await app.agent.patch(BASE).set(app.auth(managerA)).send({ manualMoves: { skipStages: false } });

    const rows = await auditRows(tenantA.id);
    expect(rows).toHaveLength(1);
    const oldValues = rows[0]?.old_values as FunnelRules;
    const newValues = rows[0]?.new_values as FunnelRules;
    expect(oldValues.manualMoves.skipStages).toBe(true);
    expect(newValues.manualMoves.skipStages).toBe(false);
  });

  it('isolamento: a regra de A nao aparece para B, e B editando nao mexe em A', async () => {
    await app.agent.patch(BASE).set(app.auth(managerA)).send({ origin: { manualInCrm: false } });

    const b = await app.agent.get(BASE).set(app.auth(managerB));
    expect((b.body as FunnelRules).origin.manualInCrm).toBe(true);

    await app.agent.patch(BASE).set(app.auth(managerB)).send({ manualMoves: { skipStages: false } });
    const a = await app.agent.get(BASE).set(app.auth(managerA));
    expect((a.body as FunnelRules).origin.manualInCrm).toBe(false);
    expect((a.body as FunnelRules).manualMoves.skipStages).toBe(true);
    expect(await auditRows(tenantB.id)).toHaveLength(1);
  });
});

describe('readFunnelRules (ponto unico de leitura)', () => {
  it('mescla o JSON gravado com os padroes; lixo cai no padrao', async () => {
    await db.withoutTenant((tx) =>
      tx.query('INSERT INTO funnel_rules (tenant_id, rules) VALUES ($1, $2::jsonb)', [
        tenantA.id,
        JSON.stringify({
          origin: { manualInCrm: false },
          automation: { sentToFollowUp: { days: 'tres' }, dayCounting: 'business' },
          manualMoves: 'quebrado',
          obsoleto: true,
        }),
      ]),
    );

    const rules = await db.withTenant(tenantA.id, (tx) => readFunnelRules(tx, tenantA.id));
    expect(rules.origin).toEqual({ fromBitlab: true, manualInCrm: false });
    expect(rules.automation.sentToFollowUp).toEqual({ enabled: true, days: 3 });
    expect(rules.automation.dayCounting).toBe('business');
    expect(rules.manualMoves).toEqual(DEFAULT_FUNNEL_RULES.manualMoves);
    expect(rules).not.toHaveProperty('obsoleto');
  });

  it('nao devolve referencia mutavel dos padroes', () => {
    const rules = mergeWithDefaults(null);
    rules.manualMoves.reopenClosed.roles.push('attendant');
    expect(DEFAULT_FUNNEL_RULES.manualMoves.reopenClosed.roles).toEqual(['manager']);
  });

  it('sob RLS, o contexto de B nao le a linha de A', async () => {
    await db.withoutTenant((tx) =>
      tx.query('INSERT INTO funnel_rules (tenant_id, rules) VALUES ($1, $2::jsonb)', [
        tenantA.id,
        JSON.stringify({ origin: { manualInCrm: false } }),
      ]),
    );
    // Mesmo pedindo o tenant A, o contexto de B nao enxerga a linha.
    const rules = await db.withTenant(tenantB.id, (tx) => readFunnelRules(tx, tenantA.id));
    expect(rules.origin.manualInCrm).toBe(true);
  });
});
