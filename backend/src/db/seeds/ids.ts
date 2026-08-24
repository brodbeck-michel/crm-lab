/**
 * Geracao DETERMINISTICA de UUIDs a partir de um nome estavel.
 *
 * Por que nao `gen_random_uuid()`: o dataset e2e precisa de IDs fixos para que o
 * Agent-QA escreva asseercoes contra eles (`/proposals/<id>` na URL, por exemplo)
 * e para que "rodar o seed duas vezes" produza exatamente as mesmas linhas.
 *
 * O algoritmo e um UUID v5-like: sha256 do nome, com os bits de versao (5) e de
 * variante (RFC 4122) forcados. Mesmo nome => mesmo UUID, sempre, em qualquer
 * maquina.
 */
import { createHash } from 'node:crypto';

export function seedUuid(...parts: Array<string | number>): string {
  const hex = createHash('sha256').update(parts.join('::')).digest('hex');
  const version = `5${hex.slice(13, 16)}`;
  const variantNibble = ((parseInt(hex[16] as string, 16) & 0x3) | 0x8).toString(16);
  const variant = `${variantNibble}${hex.slice(17, 20)}`;
  return [hex.slice(0, 8), hex.slice(8, 12), version, variant, hex.slice(20, 32)].join('-');
}

/**
 * PRNG deterministico (mulberry32). Substitui `Math.random()` no dataset de
 * desenvolvimento: os dados parecem variados, mas sao os mesmos toda execucao.
 */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Random {
  int(minInclusive: number, maxInclusive: number): number;
  pick<T>(items: readonly T[]): T;
  /** `count` itens distintos, preservando a ordem original. */
  sample<T>(items: readonly T[], count: number): T[];
  bool(probability: number): boolean;
}

export function makeRandom(seed: number): Random {
  const next = createRandom(seed);
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
  return {
    int,
    pick: <T>(items: readonly T[]): T => items[int(0, items.length - 1)] as T,
    sample<T>(items: readonly T[], count: number): T[] {
      const indexes = new Set<number>();
      const limit = Math.min(count, items.length);
      let guard = 0;
      while (indexes.size < limit && guard < 500) {
        indexes.add(int(0, items.length - 1));
        guard += 1;
      }
      return [...indexes].sort((a, b) => a - b).map((i) => items[i] as T);
    },
    bool: (probability: number): boolean => next() < probability,
  };
}
