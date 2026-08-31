import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WsEvent } from '@crm-lab/shared';
import { WebSocketHub, WS_PATH } from '../../src/lib/ws-hub.js';
import { signAccessToken } from '../../src/lib/tokens.js';
import { FakeWsHub } from '../helpers/fake-ws.js';

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const USER_A1 = 'a1111111-1111-1111-1111-111111111111';
const USER_A2 = 'a2222222-2222-2222-2222-222222222222';
const USER_B1 = 'b1111111-1111-1111-1111-111111111111';

function tokenFor(tenantId: string, userId: string): string {
  return signAccessToken({ userId, tenantId, role: 'attendant', discountLimit: 15 });
}

/** Coletor de mensagens do socket, com espera ativa limitada. */
class Collector {
  readonly received: WsEvent[] = [];
  constructor(readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      this.received.push(JSON.parse(String(raw)) as WsEvent);
    });
  }
  async waitFor(count: number, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.received.length < count && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

/** Fecha e SO retorna quando o servidor ja tirou o socket da room. */
async function closeAndWait(...sockets: WebSocket[]): Promise<void> {
  await Promise.all(
    sockets.map(
      (ws) =>
        new Promise<void>((resolve) => {
          if (ws.readyState === WebSocket.CLOSED) {
            resolve();
            return;
          }
          ws.once('close', () => resolve());
          ws.close();
        }),
    ),
  );
  // O handler 'close' do servidor roda no proximo tick.
  await new Promise((r) => setTimeout(r, 50));
}

function open(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

describe('WebSocketHub', () => {
  let server: http.Server;
  let hub: WebSocketHub;
  let baseUrl: string;

  beforeAll(async () => {
    hub = new WebSocketHub();
    server = http.createServer((_req, res) => res.end('ok'));
    hub.attach(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `ws://127.0.0.1:${address.port}${WS_PATH}`;
  });

  afterAll(async () => {
    await hub.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('recusa conexao sem token', async () => {
    await expect(open(baseUrl)).rejects.toThrow();
  });

  it('recusa token invalido', async () => {
    await expect(open(`${baseUrl}?token=nao-e-um-jwt`)).rejects.toThrow();
  });

  it('recusa caminho fora de /ws', async () => {
    const address = server.address() as AddressInfo;
    const token = tokenFor(TENANT_A, USER_A1);
    await expect(
      open(`ws://127.0.0.1:${address.port}/outro?token=${token}`),
    ).rejects.toThrow();
  });

  it('emitToTenant chega so na room do tenant do TOKEN', async () => {
    const a1 = new Collector(await open(`${baseUrl}?token=${tokenFor(TENANT_A, USER_A1)}`));
    const a2 = new Collector(await open(`${baseUrl}?token=${tokenFor(TENANT_A, USER_A2)}`));
    const b1 = new Collector(await open(`${baseUrl}?token=${tokenFor(TENANT_B, USER_B1)}`));

    expect(hub.countTenant(TENANT_A)).toBe(2);
    expect(hub.countTenant(TENANT_B)).toBe(1);

    hub.emitToTenant(TENANT_A, 'conversation.new_message', {
      conversationId: 'conv-1',
      messageId: 'msg-1',
    });

    await a1.waitFor(1);
    await a2.waitFor(1);
    await new Promise((r) => setTimeout(r, 100)); // janela para um vazamento aparecer

    expect(a1.received).toEqual([
      { event: 'conversation.new_message', data: { conversationId: 'conv-1', messageId: 'msg-1' } },
    ]);
    expect(a2.received).toHaveLength(1);
    expect(b1.received).toHaveLength(0);

    await closeAndWait(a1.ws, a2.ws, b1.ws);
  });

  it('emitToUser chega so ao usuario alvo, dentro do tenant', async () => {
    const a1 = new Collector(await open(`${baseUrl}?token=${tokenFor(TENANT_A, USER_A1)}`));
    const a2 = new Collector(await open(`${baseUrl}?token=${tokenFor(TENANT_A, USER_A2)}`));
    const b1 = new Collector(await open(`${baseUrl}?token=${tokenFor(TENANT_B, USER_B1)}`));

    hub.emitToUser(TENANT_A, USER_A2, 'approval.requested', { proposalId: 'prop-9' });

    await a2.waitFor(1);
    await new Promise((r) => setTimeout(r, 100));

    expect(a2.received).toEqual([{ event: 'approval.requested', data: { proposalId: 'prop-9' } }]);
    expect(a1.received).toHaveLength(0);
    expect(b1.received).toHaveLength(0);

    await closeAndWait(a1.ws, a2.ws, b1.ws);
  });

  it('mesmo userId em outro tenant nao recebe', async () => {
    const sameIdInB = new Collector(await open(`${baseUrl}?token=${tokenFor(TENANT_B, USER_A1)}`));

    hub.emitToUser(TENANT_A, USER_A1, 'approval.decided', {
      proposalId: 'prop-1',
      decision: 'approved',
    });
    await new Promise((r) => setTimeout(r, 100));

    expect(sameIdInB.received).toHaveLength(0);
    await closeAndWait(sameIdInB.ws);
  });

  it('emitir para tenant sem sockets nao quebra', () => {
    expect(() =>
      hub.emitToTenant('cccccccc-cccc-cccc-cccc-cccccccccccc', 'approval.requested', {
        proposalId: 'prop-x',
      }),
    ).not.toThrow();
  });

  it('desconexao libera a room', async () => {
    const before = hub.countTenant(TENANT_B);
    const ws = await open(`${baseUrl}?token=${tokenFor(TENANT_B, USER_B1)}`);
    expect(hub.countTenant(TENANT_B)).toBe(before + 1);
    await closeAndWait(ws);
    expect(hub.countTenant(TENANT_B)).toBe(before);
  });
});

describe('FakeWsHub (helper de teste)', () => {
  it('grava eventos por tenant e por usuario', () => {
    const hub = new FakeWsHub();
    hub.emitToTenant(TENANT_A, 'proposal.status_changed', { proposalId: 'p1', status: 'ganho' });
    hub.emitToUser(TENANT_A, USER_A1, 'approval.requested', { proposalId: 'p2' });
    hub.emitToTenant(TENANT_B, 'proposal.status_changed', { proposalId: 'p3', status: 'perdido' });

    expect(hub.eventsFor(TENANT_A)).toHaveLength(2);
    expect(hub.eventsFor(TENANT_A, 'proposal.status_changed')).toHaveLength(1);
    expect(hub.eventsForUser(TENANT_A, USER_A1, 'approval.requested')).toHaveLength(1);
    expect(hub.eventsFor(TENANT_B)).toHaveLength(1);
    expect(hub.last()?.data).toEqual({ proposalId: 'p3', status: 'perdido' });

    hub.clear();
    expect(hub.emitted).toHaveLength(0);
  });
});
