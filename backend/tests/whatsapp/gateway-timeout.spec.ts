/**
 * Timeout do `fetch` para gateway externo (CRMLAB-30, D-137).
 *
 * O cenario e o do incidente de 17/09: o gateway esta VIVO (aceita a conexao,
 * as vezes ate manda os headers) mas nunca termina a resposta. O fake abaixo
 * reproduz as duas variantes — silencio total e corpo que nunca fecha — porque
 * elas quebram em pontos diferentes: `fetch` resolve nos HEADERS, entao so a
 * primeira e pega pelo `fetch` em si; a segunda so morre na leitura do corpo.
 *
 * Mesmo padrao de `evolution-client.spec.ts`: servidor HTTP de mentira, nenhuma
 * chamada de rede real. Os timeouts sao injetados curtos (~150 ms) para o teste
 * custar milissegundos em vez dos 10 s de producao — a mesma disciplina do
 * `sleep` injetavel de `queue.ts`.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createEvolutionClient,
  EVOLUTION_MEDIA_TIMEOUT_MS,
  EVOLUTION_TIMEOUT_MS,
} from '../../src/lib/evolution-client.js';
import { GatewayTimeoutError, isGatewayTimeout } from '../../src/lib/fetch-timeout.js';
import { createInMemoryQueue } from '../../src/lib/queue.js';

const TIMEOUT_MS = 150;

describe('timeout de gateway externo', () => {
  let gateway: Server;
  let baseUrl: string;
  /** Sockets pendurados — fechados no final para o servidor conseguir fechar. */
  const hanging: Array<{ destroy: () => void }> = [];

  beforeAll(async () => {
    gateway = createServer((req, res) => {
      hanging.push(res.socket ?? { destroy: () => undefined });

      // Gateway mudo: aceitou a conexao e nunca respondeu nada.
      if (req.url?.includes('mudo')) return;

      // Gateway pela metade: mandou headers 200 e nunca fecha o corpo. E o
      // caso que um `signal` so no `fetch` NAO pegaria, porque `fetch` ja
      // resolveu quando os headers chegaram.
      if (req.url?.includes('pela-metade')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"key":');
        return;
      }

      // `/instance/create` nao e idempotente: com o nome ja em uso o gateway
      // responde 403 e o cliente cai no `fetchInstances`, que e a UNICA rota
      // com query string — e por isso a unica que exercita o corte dela.
      if (req.url === '/instance/create') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 403,
            response: { message: ['This name is already in use.'] },
          }),
        );
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ key: { id: 'wamid.ok' } }));
    });

    await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    for (const socket of hanging) socket.destroy();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
  });

  function client(): ReturnType<typeof createEvolutionClient> {
    return createEvolutionClient(baseUrl, 'admin-key', {
      timeoutMs: TIMEOUT_MS,
      mediaTimeoutMs: TIMEOUT_MS,
    });
  }

  it('aborta quando o gateway aceita a conexao e nao responde', async () => {
    const started = Date.now();
    await expect(client().sendText('mudo', '5511999999999', 'oi', 'key')).rejects.toBeInstanceOf(
      GatewayTimeoutError,
    );
    const elapsed = Date.now() - started;

    // Abortou PELO TIMEOUT, nao por outro motivo: nem antes dele, nem muito
    // depois (sem o `signal`, o `fetch` esperaria o socket TCP morrer).
    expect(elapsed).toBeGreaterThanOrEqual(TIMEOUT_MS - 20);
    expect(elapsed).toBeLessThan(TIMEOUT_MS * 10);
  });

  it('aborta quando o gateway manda headers e nunca fecha o corpo', async () => {
    // Prova que o signal cobre a leitura do corpo, e nao so o `fetch`.
    await expect(
      client().sendText('pela-metade', '5511999999999', 'oi', 'key'),
    ).rejects.toBeInstanceOf(GatewayTimeoutError);
  });

  it('o erro diz qual gateway, qual rota e qual era o orcamento', async () => {
    const error = await client()
      .getStatus('mudo')
      .catch((err: unknown) => err);

    expect(isGatewayTimeout(error)).toBe(true);
    const timeout = error as GatewayTimeoutError;
    expect(timeout.gateway).toBe('evolution');
    expect(timeout.path).toBe('/instance/connectionState/mudo');
    expect(timeout.timeoutMs).toBe(TIMEOUT_MS);
    // Marcado como transitorio: e o que justifica a fila tentar de novo.
    expect(timeout.retryable).toBe(true);
  });

  it('a rota no erro nao carrega query string (pode levar nome de instancia)', async () => {
    // `createInstance` leva 403 e cai em
    // `/instance/fetchInstances?instanceName=tenant-mudo`, que pendura. O
    // `path` registrado tem de vir sem a query: ela carrega o nome da
    // instancia, que e o uuid do tenant.
    const error = await client()
      .createInstance('tenant-mudo')
      .catch((err: unknown) => err);

    expect(isGatewayTimeout(error)).toBe(true);
    expect((error as GatewayTimeoutError).path).toBe('/instance/fetchInstances');
  });

  it('o timeout e retentado pela fila e vira falha depois de esgotar (SERVICES.md §11)', async () => {
    const delays: number[] = [];
    const queue = createInMemoryQueue({ sleep: async (ms) => void delays.push(ms) });

    const outcome = await queue.execute(
      'whatsapp.send',
      () => client().sendText('mudo', '5511999999999', 'oi', 'key'),
      { attempts: 3 },
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.attempts).toBe(3);
    expect(isGatewayTimeout(outcome.error)).toBe(true);
    // Backoff exponencial preservado: o timeout entra na fila como qualquer
    // outra falha, sem caminho especial.
    expect(delays).toEqual([200, 400]);
  });

  it('gateway saudavel continua passando — o signal nao atrapalha o caminho feliz', async () => {
    const result = await client().sendText('ok', '5511999999999', 'oi', 'key');
    expect(result.externalId).toBe('wamid.ok');
  });

  it('o orcamento cabe nos 60 s do proxy_read_timeout do nginx, com 3 tentativas', () => {
    // A conta que justifica os valores: 3 tentativas + backoff (200 + 400 ms).
    // Estourar 60 s trocaria o MESSAGE_SEND_FAILED (502) por um 504 do nginx.
    const budget = (timeoutMs: number): number => 3 * timeoutMs + 200 + 400;
    expect(budget(EVOLUTION_TIMEOUT_MS)).toBeLessThan(60_000);
    expect(budget(EVOLUTION_MEDIA_TIMEOUT_MS)).toBeLessThan(60_000);
    // Midia tem orcamento maior: sobe ate 15 MB em base64.
    expect(EVOLUTION_MEDIA_TIMEOUT_MS).toBeGreaterThan(EVOLUTION_TIMEOUT_MS);
  });
});
