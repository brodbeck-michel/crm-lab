import { describe, expect, it } from 'vitest';
import { MemoryCache } from '../../src/lib/cache.js';

describe('CacheService (in-memory)', () => {
  it('get/set/del basicos', async () => {
    const cache = new MemoryCache();
    expect(await cache.get('ausente')).toBeNull();

    await cache.set('k', { a: 1 }, 60);
    expect(await cache.get<{ a: number }>('k')).toEqual({ a: 1 });

    await cache.del('k');
    expect(await cache.get('k')).toBeNull();
  });

  it('expira de verdade no TTL do catalogo (1h)', async () => {
    let clock = 1_000_000;
    const cache = new MemoryCache(() => clock);

    await cache.set('exams:tenant-a', ['exame'], 3600);
    clock += 3599 * 1000;
    expect(await cache.get('exams:tenant-a')).toEqual(['exame']);

    clock += 2 * 1000; // passou de 3600s
    expect(await cache.get('exams:tenant-a')).toBeNull();
  });

  it('expira no TTL do analytics (5min)', async () => {
    let clock = 0;
    const cache = new MemoryCache(() => clock);

    await cache.set('analytics:tenant-a:conversion', { rate: 0.42 }, 300);
    clock += 299_000;
    expect(await cache.get('analytics:tenant-a:conversion')).not.toBeNull();

    clock += 2_000;
    expect(await cache.get('analytics:tenant-a:conversion')).toBeNull();
  });

  it('delByPrefix invalida so o prefixo pedido', async () => {
    const cache = new MemoryCache();
    await cache.set('exams:tenant-a:1', 1, 60);
    await cache.set('exams:tenant-a:2', 2, 60);
    await cache.set('exams:tenant-b:1', 3, 60);

    await cache.delByPrefix('exams:tenant-a:');

    expect(await cache.get('exams:tenant-a:1')).toBeNull();
    expect(await cache.get('exams:tenant-a:2')).toBeNull();
    expect(await cache.get('exams:tenant-b:1')).toBe(3);
  });

  it('entrada expirada nao conta no tamanho (nao vaza memoria)', async () => {
    let clock = 0;
    const cache = new MemoryCache(() => clock);
    await cache.set('a', 1, 10);
    await cache.set('b', 2, 100);
    expect(cache.size).toBe(2);

    clock += 20_000;
    expect(cache.size).toBe(1);
  });

  it('TTL zero expira imediatamente', async () => {
    const cache = new MemoryCache();
    await cache.set('efemera', 1, 0);
    expect(await cache.get('efemera')).toBeNull();
  });
});
