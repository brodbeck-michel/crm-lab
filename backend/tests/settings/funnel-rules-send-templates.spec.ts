/**
 * Mensagem de envio com varios modelos — API_CONTRACTS.md §6c (CRMLAB-95, D-265).
 *
 * Foco: leitura do formato antigo (`sendMessage.template`) como lista de um
 * modelo, sem migracao; validacao da lista no PATCH pelo caminho do item;
 * `template` antigo ainda aceito no PATCH; auditoria.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_FUNNEL_RULES,
  validateSendMessageTemplates,
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

/** O texto que o Lab Sante tem gravado em prod no formato antigo. */
const SANTE_A_PRAZO =
  'O investimento para realizar seus exames fica no total de {valor}. Apresente o código do seu orçamento: {numero_orcamento}. Prazo estimado de entrega de ___ dias. As formas de pagamento são Dinheiro, Pix, Débito ou Crédito em até ___ vezes sem juros de R$ ___.';
const A_VISTA =
  'O investimento para realizar seus exames fica no total de {valor}. Apresente o código do seu orçamento: {numero_orcamento}. Prazo estimado de entrega de ___ dias. As formas de pagamento são Dinheiro, Pix, Débito e Crédito.';

let db: DbClient;
let app: TestApp;
let tenantA: TenantRecord;
let managerA: UserRecord;
let attendantA: UserRecord;

async function storeRaw(tenantId: string, rules: unknown): Promise<void> {
  await db.withoutTenant((tx) =>
    tx.query('INSERT INTO funnel_rules (tenant_id, rules) VALUES ($1, $2::jsonb)', [
      tenantId,
      JSON.stringify(rules),
    ]),
  );
}

async function storedSendMessage(tenantId: string): Promise<unknown> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ rules: { sendMessage?: unknown } }>(
      'SELECT rules FROM funnel_rules WHERE tenant_id = $1',
      [tenantId],
    ),
  );
  return result.rows[0]?.rules.sendMessage;
}

function fieldsOf(body: unknown): Record<string, string> {
  return (body as ApiErrorBody).error.details?.fields as Record<string, string>;
}

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  app = await createTestApp({ db, modules: [funnelRulesModule] });
  tenantA = await createTenant({ name: 'Lab A', slug: 'lab-a', db });
  managerA = await createUser({ tenantId: tenantA.id, role: 'manager', db });
  attendantA = await createUser({ tenantId: tenantA.id, role: 'attendant', db });
});

describe('leitura do formato antigo (D-265 item 2)', () => {
  it('padrao sem linha: um modelo "Padrão"', async () => {
    const res = await app.agent.get(BASE).set(app.auth(attendantA));
    expect((res.body as FunnelRules).sendMessage).toEqual(DEFAULT_FUNNEL_RULES.sendMessage);
    expect((res.body as FunnelRules).sendMessage.templates).toHaveLength(1);
  });

  it('linha com `template` vira lista de um modelo, sem perder o texto e sem regravar', async () => {
    const legacy = { template: SANTE_A_PRAZO };
    await storeRaw(tenantA.id, { sendMessage: legacy, manualMoves: { skipStages: false } });

    const rules = await db.withTenant(tenantA.id, (tx) => readFunnelRules(tx, tenantA.id));
    expect(rules.sendMessage).toEqual({ templates: [{ name: 'Padrão', text: SANTE_A_PRAZO }] });
    expect(rules.manualMoves.skipStages).toBe(false);
    // Leitura nao migra o dado.
    expect(await storedSendMessage(tenantA.id)).toEqual(legacy);
  });

  it('`template` antigo invalido cai no padrao; `templates` valido vence o antigo', () => {
    expect(mergeWithDefaults({ sendMessage: { template: 'Oi {cpf}' } }).sendMessage).toEqual(
      DEFAULT_FUNNEL_RULES.sendMessage,
    );
    const both = mergeWithDefaults({
      sendMessage: { template: 'antigo', templates: [{ name: 'À vista', text: A_VISTA }] },
    });
    expect(both.sendMessage).toEqual({ templates: [{ name: 'À vista', text: A_VISTA }] });
  });

  it('lista gravada invalida cai no padrao inteira', () => {
    const rules = mergeWithDefaults({
      sendMessage: { templates: [{ name: 'A', text: 'ok' }, { name: 'a', text: 'dup' }] },
    });
    expect(rules.sendMessage).toEqual(DEFAULT_FUNNEL_RULES.sendMessage);
  });

  it('nao devolve referencia mutavel dos modelos padrao', () => {
    const rules = mergeWithDefaults(null);
    const first = rules.sendMessage.templates[0];
    if (first) first.text = 'mexido';
    rules.sendMessage.templates.push({ name: 'X', text: 'y' });
    expect(DEFAULT_FUNNEL_RULES.sendMessage.templates).toHaveLength(1);
    expect(DEFAULT_FUNNEL_RULES.sendMessage.templates[0]?.text).not.toBe('mexido');
  });
});

