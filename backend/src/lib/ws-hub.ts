/**
 * Hub de WebSocket montado em `/ws`.
 *
 * Contrato (docs/contracts/FRONTEND_BACKEND.md, "Real-time"):
 *   Conexao: ws://host/ws?token=<accessToken>
 *   "Servidor coloca socket na room do tenantId (do token — nunca do cliente)"
 *
 * Por isso o hub NAO le tenantId de query, header ou mensagem: ele so aceita o
 * valor que veio dentro do JWT verificado. Eventos sao NOTIFICACAO — payload so
 * com IDs; o cliente refaz o fetch.
 */
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { WsEvent, WsEventName, WsEventPayloads } from '@crm-lab/shared';
import { verifyAccessToken } from './tokens.js';
import { logger } from './logger.js';

export const WS_PATH = '/ws';

/**
 * Interface consumida pelos services. Depende SO disto — assim os testes
 * injetam um hub falso (`tests/helpers/fake-ws.ts`) sem subir servidor.
 */
export interface WsHub {
  emitToTenant<E extends WsEventName>(
    tenantId: string,
    event: E,
    data: WsEventPayloads[E],
  ): void;
  emitToUser<E extends WsEventName>(
    tenantId: string,
    userId: string,
    event: E,
    data: WsEventPayloads[E],
  ): void;
}

export interface AttachableWsHub extends WsHub {
  /** Liga o hub ao upgrade HTTP do servidor. */
  attach(server: HttpServer): void;
  close(): Promise<void>;
  /** Numero de sockets abertos no tenant — diagnostico e teste. */
  countTenant(tenantId: string): number;
}

interface SocketMeta {
  tenantId: string;
  userId: string;
}

export function serializeEvent<E extends WsEventName>(
  event: E,
  data: WsEventPayloads[E],
): string {
  const payload: WsEvent<E> = { event, data };
  return JSON.stringify(payload);
}

export class WebSocketHub implements AttachableWsHub {
  private wss: WebSocketServer | null = null;
  /** tenantId -> sockets daquele tenant (a "room"). */
  private readonly rooms = new Map<string, Set<WebSocket>>();
  private readonly meta = new WeakMap<WebSocket, SocketMeta>();

  attach(server: HttpServer): void {
    // `noServer` + handler de upgrade: rejeita qualquer caminho fora de /ws.
    const wss = new WebSocketServer({ noServer: true });
    this.wss = wss;

    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== WS_PATH) {
        socket.destroy();
        return;
      }

      const token = url.searchParams.get('token');
      if (!token) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      const verified = verifyAccessToken(token);
      if (!verified.ok) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      // tenantId e userId SO do token verificado.
      const { tenantId, userId } = verified.payload;
      wss.handleUpgrade(req, socket, head, (ws) => {
        this.join(ws, { tenantId, userId });
        wss.emit('connection', ws, req);
      });
    });
  }

  private join(ws: WebSocket, meta: SocketMeta): void {
    this.meta.set(ws, meta);
    const room = this.rooms.get(meta.tenantId) ?? new Set<WebSocket>();
    room.add(ws);
    this.rooms.set(meta.tenantId, room);

    ws.on('close', () => this.leave(ws, meta.tenantId));
    ws.on('error', () => this.leave(ws, meta.tenantId));

    logger.debug('ws.connected', { tenantId: meta.tenantId, userId: meta.userId });
  }

  private leave(ws: WebSocket, tenantId: string): void {
    const room = this.rooms.get(tenantId);
    if (!room) return;
    room.delete(ws);
    if (room.size === 0) this.rooms.delete(tenantId);
  }

  private send(ws: WebSocket, message: string): void {
    // 1 === WebSocket.OPEN (evita depender do valor exportado em runtime).
    if (ws.readyState !== 1) return;
    ws.send(message);
  }

  emitToTenant<E extends WsEventName>(
    tenantId: string,
    event: E,
    data: WsEventPayloads[E],
  ): void {
    const room = this.rooms.get(tenantId);
    if (!room || room.size === 0) return;
    const message = serializeEvent(event, data);
    for (const ws of room) this.send(ws, message);
  }

  emitToUser<E extends WsEventName>(
    tenantId: string,
    userId: string,
    event: E,
    data: WsEventPayloads[E],
  ): void {
    const room = this.rooms.get(tenantId);
    if (!room || room.size === 0) return;
    const message = serializeEvent(event, data);
    for (const ws of room) {
      if (this.meta.get(ws)?.userId === userId) this.send(ws, message);
    }
  }

  countTenant(tenantId: string): number {
    return this.rooms.get(tenantId)?.size ?? 0;
  }

  async close(): Promise<void> {
    for (const room of this.rooms.values()) {
      for (const ws of room) ws.close();
    }
    this.rooms.clear();
    const wss = this.wss;
    this.wss = null;
    if (!wss) return;
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
}

/** Hub inerte: usado quando o WS nao esta montado (CLIs, alguns testes). */
export const noopWsHub: WsHub = {
  emitToTenant: () => undefined,
  emitToUser: () => undefined,
};

export function createWsHub(): AttachableWsHub {
  return new WebSocketHub();
}
