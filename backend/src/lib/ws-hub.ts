/**
 * Hub de WebSocket montado em `/ws`.
 *
 * Contrato (docs/contracts/FRONTEND_BACKEND.md, "Real-time"):
 *   Conexao: wss://host/ws — autenticada pelo cookie httpOnly `crm_refresh`
 *   (mesmo cookie do refresh, CRMLAB-32), enviado pelo browser sozinho no
 *   handshake por ser mesmo origin. Servidor coloca socket na room do
 *   tenantId (do cookie verificado — nunca do cliente).
 *
 * CRMLAB-33/D-151 — por que cookie e nao `?token=` na URL: o token na query
 * string ia parar no access log do Caddy em texto puro. O handshake de
 * upgrade HTTP passa o header `Cookie` normalmente; so nao passa pelos
 * middlewares do Express (`cookie-parser` incluido) — por isso o parse manual
 * em `./cookies.js`.
 *
 * CRMLAB-33/D-151 — checagem de Origin: WebSocket NAO respeita a Same-Origin
 * Policy do jeito que `fetch`/XHR respeitam — o browser manda o cookie no
 * handshake mesmo que a pagina que abriu a conexao esteja em outro dominio
 * (classe conhecida: WebSocket CSRF). Autenticar so pelo cookie sem checar
 * `Origin` deixaria qualquer site abrir `wss://.../ws` a partir do browser de
 * uma vitima logada e ler o realtime dela. Por isso o upgrade SEMPRE valida
 * `Origin` contra `allowedOrigins` (mesma lista do CORS, `env.corsOrigins`)
 * antes de sequer olhar o cookie.
 *
 * Por isso o hub NAO le tenantId de query, header ou mensagem: ele so aceita
 * o valor que veio dentro do JWT verificado. Eventos sao NOTIFICACAO — payload
 * so com IDs; o cliente refaz o fetch.
 */
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  WS_CLOSE_TOO_MANY_SOCKETS,
  WS_CLOSE_UNAUTHORIZED,
  type WsEvent,
  type WsEventName,
  type WsEventPayloads,
} from '@crm-lab/shared';
import { verifyRefreshToken } from './tokens.js';
import { getCookie, REFRESH_COOKIE_NAME } from './cookies.js';
import { logger } from './logger.js';

export const WS_PATH = '/ws';

/** `ws.close()`/`terminate()` derruba socket morto se nao respondeu 2 ciclos seguidos. */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/** Mensagem WS unica: base64 de mídia caberia, mas isso é transporte de anexo — não é o uso daqui. */
const MAX_PAYLOAD_BYTES = 64 * 1024;

/** Socket mais antigo do mesmo usuario e fechado ao abrir um 6º — evita vazamento de aba esquecida aberta. */
const MAX_SOCKETS_PER_USER = 5;

/**
 * A cada quantos ciclos de heartbeat a sessao de cada socket ABERTO e conferida
 * de novo contra o banco. 10 x 30 s = 5 min: o logout de outra aba, a desativacao
 * de um usuario ou a queda de um tenant derrubam o socket em no maximo 5 min, sem
 * transformar o heartbeat (que hoje nao toca no banco) numa query por socket a
 * cada 30 s.
 */
const REVALIDATE_EVERY_SWEEPS = 10;

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

export interface WsHubOptions {
  /** Origins aceitos no handshake — mesma lista do CORS (`env.corsOrigins`). */
  allowedOrigins: string[];
  /** Testavel: intervalo do ciclo de ping/pong. Producao usa o default de 30s. */
  heartbeatIntervalMs?: number;
  /**
   * Sessao do cookie ainda VIVA no banco? (correcao da revisao do PR #47)
   *
   * `verifyRefreshToken` prova assinatura e validade — nada mais. `/auth/refresh`
   * checa muito mais: a linha em `refresh_tokens`, `revoked_at`, `user.is_active`
   * e `tenant.is_active`. Sem esta checagem, um refresh revogado no logout, ja
   * rotacionado, ou de usuario/tenant desativado ABRIA um WebSocket com realtime
   * completo do tenant por ate `JWT_REFRESH_TTL` (7 dias no default) — enquanto o
   * mesmo token era recusado no endpoint de refresh. O esquema antigo (`?token=`
   * com access token) expunha no maximo os 15 min do access.
   *
   * Opcional: hub sem validador (testes, CLIs) segue so com a verificacao do JWT.
   */
  validateSession?: (token: string) => Promise<boolean>;
}