describe('PATCH sendMessage.templates (D-265 item 3)', () => {
  it('troca a lista inteira, com trim, e grava no formato novo', async () => {
    await storeRaw(tenantA.id, { sendMessage: { template: SANTE_A_PRAZO } });
    const res = await app.agent
      .patch(BASE)
      .set(app.auth(managerA))
      .send({
        sendMessage: {
          templates: [
            { name: ' A prazo ', text: SANTE_A_PRAZO },
            { name: 'À vista', text: `  ${A_VISTA}  ` },
          ],
        },
      });
    expect(res.status).toBe(200);
    const expected = {
      templates: [
        { name: 'A prazo', text: SANTE_A_PRAZO },
        { name: 'À vista', text: A_VISTA },
      ],
    };
    expect((res.body as FunnelRules).sendMessage).toEqual(expected);
    expect(await storedSendMessage(tenantA.id)).toEqual(expected);
  });

  it('lista vazia, nao lista ou com mais de 5 -> erro na lista', async () => {
    for (const templates of [[], 'texto', Array.from({ length: 6 }, (_, i) => ({ name: `M${i}`, text: 'oi' }))]) {
      const res = await app.agent
        .patch(BASE)
        .set(app.auth(managerA))
        .send({ sendMessage: { templates } });
      expect(res.status).toBe(400);
      expect(Object.keys(fieldsOf(res.body))).toEqual(['sendMessage.templates']);
    }
  });

  it('erros por item: nome, texto, variavel desconhecida, nome repetido e chave a mais', async () => {
    const res = await app.agent
      .patch(BASE)
      .set(app.auth(managerA))
      .send({
        sendMessage: {
          templates: [
            { name: 'A prazo', text: 'ok {valor}' },
            { name: '  ', text: 'x'.repeat(1001) },
            { name: 'n'.repeat(41), text: 'Oi {cpf}' },
            { name: 'a PRAZO', text: 'ok', extra: 1 },
          ],
        },
      });
    expect(res.status).toBe(400);
    expect(fieldsOf(res.body)).toEqual({
      'sendMessage.templates.1.name': 'O nome deve ter de 1 a 40 caracteres',
      'sendMessage.templates.1.text': 'O modelo deve ter de 1 a 1000 caracteres',
      'sendMessage.templates.2.name': 'O nome deve ter de 1 a 40 caracteres',
      'sendMessage.templates.2.text': 'Variável desconhecida: {cpf}',
      'sendMessage.templates.3.name': 'Já existe um modelo com este nome',
      'sendMessage.templates.3.extra': 'Campo desconhecido',
    });
    const get = await app.agent.get(BASE).set(app.auth(managerA));
    expect((get.body as FunnelRules).sendMessage).toEqual(DEFAULT_FUNNEL_RULES.sendMessage);
  });

  it('`template` antigo ainda aceito: troca so o texto do padrao (D-265 item 4)', async () => {
    await app.agent
      .patch(BASE)
      .set(app.auth(managerA))
      .send({
        sendMessage: {
          templates: [
            { name: 'A prazo', text: SANTE_A_PRAZO },
            { name: 'À vista', text: A_VISTA },
          ],
        },
      });
    const res = await app.agent
      .patch(BASE)
      .set(app.auth(managerA))
      .send({ sendMessage: { template: ' Novo {valor} ' } });
    expect(res.status).toBe(200);
    expect((res.body as FunnelRules).sendMessage.templates).toEqual([
      { name: 'A prazo', text: 'Novo {valor}' },
      { name: 'À vista', text: A_VISTA },
    ]);
  });

  it('`template` e `templates` juntos -> erro em sendMessage.template', async () => {
    const res = await app.agent
      .patch(BASE)
      .set(app.auth(managerA))
      .send({ sendMessage: { template: 'a', templates: [{ name: 'B', text: 'b' }] } });
    expect(res.status).toBe(400);
    expect(Object.keys(fieldsOf(res.body))).toEqual(['sendMessage.template']);
  });

  it('atendente nao edita os modelos', async () => {
    const res = await app.agent
      .patch(BASE)
      .set(app.auth(attendantA))
      .send({ sendMessage: { templates: [{ name: 'X', text: 'y' }] } });
    expect(res.status).toBe(403);
  });

  it('audita update_funnel_rules: antigo convertido x lista nova; reenvio igual nao audita', async () => {
    await storeRaw(tenantA.id, { sendMessage: { template: SANTE_A_PRAZO } });
    const body = {
      sendMessage: {
        templates: [
          { name: 'Padrão', text: SANTE_A_PRAZO },
          { name: 'À vista', text: A_VISTA },
        ],
      },
    };
    await app.agent.patch(BASE).set(app.auth(managerA)).send(body);
    await app.agent.patch(BASE).set(app.auth(managerA)).send(body);

    const rows = await db.withoutTenant((tx) =>
      tx.query<{ old_values: FunnelRules; new_values: FunnelRules }>(
        `SELECT old_values, new_values FROM audit_logs
          WHERE tenant_id = $1 AND action = 'update_funnel_rules'`,
        [tenantA.id],
      ),
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.old_values.sendMessage).toEqual({
      templates: [{ name: 'Padrão', text: SANTE_A_PRAZO }],
    });
    expect(rows.rows[0]?.new_values.sendMessage).toEqual(body.sendMessage);
  });

  it('salvar so o formato convertido, sem mudar nada, nao grava nem audita', async () => {
    await storeRaw(tenantA.id, { sendMessage: { template: SANTE_A_PRAZO } });
    const res = await app.agent
      .patch(BASE)
      .set(app.auth(managerA))
      .send({ sendMessage: { templates: [{ name: 'Padrão', text: SANTE_A_PRAZO }] } });
    expect(res.status).toBe(200);
    expect(await storedSendMessage(tenantA.id)).toEqual({ template: SANTE_A_PRAZO });
  });
});

describe('validateSendMessageTemplates (shared)', () => {
  it('devolve a lista com trim quando vale', () => {
    expect(validateSendMessageTemplates([{ name: ' A ', text: ' b ' }])).toEqual({
      templates: [{ name: 'A', text: 'b' }],
      errors: {},
    });
  });

  it('item que nao e objeto', () => {
    expect(validateSendMessageTemplates(['x']).errors).toEqual({
      'templates.0': 'Deve ser um objeto com nome e texto',
    });
  });
});
