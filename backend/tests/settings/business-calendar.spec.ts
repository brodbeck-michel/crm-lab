/**
 * `GET /api/v1/settings/business-calendar` — API_CONTRACTS.md §6e (CRMLAB-84,
 * D-254). O que o navegador precisa para contar minutos uteis do alerta de
 * tempo de resposta: horario de funcionamento + feriados cadastrados da
 * janela. Todo perfil de laboratorio le (a atendente nao le `/settings/channels`).
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BUSINESS_CALENDAR_LOOKBACK_DAYS,
  localDateOf,
  type BusinessCalendarResponse,
} from '@crm-lab/shared';
import { businessCalendarModule } from '../../src/controllers/holiday.routes.js';
import type { DbClient } from '../../src/db/types.js';
import { createTenant, createUser, type TenantRecord, type UserRecord } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

const BASE = '/api/v1/settings/business-calendar';
const TZ = 'America/Sao_Paulo';
const DAY_MS = 24 * 60 * 60 * 1000;

let db: DbClient;
let app: TestApp;
let tenantA: TenantRecord;
let tenantB: TenantRecord;
let attendantA: UserRecord;

function daysFromNow(days: number): string {
  return localDateOf(new Date(Date.now() + days * DAY_MS), TZ);
}

async function holiday(tenantId: string, date: string): Promise<void> {
  await db.withoutTenant((tx) =>
    tx.query(`INSERT INTO tenant_holidays (tenant_id, holiday_date, description) VALUES ($1, $2::date, 'X')`, [
      tenantId,
      date,
    ]),
  );
}

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  app = await createTestApp({ db, modules: [businessCalendarModule] });
  tenantA = await createTenant({ name: 'Lab A', slug: 'lab-a', db });
  tenantB = await createTenant({ name: 'Lab B', slug: 'lab-b', db });
  attendantA = await createUser({ tenantId: tenantA.id, role: 'attendant', db });
});

describe('GET /settings/business-calendar', () => {
  it('atendente le: sem configuracao = sem dias (sempre aberto) e sem feriados', async () => {
    const res = await app.agent.get(BASE).set(app.auth(attendantA));
    expect(res.status).toBe(200);
    const body = res.body as BusinessCalendarResponse;
    expect(body.businessHours).toEqual({ timezone: TZ, days: {} });
    expect(body.customHolidays).toEqual([]);
    expect(body.from).toBe(daysFromNow(-BUSINESS_CALENDAR_LOOKBACK_DAYS));
    expect(body.to).toBe(daysFromNow(1));
  });

  it('devolve o horario gravado e so os feriados do laboratorio dentro da janela', async () => {
    const hours = { timezone: TZ, days: { mon: { start: '08:00', end: '18:00' }, sat: null } };
    await db.withoutTenant((tx) =>
      tx.query(`INSERT INTO tenant_settings (tenant_id, business_hours) VALUES ($1, $2::jsonb)`, [
        tenantA.id,
        JSON.stringify(hours),
      ]),
    );
    await holiday(tenantA.id, daysFromNow(-3));
    await holiday(tenantA.id, daysFromNow(-(BUSINESS_CALENDAR_LOOKBACK_DAYS + 5)));
    await holiday(tenantA.id, daysFromNow(10));
    await holiday(tenantB.id, daysFromNow(-2));

    const res = await app.agent.get(BASE).set(app.auth(attendantA));
    const body = res.body as BusinessCalendarResponse;
    expect(body.businessHours).toEqual(hours);
    expect(body.customHolidays).toEqual([daysFromNow(-3)]);
  });

  it('platform_operator recebe FORBIDDEN', async () => {
    const plataforma = await createTenant({ name: 'Plataforma', slug: 'plataforma', db });
    const operator = await createUser({ tenantId: plataforma.id, role: 'platform_operator', db });
    const res = await app.agent.get(BASE).set(app.auth(operator));
    expect(res.status).toBe(403);
  });
});
