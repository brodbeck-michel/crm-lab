/**
 * `src/lib/queue.ts` — retry exponencial (D-011, SERVICES.md §11).
 *
 * O relogio e injetado: a suite prova o backoff sem esperar segundos de
 * wall-clock. Se este teste comecar a demorar, alguem tirou a injecao.
 */
import { describe, expect, it, vi } from 'vitest';
import { backoffFor, createInMemoryQueue, DEFAULT_RETRY_POLICY } from '../../src/lib/queue.js';

/** Coleta os atrasos pedidos e resolve na hora. */
function fakeClock(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

describe('QueueService — retry exponencial', () => {
  it('sucesso na primeira tentativa nao espera nada', async () => {
    const clock = fakeClock();
    const queue = createInMemoryQueue({ sleep: clock.sleep });
    const task = vi.fn(async () => 'ok');

    await expect(queue.run('job', task)).resolves.toBe('ok');
    expect(task).toHaveBeenCalledTimes(1);
    expect(clock.delays).toEqual([]);
  });

  it('falha transitoria: tenta 3 vezes e sucede na ultima', async () => {
    const clock = fakeClock();
    const queue = createInMemoryQueue({ sleep: clock.sleep, defaults: { backoffMs: 100 } });
    let calls = 0;
    const task = async (): Promise<string> => {
      calls += 1;
      if (calls < 3) throw new Error('ECONNRESET');
      return 'entregue';
    };

    await expect(queue.run('whatsapp.send', task)).resolves.toBe('entregue');
    expect(calls).toBe(3);
    // Backoff exponencial: 100ms, 200ms.
    expect(clock.delays).toEqual([100, 200]);
  });

  it('falha permanente: esgota 3 tentativas e propaga o ultimo erro', async () => {
    const clock = fakeClock();
    const queue = createInMemoryQueue({ sleep: clock.sleep, defaults: { backoffMs: 50 } });
    let calls = 0;
    const task = async (): Promise<never> => {
      calls += 1;
      throw new Error(`falha ${calls}`);
    };

    await expect(queue.run('whatsapp.send', task)).rejects.toThrow('falha 3');
    expect(calls).toBe(3);
    expect(clock.delays).toEqual([50, 100]);
  });

  it('execute() devolve o desfecho estruturado sem rejeitar', async () => {
    const clock = fakeClock();
    const queue = createInMemoryQueue({ sleep: clock.sleep, defaults: { backoffMs: 10 } });

    const outcome = await queue.execute('job', async () => {
      throw new Error('sempre falha');
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.attempts).toBe(3);
    expect(outcome.delays).toEqual([10, 20]);
  });

  it('attempts:1 desliga o retry', async () => {
    const clock = fakeClock();
    const queue = createInMemoryQueue({ sleep: clock.sleep });
    let calls = 0;

    await expect(
      queue.run(
        'job',
        async () => {
          calls += 1;
          throw new Error('nao');
        },
        { attempts: 1 },
      ),
    ).rejects.toThrow('nao');
    expect(calls).toBe(1);
    expect(clock.delays).toEqual([]);
  });

  it('o backoff tem teto', () => {
    const policy = { attempts: 10, backoffMs: 1000, maxBackoffMs: 4000 };
    expect(backoffFor(1, policy)).toBe(1000);
    expect(backoffFor(2, policy)).toBe(2000);
    expect(backoffFor(3, policy)).toBe(4000);
    expect(backoffFor(9, policy)).toBe(4000);
  });

  it('a politica default e a de SERVICES.md §11: 3 tentativas', () => {
    expect(DEFAULT_RETRY_POLICY.attempts).toBe(3);
  });
});
