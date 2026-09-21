/**
 * CRMLAB-38 item 5 (D-149) — teste UNITARIO do guard de anti-replay, direto
 * nas funções exportadas de `webhook.routes.ts`. Preferido a um teste de
 * integração via HTTP porque o cenário que este guard resolve (corpo
 * BYTE-IDENTICO reenviado) já é coberto na prática, pelo lado de fora, pela
 * UNIQUE de `messages.external_id` (019_messages_external_id_unique.sql) —
 * um teste HTTP que reenvia o mesmo payload não provaria QUAL dos dois
 * mecanismos barrou a duplicata. Testando a função isolada, prova-se o
 * mecanismo novo especificamente.
 */
import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { isReplay, replayExempt, replayKey } from '../../src/controllers/webhook.routes.js';
import { MemoryCache } from '../../src/lib/cache.js';

describe('anti-replay de webhook (CRMLAB-38)', () => {
  it('replayKey muda com o tenant e com o corpo — nao colide entre tenants nem entre payloads diferentes', () => {
    const a = replayKey('tenant-1', '{"x":1}');
    const b = replayKey('tenant-2', '{"x":1}');
    const c = replayKey('tenant-1', '{"x":2}');
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(replayKey('tenant-1', '{"x":1}')).toBe(a);
  });

  it('primeira vez nao e replay; a mesma chamada de novo (mesmo tenant + mesmo corpo) e', async () => {
    const cache = new MemoryCache();
    const first = await isReplay(cache, 'tenant-1', 'corpo-identico');
    const second = await isReplay(cache, 'tenant-1', 'corpo-identico');
    expect(first).toBe(false);
    expect(second).toBe(true);
  });

  it('corpo diferente do mesmo tenant nao e replay', async () => {
    const cache = new MemoryCache();
    await isReplay(cache, 'tenant-1', 'corpo-A');
    const outro = await isReplay(cache, 'tenant-1', 'corpo-B');
    expect(outro).toBe(false);
  });

  it('mesmo corpo em tenants diferentes nao e replay (chave inclui o tenant)', async () => {
    const cache = new MemoryCache();
    await isReplay(cache, 'tenant-1', 'corpo-identico');
    const outroTenant = await isReplay(cache, 'tenant-2', 'corpo-identico');
    expect(outroTenant).toBe(false);
  });

  it('payload antigo NAO e recusado por idade — so por ter sido visto antes (D-149)', async () => {
    // Guarda de regressao da janela de timestamp removida: a Meta retenta
    // webhook falho por ate 7 dias, entao recusar por idade descartaria
    // reentrega legitima depois de qualquer indisponibilidade. Um corpo velho
    // que o servidor nunca viu tem que passar.
    const cache = new MemoryCache();
    const payloadDe2024 = JSON.stringify({
      entry: [{ changes: [{ value: { messages: [{ timestamp: '1724425200' }] } }] }],
    });
    expect(await isReplay(cache, 'tenant-1', payloadDe2024)).toBe(false);
    // ...e so a SEGUNDA entrega do mesmo corpo e barrada.
    expect(await isReplay(cache, 'tenant-1', payloadDe2024)).toBe(true);
  });

  it('duas chamadas CONCORRENTES com o mesmo corpo: exatamente uma passa (guard atomico)', async () => {
    const cache = new MemoryCache();
    // get-entao-set deixava as duas passarem: ambas liam `null` antes de
    // qualquer `set`. Com `incr`, a segunda enxerga o contador em 2.
    const [a, b] = await Promise.all([
      isReplay(cache, 'tenant-1', 'corpo-simultaneo'),
      isReplay(cache, 'tenant-1', 'corpo-simultaneo'),
    ]);
    expect([a, b].filter((r) => r === false)).toHaveLength(1);
    expect([a, b].filter((r) => r === true)).toHaveLength(1);
  });

  it('CONNECTION_UPDATE e isento do guard — flap open/close/open nao pode virar replay', () => {
    const req = (body: unknown) => ({ body }) as Request;
    expect(replayExempt(req({ event: 'CONNECTION_UPDATE', data: { state: 'open' } }))).toBe(true);
    // O gateway v2.3.7 manda minusculo com ponto; `normalizeEvolutionEvent` cobre as duas grafias.
    expect(replayExempt(req({ event: 'connection.update', data: { state: 'open' } }))).toBe(true);
    expect(replayExempt(req({ event: 'MESSAGES_UPSERT', data: {} }))).toBe(false);
    expect(replayExempt(req({ data: {} }))).toBe(false);
    expect(replayExempt(req(undefined))).toBe(false);
  });
});
