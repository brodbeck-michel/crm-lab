import { describe, expect, it, vi } from 'vitest';
import { MAX_SCAN_BYTES } from '@crm-lab/shared';
import { formatPairingCode } from '@/lib/pairing-code';
import { encodeWithinLimit, fitWithin } from './capture-helpers';

describe('formatPairingCode', () => {
  it('maiúsculas e hífen depois do 4º', () => {
    expect(formatPairingCode('k7mx')).toBe('K7MX');
    expect(formatPairingCode('k7mx4')).toBe('K7MX-4');
    expect(formatPairingCode('k7mx4qpr')).toBe('K7MX-4QPR');
  });

  it('ignora hífen/espaço digitados, símbolos fora do alfabeto e o excesso', () => {
    expect(formatPairingCode('K7MX - 4QPR')).toBe('K7MX-4QPR');
    expect(formatPairingCode('K7MX-4QPRZZZ')).toBe('K7MX-4QPR');
    // 0, O, 1, I e L não existem no alfabeto do código.
    expect(formatPairingCode('0O1IL23')).toBe('23');
  });
});

describe('fitWithin', () => {
  it('reduz o lado maior para 2048 mantendo a proporção', () => {
    expect(fitWithin(4032, 3024)).toEqual({ width: 2048, height: 1536 });
    expect(fitWithin(3024, 4032)).toEqual({ width: 1536, height: 2048 });
  });

  it('nunca amplia', () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
  });
});

describe('encodeWithinLimit', () => {
  const blobOf = (size: number) => new Blob([new Uint8Array(size)], { type: 'image/jpeg' });

  it('0,8 cabe: para aí', async () => {
    const encode = vi.fn(() => Promise.resolve(blobOf(100)));
    expect((await encodeWithinLimit(encode))?.size).toBe(100);
    expect(encode).toHaveBeenCalledWith(0.8);
    expect(encode).toHaveBeenCalledTimes(1);
  });

  it('acima de 5 MB tenta 0,6', async () => {
    const encode = vi.fn((quality: number) =>
      Promise.resolve(blobOf(quality === 0.8 ? MAX_SCAN_BYTES + 1 : 200)),
    );
    expect((await encodeWithinLimit(encode))?.size).toBe(200);
    expect(encode.mock.calls.map(([quality]) => quality)).toEqual([0.8, 0.6]);
  });

  it('ainda acima: null (avisa e não sobe)', async () => {
    const encode = vi.fn(() => Promise.resolve(blobOf(11)));
    expect(await encodeWithinLimit(encode, 10)).toBeNull();
    expect(encode).toHaveBeenCalledTimes(2);
  });
});