interface SocketMeta {
  tenantId: string;
  userId: string;
  isAlive: boolean;
  /**
   * Cookie que autenticou o handshake, guardado para a REVALIDACAO periodica
   * (`REVALIDATE_EVERY_SWEEPS`). Sem isto, um socket aberto antes do logout
   * seguia recebendo eventos do tenant indefinidamente — o proprio heartbeat
   * o mantinha vivo.
   */
  token: string;
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
  private readonly allowedOrigins: Set<string>;
  private readonly heartbeatIntervalMs: number;
  private readonly validateSession: ((token: string) => Promise<boolean>) | null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private upgradeHandler: ((req: IncomingMessage, socket: Duplex, head: Buffer) => void) | null = null;
  private attachedServer: HttpServer | null = null;
  private sweepCount = 0;

  constructor(options: WsHubOptions) {
    this.allowedOrigins = new Set(options.allowedOrigins);
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.validateSession = options.validateSession ?? null;
  }

  attach(server: HttpServer): void {
    // `noServer` + handler de upgrade: rejeita qualquer caminho fora de /ws.
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
    this.wss = wss;

    const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== WS_PATH) {
        socket.destroy();
        return;
      }

      // Origin errado: nunca e um cliente legitimo nosso (a SPA sempre manda
      // o Origin certo). Recusa crua, sem completar o handshake — nao ha UX
      // de cliente proprio pra preservar aqui, so um vetor de CSRF a fechar.
      const origin = req.headers.origin;
      if (!origin || !this.allowedOrigins.has(origin)) {
        logger.warn('ws.origin_rejected', { origin: origin ?? null });
        socket.destroy();
        return;
      }

      // Cookie ausente/invalido/expirado: ISSO pode ser um cliente legitimo
      // com sessao vencida, e o cliente PRECISA distinguir isso de uma queda
      // de rede pra decidir "tento refresh antes de reconectar". Um 4xx cru
      // aqui (como o Origin acima) nao seria observavel pelo `WebSocket` do
      // browser — por isso completamos o handshake (101) e so DEPOIS fechamos
      // com o codigo 4401, que o cliente LE em `onclose`.
      const token = getCookie(req.headers.cookie, REFRESH_COOKIE_NAME);
      if (!token) {
        this.refuse(wss, req, socket, head);
        return;
      }
      const verified = verifyRefreshToken(token);

      if (!verified.ok) {
        this.refuse(wss, req, socket, head);
        return;
      }

      // tenantId e userId SO do token verificado.
      const { tenantId, userId } = verified.payload;

