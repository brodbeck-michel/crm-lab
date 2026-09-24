/**
 * `MessageService.createFromPhone` e a corrida do eco (D-173, CRMLAB-46).
 *
 * O eco do `sendText` pode chegar pelo webhook ANTES de o proprio `sendText`
 * responder com o id — ou seja, antes de `createFromAgent` gravar o
 * `externalId`. Os testes simulam isso com um gateway falso que entrega o eco
 * DE DENTRO do envio, pelo caminho real de `createFromAgent`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../src/db/types.js';
import { ConversationRepository } from '../../src/repositories/conversation.repository.js';
import { MessageRepository } from '../../src/repositories/message.repository.js';
import { MessageService, type EchoWaitOptions } from '../../src/services/message.service.js';
import type { WhatsAppService } from '../../src/services/whatsapp.service.js';
import { countMessages, seedMessage } from '../conversations/helpers.js';
import { createConversation, createTenant, createUser } from '../helpers/factories.js';
import { FakeWsHub } from '../helpers/fake-ws.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

let db: DbClient;
let wsHub: FakeWsHub;

beforeEach(async () => {
  await resetDatabase();
  db = await getTestDb();
  wsHub = new FakeWsHub();
});

/** Gateway falso: `onSend` roda no meio do envio, antes de devolver o id. */
function fakeWhatsApp(externalId: string, onSend: () => Promise<void>): WhatsAppService {
  const fake = {
    send: async () => {
      await onSend();
      return { externalId };
    },
  };
  return fake as unknown as WhatsAppService;
}

function buildService(
  echoWait: Partial<EchoWaitOptions>,
  whatsapp?: WhatsAppService,
): MessageService {
  return new MessageService({
    messages: new MessageRepository(db),
    conversations: new ConversationRepository(db),
    wsHub,
    ...(whatsapp ? { whatsapp } : {}),
    echoWait,
  });
}

async function scenario() {
  const tenant = await createTenant();
  const agent = await createUser({ tenantId: tenant.id });
  const conversation = await createConversation({ tenantId: tenant.id });
  return { tenant, agent, conversation };
}

async function rowsOf(conversationId: string) {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ sender_id: string | null; external_message_id: string | null; status: string }>(
      'SELECT sender_id, external_message_id, status FROM messages WHERE conversation_id = $1',
      [conversationId],
    ),
  );
  return result.rows;
}

