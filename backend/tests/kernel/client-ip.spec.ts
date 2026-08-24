/**
 * IP do cliente — cadeia de proxies confiavel (D-057).
 *
 * `clientIp` alimenta TRES controles de seguranca: o balde por IP do rate
 * limit, o contador de lockout de login (`login-failures:<email>:<ip>`) e o
 * `ip_address` do audit log. Se o valor puder vir de um header que o proprio
 * cliente escreve, os tres viram enfeite.
 *
 * A regra: o IP so sai de `req.ip`, e `req.ip` so olha `X-Forwarded-For`
 * quando `trust proxy` foi CONFIGURADO por env var. Default = nao confia.
 */
import express from 'express';
import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.js';
import { clientIp } from '../../src/http/context.js';

/** Endereco do socket quando o teste chama pelo loopback. */
const LOOPBACK = '::ffff:127.0.0.1';

function ipEcho(trustProxy: number | string[] | boolean) {
  const app = express();
  app.set('trust proxy', trustProxy);
  app.get('/ip', (req, res) => {
    res.json({ ip: clientIp(req) });
  });
  return supertest(app);
}

describe('clientIp — cadeia de proxies', () => {
  it('sem proxy confiavel, X-Forwarded-For do cliente e IGNORADO', async () => {
    const response = await ipEcho(false)
      .get('/ip')
      .set('X-Forwarded-For', '203.0.113.9')
      .expect(200);

    expect((response.body as { ip: string }).ip).toBe(LOOPBACK);
  });

  it('varios valores forjados no header nao mudam nada', async () => {
    const agent = ipEcho(false);
    for (const forjado of ['10.0.0.1', '10.0.0.2, 10.0.0.3', 'nao-e-um-ip']) {
      const response = await agent.get('/ip').set('X-Forwarded-For', forjado).expect(200);
      expect((response.body as { ip: string }).ip).toBe(LOOPBACK);
    }
  });

  it('com 1 hop confiavel, o IP e o ULTIMO da cadeia (o que o proxy escreveu)', async () => {
    const response = await ipEcho(1)
      .get('/ip')
      // '1.1.1.1' e o que o cliente forjou; '2.2.2.2' e o que o proxy anexou.
      .set('X-Forwarded-For', '1.1.1.1, 2.2.2.2')
      .expect(200);

    expect((response.body as { ip: string }).ip).toBe('2.2.2.2');
  });

  it('sem header nenhum, cai no endereco do socket', async () => {
    const response = await ipEcho(false).get('/ip').expect(200);
    expect((response.body as { ip: string }).ip).toBe(LOOPBACK);
  });
});

describe('env.trustProxy', () => {
  const base = { NODE_ENV: 'development' } as const;

  it('default seguro: nao confia em proxy nenhum', () => {
    expect(loadEnv({ ...base }).trustProxy).toBe(false);
    expect(loadEnv({ ...base, TRUST_PROXY_HOPS: '' }).trustProxy).toBe(false);
    expect(loadEnv({ ...base, TRUST_PROXY_HOPS: '0' }).trustProxy).toBe(false);
  });

  it('TRUST_PROXY_HOPS vira o numero de hops confiaveis', () => {
    expect(loadEnv({ ...base, TRUST_PROXY_HOPS: '1' }).trustProxy).toBe(1);
    expect(loadEnv({ ...base, TRUST_PROXY_HOPS: '2' }).trustProxy).toBe(2);
  });

  it('TRUSTED_PROXIES (lista de ips/CIDRs) tem precedencia sobre a contagem', () => {
    const env = loadEnv({
      ...base,
      TRUST_PROXY_HOPS: '3',
      TRUSTED_PROXIES: '10.0.0.0/8, 172.16.0.1',
    });
    expect(env.trustProxy).toEqual(['10.0.0.0/8', '172.16.0.1']);
  });

  it('recusa hops negativo ou nao numerico', () => {
    expect(() => loadEnv({ ...base, TRUST_PROXY_HOPS: '-1' })).toThrow();
    expect(() => loadEnv({ ...base, TRUST_PROXY_HOPS: 'todos' })).toThrow();
  });
});
