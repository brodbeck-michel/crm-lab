/**
 * `/themes` — SERVICES.md §8, WORKFLOWS.md §9, D-005.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LoginResponse, Theme, ThemePreset } from '@crm-lab/shared';
import type { DbClient } from '../../src/db/types.js';
import { authModule } from '../../src/controllers/auth.routes.js';
import { themeModule } from '../../src/controllers/theme.routes.js';
import { DEFAULT_THEME, THEME_PRESETS } from '../../src/services/theme.service.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import {
  createTenant,
  createUser,
  DEFAULT_TEST_PASSWORD,
  type TenantRecord,
  type UserRecord,
} from '../helpers/factories.js';

describe('/themes', () => {
  let db: DbClient;
  let app: TestApp;
  let tenantA: TenantRecord;
  let tenantB: TenantRecord;
  let adminA: UserRecord;
  let attendantA: UserRecord;
  let adminB: UserRecord;

  beforeAll(async () => {
    db = await getTestDb();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    app = await createTestApp({ db, modules: [themeModule, authModule] });

    tenantA = await createTenant({ name: 'Lab A' });
    tenantB = await createTenant({ name: 'Lab B' });
    adminA = await createUser({ tenantId: tenantA.id, role: 'admin', email: 'admin@a.com' });
    attendantA = await createUser({ tenantId: tenantA.id, role: 'attendant' });
    adminB = await createUser({ tenantId: tenantB.id, role: 'admin', email: 'admin@b.com' });
  });

  it('GET /themes/current devolve o tema padrao quando ainda nao houve personalizacao', async () => {
    const response = await app.agent
      .get('/api/v1/themes/current')
      .set(app.auth(adminA))
      .expect(200);

    expect(response.body.theme).toEqual(DEFAULT_THEME);
  });

  it('GET /themes/presets devolve os 5 temas de DESIGN_TOKENS.md', async () => {
    const response = await app.agent
      .get('/api/v1/themes/presets')
      .set(app.auth(attendantA))
      .expect(200);

    const presets = response.body.presets as ThemePreset[];
    expect(presets).toHaveLength(5);
    expect(presets.map((p) => p.id)).toEqual([
      'terracota',
      'jaleco',
      'esteril',
      'hemograma',
      'diagnostico',
    ]);
    expect(presets[0]).toEqual(THEME_PRESETS[0]);
    // D-005: preset carrega so as cores base — nenhuma rampa derivada.
    expect(Object.keys(presets[0]!).sort()).toEqual(
      ['accent', 'accent2', 'bg', 'id', 'name', 'surface', 'text'].sort(),
    );
  });

  it('PATCH /themes/current salva as 5 cores base + radius + font + brand', async () => {
    const response = await app.agent
      .patch('/api/v1/themes/current')
      .set(app.auth(adminA))
      .send({
        accent: '#2f6f9f',
        accent2: '#4f9d8b',
        bg: '#eef3f7',
        surface: '#dbe6ef',
        text: '#1a1a1a',
        radiusId: 'redondo',
        fontId: 'playfair',
        brandName: 'Lab Azul',
      })
      .expect(200);

    const theme = response.body.theme as Theme;
    expect(theme).toEqual({
      accent: '#2f6f9f',
      accent2: '#4f9d8b',
      bg: '#eef3f7',
      surface: '#dbe6ef',
      text: '#1a1a1a',
      radiusId: 'redondo',
      fontId: 'playfair',
      brandName: 'Lab Azul',
      logoUrl: null,
    });

    // A resposta nao traz rampa (D-005): as 27 variacoes sao derivadas no front.
    expect(JSON.stringify(theme)).not.toContain('color-mix');
    expect(Object.keys(theme)).toHaveLength(9);
  });

  it('PATCH e parcial: campo nao enviado permanece', async () => {
    await app.agent
      .patch('/api/v1/themes/current')
      .set(app.auth(adminA))
      .send({ accent: '#a63a3a', brandName: 'Hemograma Lab' })
      .expect(200);

    const response = await app.agent
      .patch('/api/v1/themes/current')
      .set(app.auth(adminA))
      .send({ radiusId: 'reto' })
      .expect(200);

    const theme = response.body.theme as Theme;
    expect(theme.accent).toBe('#a63a3a');
    expect(theme.brandName).toBe('Hemograma Lab');
    expect(theme.radiusId).toBe('reto');
  });

  it('hex invalido -> VALIDATION_ERROR com details.fields', async () => {
    const response = await app.agent
      .patch('/api/v1/themes/current')
      .set(app.auth(adminA))
      .send({ accent: 'azul', bg: '#fff' })
      .expect(400);

    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.details.fields).toHaveProperty('accent');
    // Forma curta (#fff) tambem e recusada: o contrato e #rrggbb.
    expect(response.body.error.details.fields).toHaveProperty('bg');
  });

  it('radiusId e fontId fora do enum -> VALIDATION_ERROR', async () => {
    const response = await app.agent
      .patch('/api/v1/themes/current')
      .set(app.auth(adminA))
      .send({ radiusId: 'md', fontId: 'comic-sans' })
      .expect(400);

    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.details.fields).toHaveProperty('radiusId');
    expect(response.body.error.details.fields).toHaveProperty('fontId');
  });

  it('nao-admin nao personaliza -> FORBIDDEN', async () => {
    const response = await app.agent
      .patch('/api/v1/themes/current')
      .set(app.auth(attendantA))
      .send({ accent: '#2f7d5f' })
      .expect(403);

    expect(response.body.error.code).toBe('FORBIDDEN');
    expect(response.body.error.details.requiredRoles).toEqual(['admin']);
  });

  it('o tema salvo aparece no proximo login (WORKFLOWS §9 passo 7)', async () => {
    await app.agent
      .patch('/api/v1/themes/current')
      .set(app.auth(adminA))
      .send({ accent: '#6a4f9c', accent2: '#3f8a9a', brandName: 'Lab Lilás' })
      .expect(200);

    const login = await app.agent
      .post('/api/v1/auth/login')
      .send({ email: adminA.email, password: DEFAULT_TEST_PASSWORD })
      .expect(200);

    const theme = (login.body as LoginResponse).tenant.theme;
    expect(theme.accent).toBe('#6a4f9c');
    expect(theme.accent2).toBe('#3f8a9a');
    expect(theme.brandName).toBe('Lab Lilás');
  });

  it('ISOLAMENTO: o tema do tenant A nao vaza para o tenant B', async () => {
    await app.agent
      .patch('/api/v1/themes/current')
      .set(app.auth(adminA))
      .send({ accent: '#2f7d5f', brandName: 'So do A' })
      .expect(200);

    const seenByB = await app.agent
      .get('/api/v1/themes/current')
      .set(app.auth(adminB))
      .expect(200);

    expect(seenByB.body.theme).toEqual(DEFAULT_THEME);
    expect(seenByB.body.theme.brandName).toBeNull();

    const loginB = await app.agent
      .post('/api/v1/auth/login')
      .send({ email: adminB.email, password: DEFAULT_TEST_PASSWORD })
      .expect(200);
    expect((loginB.body as LoginResponse).tenant.theme).toEqual(DEFAULT_THEME);
  });

  it('a personalizacao gera audit log no tenant certo', async () => {
    await app.agent
      .patch('/api/v1/themes/current')
      .set(app.auth(adminA))
      .send({ accent: '#c67139' })
      .expect(200);

    const logs = await db.withoutTenant((tx) =>
      tx.query<{ action: string; tenant_id: string; entity_type: string }>(
        'SELECT action, tenant_id, entity_type FROM audit_logs',
      ),
    );
    expect(logs.rows).toEqual([
      { action: 'update_theme', tenant_id: tenantA.id, entity_type: 'theme' },
    ]);
  });

  it('sem token -> 401', async () => {
    await app.agent.get('/api/v1/themes/current').expect(401);
    await app.agent.patch('/api/v1/themes/current').send({ accent: '#c67139' }).expect(401);
  });
});