describe('MessageService.createFromPhone — eco do CRM (D-173)', () => {
  it('eco que chega ANTES da confirmacao do envio espera o id e e descartado', async () => {
    const { tenant, agent, conversation } = await scenario();
    let echo: Promise<unknown> = Promise.resolve();
    const whatsapp = fakeWhatsApp('EVO-RACE-1', async () => {
      // O webhook do eco comeca a rodar enquanto o envio ainda nao voltou.
      echo = service.createFromPhone(tenant.id, conversation.id, {
        content: 'Seu exame esta pronto',
        externalId: 'EVO-RACE-1',
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const service = buildService(
      { timeoutMs: 5_000, pollMs: 5, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
      whatsapp,
    );

    await service.createFromAgent(tenant.id, conversation.id, agent.id, {
      content: 'Seu exame esta pronto',
    });
    expect(await echo).toBeNull();

    expect(await rowsOf(conversation.id)).toEqual([
      { sender_id: agent.id, external_message_id: 'EVO-RACE-1', status: 'sent' },
    ]);
    // So o INSERT do atendente emitiu — o eco nao.
    expect(wsHub.eventsFor(tenant.id, 'conversation.new_message')).toHaveLength(1);
  });

  it('envio mais lento que a espera: a copia do celular e apagada quando o envio grava o id', async () => {
    const { tenant, agent, conversation } = await scenario();
    const whatsapp = fakeWhatsApp('EVO-SLOW-1', async () => {
      // Espera esgota na hora: o eco vira copia "enviada pelo celular".
      const copy = await service.createFromPhone(tenant.id, conversation.id, {
        content: 'Resposta lenta',
        externalId: 'EVO-SLOW-1',
      });
      expect(copy?.senderId).toBeNull();
      expect(await countMessages(tenant.id)).toBe(2);
    });
    const service = buildService(
      { timeoutMs: 0, pollMs: 0, sleep: async () => undefined },
      whatsapp,
    );

    const sent = await service.createFromAgent(tenant.id, conversation.id, agent.id, {
      content: 'Resposta lenta',
    });

    expect(sent.status).toBe('sent');
    expect(await rowsOf(conversation.id)).toEqual([
      { sender_id: agent.id, external_message_id: 'EVO-SLOW-1', status: 'sent' },
    ]);
    // INSERT do atendente + copia + reemissao para a tela refazer a lista.
    expect(wsHub.eventsFor(tenant.id, 'conversation.new_message')).toHaveLength(3);
  });

  it('sem envio em voo, id desconhecido e mensagem do celular — sem esperar', async () => {
    const { tenant, conversation } = await scenario();
    const service = buildService({
      timeoutMs: 60_000,
      sleep: async () => {
        throw new Error('nao deveria esperar sem envio em voo');
      },
    });

    const message = await service.createFromPhone(tenant.id, conversation.id, {
      content: 'digitado no celular',
      externalId: 'EVO-CEL-1',
    });

    expect(message).toEqual(
      expect.objectContaining({ senderType: 'agent', senderId: null, status: 'sent' }),
    );
  });

  it('envio antigo parado (mais de 60 s sem id) nao segura a mensagem do celular', async () => {
    const { tenant, agent, conversation } = await scenario();
    const stale = await seedMessage({
      tenantId: tenant.id,
      conversationId: conversation.id,
      senderType: 'agent',
      senderId: agent.id,
      status: 'sent',
    });
    await db.withoutTenant((tx) =>
      tx.query(`UPDATE messages SET created_at = NOW() - INTERVAL '5 minutes' WHERE id = $1`, [
        stale.id,
      ]),
    );
    const service = buildService({
      timeoutMs: 60_000,
      sleep: async () => {
        throw new Error('nao deveria esperar por envio antigo');
      },
    });

    const message = await service.createFromPhone(tenant.id, conversation.id, {
      content: 'depois de muito tempo',
      externalId: 'EVO-CEL-2',
    });

    expect(message).not.toBeNull();
  });

  it('envio em voo de OUTRA conversa nao segura a mensagem do celular', async () => {
    const { tenant, agent, conversation } = await scenario();
    const other = await createConversation({ tenantId: tenant.id });
    await seedMessage({
      tenantId: tenant.id,
      conversationId: other.id,
      senderType: 'agent',
      senderId: agent.id,
      status: 'sent',
    });
    const service = buildService({
      timeoutMs: 60_000,
      sleep: async () => {
        throw new Error('nao deveria esperar por outra conversa');
      },
    });

    const message = await service.createFromPhone(tenant.id, conversation.id, {
      content: 'conversa certa',
      externalId: 'EVO-CEL-3',
    });

    expect(message?.conversationId).toBe(conversation.id);
  });

  it('confirmSent nunca apaga mensagem de paciente com o mesmo id externo', async () => {
    const { tenant, agent, conversation } = await scenario();
    await seedMessage({
      tenantId: tenant.id,
      conversationId: conversation.id,
      senderType: 'patient',
      externalMessageId: 'EVO-PAC-1',
    });
    const mine = await seedMessage({
      tenantId: tenant.id,
      conversationId: conversation.id,
      senderType: 'agent',
      senderId: agent.id,
      status: 'sent',
    });

    const repo = new MessageRepository(db);
    await expect(repo.confirmSent(tenant.id, mine.id, 'EVO-PAC-1')).rejects.toThrow();
    expect(await countMessages(tenant.id)).toBe(2);
  });
});
