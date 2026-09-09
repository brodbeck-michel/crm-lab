/**
 * PlatformService — console da plataforma (PAGES.md §11, WORKFLOWS.md §7).
 *
 * Tres coisas sao testadas aqui, em ordem de gravidade:
 *
 *  1. QUEM ENTRA — so `platform_operator`. Admin de laboratorio e admin do SEU
 *     tenant; no console ele nao existe.
 *  2. O QUE SAI — o console NAO ve conversa, paciente nem canal interno de
 *     laboratorio. Ha teste explicito de nao-vazamento: o payload inteiro e
 *     varrido atras de nome de paciente e conteudo de mensagem.
 *  3. ONBOARDING ATOMICO — tenant + tema + 2 canais + admin, ou nada. A falha e
 *     injetada de verdade no meio da transacao.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../src/db/types.js';
import { createAuditService } from '../../src/services/audit.service.js';
import {
  billingFor,
  createPlatformService,
  currentMonthBounds,
  MIN_PASSWORD_LENGTH,
  normalizeSlug,
  PLAN_CATALOG,
  type PlatformService,
} from '../../src/services/platform.service.js';
import { verifyPassword } from '../../src/lib/password.js';
import {
  createConversation,
  createProposal,
  createTenant,
  createUser,
  type UserRecord,
} from '../helpers/factories.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { dbFailingOn, insertChannel, insertMessages, operatorCtx } from './helpers.js';

/** Mes de referencia fixo: a fatura nao pode depender do dia em que roda. */
const NOW = new Date('2026-08-15T12:00:00.000Z');

let db: DbClient;
let operator: UserRecord;

function service(client: DbClient = db): PlatformService {
  return createPlatformService({
    db: client,
    audit: createAuditService(client),
    now: () => NOW,
  });
}

/** O operador vive num tenant proprio ("plataforma"), como nos seeds. */
async function seedOperator(): Promise<UserRecord> {
  const plataforma = await createTenant({ name: 'Plataforma', slug: 'plataforma', db });
  return createUser({
    tenantId: plataforma.id,
    role: 'platform_operator',
    name: 'Operadora',
    db,
  });
}

const VALID_DTO = {
  name: 'Laboratorio Vida',
  slug: 'lab-vida',
  plan: 'pro' as const,
  adminEmail: 'admin@labvida.com.br',
  adminName: 'Admin Vida',
  adminPassword: 'senha-super-segura',
};

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  operator = await seedOperator();
});

