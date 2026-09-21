/**
 * Timeout de chamada a gateway externo (CRMLAB-30, D-137).
 *
 * ============================================================================
 * Por que isto existe
 * ============================================================================
 * `fetch` do Node NAO tem timeout proprio: sem `signal`, uma chamada so
 * desiste quando o socket TCP morre — o que, num gateway "vivo mas quebrado"
 * (aceita a conexao e nunca responde), pode levar MINUTOS. Foi o incidente de
 * 2026-09-17: o handler de envio ficava preso segurando a transacao
 * `withTenant` e, com ela, uma das 10 conexoes do pool do Postgres. Tres ou
 * quatro atendentes mandando mensagem esgotavam o pool e a API inteira parava
 * — para TODOS os tenants, inclusive nas rotas que nem tocam WhatsApp.
 *
 * `AbortSignal.timeout` e nativo do Node (>= 17.3) — nenhuma dependencia nova.
 *
 * ============================================================================
 * Por que um wrapper e nao so `signal:` no `fetch`
 * ============================================================================
 * O corpo da resposta tambem pode travar: `fetch` resolve quando chegam os
 * HEADERS, e um gateway pode mandar `200 OK` e nunca terminar o body. O mesmo
 * `AbortSignal` cobre os dois, mas a rejeicao acontece no `.text()`/`.json()`,
 * fora do `fetch`. Por isso o callback recebe o signal e faz as DUAS coisas
 * dentro do mesmo `try`: um unico ponto traduz o aborto para
 * `GatewayTimeoutError` e emite um unico `gateway.timeout`.
 *
 * ============================================================================
 * Retry: quem decide e a fila
 * ============================================================================
 * `GatewayTimeoutError` e um `Error` comum e, como qualquer erro lancado dentro
 * de um job, e RETENTADO por `lib/queue.ts` (retry exponencial, 3 tentativas,
 * SERVICES.md §11). A fila NAO distingue erro transitorio de recusa
 * deliberada (credencial ausente, canal desativado): retenta tudo. Uma versao
 * anterior desta classe carregava um campo `retryable = true` que nada lia —
 * documentava uma intencao que o codigo nao implementava (revisao do PR #24),
 * e um leitor futuro marcaria `retryable = false` esperando parar o retry.
 *
 * O orcamento de tempo, entao, nao e o timeout de UMA tentativa e sim
 * `attempts * timeoutMs + backoff`. O teto real e o `proxy_read_timeout 60s`
 * do nginx (`nginx/frontend.conf`): estourar isso troca o `MESSAGE_SEND_FAILED`
 * (502, que a tela sabe explicar) por um 504 generico do proxy. Ver os valores
 * escolhidos em `evolution-client.ts`.
 */
import { logger } from './logger.js';

/** Quem esta sendo chamado — vira contexto do log `gateway.timeout`. */
export interface GatewayTarget {
  /** Nome curto do gateway: `evolution`, `meta`. */
  gateway: string;
  /** Caminho chamado, SEM query string (pode conter id/nome de instancia). */
  path: string;
  timeoutMs: number;
}

/**
 * Gateway externo nao respondeu dentro do orcamento. Tipado de proposito
 * (CONVENTIONS.md "Erros: excecoes tipadas") para que o chamador consiga
 * distinguir "o gateway esta doente" de "o gateway respondeu e recusou".
 */
export class GatewayTimeoutError extends Error {
  readonly gateway: string;
  readonly path: string;
  readonly timeoutMs: number;

  constructor(target: GatewayTarget) {
    super(
      `gateway ${target.gateway} nao respondeu em ${target.timeoutMs}ms em ${target.path}`,
    );
    this.name = 'GatewayTimeoutError';
    this.gateway = target.gateway;
    this.path = target.path;
    this.timeoutMs = target.timeoutMs;
  }
}

export function isGatewayTimeout(error: unknown): error is GatewayTimeoutError {
  return error instanceof GatewayTimeoutError;
}

/**
 * O aborto de `AbortSignal.timeout` chega como `DOMException` de nome
 * `TimeoutError`. O undici as vezes embrulha em `TypeError: fetch failed` com
 * a causa original em `cause`, entao olhamos os dois niveis. Comparamos por
 * NOME e nao por `instanceof DOMException` porque a classe varia entre o
 * global do Node e o do undici.
 */
function isAbortTimeout(error: unknown): boolean {
  if (error instanceof Error && error.name === 'TimeoutError') return true;
  if (error instanceof Error && error.cause !== undefined) return isAbortTimeout(error.cause);
  return false;
}

/**
 * Roda `fn` com um `AbortSignal` que expira em `target.timeoutMs`.
 *
 *   const body = await withGatewayTimeout(
 *     { gateway: 'evolution', path, timeoutMs: 10_000 },
 *     async (signal) => (await fetch(url, { ...init, signal })).text(),
 *   );
 *
 * Qualquer erro que NAO seja o aborto sobe intacto — 500 do gateway, DNS,
 * connection refused continuam sendo o que sempre foram.
 */
export async function withGatewayTimeout<T>(
  target: GatewayTarget,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  try {
    return await fn(AbortSignal.timeout(target.timeoutMs));
  } catch (error) {
    if (!isAbortTimeout(error)) throw error;
    logger.warn('gateway.timeout', {
      gateway: target.gateway,
      path: target.path,
      timeoutMs: target.timeoutMs,
    });
    throw new GatewayTimeoutError(target);
  }
}
