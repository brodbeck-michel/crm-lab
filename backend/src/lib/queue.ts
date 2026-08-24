/**
 * QueueService — interface unica, driver in-memory por padrao (D-011).
 *
 * O unico consumidor hoje e o envio de mensagem pelo WhatsAppService, que
 * SERVICES.md §11 exige "em fila (Bull) com retry exponencial (3 tentativas) ->
 * status `failed` apos esgotar". Bull/Redis entra depois ATRAS DESTA MESMA
 * interface: nenhum service precisa mudar.
 *
 * O relogio e injetavel (`sleep`) de proposito: o backoff exponencial precisa
 * ser testavel sem esperar segundos de verdade. Em teste passa-se um `sleep`
 * que so registra o atraso pedido e resolve na hora.
 *
 *   const queue = createInMemoryQueue({ sleep: async (ms) => { delays.push(ms); } });
 *   await queue.run('whatsapp.send', () => driver.send(...));
 */
import { logger } from './logger.js';

/** Politica de retry de um job. */
export interface RetryPolicy {
  /** Numero TOTAL de tentativas (1 = sem retry). Default: 3. */
  attempts: number;
  /** Atraso da primeira espera, em ms. Dobra a cada tentativa. Default: 200. */
  backoffMs: number;
  /** Teto do atraso, em ms. Default: 30_000. */
  maxBackoffMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  attempts: 3,
  backoffMs: 200,
  maxBackoffMs: 30_000,
};

export interface JobOptions extends Partial<RetryPolicy> {
  /** Nome do job — so para log/diagnostico. */
  name?: string;
}

/** Resultado detalhado de uma execucao — usado por teste e diagnostico. */
export interface JobOutcome<T> {
  ok: boolean;
  value?: T;
  error?: unknown;
  /** Quantas vezes a task foi de fato executada. */
  attempts: number;
  /** Atrasos aplicados entre as tentativas, em ms. */
  delays: number[];
}

export interface QueueService {
  /**
   * Executa `task` com retry exponencial. Resolve com o valor da primeira
   * tentativa bem-sucedida; rejeita com o ULTIMO erro quando esgota.
   */
  run<T>(name: string, task: () => Promise<T>, options?: JobOptions): Promise<T>;
  /** Igual a `run`, mas nunca rejeita: devolve o desfecho estruturado. */
  execute<T>(name: string, task: () => Promise<T>, options?: JobOptions): Promise<JobOutcome<T>>;
  close(): Promise<void>;
}

/** Atraso da tentativa `attempt` (1-based) — exponencial, com teto. */
export function backoffFor(attempt: number, policy: RetryPolicy): number {
  const raw = policy.backoffMs * 2 ** (attempt - 1);
  return Math.min(raw, policy.maxBackoffMs);
}

export type SleepFn = (ms: number) => Promise<void>;

const realSleep: SleepFn = (ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Nao segura o event loop no shutdown.
    timer.unref?.();
  });

export interface InMemoryQueueOptions {
  /** Injetavel para teste: o retry nao pode custar segundos de wall-clock. */
  sleep?: SleepFn;
  defaults?: Partial<RetryPolicy>;
}

function resolvePolicy(options: JobOptions | undefined, defaults: RetryPolicy): RetryPolicy {
  return {
    attempts: Math.max(1, Math.trunc(options?.attempts ?? defaults.attempts)),
    backoffMs: Math.max(0, options?.backoffMs ?? defaults.backoffMs),
    maxBackoffMs: Math.max(0, options?.maxBackoffMs ?? defaults.maxBackoffMs),
  };
}

/**
 * Driver in-memory: executa o job no proprio processo, em linha. Nao ha
 * persistencia — se o processo morre no meio, o job morre junto. Isso e
 * aceitavel para o unico consumidor atual (o envio ja marca a mensagem como
 * `failed` e devolve `MESSAGE_SEND_FAILED` ao cliente).
 */
export class InMemoryQueue implements QueueService {
  private readonly sleep: SleepFn;
  private readonly defaults: RetryPolicy;
  private closed = false;

  constructor(options: InMemoryQueueOptions = {}) {
    this.sleep = options.sleep ?? realSleep;
    this.defaults = { ...DEFAULT_RETRY_POLICY, ...options.defaults };
  }

  async execute<T>(
    name: string,
    task: () => Promise<T>,
    options?: JobOptions,
  ): Promise<JobOutcome<T>> {
    if (this.closed) throw new Error('QueueService ja foi encerrado');
    const policy = resolvePolicy(options, this.defaults);
    const delays: number[] = [];
    let lastError: unknown;

    for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
      try {
        const value = await task();
        return { ok: true, value, attempts: attempt, delays };
      } catch (err) {
        lastError = err;
        logger.warn('queue.job_attempt_failed', {
          job: name,
          attempt,
          attempts: policy.attempts,
          reason: err instanceof Error ? err.message : String(err),
        });
        if (attempt < policy.attempts) {
          const delay = backoffFor(attempt, policy);
          delays.push(delay);
          await this.sleep(delay);
        }
      }
    }

    logger.error('queue.job_exhausted', { job: name, attempts: policy.attempts });
    return { ok: false, error: lastError, attempts: policy.attempts, delays };
  }

  async run<T>(name: string, task: () => Promise<T>, options?: JobOptions): Promise<T> {
    const outcome = await this.execute(name, task, options);
    if (outcome.ok) return outcome.value as T;
    throw outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error));
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export function createInMemoryQueue(options: InMemoryQueueOptions = {}): QueueService {
  return new InMemoryQueue(options);
}

/**
 * Escolhe a implementacao pelo ambiente. Hoje so existe a in-memory; quando o
 * cliente Bull/Redis entrar, e AQUI que a troca acontece (D-011).
 */
export function createQueue(options: InMemoryQueueOptions = {}): QueueService {
  return createInMemoryQueue(options);
}
