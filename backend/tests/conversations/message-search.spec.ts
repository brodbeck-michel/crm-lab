/**
 * Busca pelo conteudo das mensagens (CRMLAB-68, D-228) — API_CONTRACTS.md §2:
 *
 *   GET /conversations/search/messages?q=   todas as conversas visiveis
 *   GET /conversations/:id/messages?q=      uma conversa
 *
 * O que importa aqui:
 *  - palavra que so existe DENTRO de uma mensagem acha a conversa;
 *  - ignora maiuscula e acento (funcao `crm_unaccent` da migracao 043);
 *  - apagada (D-220) e evento de sistema nunca aparecem;
 *  - recorte da fila para atendente, outro tenant nunca;
 *  - o indice GIN parcial e usado e a busca aguenta alguns milhares de linhas.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MessageSearchHit, SearchMessagesResponse } from '@crm-lab/shared';
import { conversationModule } from '../../src/controllers/conversation.routes.js';
import { toSearchTsQuery } from '../../src/repositories/message.repository.js';
import { createConversation, createTenant, createUser } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { seedMessage } from './helpers.js';

const SEARCH = '/api/v1/conversations/search/messages';

async function setMessage(id: string, sql: string, params: unknown[] = []): Promise<void> {
  const db = await getTestDb();
  await db.withoutTenant((tx) =>
    tx.query(`UPDATE messages SET ${sql} WHERE id = $1`, [id, ...params]),
  );
}

function contents(body: SearchMessagesResponse): string[] {
  return body.results.map((hit: MessageSearchHit) => hit.content);
}

describe('toSearchTsQuery (D-228 item 3)', () => {
  it('palavras por prefixo, todas obrigatorias, sem sintaxe do to_tsquery', () => {
    expect(toSearchTsQuery('Glicose  jejum')).toBe('glicose:* & jejum:*');
    expect(toSearchTsQuery("a' | b & !c:*")).toBe('a:* & b:* & c:*');
    expect(toSearchTsQuery('orçamento')).toBe('orçamento:*');
    expect(toSearchTsQuery('  !!  ')).toBeNull();
  });
});

describe('GET /conversations/search/messages (D-228)', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp({ modules: [conversationModule] });
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  async function scenario() {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const conversation = await createConversation({
      tenantId: tenant.id,
      assignedTo: ana.id,
      patientName: 'João Santos',
    });
    return { tenant, ana, conversation };
  }

  it('palavra que so existe dentro de uma mensagem acha a conversa, com o shape do contrato', async () => {
    const { tenant, ana, conversation } = await scenario();
    await seedMessage({ tenantId: tenant.id, conversationId: conversation.id, content: 'Bom dia' });
    const hit = await seedMessage({
      tenantId: tenant.id,
      conversationId: conversation.id,
      content: 'Preciso do pedido de hemograma completo',
    });

    const response = await app.agent.get(`${SEARCH}?q=hemograma`).set(app.auth(ana)).expect(200);
    const body = response.body as SearchMessagesResponse;
    expect(Object.keys(body).sort()).toEqual(['pagination', 'results']);
    expect(body.pagination).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 });
    expect(body.results).toEqual([
      {
        messageId: hit.id,
        conversationId: conversation.id,
        patientName: 'João Santos',
        patientPhone: conversation.patientPhone,
        senderType: 'patient',
        senderName: 'João Santos',
        messageType: 'text',
        content: 'Preciso do pedido de hemograma completo',
        createdAt: expect.stringMatching(/Z$/),
      },
    ]);
  });

  it('ignora maiuscula e acento nos dois sentidos, e casa por prefixo', async () => {
    const { tenant, ana, conversation } = await scenario();
    for (const content of ['Resultado da Glicose saiu', 'Segue o orçamento', 'EXAME DE AÇÚCAR']) {
      await seedMessage({ tenantId: tenant.id, conversationId: conversation.id, content });
    }
    const search = async (q: string) =>
      contents(
        (
          await app.agent
            .get(`${SEARCH}?q=${encodeURIComponent(q)}`)
            .set(app.auth(ana))
            .expect(200)
        ).body,
      );

    expect(await search('glicose')).toEqual(['Resultado da Glicose saiu']);
    expect(await search('orcamento')).toEqual(['Segue o orçamento']);
    expect(await search('ORÇAMENTO')).toEqual(['Segue o orçamento']);
    expect(await search('acucar')).toEqual(['EXAME DE AÇÚCAR']);
    expect(await search('glic')).toEqual(['Resultado da Glicose saiu']);
    // Todas as palavras precisam estar na mensagem.
    expect(await search('glicose orcamento')).toEqual([]);
    expect(await search('resultado glicose')).toEqual(['Resultado da Glicose saiu']);
  });

  it('mensagem apagada e evento de sistema nunca aparecem; editada acha pelo texto novo', async () => {
    const { tenant, ana, conversation } = await scenario();
    const apagada = await seedMessage({
      tenantId: tenant.id,
      conversationId: conversation.id,
      content: 'glicose apagada',
    });
    await setMessage(apagada.id, "deleted_at = NOW(), deleted_by = 'patient'");
    await seedMessage({
      tenantId: tenant.id,
      conversationId: conversation.id,
      senderType: 'system',
      content: 'Orçamento de glicose enviado',
    });
    const editada = await seedMessage({
      tenantId: tenant.id,
      conversationId: conversation.id,
      content: 'texto antigo',
    });
    await setMessage(editada.id, "content = 'glicose corrigida', edited_at = NOW()");

    const response = await app.agent.get(`${SEARCH}?q=glicose`).set(app.auth(ana)).expect(200);
    expect(contents(response.body)).toEqual(['glicose corrigida']);
    const antigo = await app.agent.get(`${SEARCH}?q=antigo`).set(app.auth(ana)).expect(200);
    expect(antigo.body.results).toEqual([]);
  });

  it('atendente so ve o que veria na fila; gestor ve todas; outro tenant nunca', async () => {
    const { tenant, ana, conversation } = await scenario();
    const bia = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const gestor = await createUser({ tenantId: tenant.id, role: 'manager' });
    const daBia = await createConversation({ tenantId: tenant.id, assignedTo: bia.id });
    const livre = await createConversation({ tenantId: tenant.id, assignedTo: null });
    const encerrada = await createConversation({
      tenantId: tenant.id,
      assignedTo: ana.id,
      status: 'closed',
    });
    const outro = await createTenant();
    const outraConversa = await createConversation({ tenantId: outro.id });
    const gestorOutro = await createUser({ tenantId: outro.id, role: 'admin' });

    for (const [conversationId, tenantId] of [
      [conversation.id, tenant.id],
      [daBia.id, tenant.id],
      [livre.id, tenant.id],
      [encerrada.id, tenant.id],
      [outraConversa.id, outro.id],
    ] as const) {
      await seedMessage({ tenantId, conversationId, content: `glicose em ${conversationId}` });
    }

    const ids = async (user: typeof ana) =>
      (
        (await app.agent.get(`${SEARCH}?q=glicose`).set(app.auth(user)).expect(200))
          .body as SearchMessagesResponse
      ).results
        .map((hit) => hit.conversationId)
        .sort();

    expect(await ids(ana)).toEqual([conversation.id, livre.id, encerrada.id].sort());
    expect(await ids(bia)).toEqual([daBia.id, livre.id].sort());
    expect(await ids(gestor)).toEqual([conversation.id, daBia.id, livre.id, encerrada.id].sort());
    expect(await ids(gestorOutro)).toEqual([outraConversa.id]);
  });

  it('mais nova primeiro, com paginacao', async () => {
    const { tenant, ana, conversation } = await scenario();
    for (let i = 1; i <= 3; i += 1) {
      const seeded = await seedMessage({
        tenantId: tenant.id,
        conversationId: conversation.id,
        content: `glicose ${i}`,
      });
      await setMessage(seeded.id, 'created_at = $2::timestamp', [`2026-09-20 10:0${i}:00`]);
    }
    const first = await app.agent.get(`${SEARCH}?q=glicose&limit=2`).set(app.auth(ana)).expect(200);
    expect(contents(first.body)).toEqual(['glicose 3', 'glicose 2']);
    expect(first.body.pagination).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
    const second = await app.agent
      .get(`${SEARCH}?q=glicose&limit=2&page=2`)
      .set(app.auth(ana))
      .expect(200);
    expect(contents(second.body)).toEqual(['glicose 1']);
  });

  it('termo invalido -> VALIDATION_ERROR; so palavra vazia -> nada', async () => {
    const { ana } = await scenario();
    for (const q of ['', 'a', '!!', 'x'.repeat(121)]) {
      const response = await app.agent
        .get(`${SEARCH}?q=${encodeURIComponent(q)}`)
        .set(app.auth(ana))
        .expect(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
    await app.agent.get(SEARCH).set(app.auth(ana)).expect(400);
    await app.agent.get(`${SEARCH}?q=glicose&limit=101`).set(app.auth(ana)).expect(400);
    const stop = await app.agent.get(`${SEARCH}?q=de`).set(app.auth(ana)).expect(200);
    expect(stop.body.results).toEqual([]);
  });

  it('alguns milhares de mensagens: usa o indice GIN parcial e responde rapido', async () => {
    const { tenant, ana, conversation } = await scenario();
    const db = await getTestDb();
    await db.withoutTenant((tx) =>
      tx.query(
        `INSERT INTO messages (tenant_id, conversation_id, sender_type, content, message_type, status)
         SELECT $1, $2, 'patient',
                CASE WHEN g % 500 = 0 THEN 'quero o orçamento do hemograma ' || g
                     ELSE 'mensagem comum numero ' || g || ' sobre exames e jejum' END,
                'text', 'delivered'
         FROM generate_series(1, 4000) AS g`,
        [tenant.id, conversation.id],
      ),
    );

    const started = Date.now();
    const response = await app.agent
      .get(`${SEARCH}?q=orcamento hemograma`)
      .set(app.auth(ana))
      .expect(200);
    const elapsed = Date.now() - started;
    expect(response.body.pagination.total).toBe(8);
    // Folga larga para a maquina de CI; sem indice a varredura com to_tsvector
    // por linha passa disso com folga no PGlite.
    expect(elapsed).toBeLessThan(3000);

    // O planner escolhe o GIN parcial quando a expressao e o predicado batem.
    const plan = await db.withoutTenant(async (tx) => {
      await tx.query('SET LOCAL enable_seqscan = off');
      const explained = await tx.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT m.id FROM messages m
          WHERE m.deleted_at IS NULL
            AND to_tsvector('portuguese', crm_unaccent(m.content))
                @@ to_tsquery('portuguese', crm_unaccent('orcamento:* & hemograma:*'))`,
      );
      return explained.rows.map((row) => row['QUERY PLAN']).join('\n');
    });
    expect(plan).toContain('idx_messages_content_search');
  });
});

describe('GET /conversations/:id/messages?q= (D-228)', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp({ modules: [conversationModule] });
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  it('so desta conversa; conversa invisivel ou de outro tenant -> 404', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const bia = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const minha = await createConversation({ tenantId: tenant.id, assignedTo: ana.id });
    const outra = await createConversation({ tenantId: tenant.id, assignedTo: ana.id });
    const daBia = await createConversation({ tenantId: tenant.id, assignedTo: bia.id });
    const outro = await createTenant();
    const alheia = await createConversation({ tenantId: outro.id });
    await seedMessage({ tenantId: tenant.id, conversationId: minha.id, content: 'glicose aqui' });
    await seedMessage({ tenantId: tenant.id, conversationId: outra.id, content: 'glicose la' });

    const response = await app.agent
      .get(`/api/v1/conversations/${minha.id}/messages?q=glicose`)
      .set(app.auth(ana))
      .expect(200);
    expect(contents(response.body)).toEqual(['glicose aqui']);

    for (const id of [daBia.id, alheia.id]) {
      const denied = await app.agent
        .get(`/api/v1/conversations/${id}/messages?q=glicose`)
        .set(app.auth(ana))
        .expect(404);
      expect(denied.body.error.code).toBe('NOT_FOUND');
    }
    await app.agent
      .get(`/api/v1/conversations/nao-uuid/messages?q=glicose`)
      .set(app.auth(ana))
      .expect(400);
  });
});
