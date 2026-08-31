/**
 * MAX_PAGE aplicado nos services que ainda faltavam (Onda 7, pendencia
 * mecanica): `patient.service.ts`, `proposal.service.ts` e
 * `insurance.service.ts` ja tinham o teto; `conversation.service.ts`,
 * `exam-catalog.service.ts`, `platform.service.ts` e `internal-chat.service.ts`
 * clampavam `page` ate `Number.MAX_SAFE_INTEGER` — sem teto, um
 * `?page=9007199254740991` produz `OFFSET` absurdo na consulta (ver o
 * comentario de `proposal.service.ts` MAX_PAGE).
 */
import { describe, expect, it } from 'vitest';
import { conversationModule } from '../../src/controllers/conversation.routes.js';
import { createConversation, createTenant, createUser } from '../helpers/factories.js';
import { createTestApp } from '../helpers/test-app.js';
import { resetDatabase } from '../helpers/test-db.js';

describe('MAX_PAGE aplicado nos services restantes', () => {
  it.each([
    ['conversation.service.ts', () => import('../../src/services/conversation.service.js')],
    ['exam-catalog.service.ts', () => import('../../src/services/exam-catalog.service.js')],
    ['platform.service.ts', () => import('../../src/services/platform.service.js')],
    ['internal-chat.service.ts', () => import('../../src/services/internal-chat.service.js')],
  ] as const)('%s exporta MAX_PAGE = 10_000', async (_file, load) => {
    const mod: unknown = await load();
    expect((mod as { MAX_PAGE?: number }).MAX_PAGE).toBe(10_000);
  });

  it('GET /conversations com page=Number.MAX_SAFE_INTEGER nao trava/erra — devolve lista vazia', async () => {
    await resetDatabase();
    const app = await createTestApp({ modules: [conversationModule] });
    const tenant = await createTenant();
    const attendant = await createUser({ tenantId: tenant.id, role: 'attendant' });
    await createConversation({ tenantId: tenant.id, assignedTo: attendant.id });

    const response = await app.agent
      .get(`/api/v1/conversations?page=${Number.MAX_SAFE_INTEGER}`)
      .set(app.auth(attendant));

    // Sem o teto, o OFFSET calculado (`(page - 1) * limit`) estoura a faixa
    // que o Postgres aceita para o parametro e a query falha (500), em vez de
    // simplesmente devolver pagina vazia.
    expect(response.status).toBe(200);
    expect(response.body.conversations).toEqual([]);
  });
});
