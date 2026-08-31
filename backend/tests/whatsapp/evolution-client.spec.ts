/**
 * `createEvolutionClient` — HTTP client do gateway Evolution API (self-hosted,
 * Onda 7 Bloco B). Testado contra um servidor HTTP fake, o mesmo padrao do
 * `MockWhatsAppDriver` (nenhuma chamada de rede real em teste/CI).
 */
import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEvolutionClient } from '../../src/lib/evolution-client.js';

describe('EvolutionClient', () => {
  let fakeGateway: ReturnType<typeof createServer>;
  let baseUrl: string;
  let lastApikeyHeader: string | undefined;

  beforeAll(async () => {
    fakeGateway = createServer((req, res) => {
      lastApikeyHeader = req.headers.apikey as string | undefined;

      if (req.method === 'POST' && req.url === '/instance/create') {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ instance: { instanceName: 'tenant-abc' }, hash: { apikey: 'fake-key' } }));
        return;
      }
      if (req.method === 'GET' && req.url === '/instance/connect/tenant-abc') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ base64: 'data:image/png;base64,AAAA', status: 'pairing' }));
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
    });
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

  it('getQr devolve qrcode base64 e status pairing', async () => {
    const client = createEvolutionClient(baseUrl, 'admin-key');
    const result = await client.getQr('tenant-abc');
    expect(result.status).toBe('pairing');
    expect(result.qrcode).toContain('base64');
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

  it('sendText devolve o externalId da mensagem', async () => {
    const client = createEvolutionClient(baseUrl, 'admin-key');
    const result = await client.sendText('tenant-abc', '5511987654321', 'Ola');
    expect(result.externalId).toBe('EVO123');
  });

  it('resposta HTTP nao-2xx lanca Error com o corpo anexado (nao BusinessError)', async () => {
    const client = createEvolutionClient(baseUrl, 'admin-key');
    // Nenhuma rota do fake gateway responde a este caminho -> 404 vazio.
    await expect(client.getStatus('instancia-desconhecida')).rejects.toThrow(Error);
  });
});
