import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WS_CLOSE_TOO_MANY_SOCKETS, WS_CLOSE_UNAUTHORIZED, type WsEvent } from '@crm-lab/shared';
import { WebSocketHub, WS_PATH } from '../../src/lib/ws-hub.js';
import { signRefreshToken } from '../../src/lib/tokens.js';
import { REFRESH_COOKIE_NAME } from '../../src/lib/cookies.js';
import { FakeWsHub } from '../helpers/fake-ws.js';

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const USER_A1 = 'a1111111-1111-1111-1111-111111111111';
const USER_A2 = 'a2222222-2222-2222-2222-222222222222';
const USER_B1 = 'b1111111-1111-1111-1111-111111111111';

const ALLOWED_ORIGIN = 'http://localhost:5173';

function tokenFor(tenantId: string, userId: string): string {
  return signRefreshToken({ userId, tenantId, role: 'attendant' });
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

interface OpenOptions {
  cookie?: string;
  origin?: string;
  autoPong?: boolean;
}

/** Abre uma conexao real contra o hub — Origin permitido e cookie de refresh por padrao. */
function open(url: string, options: OpenOptions = {}): Promise<WebSocket> {
  const { cookie, origin = ALLOWED_ORIGIN, autoPong = true } = options;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      origin,
      autoPong,
      headers: cookie ? { Cookie: cookie } : undefined,
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function cookieFor(tenantId: string, userId: string): string {
  return `${REFRESH_COOKIE_NAME}=${tokenFor(tenantId, userId)}`;
}

/** Espera o `close` do socket e devolve o codigo — usado nos testes de recusa. */
function waitClose(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once('close', (code) => resolve(code)));
}

describe('WebSocketHub', () => {
  let server: http.Server;
  let hub: WebSocketHub;
  let baseUrl: string;

  beforeAll(async () => {
    hub = new WebSocketHub({ allowedOrigins: [ALLOWED_ORIGIN] });
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

  it('recusa e fecha com 4401 quando falta o cookie de refresh', async () => {
    const ws = await open(baseUrl);
    const code = await waitClose(ws);
    expect(code).toBe(4401);
  });

  it('recusa e fecha com 4401 quando o cookie nao e um JWT valido', async () => {
    const ws = await open(baseUrl, { cookie: `${REFRESH_COOKIE_NAME}=nao-e-um-jwt` });
    const code = await waitClose(ws);
    expect(code).toBe(4401);
  });

  it('recusa a nivel de socket (sem completar handshake) quando o Origin nao e permitido', async () => {
    await expect(
      open(baseUrl, { cookie: cookieFor(TENANT_A, USER_A1), origin: 'https://site-malicioso.example' }),
    ).rejects.toThrow();
  });

  it('recusa caminho fora de /ws', async () => {
    const address = server.address() as AddressInfo;
    await expect(
      open(`ws://127.0.0.1:${address.port}/outro`, { cookie: cookieFor(TENANT_A, USER_A1) }),
    ).rejects.toThrow();
  });

  it('aceita cookie valido e coloca na room do tenant DO COOKIE', async () => {
    const ws = await open(baseUrl, { cookie: cookieFor(TENANT_A, USER_A1) });
    expect(hub.countTenant(TENANT_A)).toBeGreaterThan(0);
    await closeAndWait(ws);
  });

  it('emitToTenant chega so na room do tenant do COOKIE', async () => {
    const a1 = new Collector(await open(baseUrl, { cookie: cookieFor(TENANT_A, USER_A1) }));
    const a2 = new Collector(await open(baseUrl, { cookie: cookieFor(TENANT_A, USER_A2) }));
    const b1 = new Collector(await open(baseUrl, { cookie: cookieFor(TENANT_B, USER_B1) }));

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
    const a1 = new Collector(await open(baseUrl, { cookie: cookieFor(TENANT_A, USER_A1) }));
    const a2 = new Collector(await open(baseUrl, { cookie: cookieFor(TENANT_A, USER_A2) }));
    const b1 = new Collector(await open(baseUrl, { cookie: cookieFor(TENANT_B, USER_B1) }));

    hub.emitToUser(TENANT_A, USER_A2, 'approval.requested', { proposalId: 'prop-9' });

    await a2.waitFor(1);
    await new Promise((r) => setTimeout(r, 100));

    expect(a2.received).toEqual([{ event: 'approval.requested', data: { proposalId: 'prop-9' } }]);
    expect(a1.received).toHaveLength(0);
    expect(b1.received).toHaveLength(0);

    await closeAndWait(a1.ws, a2.ws, b1.ws);
  });

  it('mesmo userId em outro tenant nao recebe', async () => {
    const sameIdInB = new Collector(await open(baseUrl, { cookie: cookieFor(TENANT_B, USER_A1) }));

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
    const ws = await open(baseUrl, { cookie: cookieFor(TENANT_B, USER_B1) });
    expect(hub.countTenant(TENANT_B)).toBe(before + 1);
    await closeAndWait(ws);
    expect(hub.countTenant(TENANT_B)).toBe(before);
  });

  it('limite de 5 sockets por usuario: o 6º fecha o mais antigo', async () => {
    const sockets: WebSocket[] = [];
    for (let i = 0; i < 5; i += 1) {
      sockets.push(await open(baseUrl, { cookie: cookieFor(TENANT_A, USER_A1) }));
    }
    const before = hub.countTenant(TENANT_A);
    const oldestClosed = waitClose(sockets[0]!);

    const sixth = await open(baseUrl, { cookie: cookieFor(TENANT_A, USER_A1) });
    await oldestClosed;
    await new Promise((r) => setTimeout(r, 50));

    // 5 antigos + 1 novo - 1 fechado = mesma contagem de antes do 6º.
    expect(hub.countTenant(TENANT_A)).toBe(before);
    // Codigo proprio, nao 1006: `terminate()` chegava como queda anormal e o
    // cliente reconectava na hora, evictando a proxima aba em ciclo infinito.
    expect(await oldestClosed).toBe(WS_CLOSE_TOO_MANY_SOCKETS);

    await closeAndWait(...sockets.slice(1), sixth);
  });
});

describe('WebSocketHub — sessao viva no banco (validateSession)', () => {
  let server: http.Server;
  let hub: WebSocketHub;
  let baseUrl: string;
  let live = true;
  let asked: string[] = [];

  beforeAll(async () => {
    hub = new WebSocketHub({
      allowedOrigins: [ALLOWED_ORIGIN],
      heartbeatIntervalMs: 50,
      validateSession: (token) => {
        asked.push(token);
        return Promise.resolve(live);
      },
    });
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

  it('JWT valido mas sessao morta no banco (logout, revogacao, usuario inativo) fecha com 4401', async () => {
    live = false;
    asked = [];
    const ws = await open(baseUrl, { cookie: cookieFor(TENANT_A, USER_A1) });
    expect(await waitClose(ws)).toBe(WS_CLOSE_UNAUTHORIZED);
    expect(asked).toHaveLength(1);
    expect(hub.countTenant(TENANT_A)).toBe(0);
    live = true;
  });

  it('falha da checagem (banco fora do ar) recusa o handshake — fail-closed', async () => {
    const failing = new WebSocketHub({
      allowedOrigins: [ALLOWED_ORIGIN],
      validateSession: () => Promise.reject(new Error('db down')),
    });
    const srv = http.createServer((_req, res) => res.end('ok'));
    failing.attach(srv);
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const { port } = srv.address() as AddressInfo;

    const ws = await open(`ws://127.0.0.1:${port}${WS_PATH}`, { cookie: cookieFor(TENANT_A, USER_A1) });
    expect(await waitClose(ws)).toBe(WS_CLOSE_UNAUTHORIZED);

    await failing.close();
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  });

  it('socket ja aberto e derrubado quando a sessao morre depois (revalidacao periodica)', async () => {
    live = true;
    const ws = await open(baseUrl, { cookie: cookieFor(TENANT_A, USER_A2) });
    expect(hub.countTenant(TENANT_A)).toBe(1);

    // A revalidacao roda a cada REVALIDATE_EVERY_SWEEPS (10) ciclos; com
    // heartbeat de 50ms, ~500ms. Antes disto, um socket aberto antes do logout
    // seguia recebendo o realtime do tenant ate o processo reiniciar.
    live = false;
    expect(await Promise.race([
      waitClose(ws),
      new Promise<number>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ])).toBe(WS_CLOSE_UNAUTHORIZED);
    live = true;
  });
});

describe('WebSocketHub — heartbeat', () => {
  let server: http.Server;
  let hub: WebSocketHub;
  let baseUrl: string;

  beforeAll(async () => {
    hub = new WebSocketHub({ allowedOrigins: [ALLOWED_ORIGIN], heartbeatIntervalMs: 50 });
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

  it('termina socket que nao responde pong ate o proximo ciclo', async () => {
    // `autoPong: false` simula um cliente travado (aba minimizada, rede
    // instavel) — o `ws` real responde ping com pong sozinho por padrao.
    const dead = await open(baseUrl, { cookie: cookieFor(TENANT_A, USER_A1), autoPong: false });
    const closed = waitClose(dead);
    // 2 ciclos: 1º manda o ping (marca isAlive=false), 2º termina quem nao respondeu.
    await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000))]);
  });

  it('socket que responde pong normalmente permanece conectado', async () => {
    const alive = await open(baseUrl, { cookie: cookieFor(TENANT_A, USER_A2) });
    await new Promise((r) => setTimeout(r, 250)); // ~5 ciclos de 50ms
    expect(alive.readyState).toBe(WebSocket.OPEN);
    await closeAndWait(alive);
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
