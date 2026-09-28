/**
 * Integração CRMLAB-56 × CRMLAB-57: o liga/desliga "Nascer do orçamento do
 * Bitlab" da página de Regras (`origin.fromBitlab`) é o que decide se a
 * ingestão cria o cartão (D-196 item 1).
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_FUNNEL_RULES } from '@crm-lab/shared';
import type { DbClient } from '../../src/db/types.js';
import { upsertRules } from '../../src/repositories/funnel-rules.repository.js';
import { isBitlabOriginEnabled } from '../../src/services/bitlab-origin-gate.js';
import { createTenant, createUser, type TenantRecord } from '../helpers/factories.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

let db: DbClient;
let tenantA: TenantRecord;
let tenantB: TenantRecord;

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  tenantA = await createTenant({ name: 'Lab A', slug: 'lab-a', db });
  tenantB = await createTenant({ name: 'Lab B', slug: 'lab-b', db });
});

describe('isBitlabOriginEnabled', () => {
  it('sem regra gravada segue o padrão (ligado)', async () => {
    const enabled = await db.withTenant(tenantA.id, (tx) => isBitlabOriginEnabled(tx, tenantA.id));
    expect(enabled).toBe(DEFAULT_FUNNEL_RULES.origin.fromBitlab);
    expect(enabled).toBe(true);
  });

  it('desligado nas Regras de um laboratório não afeta o outro', async () => {
    const admin = await createUser({ tenantId: tenantA.id, role: 'admin', db });
    await db.withTenant(tenantA.id, (tx) =>
      upsertRules(tx, tenantA.id, {
        ...DEFAULT_FUNNEL_RULES,
        origin: { fromBitlab: false, manualInCrm: true },
      }, admin.id),
    );
    const a = await db.withTenant(tenantA.id, (tx) => isBitlabOriginEnabled(tx, tenantA.id));
    const b = await db.withTenant(tenantB.id, (tx) => isBitlabOriginEnabled(tx, tenantB.id));
    expect(a).toBe(false);
    expect(b).toBe(true);
  });
});
