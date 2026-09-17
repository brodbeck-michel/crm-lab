/**
 * `createEvolutionClient` — HTTP client do gateway Evolution API (self-hosted,
 * Onda 7 Bloco B). Testado contra um servidor HTTP fake, o mesmo padrao do
 * `MockWhatsAppDriver` (nenhuma chamada de rede real em teste/CI).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createEvolutionClient,
  isInstanceNotFound,
  isSessionClosed,
} from '../../src/lib/evolution-client.js';

describe('EvolutionClient', () => {
  let fakeGateway: ReturnType<typeof createServer>;
  let baseUrl: string;
  let lastApikeyHeader: string | undefined;
  /** Ultimo corpo recebido em /instance/create ou /webhook/set. */
  let lastBody: Record<string, unknown> = {};

  beforeAll(async () => {
    // O corpo e lido ANTES de rotear: `/instance/create` decide pelo
    // `instanceName` do corpo (a URL e a mesma para todas as instancias).
    fakeGateway = createServer((req, res) => {
      lastApikeyHeader = req.headers.apikey as string | undefined;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        lastBody = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
        route(req, res);
      });
    });

    function route(req: IncomingMessage, res: ServerResponse): void {
      if (req.method === 'POST' && req.url === '/instance/create') {
        if (lastBody.instanceName === 'tenant-existe') {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              status: 403,
              response: { message: ['This name "tenant-existe" is already in use.'] },
            }),
          );
          return;
        }
        res.writeHead(201, { 'Content-Type': 'application/json' });
        // `hash` em STRING e o formato do gateway v2.3.7 de verdade.
        res.end(JSON.stringify({ instance: { instanceName: 'tenant-abc' }, hash: 'fake-key' }));
        return;
      }
      if (req.method === 'GET' && req.url === '/instance/fetchInstances?instanceName=tenant-existe') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ name: 'tenant-existe', token: 'key-ja-existente' }]));
        return;
      }
      if (req.method === 'POST' && req.url === '/webhook/set/tenant-existe') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ enabled: true }));
        return;
      }
      if (req.method === 'GET' && req.url === '/instance/connect/tenant-abc') {
        // Formato REAL do Evolution v2 enquanto pareando: sem `status`
        // (a `status: 'pairing'` extra aqui prova que o cliente NAO depende
        // dela — ver o teste "ignora um `status` inventado no corpo").
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ base64: 'data:image/png;base64,AAAA', status: 'pairing' }));
        return;
      }
      if (req.method === 'GET' && req.url === '/instance/connect/tenant-ja-conectado') {
        // Formato REAL quando a instancia JA esta conectada: sem `base64`,
        // `instance.state: 'open'` (Minor 7 da revisao da Task 5).
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ instance: { instanceName: 'tenant-ja-conectado', state: 'open' } }));
        return;
      }
      if (req.method === 'GET' && req.url === '/instance/connectionState/tenant-connected') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ instance: { state: 'open', owner: '5511987654321@s.whatsapp.net' } }),
        );
        return;
      }
      if (req.method === 'GET' && req.url === '/instance/connectionState/tenant-closed') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ instance: { state: 'close' } }));
        return;
      }
      if (req.method === 'DELETE' && req.url === '/instance/logout/tenant-abc') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'SUCCESS' }));
        return;
      }
      // Sessao morta com registro preso em `open` — corpo COPIADO da resposta
      // real do v2.3.7 em producao (2026-09-17).
      if (req.method === 'DELETE' && req.url === '/instance/logout/tenant-sessao-morta') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 500,
            error: 'Internal Server Error',
            response: { message: ['Error: Connection Closed'] },
          }),
        );
        return;
      }
      if (req.method === 'POST' && req.url === '/message/sendText/tenant-abc') {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ key: { id: 'EVO123' } }));
        return;
      }
      if (req.method === 'POST' && req.url === '/instance/create/erro') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'gateway indisponivel' }));
        return;
      }
      res.writeHead(404);
      res.end();
    }

    await new Promise<void>((resolve) => fakeGateway.listen(0, resolve));
    const address = fakeGateway.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(() => fakeGateway.close());

  it('createInstance devolve instanceName e apikey, autenticado pela apikey admin', async () => {
    const client = createEvolutionClient(baseUrl, 'admin-key');
    const handle = await client.createInstance('tenant-abc');
    expect(handle.instanceName).toBe('tenant-abc');
    expect(handle.apikey).toBe('fake-key');
    expect(lastApikeyHeader).toBe('admin-key');
  });

  it('createInstance registra o webhook do tenant no proprio /instance/create', async () => {
    const client = createEvolutionClient(baseUrl, 'admin-key');
    await client.createInstance('tenant-abc', {
      url: 'https://crm.local/api/v1/webhooks/evolution/t1',
      token: 'segredo',
    });
    const webhook = lastBody.webhook as Record<string, unknown>;
    expect(webhook.url).toBe('https://crm.local/api/v1/webhooks/evolution/t1');
    expect(webhook.headers).toEqual({ 'x-evolution-webhook-token': 'segredo' });
    expect(webhook.events).toEqual(['MESSAGES_UPSERT', 'CONNECTION_UPDATE']);
  });

  it('createInstance numa instancia que JA existe (403) adota a existente e reaplica o webhook', async () => {
    // O gateway responde 403 `already in use` — e o caminho de TODA reconexao.
    const client = createEvolutionClient(baseUrl, 'admin-key');
    const handle = await client.createInstance('tenant-existe', {
      url: 'https://crm.local/api/v1/webhooks/evolution/t1',
      token: 'segredo',
    });
    expect(handle.apikey).toBe('key-ja-existente');
    const webhook = (lastBody.webhook ?? {}) as Record<string, unknown>;
    expect(webhook.enabled).toBe(true);
    expect(webhook.url).toBe('https://crm.local/api/v1/webhooks/evolution/t1');
  });

  it('getQr devolve qrcode base64 e status pairing', async () => {
    const client = createEvolutionClient(baseUrl, 'admin-key');
    const result = await client.getQr('tenant-abc');
    expect(result.status).toBe('pairing');
    expect(result.qrcode).toContain('base64');
  });

  it('getQr numa instancia JA CONECTADA (sem base64, sem status) devolve connected', async () => {
    // Fix do Minor 7: o gateway real nao manda `status` neste endpoint; uma
    // instancia conectada devolve so `instance.state: 'open'`. Antes deste
    // fix o cliente caia no fallback `qrcode ? 'pairing' : 'disconnected'` e
    // respondia `disconnected` para um canal saudavel — o modal de QR do
    // frontend (Task 9) nunca via `connected` e rodava ate o timeout de ~90s.
    const client = createEvolutionClient(baseUrl, 'admin-key');
    const result = await client.getQr('tenant-ja-conectado');
    expect(result.status).toBe('connected');
    expect(result.qrcode).toBeNull();
  });

  it('getStatus mapeia state open -> connected e devolve o numero', async () => {
    const client = createEvolutionClient(baseUrl, 'admin-key');
    const result = await client.getStatus('tenant-connected');
    expect(result.status).toBe('connected');
    expect(result.phoneNumber).toBe('5511987654321');
  });

  it('getStatus mapeia state close -> disconnected, sem numero', async () => {
    const client = createEvolutionClient(baseUrl, 'admin-key');
    const result = await client.getStatus('tenant-closed');
    expect(result.status).toBe('disconnected');
    expect(result.phoneNumber).toBeNull();
  });

  it('logout chama DELETE /instance/logout/:instance', async () => {
    const client = createEvolutionClient(baseUrl, 'admin-key');
    await expect(client.logout('tenant-abc')).resolves.toBeUndefined();
  });

  it('logout numa sessao morta (500 Connection Closed) e reconhecido por isSessionClosed', async () => {
    // O gateway esta NO AR e responde — quem morreu foi a sessao Baileys. O
    // service precisa distinguir isso de "gateway fora do ar" para nao mandar
    // o admin conferir uma configuracao que esta correta.
    const client = createEvolutionClient(baseUrl, 'admin-key');
    const error = await client.logout('tenant-sessao-morta').catch((e: unknown) => e);
    expect(isSessionClosed(error)).toBe(true);
    expect(isInstanceNotFound(error)).toBe(false);
  });

  it('sendText devolve o externalId da mensagem, autenticado pela apikey DA INSTANCIA', async () => {
    // Fix do Important 6 da revisao da Task 5: sendText NUNCA pode sair com a
    // apikey administrativa do gateway (privilegio maximo) — so com a apikey
    // da PROPRIA instancia, a mesma que fica cifrada em repouso em
    // `tenant_channels.api_token`.
    const client = createEvolutionClient(baseUrl, 'admin-key');
    const result = await client.sendText(
      'tenant-abc',
      '5511987654321',
      'Ola',
      'apikey-da-instancia-tenant-abc',
    );
    expect(result.externalId).toBe('EVO123');
    expect(lastApikeyHeader).toBe('apikey-da-instancia-tenant-abc');
    expect(lastApikeyHeader).not.toBe('admin-key');
  });

  it('resposta HTTP nao-2xx lanca Error com o corpo anexado (nao BusinessError)', async () => {
    const client = createEvolutionClient(baseUrl, 'admin-key');
    // Nenhuma rota do fake gateway responde a este caminho -> 404 vazio.
    await expect(client.getStatus('instancia-desconhecida')).rejects.toThrow(Error);
  });
});