      // Sessao viva no banco (revogacao, usuario/tenant inativo) — ver
      // `validateSession` em `WsHubOptions`. Falha da checagem = recusa: a
      // alternativa (abrir mesmo assim quando o banco pisca) daria realtime a
      // um token possivelmente revogado, que e exatamente o buraco que esta
      // checagem existe para fechar.
      const finish = (live: boolean): void => {
        if (!live) {
          this.refuse(wss, req, socket, head);
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          this.join(ws, { tenantId, userId, isAlive: true, token });
          wss.emit('connection', ws, req);
        });
      };

      if (!this.validateSession) {
        finish(true);
        return;
      }
      this.validateSession(token).then(finish, (err: unknown) => {
        logger.warn('ws.session_check_failed', {
          message: err instanceof Error ? err.message : String(err),
        });
        finish(false);
      });
    };

    this.upgradeHandler = onUpgrade;
    this.attachedServer = server;
    server.on('upgrade', onUpgrade);

    this.heartbeatTimer = setInterval(() => this.sweep(), this.heartbeatIntervalMs);
    // Um timer pendurado nao pode ser a unica coisa segurando o processo vivo.
    this.heartbeatTimer.unref?.();
  }

  /**
   * Handshake completado (101) so para poder fechar com 4401 — ver
   * `WS_CLOSE_UNAUTHORIZED`. O listener de `'error'` nao e decorativo: `ws`
   * reemite erro de protocolo do receiver/sender como `emit('error')`, e um
   * `EventEmitter` sem listener de `'error'` LANCA — o que caia no
   * `process.on('uncaughtException')` do `main.ts` e derrubava o backend
   * inteiro. Qualquer cliente que alcance `/ws` consegue chegar aqui (Origin
   * e header, forjavel fora do browser), entao era crash remoto sem
   * autenticacao nenhuma.
   */
  private refuse(wss: WebSocketServer, req: IncomingMessage, socket: Duplex, head: Buffer): void {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('error', () => undefined);
      ws.close(WS_CLOSE_UNAUTHORIZED, 'unauthorized');
    });
  }

  /**
   * Roda a cada `heartbeatIntervalMs`: termina quem nao respondeu `pong` desde o
   * ciclo anterior e, a cada `REVALIDATE_EVERY_SWEEPS` ciclos, reconfere no banco
   * se a sessao de cada socket aberto continua valida.
   */
  private sweep(): void {
    this.sweepCount += 1;
    const revalidate = this.validateSession !== null && this.sweepCount % REVALIDATE_EVERY_SWEEPS === 0;

    for (const room of this.rooms.values()) {
      for (const ws of room) {
        const meta = this.meta.get(ws);
        if (!meta) continue;
        if (!meta.isAlive) {
          ws.terminate();
          continue;
        }
        meta.isAlive = false;
        ws.ping();
        if (revalidate) this.revalidate(ws, meta);
      }
    }
  }

  /** Sessao morreu (logout, revogacao, usuario/tenant inativo) => fecha como nao-autorizado. */
  private revalidate(ws: WebSocket, meta: SocketMeta): void {
    const check = this.validateSession;
    if (!check) return;
    check(meta.token).then(
      (live) => {
        if (live) return;
        logger.debug('ws.session_expired', { tenantId: meta.tenantId, userId: meta.userId });
        ws.close(WS_CLOSE_UNAUTHORIZED, 'unauthorized');
      },
      // Banco fora do ar nao derruba socket ja estabelecido: o handshake e' que
      // e' fail-closed. Derrubar todo mundo num soluco do Postgres trocaria um
      // risco de sessao velha por uma queda geral do realtime.
      (err: unknown) => {
        logger.warn('ws.session_check_failed', {
          message: err instanceof Error ? err.message : String(err),
        });
      },
    );
  }

  private join(ws: WebSocket, meta: SocketMeta): void {
    this.meta.set(ws, meta);
    const room = this.rooms.get(meta.tenantId) ?? new Set<WebSocket>();
    room.add(ws);
    this.rooms.set(meta.tenantId, room);

    ws.on('pong', () => {
      const current = this.meta.get(ws);
      if (current) current.isAlive = true;
    });

    ws.on('close', () => this.leave(ws, meta.tenantId));
    ws.on('error', () => this.leave(ws, meta.tenantId));

    logger.debug('ws.connected', { tenantId: meta.tenantId, userId: meta.userId });

    // Limite por usuario: fecha o socket MAIS ANTIGO do mesmo usuario ao abrir
    // um 6º (Set preserva ordem de insercao — o primeiro da lista filtrada e
    // o mais velho, o proprio `ws` recem-adicionado sempre entra por ultimo).
    // `close(WS_CLOSE_TOO_MANY_SOCKETS)` e nao `terminate()`: terminate chega no
    // browser como 1006, que o cliente le como queda de rede e reconecta na hora
    // — com 6 abas, cada reconexao estourava o teto de novo e evictava a proxima,
    // num ciclo sem fim (e cada reconexao dispara `invalidateQueries()`).
    const sameUser = [...room].filter((s) => this.meta.get(s)?.userId === meta.userId);
    if (sameUser.length > MAX_SOCKETS_PER_USER) {
      const oldest = sameUser[0];
      if (oldest) oldest.close(WS_CLOSE_TOO_MANY_SOCKETS, 'too_many_sockets');
    }
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
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    // Sem isto o listener de `upgrade` ficava no servidor com a closure de um
    // `WebSocketServer` ja fechado, e um `attach()` seguinte registrava um
    // SEGUNDO handler no mesmo socket.
    if (this.attachedServer && this.upgradeHandler) {
      this.attachedServer.off('upgrade', this.upgradeHandler);
    }
    this.attachedServer = null;
    this.upgradeHandler = null;
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

export function createWsHub(options: WsHubOptions): AttachableWsHub {
  return new WebSocketHub(options);
}
