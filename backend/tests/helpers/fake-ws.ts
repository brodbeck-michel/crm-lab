/**
 * Hub de WebSocket falso: grava o que foi emitido, para asserção nos testes.
 *
 *   const ws = new FakeWsHub();
 *   const { agent } = await createTestApp({ wsHub: ws, modules: [...] });
 *   ...
 *   expect(ws.eventsFor(tenant.id, 'proposal.status_changed')).toHaveLength(1);
 */
import type { WsEventName, WsEventPayloads } from '@crm-lab/shared';
import type { WsHub } from '../../src/lib/ws-hub.js';

export interface EmittedEvent<E extends WsEventName = WsEventName> {
  tenantId: string;
  /** null quando o evento foi para o tenant inteiro. */
  userId: string | null;
  event: E;
  data: WsEventPayloads[E];
}

export class FakeWsHub implements WsHub {
  readonly emitted: EmittedEvent[] = [];

  emitToTenant<E extends WsEventName>(
    tenantId: string,
    event: E,
    data: WsEventPayloads[E],
  ): void {
    this.emitted.push({ tenantId, userId: null, event, data } as EmittedEvent);
  }

  emitToUser<E extends WsEventName>(
    tenantId: string,
    userId: string,
    event: E,
    data: WsEventPayloads[E],
  ): void {
    this.emitted.push({ tenantId, userId, event, data } as EmittedEvent);
  }

  /** Todos os eventos de um tenant, opcionalmente filtrados pelo nome. */
  eventsFor(tenantId: string, event?: WsEventName): EmittedEvent[] {
    return this.emitted.filter(
      (e) => e.tenantId === tenantId && (event === undefined || e.event === event),
    );
  }

  /** Eventos direcionados a um usuario especifico. */
  eventsForUser(tenantId: string, userId: string, event?: WsEventName): EmittedEvent[] {
    return this.eventsFor(tenantId, event).filter((e) => e.userId === userId);
  }

  last(): EmittedEvent | undefined {
    return this.emitted[this.emitted.length - 1];
  }

  clear(): void {
    this.emitted.length = 0;
  }
}
