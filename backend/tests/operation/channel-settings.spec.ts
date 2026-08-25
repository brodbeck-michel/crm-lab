/**
 * `GET|PATCH /api/v1/settings/channels` — Canais & Equipe (API_CONTRACTS.md §6,
 * SERVICES.md §13, D-064/D-065/D-066).
 *
 * O que estas specs provam, e por que cada uma existe:
 *
 *  - O SEGREDO NAO VAZA. A assercao e sobre o JSON INTEIRO da resposta
 *    (`JSON.stringify`), nao sobre o campo que esperamos: um vazamento
 *    aparece justamente onde ninguem olhou (um campo novo, um eco do corpo do
 *    PATCH, um erro de validacao que devolve o valor recebido).
 *  - OS TRES CAMINHOS DO PATCH DE SEGREDO. Ausente preserva, `null` apaga,
 *    string grava. Uma implementacao com `COALESCE` passa nos dois primeiros e
 *    falha no terceiro — por isso os tres estao aqui.
 *  - LINHA AUSENTE = DEFAULTS, e o `GET` NAO GRAVA. A verificacao final e no
 *    banco (`SELECT COUNT(*) FROM tenant_settings`), nao na resposta.
 *  - ISOLAMENTO com DOIS tenants, na leitura e na escrita.
 *  - PAPEIS validados no servidor.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { channelSettingsModule } from '../../src/controllers/channel-settings.routes.js';
import type { DbClient } from '../../src/db/types.js';
import { createTenant, createUser, type UserRecord } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

const URL = '/api/v1/settings/channels';

const TOKEN = 'EAAG-token-em-claro-1234-9f2a';
const SECRET = 'segredo-de-webhook-bem-longo';

let db: DbClient;
let app: TestApp;
let admin: UserRecord;
let manager: UserRecord;
let attendant: UserRecord;
let tenantId: string;

/** Grava um canal completo direto pela API (o caminho real do admin). */
async function patchChannel(body: object, as: UserRecord = admin): Promise<unknown> {
  const res = await app.agent.patch(URL).set(app.auth(as)).send(body).expect(200);
  return res.body;
}

