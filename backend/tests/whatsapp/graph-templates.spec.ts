/**
 * CRMLAB-136 (D-309) — driver REAL da Cloud API contra uma Graph API falsa
 * (servidor HTTP local, SERVICES §35 "Teste").
 *
 * - `listTemplates`: `GET /{waba_id}/message_templates` com Bearer, segue
 *   `paging.next` da mesma origem e NUNCA leva o token para outro host;
 * - `sendTemplate`: `type: template`, idioma por código e variáveis como
 *   `parameters` de texto do corpo, em ordem.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HttpWhatsAppDriver, type WhatsAppCredentials } from '../../src/services/whatsapp.service.js';

interface Hit {
  method: string;
  url: string;
  authorization: string | undefined;
  body: unknown;
}

let server: Server;
let hits: Hit[];
let base: string;
let respond: (hit: Hit) => { status: number; body: unknown };

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as unknown) : null;
}

beforeEach(async () => {
  hits = [];
  server = createServer((req, res) => {
    void readBody(req).then((body) => {
      const hit: Hit = {
        method: req.method ?? '',
        url: req.url ?? '',
        authorization: req.headers.authorization,
        body,
      };
      hits.push(hit);
      const { status, body: out } = respond(hit);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v21.0`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function creds(): WhatsAppCredentials {
  return {
    tenantId: 't1',
    phoneNumberId: 'PNID',
    apiUrl: base,
    wabaId: 'WABA1',
    apiToken: 'token-da-meta',
    webhookSecret: 's',
    isActive: true,
    apiTokenRevoked: false,
    connectionMode: 'cloud_api',
    qrInstanceApiKey: null,
  };
}

describe('HttpWhatsAppDriver.listTemplates', () => {
  it('busca na WABA com Bearer e segue a paginação da mesma origem', async () => {
    respond = (hit) =>
      hit.url.includes('after=P2')
        ? { status: 200, body: { data: [{ name: 'b' }] } }
        : { status: 200, body: { data: [{ name: 'a' }], paging: { next: `${base}/WABA1/message_templates?after=P2` } } };

    const rows = await new HttpWhatsAppDriver().listTemplates(creds());
    expect(rows).toEqual([{ name: 'a' }, { name: 'b' }]);
    expect(hits).toHaveLength(2);
    expect(hits[0]?.method).toBe('GET');
    expect(hits[0]?.url).toMatch(/^\/v21\.0\/WABA1\/message_templates\?fields=/);
    expect(hits.every((h) => h.authorization === 'Bearer token-da-meta')).toBe(true);
  });

  it('link "next" de OUTRO host não é seguido (o token não sai)', async () => {
    respond = () => ({
      status: 200,
      body: { data: [{ name: 'a' }], paging: { next: 'https://evil.example/steal?after=P2' } },
    });
    const rows = await new HttpWhatsAppDriver().listTemplates(creds());
    expect(rows).toEqual([{ name: 'a' }]);
    expect(hits).toHaveLength(1);
  });

  it('erro da Meta vira exceção (o serviço traduz para 503)', async () => {
    respond = () => ({ status: 401, body: { error: { message: 'token invalido' } } });
    await expect(new HttpWhatsAppDriver().listTemplates(creds())).rejects.toThrow(/401/);
  });
});

describe('HttpWhatsAppDriver.sendTemplate', () => {
  it('manda type template com idioma e parâmetros do corpo em ordem', async () => {
    respond = () => ({ status: 200, body: { messages: [{ id: 'wamid.ABC' }] } });
    const result = await new HttpWhatsAppDriver().sendTemplate(creds(), '5548999991234', {
      name: 'lembrete_coleta',
      language: 'pt_BR',
      variables: ['Maria', '12/11'],
    });
    expect(result.externalId).toBe('wamid.ABC');
    expect(hits[0]?.url).toBe('/v21.0/PNID/messages');
    expect(hits[0]?.body).toEqual({
      messaging_product: 'whatsapp',
      to: '5548999991234',
      type: 'template',
      template: {
        name: 'lembrete_coleta',
        language: { code: 'pt_BR' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'Maria' },
              { type: 'text', text: '12/11' },
            ],
          },
        ],
      },
    });
  });

  it('modelo sem variável não manda components', async () => {
    respond = () => ({ status: 200, body: { messages: [{ id: 'wamid.X' }] } });
    await new HttpWhatsAppDriver().sendTemplate(creds(), '5548', { name: 'oi', language: 'pt_BR', variables: [] });
    expect((hits[0]?.body as { template: Record<string, unknown> }).template).toEqual({
      name: 'oi',
      language: { code: 'pt_BR' },
    });
  });
});
