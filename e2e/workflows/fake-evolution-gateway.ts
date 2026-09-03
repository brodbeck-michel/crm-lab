/**
 * Gateway Evolution API falso — usado pelo fluxo 14 (conexao WhatsApp por QR).
 *
 * Por que um servidor de verdade e nao um mock: o caminho sob teste e
 * `browser -> backend -> gateway`. O backend so fala com o gateway por HTTP
 * (`backend/src/lib/evolution-client.ts`), e ele roda em OUTRO processo — nao
 * ha objeto para injetar daqui. O unico ponto de troca e a URL.
 *
 * Contrato replicado (so o que o cliente consome — ver `evolution-client.ts`):
 *   POST   /instance/create                   -> { instance: {...}, hash: { apikey } }
 *   GET    /instance/connect/:name            -> 1a chamada: { base64 } (pareando)
 *                                                depois:     { instance: { state: 'open' } }
 *   GET    /instance/connectionState/:name    -> { instance: { state, owner } }
 *   DELETE /instance/logout/:name             -> {}
 *
 * A segunda chamada de `/instance/connect` responder "conectado" e o que faz o
 * polling do modal terminar sozinho — e o roteiro do gateway real: o QR sai,
 * o celular pareia, o estado vira `open`.
 *
 * **Porta**: por padrao 8080, a MESMA do servico `evolution` do
 * `docker-compose.yml`, porque o backend do ambiente de teste aponta para uma
 * URL so (`EVOLUTION_API_URL`). Rodar a suite com o gateway real de pe da
 * `EADDRINUSE` — de proposito: e o aviso de que o teste falaria com o gateway
 * de verdade, nao um falso-verde silencioso. Pare o container antes:
 * `docker compose stop evolution`.
 */
import { createServer, type Server } from 'node:http';

/** PNG 1x1 em data URI — o `<img>` do modal so precisa de um src valido. */
export const FAKE_QR_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** Numero devolvido em `owner` quando a instancia esta conectada. */
export const FAKE_OWNER_PHONE = '5548999990000';

export interface FakeEvolutionGateway {
  /** Base HTTP (`http://127.0.0.1:<porta>`) — o valor de `EVOLUTION_API_URL`. */
  readonly baseUrl: string;
  /** Quantas vezes `/instance/connect/:name` foi chamado. */
  readonly connectCalls: number;
  close(): Promise<void>;
}

export interface FakeEvolutionOptions {
  port?: number;
  /**
   * Em quantas chamadas de `/instance/connect` o gateway ainda devolve QR
   * antes de dizer "conectado". `1` = a primeira mostra o QR, a segunda ja
   * pareou.
   */
  qrResponsesBeforeConnected?: number;
}

export async function startFakeEvolutionGateway(
  options: FakeEvolutionOptions = {},
): Promise<FakeEvolutionGateway> {
  const port = options.port ?? Number(process.env.E2E_EVOLUTION_PORT ?? 8080);
  const qrRounds = options.qrResponsesBeforeConnected ?? 1;

  let connectCalls = 0;

  const server: Server = createServer((req, res) => {
    const url = req.url ?? '';
    const respond = (body: unknown): void => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'POST' && url.startsWith('/instance/create')) {
      respond({
        instance: { instanceName: 'fake', status: 'created' },
        hash: { apikey: 'fake-instance-apikey' },
      });
      return;
    }

    if (req.method === 'GET' && url.startsWith('/instance/connect/')) {
      connectCalls += 1;
      if (connectCalls <= qrRounds) {
        respond({ base64: FAKE_QR_DATA_URI, code: 'fake-pairing-code' });
      } else {
        respond({ instance: { instanceName: 'fake', state: 'open' } });
      }
      return;
    }

    if (req.method === 'GET' && url.startsWith('/instance/connectionState/')) {
      const state = connectCalls > qrRounds ? 'open' : 'connecting';
      respond({
        instance: {
          instanceName: 'fake',
          state,
          owner: state === 'open' ? `${FAKE_OWNER_PHONE}@s.whatsapp.net` : null,
        },
      });
      return;
    }

    if (req.method === 'DELETE' && url.startsWith('/instance/logout/')) {
      connectCalls = 0;
      respond({});
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `rota nao mapeada no gateway falso: ${req.method} ${url}` }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'EADDRINUSE'
          ? new Error(
              `porta ${port} ocupada — o gateway Evolution real esta de pe. ` +
                'Pare o container antes da suite: `docker compose stop evolution`.',
            )
          : error,
      );
    });
    server.listen(port, '127.0.0.1', resolve);
  });

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    get connectCalls() {
      return connectCalls;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