async function countSettingsRows(target: string): Promise<number> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM tenant_settings WHERE tenant_id = $1`,
      [target],
    ),
  );
  return result.rows[0]?.count ?? 0;
}

/** Le os valores EM CLARO do banco — so o teste faz isso, nunca a API. */
async function rawChannel(
  target: string,
  channel: string,
): Promise<{ api_token: string | null; webhook_secret: string | null } | undefined> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ api_token: string | null; webhook_secret: string | null }>(
      `SELECT api_token, webhook_secret FROM tenant_channels
        WHERE tenant_id = $1 AND channel = $2`,
      [target, channel],
    ),
  );
  return result.rows[0];
}

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  app = await createTestApp({ db, modules: [channelSettingsModule] });

  const tenant = await createTenant({ name: 'Lab Vida', slug: 'lab-vida', db });
  tenantId = tenant.id;
  admin = await createUser({ tenantId, role: 'admin', name: 'Admin Ana', db });
  manager = await createUser({ tenantId, role: 'manager', name: 'Gestora Bia', db });
  attendant = await createUser({ tenantId, role: 'attendant', name: 'Maria Souza', db });
});

// ---------------------------------------------------------------------------
// Defaults (D-065)
// ---------------------------------------------------------------------------

describe('GET /settings/channels — laboratorio sem configuracao', () => {
  it('responde os defaults e NAO cria linha em tenant_settings', async () => {
    expect(await countSettingsRows(tenantId)).toBe(0);

    const res = await app.agent.get(URL).set(app.auth(admin)).expect(200);

    expect(res.body.channels).toEqual([]);
    expect(res.body.distributionMode).toBe('manual');
    expect(res.body.autoMessages).toEqual({
      greeting: { enabled: false, message: null },
      offHours: { enabled: false, message: null },
    });
    expect(res.body.businessHours).toEqual({ timezone: 'America/Sao_Paulo', days: {} });

    // A prova de que o GET e somente leitura esta no BANCO, nao na resposta.
    expect(await countSettingsRows(tenantId)).toBe(0);
  });

  it('o primeiro PATCH e que cria a linha', async () => {
    await patchChannel({ distributionMode: 'round_robin' });
    expect(await countSettingsRows(tenantId)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Segredo
// ---------------------------------------------------------------------------

describe('o segredo nunca sai do backend (D-064)', () => {
  it('nem no PATCH que o grava, nem no GET seguinte', async () => {
    const escrita = await app.agent
      .patch(URL)
      .set(app.auth(admin))
      .send({
        channels: [
          {
            channel: 'whatsapp',
            displayName: 'WhatsApp do Vida',
            apiToken: TOKEN,
            webhookSecret: SECRET,
          },
        ],
      })
      .expect(200);

    const leitura = await app.agent.get(URL).set(app.auth(admin)).expect(200);

    for (const body of [escrita.body, leitura.body]) {
      // Assercao sobre o JSON INTEIRO: um campo novo que devolvesse o token
      // passaria batido numa assercao so sobre `apiTokenMasked`.
      const json = JSON.stringify(body);
      expect(json).not.toContain(TOKEN);
      expect(json).not.toContain(SECRET);
      expect(json).not.toContain('apiToken"');
      expect(json).not.toContain('webhookSecret"');

      const [channel] = body.channels;
      expect(channel.apiTokenMasked).toBe('••••••••9f2a');
      expect(channel.webhookSecretSet).toBe(true);
      expect(channel.connectedAt).not.toBeNull();
    }

    // E o valor EM CLARO esta mesmo guardado (senao "nao vazou" seria so
    // "nao gravou").
    expect(await rawChannel(tenantId, 'whatsapp')).toEqual({
      api_token: TOKEN,
      webhook_secret: SECRET,
    });
  });

  it('audit log grava [REDACTED] no lugar do segredo', async () => {
    await patchChannel({ channels: [{ channel: 'whatsapp', apiToken: TOKEN }] });

    const result = await db.withoutTenant((tx) =>
      tx.query<{ action: string; new_values: unknown }>(
        `SELECT action, new_values FROM audit_logs WHERE tenant_id = $1`,
        [tenantId],
      ),
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.action).toBe('update_channel_settings');
    const gravado = JSON.stringify(result.rows[0]?.new_values);
    expect(gravado).not.toContain(TOKEN);
    expect(gravado).toContain('[REDACTED]');
  });
});

// ---------------------------------------------------------------------------
// Os tres caminhos do PATCH de segredo
// ---------------------------------------------------------------------------

describe('semantica de escrita de segredo: ausente | null | string', () => {
  beforeEach(async () => {
    await patchChannel({
      channels: [
        {
          channel: 'whatsapp',
          displayName: 'WhatsApp do Vida',
          apiToken: TOKEN,
          webhookSecret: SECRET,
        },
      ],
    });
  });

  it('campo AUSENTE preserva o valor guardado', async () => {
    const body = await app.agent
      .patch(URL)
      .set(app.auth(admin))
      .send({ channels: [{ channel: 'whatsapp', displayName: 'Outro nome' }] })
      .expect(200);

    expect(body.body.channels[0].displayName).toBe('Outro nome');
    expect(body.body.channels[0].apiTokenMasked).toBe('••••••••9f2a');
    expect(body.body.channels[0].webhookSecretSet).toBe(true);
    expect(await rawChannel(tenantId, 'whatsapp')).toEqual({
      api_token: TOKEN,
      webhook_secret: SECRET,
    });
  });

  it('`null` APAGA o segredo', async () => {
    const body = await app.agent
      .patch(URL)
      .set(app.auth(admin))
      .send({ channels: [{ channel: 'whatsapp', apiToken: null, webhookSecret: null }] })
      .expect(200);

    expect(body.body.channels[0].apiTokenMasked).toBeNull();
    expect(body.body.channels[0].webhookSecretSet).toBe(false);
    // A COLUNA guarda `''`, e nao `NULL` (D-073 emendada): `NULL` significa
    // "nunca configurou" e AUTORIZA o fallback para a env var global. Apagar
    // tem que revogar de verdade, entao a revogacao precisa de valor proprio.
    // A API nao ve diferenca — os dois estados respondem "nao configurado".
    expect(await rawChannel(tenantId, 'whatsapp')).toEqual({
      api_token: '',
      webhook_secret: '',
    });
  });

  it('string GRAVA o novo valor', async () => {
    const novo = 'EAAG-token-novo-em-claro-abcd';
    const body = await app.agent
      .patch(URL)
      .set(app.auth(admin))
      .send({ channels: [{ channel: 'whatsapp', apiToken: novo }] })
      .expect(200);

    expect(body.body.channels[0].apiTokenMasked).toBe('••••••••abcd');
    expect(JSON.stringify(body.body)).not.toContain(novo);
    expect((await rawChannel(tenantId, 'whatsapp'))?.api_token).toBe(novo);
  });

  it('string vazia e VALIDATION_ERROR — apagar e `null`, explicitamente', async () => {
    const res = await app.agent
      .patch(URL)
      .set(app.auth(admin))
      .send({ channels: [{ channel: 'whatsapp', apiToken: '' }] })
      .expect(400);

    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    // Chave pelo NOME do canal (API_ERRORS.md), que e o que a tela procura.
    expect(res.body.error.details.fields).toHaveProperty('channels.whatsapp.apiToken');
    // E nao apagou nada.
    expect((await rawChannel(tenantId, 'whatsapp'))?.api_token).toBe(TOKEN);
  });
});

// ---------------------------------------------------------------------------
// Upsert por `channel`, nao por id
// ---------------------------------------------------------------------------

describe('upsert de canal pela chave `channel`', () => {
  it('duas escritas no mesmo canal atualizam a MESMA linha', async () => {
    const primeira = await patchChannel({
      channels: [{ channel: 'whatsapp', displayName: 'Primeiro nome' }],
    });
    const segunda = await patchChannel({
      channels: [{ channel: 'whatsapp', displayName: 'Segundo nome' }],
    });

    const a = (primeira as { channels: { id: string }[] }).channels[0];
    const b = (segunda as { channels: { id: string; displayName: string }[] }).channels[0];
    expect(b?.id).toBe(a?.id);
    expect(b?.displayName).toBe('Segundo nome');
    expect((segunda as { channels: unknown[] }).channels).toHaveLength(1);
  });

  it('canal ausente do array NAO e removido; desligar e isActive: false', async () => {
    await patchChannel({ channels: [{ channel: 'whatsapp' }, { channel: 'sms' }] });
    const body = await patchChannel({ channels: [{ channel: 'sms', isActive: false }] });

    const canais = (body as { channels: { channel: string; isActive: boolean }[] }).channels;
    // Ordem fixa por `channel ASC`.
    expect(canais.map((c) => c.channel)).toEqual(['sms', 'whatsapp']);
    expect(canais[0]?.isActive).toBe(false);
    expect(canais[1]?.isActive).toBe(true);
  });

  it('canal repetido no mesmo array e VALIDATION_ERROR', async () => {
    const res = await app.agent
      .patch(URL)
      .set(app.auth(admin))
      .send({ channels: [{ channel: 'whatsapp' }, { channel: 'whatsapp' }] })
      .expect(400);
    // Repetido: o canal JA e conhecido, entao a chave e pelo NOME (a segunda
    // ocorrencia e a recusada — o indice nao aparece mais no caminho).
    expect(res.body.error.details.fields).toHaveProperty('channels.whatsapp.channel');
  });
});

// ---------------------------------------------------------------------------
// `details.fields` — a convencao que a tela procura (API_ERRORS.md)
//
// A chave de um campo de canal e o NOME do canal, nunca o indice do array. O
// backend montava `channels.0.phoneNumber` e a tela procurava
// `channels.whatsapp.phoneNumber`: o admin digitava um numero longo demais,
// tomava 400 e NAO VIA ERRO NENHUM — a tela apagava a mensagem geral porque
// havia `fields`, e nenhum campo casava com a chave recebida.
//
// O payload exato deste teste esta espelhado em
// `frontend/src/pages/Settings/Channels.spec.tsx` ("o 400 real da API"): os dois
// lados da convencao sao provados com o MESMO objeto.
// ---------------------------------------------------------------------------

describe('details.fields usa o NOME do canal', () => {
  it('phoneNumber longo demais devolve `channels.whatsapp.phoneNumber`', async () => {
    const res = await app.agent
      .patch(URL)
      .set(app.auth(admin))
      .send({ channels: [{ channel: 'whatsapp', phoneNumber: '+'.padEnd(60, '9') }] })
      .expect(400);

    const fields = res.body.error.details.fields as Record<string, string>;
    expect(Object.keys(fields)).toEqual(['channels.whatsapp.phoneNumber']);
    expect(fields['channels.whatsapp.phoneNumber']).toBe('Maximo de 30 caracteres');
    // Nenhuma chave por indice sobrou.
    expect(Object.keys(fields).some((key) => /^channels\.\d/.test(key))).toBe(false);
  });

  it('o canal errado do array nao contamina a chave do outro', async () => {
    const res = await app.agent
      .patch(URL)
      .set(app.auth(admin))
      .send({
        channels: [
          { channel: 'sms', displayName: 'x'.repeat(300) },
          { channel: 'whatsapp', apiToken: 'curto' },
        ],
      })
      .expect(400);

    const fields = res.body.error.details.fields as Record<string, string>;
    expect(Object.keys(fields).sort()).toEqual([
      'channels.sms.displayName',
      'channels.whatsapp.apiToken',
    ]);
    // Segredo NUNCA aparece em `details` — nem o valor recusado (API_ERRORS.md).
    expect(JSON.stringify(fields)).not.toContain('curto');
  });

  it('canal desconhecido continua pelo indice — nao ha nome para usar', async () => {
    const res = await app.agent
      .patch(URL)
      .set(app.auth(admin))
      .send({ channels: [{ channel: 'telegrama' }] })
      .expect(400);
    expect(res.body.error.details.fields).toHaveProperty('channels.0.channel');
  });
});

// ---------------------------------------------------------------------------
// Configuracoes
// ---------------------------------------------------------------------------

describe('distribuicao, mensagens automaticas e horario', () => {
  it('autoMessages e patch parcial por mensagem', async () => {
    await patchChannel({
      autoMessages: {
        greeting: { enabled: true, message: 'Ola!' },
        offHours: { enabled: true, message: 'Estamos fechados.' },
      },
    });
    const body = await patchChannel({
      autoMessages: { greeting: { enabled: true, message: 'Ola de novo!' } },
    });

    expect(body).toMatchObject({
      autoMessages: {
        greeting: { enabled: true, message: 'Ola de novo!' },
        offHours: { enabled: true, message: 'Estamos fechados.' },
      },
    });
  });

  it('mensagem ligada e vazia e VALIDATION_ERROR', async () => {
    const res = await app.agent
      .patch(URL)
      .set(app.auth(admin))
      .send({ autoMessages: { greeting: { enabled: true, message: '' } } })
      .expect(400);
    expect(res.body.error.details.fields).toHaveProperty('autoMessages.greeting.message');
  });

  it('businessHours e SUBSTITUICAO, nao merge por dia', async () => {
    await patchChannel({
      businessHours: {
        timezone: 'America/Sao_Paulo',
        days: { mon: { start: '08:00', end: '18:00' }, sat: { start: '08:00', end: '12:00' } },
      },
    });
    const body = await patchChannel({
      businessHours: {
        timezone: 'America/Sao_Paulo',
        days: { mon: { start: '09:00', end: '17:00' } },
      },
    });

    // `sat` sumiu porque o objeto novo substitui o anterior inteiro.
    expect((body as { businessHours: { days: Record<string, unknown> } }).businessHours.days)
      .toEqual({ mon: { start: '09:00', end: '17:00' } });
  });

  it('recusa horario invertido e fuso inexistente', async () => {
    const invertido = await app.agent
      .patch(URL)
      .set(app.auth(admin))
      .send({
        businessHours: {
          timezone: 'America/Sao_Paulo',
          days: { mon: { start: '18:00', end: '08:00' } },
        },
      })
      .expect(400);
    expect(invertido.body.error.details.fields).toHaveProperty('businessHours.days.mon.end');

    const fuso = await app.agent
      .patch(URL)
      .set(app.auth(admin))
      .send({ businessHours: { timezone: 'Marte/Olympus', days: {} } })
      .expect(400);
    expect(fuso.body.error.details.fields).toHaveProperty('businessHours.timezone');
  });

  it('corpo vazio e campo desconhecido sao VALIDATION_ERROR', async () => {
    const vazio = await app.agent.patch(URL).set(app.auth(admin)).send({}).expect(400);
    expect(vazio.body.error.code).toBe('VALIDATION_ERROR');

    const desconhecido = await app.agent
      .patch(URL)
      .set(app.auth(admin))
      .send({ distributionMod: 'manual' })
      .expect(400);
    expect(desconhecido.body.error.details.fields).toHaveProperty('distributionMod');
  });
});

// ---------------------------------------------------------------------------
// Equipe (D-066)
// ---------------------------------------------------------------------------

describe('team — recorte minimo de D-066', () => {
  it('lista papeis de laboratorio por nome, com inativos, sem e-mail nem alcada', async () => {
    await createUser({ tenantId, role: 'attendant', name: 'Ze Inativo', isActive: false, db });
    const plataforma = await createTenant({ name: 'Plataforma', slug: 'plat', db });
    await createUser({ tenantId: plataforma.id, role: 'platform_operator', db });

    const res = await app.agent.get(URL).set(app.auth(manager)).expect(200);

    expect(res.body.team.map((m: { name: string }) => m.name)).toEqual([
      'Admin Ana',
      'Gestora Bia',
      'Maria Souza',
      'Ze Inativo',
    ]);
    const inativo = res.body.team.find((m: { name: string }) => m.name === 'Ze Inativo');
    expect(inativo).toEqual({
      id: expect.any(String),
      name: 'Ze Inativo',
      role: 'attendant',
      isActive: false,
    });
    // Nenhum e-mail e nenhuma alcada na resposta inteira.
    const json = JSON.stringify(res.body);
    expect(json).not.toContain('@teste.local');
    expect(json).not.toContain('discountLimit');
  });
});

// ---------------------------------------------------------------------------
// Papeis
// ---------------------------------------------------------------------------

describe('papeis validados no servidor', () => {
  it('gestor LE mas nao ESCREVE', async () => {
    await app.agent.get(URL).set(app.auth(manager)).expect(200);

    const res = await app.agent
      .patch(URL)
      .set(app.auth(manager))
      .send({ distributionMode: 'round_robin' })
      .expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.details.requiredRoles).toEqual(['admin']);
    // E nada foi gravado.
    expect(await countSettingsRows(tenantId)).toBe(0);
  });

  it('atendente e recusado nas duas', async () => {
    const leitura = await app.agent.get(URL).set(app.auth(attendant)).expect(403);
    expect(leitura.body.error.details.requiredRoles).toEqual(['manager', 'admin']);

    const escrita = await app.agent
      .patch(URL)
      .set(app.auth(attendant))
      .send({ distributionMode: 'round_robin' })
      .expect(403);
    expect(escrita.body.error.details.requiredRoles).toEqual(['admin']);
  });

  it('platform_operator e recusado pelo guard de plataforma', async () => {
    const plataforma = await createTenant({ name: 'Plataforma', slug: 'plat', db });
    const operador = await createUser({
      tenantId: plataforma.id,
      role: 'platform_operator',
      db,
    });

    for (const res of [
      await app.agent.get(URL).set(app.auth(operador)),
      await app.agent.patch(URL).set(app.auth(operador)).send({ distributionMode: 'manual' }),
    ]) {
      expect(res.status).toBe(403);
      // Papeis de LABORATORIO provam que quem recusou foi `denyPlatformOperator`.
      expect(res.body.error.details.requiredRoles).toEqual(['attendant', 'manager', 'admin']);
    }
  });

  it('sem token: 401', async () => {
    await app.agent.get(URL).expect(401);
    await app.agent.patch(URL).send({ distributionMode: 'manual' }).expect(401);
  });
});

// ---------------------------------------------------------------------------
// Isolamento multitenant
// ---------------------------------------------------------------------------

describe('isolamento entre dois laboratorios', () => {
  it('canais, configuracao e equipe de B nao aparecem para A', async () => {
    const outro = await createTenant({ name: 'Lab Beta', slug: 'lab-beta', db });
    const adminB = await createUser({ tenantId: outro.id, role: 'admin', name: 'Admin B', db });

    await app.agent
      .patch(URL)
      .set(app.auth(adminB))
      .send({
        channels: [{ channel: 'sms', displayName: 'SMS do Beta', apiToken: TOKEN }],
        distributionMode: 'round_robin',
      })
      .expect(200);

    const res = await app.agent.get(URL).set(app.auth(admin)).expect(200);
    expect(res.body.channels).toEqual([]);
    expect(res.body.distributionMode).toBe('manual');
    expect(res.body.team.map((m: { name: string }) => m.name)).not.toContain('Admin B');
    expect(JSON.stringify(res.body)).not.toContain('SMS do Beta');

    // E o inverso: A escrever nao altera B.
    await patchChannel({ channels: [{ channel: 'whatsapp', displayName: 'WhatsApp do Vida' }] });
    const resB = await app.agent.get(URL).set(app.auth(adminB)).expect(200);
    expect(resB.body.channels.map((c: { channel: string }) => c.channel)).toEqual(['sms']);
    expect(resB.body.distributionMode).toBe('round_robin');
  });

  it('o mesmo `channel` em dois tenants sao linhas independentes', async () => {
    const outro = await createTenant({ name: 'Lab Beta', slug: 'lab-beta', db });
    const adminB = await createUser({ tenantId: outro.id, role: 'admin', db });

    await patchChannel({ channels: [{ channel: 'whatsapp', apiToken: TOKEN }] });
    await app.agent
      .patch(URL)
      .set(app.auth(adminB))
      .send({ channels: [{ channel: 'whatsapp', apiToken: null }] })
      .expect(200);

    // Apagar o token de B nao toca no de A. (`''` em B = revogado, D-073.)
    expect((await rawChannel(tenantId, 'whatsapp'))?.api_token).toBe(TOKEN);
    expect((await rawChannel(outro.id, 'whatsapp'))?.api_token).toBe('');
  });
});