describe('permissao — so o operador da plataforma entra', () => {
  it('recusa admin de laboratorio nos tres metodos', async () => {
    const lab = await createTenant({ db });
    const admin = await createUser({ tenantId: lab.id, role: 'admin', db });
    const ctx = {
      userId: admin.id,
      tenantId: lab.id,
      role: 'admin' as const,
      discountLimit: 100,
      ip: '127.0.0.1',
      userAgent: 'vitest',
    };

    await expect(service().listTenants(ctx, {})).rejects.toMatchObject({
      code: 'FORBIDDEN',
      details: { requiredRoles: ['platform_operator'] },
    });
    await expect(service().createTenant(ctx, VALID_DTO)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(service().getBilling(ctx)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('recusa gestor e atendente', async () => {
    const lab = await createTenant({ db });
    for (const role of ['manager', 'attendant'] as const) {
      const user = await createUser({ tenantId: lab.id, role, db });
      await expect(
        service().listTenants(
          {
            userId: user.id,
            tenantId: lab.id,
            role,
            discountLimit: 15,
            ip: '127.0.0.1',
            userAgent: 'vitest',
          },
          {},
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });
});

describe('createTenant — onboarding (WORKFLOWS.md §7)', () => {
  it('cria tenant + tema padrao + 2 canais + admin inicial', async () => {
    const summary = await service().createTenant(operatorCtx(operator), VALID_DTO);

    expect(summary).toMatchObject({
      name: 'Laboratorio Vida',
      slug: 'lab-vida',
      isActive: true,
      subscriptionPlan: 'pro',
      userCount: 1,
    });

    const estado = await db.withoutTenant(async (tx) => ({
      tema: (
        await tx.query<{ accent: string; brand_name: string | null }>(
          'SELECT accent, brand_name FROM themes WHERE tenant_id = $1',
          [summary.id],
        )
      ).rows,
      canais: (
        await tx.query<{ key: string; name: string; kind: string }>(
          'SELECT key, name, kind FROM internal_channels WHERE tenant_id = $1 ORDER BY key',
          [summary.id],
        )
      ).rows,
      admins: (
        await tx.query<{ email: string; role: string; password_hash: string }>(
          'SELECT email, role, password_hash FROM users WHERE tenant_id = $1',
          [summary.id],
        )
      ).rows,
    }));

    // Tema padrao do design system: Terracota & Salvia.
    expect(estado.tema).toHaveLength(1);
    expect(estado.tema[0]?.accent).toBe('#c67139');
    expect(estado.tema[0]?.brand_name).toBe('Laboratorio Vida');

    expect(estado.canais).toEqual([
      { key: 'aprovacoes', name: '#aprovacoes', kind: 'channel' },
      { key: 'geral', name: '#geral', kind: 'channel' },
    ]);

    expect(estado.admins).toHaveLength(1);
    expect(estado.admins[0]?.role).toBe('admin');
    expect(estado.admins[0]?.email).toBe('admin@labvida.com.br');
    // A senha vira hash bcrypt de verdade — nunca texto claro.
    expect(estado.admins[0]?.password_hash).not.toBe(VALID_DTO.adminPassword);
    expect(await verifyPassword(VALID_DTO.adminPassword, estado.admins[0]!.password_hash)).toBe(
      true,
    );
  });

  it('ATOMICO: falha no meio nao deixa tenant, tema, canal nem admin pela metade', async () => {
    const quebrado = service(dbFailingOn(db, /INSERT INTO internal_channels/i));

    await expect(quebrado.createTenant(operatorCtx(operator), VALID_DTO)).rejects.toThrowError(
      /falha injetada/,
    );

    const sobrou = await db.withoutTenant(async (tx) => ({
      tenants: (await tx.query('SELECT id FROM tenants WHERE slug = $1', ['lab-vida'])).rows.length,
      temas: (await tx.query('SELECT id FROM themes')).rows.length,
      canais: (await tx.query('SELECT id FROM internal_channels')).rows.length,
      usuarios: (
        await tx.query('SELECT id FROM users WHERE email = $1', [VALID_DTO.adminEmail])
      ).rows.length,
    }));

    expect(sobrou).toEqual({ tenants: 0, temas: 0, canais: 0, usuarios: 0 });

    // E o slug continua livre: da para repetir o onboarding sem intervencao.
    const ok = await service().createTenant(operatorCtx(operator), VALID_DTO);
    expect(ok.slug).toBe('lab-vida');
  });

  it('ATOMICO: falha no ULTIMO passo (admin) tambem desfaz o tenant', async () => {
    const quebrado = service(dbFailingOn(db, /INSERT INTO users/i));

    await expect(quebrado.createTenant(operatorCtx(operator), VALID_DTO)).rejects.toThrowError(
      /falha injetada/,
    );

    const tenants = await db.withoutTenant((tx) =>
      tx.query('SELECT id FROM tenants WHERE slug = $1', ['lab-vida']),
    );
    expect(tenants.rows).toHaveLength(0);
  });

  it('slug duplicado devolve CONFLICT', async () => {
    await service().createTenant(operatorCtx(operator), VALID_DTO);
    await expect(
      service().createTenant(operatorCtx(operator), {
        ...VALID_DTO,
        name: 'Outro Lab',
        adminEmail: 'outro@lab.com.br',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT', details: { field: 'slug' } });
  });

  it('slug e canonizado antes de decidir duplicidade', async () => {
    const criado = await service().createTenant(operatorCtx(operator), {
      ...VALID_DTO,
      slug: '  Lab Vida  ',
    });
    expect(criado.slug).toBe('lab-vida');
    expect(normalizeSlug('Lab  Vida!!')).toBe('lab-vida');

    await expect(
      service().createTenant(operatorCtx(operator), {
        ...VALID_DTO,
        slug: 'LAB-VIDA',
        adminEmail: 'x@y.com.br',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('recusa DTO invalido com VALIDATION_ERROR e details.fields', async () => {
    await expect(
      service().createTenant(operatorCtx(operator), {
        name: '',
        slug: '!',
        plan: 'gold' as never,
        adminEmail: 'nao-e-email',
        adminName: '',
        adminPassword: '123',
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: {
        fields: {
          name: expect.any(String),
          slug: expect.any(String),
          plan: expect.any(String),
          adminEmail: expect.any(String),
          adminName: expect.any(String),
          adminPassword: expect.any(String),
        },
      },
    });
  });

  it('registra a criacao no audit log, sem senha nem e-mail', async () => {
    const criado = await service().createTenant(operatorCtx(operator), VALID_DTO);
    const logs = await db.withoutTenant((tx) =>
      tx.query<{ action: string; entity_id: string; new_values: unknown }>(
        'SELECT action, entity_id, new_values FROM audit_logs',
      ),
    );
    expect(logs.rows).toHaveLength(1);
    expect(logs.rows[0]).toMatchObject({ action: 'create_tenant', entity_id: criado.id });
    const serializado = JSON.stringify(logs.rows[0]);
    expect(serializado).not.toContain(VALID_DTO.adminPassword);
    expect(serializado).not.toContain(VALID_DTO.adminEmail);
  });
});

describe('listTenants', () => {
  it('lista os laboratorios com contagem de usuarios e paginacao', async () => {
    const a = await createTenant({ name: 'Lab Alfa', slug: 'lab-alfa', db });
    await createUser({ tenantId: a.id, role: 'admin', db });
    await createUser({ tenantId: a.id, role: 'attendant', db });
    await createTenant({ name: 'Lab Beta', slug: 'lab-beta', db });

    const res = await service().listTenants(operatorCtx(operator), {});
    // 2 laboratorios + o tenant da propria plataforma
    expect(res.pagination.total).toBe(3);
    expect(res.pagination).toMatchObject({ page: 1, limit: 20, totalPages: 1 });

    const alfa = res.tenants.find((t) => t.slug === 'lab-alfa');
    expect(alfa).toMatchObject({ name: 'Lab Alfa', isActive: true, userCount: 2 });
    expect(alfa?.subscriptionUntil).toBeNull();
  });

  it('filtra por busca, plano e status', async () => {
    await createTenant({ name: 'Lab Alfa', slug: 'lab-alfa', subscriptionPlan: 'starter', db });
    await createTenant({ name: 'Lab Beta', slug: 'lab-beta', subscriptionPlan: 'enterprise', db });
    await createTenant({ name: 'Lab Gama', slug: 'lab-gama', isActive: false, db });

    const ctx = operatorCtx(operator);
    expect((await service().listTenants(ctx, { search: 'Beta' })).tenants).toHaveLength(1);
    expect((await service().listTenants(ctx, { plan: 'enterprise' })).tenants).toHaveLength(1);
    expect((await service().listTenants(ctx, { isActive: false })).tenants).toHaveLength(1);
  });

  it('pagina de verdade', async () => {
    for (let i = 0; i < 5; i += 1) {
      await createTenant({ name: `Lab ${i}`, slug: `lab-${i}`, db });
    }
    const res = await service().listTenants(operatorCtx(operator), { page: 2, limit: 2 });
    expect(res.tenants).toHaveLength(2);
    expect(res.pagination).toMatchObject({ page: 2, limit: 2, total: 6, totalPages: 3 });
  });
});

describe('getBilling', () => {
  it('conta mensagens do mes corrente e propostas, e calcula o MRR', async () => {
    const lab = await createTenant({ name: 'Lab Pro', slug: 'lab-pro', subscriptionPlan: 'pro', db });
    const user = await createUser({ tenantId: lab.id, role: 'admin', db });
    const conversa = await createConversation({ tenantId: lab.id, db });

    await insertMessages(db, {
      tenantId: lab.id,
      conversationId: conversa.id,
      count: 3,
      createdAt: '2026-08-10 10:00:00',
    });
    // Mes anterior: NAO entra na fatura do mes corrente.
    await insertMessages(db, {
      tenantId: lab.id,
      conversationId: conversa.id,
      count: 7,
      createdAt: '2026-07-10 10:00:00',
    });
    await createProposal({ tenantId: lab.id, createdBy: user.id, totalPrice: 500, db });
    await createProposal({ tenantId: lab.id, createdBy: user.id, totalPrice: 900, db });

    const billing = await service().getBilling(operatorCtx(operator));
    const linha = billing.usage.find((row) => row.tenantId === lab.id);

    expect(linha).toEqual({
      tenantId: lab.id,
      tenantName: 'Lab Pro',
      plan: 'pro',
      messagesIncluded: PLAN_CATALOG.pro.messagesIncluded,
      messagesUsed: 3,
      extraMessages: 0,
      proposalCount: 2,
      monthlyPrice: PLAN_CATALOG.pro.monthlyPrice,
    });

    // O tenant da plataforma tambem aparece (plano padrao 'pro' da factory).
    expect(billing.totals.messages).toBe(3);
    expect(billing.totals.tenants).toBe(2);
    expect(billing.totals.mrr).toBe(
      billing.usage.reduce((total, row) => total + row.monthlyPrice, 0),
    );
    expect(typeof billing.totals.mrr).toBe('number');
  });

  it('MRR ignora laboratorio inativo', async () => {
    await createTenant({ name: 'Suspenso', slug: 'suspenso', isActive: false, db });
    const billing = await service().getBilling(operatorCtx(operator));

    expect(billing.usage).toHaveLength(2); // o suspenso continua listado
    expect(billing.totals.tenants).toBe(1); // mas nao conta como cliente ativo
    const suspenso = billing.usage.find((row) => row.tenantName === 'Suspenso');
    expect(billing.totals.mrr).toBe(
      billing.usage.reduce((t, r) => t + r.monthlyPrice, 0) - (suspenso?.monthlyPrice ?? 0),
    );
  });

  it('excedente e derivado do uso, nao de contador materializado', () => {
    expect(billingFor('starter', 0)).toEqual({
      messagesIncluded: 1000,
      extraMessages: 0,
      monthlyPrice: 299,
    });
    expect(billingFor('starter', 1000)).toMatchObject({ extraMessages: 0, monthlyPrice: 299 });
    // 1250 - 1000 = 250 excedentes a R$ 0,10 = R$ 25 -> 299 + 25
    expect(billingFor('starter', 1250)).toEqual({
      messagesIncluded: 1000,
      extraMessages: 250,
      monthlyPrice: 324,
    });
    expect(billingFor('enterprise', 20_001)).toMatchObject({ extraMessages: 1 });
  });

  it('a janela do mes e UTC e vira o ano corretamente', () => {
    expect(currentMonthBounds(new Date('2026-08-15T12:00:00Z'))).toEqual({
      start: '2026-08-01 00:00:00',
      endExclusive: '2026-09-01 00:00:00',
    });
    expect(currentMonthBounds(new Date('2026-12-31T23:59:59Z'))).toEqual({
      start: '2026-12-01 00:00:00',
      endExclusive: '2027-01-01 00:00:00',
    });
  });
});

describe('getTenantDetail (D-102)', () => {
  it('devolve status de canal, admins e saude de uso', async () => {
    const lab = await createTenant({ name: 'Lab Vida', slug: 'lab-vida', db });
    const admin = await createUser({ tenantId: lab.id, role: 'admin', email: 'admin@labvida.com.br', db });
    await createUser({ tenantId: lab.id, role: 'attendant', isActive: false, db });
    await insertChannel(db, {
      tenantId: lab.id,
      channel: 'whatsapp',
      isActive: true,
      connectionMode: 'cloud_api',
      connectedAt: '2026-08-01 09:00:00',
      phoneNumber: '+5548999998888',
      apiToken: 'segredo-nunca-sai',
    });
    const conversa = await createConversation({ tenantId: lab.id, db });
    await insertMessages(db, {
      tenantId: lab.id,
      conversationId: conversa.id,
      count: 4,
      createdAt: '2026-08-10 10:00:00',
    });
    const proposta = await createProposal({ tenantId: lab.id, createdBy: admin.id, totalPrice: 500, db });
    // `createProposal` grava `created_at = NOW()` real — alinha ao mes mockado (NOW acima).
    await db.withoutTenant((tx) =>
      tx.query('UPDATE proposals SET created_at = $1::timestamp WHERE id = $2', [
        '2026-08-12 10:00:00',
        proposta.id,
      ]),
    );

    const detail = await service().getTenantDetail(operatorCtx(operator), lab.id);

    expect(detail).toMatchObject({ name: 'Lab Vida', slug: 'lab-vida', isActive: true });
    expect(detail.channels).toEqual([
      { channel: 'whatsapp', isActive: true, connectionMode: 'cloud_api', connectedAt: expect.any(String) },
    ]);
    expect(detail.admins).toEqual([{ id: admin.id, email: 'admin@labvida.com.br' }]);
    expect(detail.usage).toEqual({
      activeUsers: 1, // só o admin — o attendant nasceu inativo
      totalUsers: 2,
      lastLoginAt: null,
      proposalsThisMonth: 1,
      messagesThisMonth: 4,
    });
  });

  it('canal e admin nunca vazam telefone, token ou nome', async () => {
    const lab = await createTenant({ name: 'Lab Sigiloso', slug: 'lab-sigiloso', db });
    await createUser({
      tenantId: lab.id,
      role: 'admin',
      name: 'Admin Secreto',
      email: 'admin@sigiloso.com.br',
      db,
    });
    await insertChannel(db, {
      tenantId: lab.id,
      phoneNumber: '+5548999998888',
      apiToken: 'segredo-nunca-sai',
    });

    const detail = await service().getTenantDetail(operatorCtx(operator), lab.id);
    const payload = JSON.stringify(detail);

    expect(payload).not.toContain('+5548999998888');
    expect(payload).not.toContain('segredo-nunca-sai');
    expect(payload).not.toContain('Admin Secreto');
    expect(Object.keys(detail.channels[0] ?? {}).sort()).toEqual([
      'channel',
      'connectedAt',
      'connectionMode',
      'isActive',
    ]);
    expect(Object.keys(detail.admins[0] ?? {}).sort()).toEqual(['email', 'id']);
  });

  it('exclui manager e attendant de `admins`', async () => {
    const lab = await createTenant({ db });
    await createUser({ tenantId: lab.id, role: 'manager', email: 'gestor@lab.com.br', db });
    await createUser({ tenantId: lab.id, role: 'attendant', email: 'atendente@lab.com.br', db });

    const detail = await service().getTenantDetail(operatorCtx(operator), lab.id);
    expect(detail.admins).toEqual([]);
  });

  it('tenant inexistente devolve NOT_FOUND', async () => {
    await expect(
      service().getTenantDetail(operatorCtx(operator), '00000000-0000-4000-8000-000000000099'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('recusa quem nao e platform_operator', async () => {
    const lab = await createTenant({ db });
    const admin = await createUser({ tenantId: lab.id, role: 'admin', db });
    const ctx = {
      userId: admin.id,
      tenantId: lab.id,
      role: 'admin' as const,
      discountLimit: 100,
      ip: '127.0.0.1',
      userAgent: 'vitest',
    };
    await expect(service().getTenantDetail(ctx, lab.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

describe('updateTenant (D-102)', () => {
  it('suspende o tenant e audita a mudanca', async () => {
    const lab = await createTenant({ name: 'Lab Vida', slug: 'lab-vida', db });
    const updated = await service().updateTenant(operatorCtx(operator), lab.id, {
      isActive: false,
    });
    expect(updated.isActive).toBe(false);

    const logs = await db.withoutTenant((tx) =>
      tx.query<{ action: string; old_values: unknown; new_values: unknown }>(
        "SELECT action, old_values, new_values FROM audit_logs WHERE action = 'update_tenant'",
      ),
    );
    expect(logs.rows).toHaveLength(1);
    expect(logs.rows[0]).toMatchObject({
      action: 'update_tenant',
      old_values: { isActive: true },
      new_values: { isActive: false },
    });
  });

  it('troca o plano', async () => {
    const lab = await createTenant({ subscriptionPlan: 'starter', db });
    const updated = await service().updateTenant(operatorCtx(operator), lab.id, {
      subscriptionPlan: 'enterprise',
    });
    expect(updated.subscriptionPlan).toBe('enterprise');
  });

  it('PATCH que repete o valor atual nao grava audit log', async () => {
    const lab = await createTenant({ isActive: true, db });
    await service().updateTenant(operatorCtx(operator), lab.id, { isActive: true });

    const logs = await db.withoutTenant((tx) =>
      tx.query("SELECT id FROM audit_logs WHERE action = 'update_tenant'"),
    );
    expect(logs.rows).toHaveLength(0);
  });

  it('corpo vazio (nem isActive nem subscriptionPlan) e VALIDATION_ERROR', async () => {
    const lab = await createTenant({ db });
    await expect(service().updateTenant(operatorCtx(operator), lab.id, {})).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('tenant inexistente devolve NOT_FOUND', async () => {
    await expect(
      service().updateTenant(operatorCtx(operator), '00000000-0000-4000-8000-000000000099', {
        isActive: false,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('recusa quem nao e platform_operator', async () => {
    const lab = await createTenant({ db });
    const admin = await createUser({ tenantId: lab.id, role: 'admin', db });
    const ctx = {
      userId: admin.id,
      tenantId: lab.id,
      role: 'admin' as const,
      discountLimit: 100,
      ip: '127.0.0.1',
      userAgent: 'vitest',
    };
    await expect(
      service().updateTenant(ctx, lab.id, { isActive: false }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('resetAdminPassword (D-102)', () => {
  it('gera senha temporaria, hasheia e audita sem a senha', async () => {
    const lab = await createTenant({ db });
    const admin = await createUser({ tenantId: lab.id, role: 'admin', email: 'admin@lab.com.br', db });

    const result = await service().resetAdminPassword(operatorCtx(operator), lab.id, admin.id);
    expect(result.email).toBe('admin@lab.com.br');
    expect(result.temporaryPassword.length).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH);

    const row = await db.withoutTenant((tx) =>
      tx.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [
        admin.id,
      ]),
    );
    const hash = row.rows[0]?.password_hash;
    expect(hash).not.toBe(result.temporaryPassword);
    expect(await verifyPassword(result.temporaryPassword, hash ?? '')).toBe(true);

    const logs = await db.withoutTenant((tx) =>
      tx.query<{ action: string; entity_id: string; old_values: unknown; new_values: unknown }>(
        "SELECT action, entity_id, old_values, new_values FROM audit_logs WHERE action = 'reset_admin_password'",
      ),
    );
    expect(logs.rows).toHaveLength(1);
    expect(logs.rows[0]?.entity_id).toBe(admin.id);
    const serializado = JSON.stringify(logs.rows[0]);
    expect(serializado).not.toContain(result.temporaryPassword);
  });

  it('usuario de outro tenant devolve NOT_FOUND, nunca FORBIDDEN', async () => {
    const labA = await createTenant({ db });
    const labB = await createTenant({ db });
    const adminB = await createUser({ tenantId: labB.id, role: 'admin', db });

    await expect(
      service().resetAdminPassword(operatorCtx(operator), labA.id, adminB.id),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('usuario que nao e admin (manager/attendant) devolve NOT_FOUND', async () => {
    const lab = await createTenant({ db });
    const manager = await createUser({ tenantId: lab.id, role: 'manager', db });

    await expect(
      service().resetAdminPassword(operatorCtx(operator), lab.id, manager.id),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('tenant inexistente devolve NOT_FOUND', async () => {
    const lab = await createTenant({ db });
    const admin = await createUser({ tenantId: lab.id, role: 'admin', db });
    await expect(
      service().resetAdminPassword(
        operatorCtx(operator),
        '00000000-0000-4000-8000-000000000099',
        admin.id,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('recusa quem nao e platform_operator', async () => {
    const lab = await createTenant({ db });
    const admin = await createUser({ tenantId: lab.id, role: 'admin', db });
    const ctx = {
      userId: admin.id,
      tenantId: lab.id,
      role: 'admin' as const,
      discountLimit: 100,
      ip: '127.0.0.1',
      userAgent: 'vitest',
    };
    await expect(
      service().resetAdminPassword(ctx, lab.id, admin.id),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('NAO-VAZAMENTO: o console nao ve dado de laboratorio', () => {
  it('nenhum payload carrega nome de paciente nem conteudo de mensagem', async () => {
    const lab = await createTenant({ name: 'Lab Sigiloso', slug: 'lab-sigiloso', db });
    const user = await createUser({
      tenantId: lab.id,
      role: 'attendant',
      name: 'Atendente Secreta',
      db,
    });
    const conversa = await createConversation({
      tenantId: lab.id,
      patientName: 'Maria Paciente Secreta',
      patientPhone: '+5548999000111',
      patientEmail: 'maria@paciente.local',
      db,
    });
    await insertMessages(db, {
      tenantId: lab.id,
      conversationId: conversa.id,
      count: 2,
      createdAt: '2026-08-10 10:00:00',
      content: 'resultado do hemograma da Maria',
    });
    await createProposal({ tenantId: lab.id, createdBy: user.id, totalPrice: 1234.56, db });

    const ctx = operatorCtx(operator);
    const payloads = JSON.stringify([
      await service().listTenants(ctx, {}),
      await service().getBilling(ctx),
      await service().createTenant(ctx, VALID_DTO),
    ]);

    for (const segredo of [
      'Maria Paciente Secreta',
      'resultado do hemograma',
      '+5548999000111',
      'maria@paciente.local',
      'Atendente Secreta',
      'hemograma',
    ]) {
      expect(payloads).not.toContain(segredo);
    }

    // Valor de proposta tambem nao: o console ve QUANTAS, nunca QUANTO.
    expect(payloads).not.toContain('1234.56');

    const billing = await service().getBilling(ctx);
    const linha = billing.usage.find((row) => row.tenantId === lab.id);
    // O que o console pode ver e a contagem agregada — numero sem sujeito.
    expect(linha?.proposalCount).toBe(1);
    expect(linha?.messagesUsed).toBe(2);
    expect(Object.keys(linha ?? {}).sort()).toEqual([
      'extraMessages',
      'messagesIncluded',
      'messagesUsed',
      'monthlyPrice',
      'plan',
      'proposalCount',
      'tenantId',
      'tenantName',
    ]);
  });

  it('TenantSummary expoe so cadastro do tenant — nada de conteudo', async () => {
    const lab = await createTenant({ name: 'Lab X', slug: 'lab-x', db });
    await createConversation({ tenantId: lab.id, patientName: 'Joao Paciente', db });

    const res = await service().listTenants(operatorCtx(operator), { search: 'Lab X' });
    expect(Object.keys(res.tenants[0] ?? {}).sort()).toEqual([
      'createdAt',
      'id',
      'isActive',
      'name',
      'slug',
      'subscriptionPlan',
      'subscriptionUntil',
      'userCount',
    ]);
  });
});
