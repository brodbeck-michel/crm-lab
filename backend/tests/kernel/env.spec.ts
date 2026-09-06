import { describe, expect, it } from 'vitest';
import { EnvValidationError, loadEnv, safeEnv } from '../../src/config/env.js';

const PROD_BASE = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://crm:crm@db:5432/crm_lab',
  JWT_SECRET: 'x'.repeat(48),
  JWT_REFRESH_SECRET: 'y'.repeat(48),
  // D-076: cifra as credenciais de canal em repouso. Sem ela o boot de
  // producao falha — de proposito.
  CHANNEL_SECRET_KEY: 'z'.repeat(48),
  // Onda 8 §4.1: mídia em disco. Obrigatoria em producao, mesma razao de
  // CHANNEL_SECRET_KEY.
  MEDIA_DIR: '/data/media',
};

describe('config/env', () => {
  it('aceita defaults em desenvolvimento (sem .env)', () => {
    const env = loadEnv({ NODE_ENV: 'development' });
    expect(env.PORT).toBe(3000);
    expect(env.RATE_LIMIT_PER_MINUTE).toBe(100);
    expect(env.JWT_ACCESS_TTL).toBe(900);
    expect(env.JWT_SECRET.length).toBeGreaterThan(0);
    expect(env.isDevelopment).toBe(true);
  });

  it('aceita defaults em teste', () => {
    const env = loadEnv({ NODE_ENV: 'test' });
    expect(env.isTest).toBe(true);
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it('falha rapido sem JWT_SECRET em producao', () => {
    expect(() => loadEnv({ ...PROD_BASE, JWT_SECRET: undefined })).toThrow(EnvValidationError);
    try {
      loadEnv({ ...PROD_BASE, JWT_SECRET: undefined });
    } catch (err) {
      expect((err as Error).message).toContain('JWT_SECRET');
      expect((err as Error).message).toContain('NODE_ENV=production');
    }
  });

  it('falha sem JWT_REFRESH_SECRET em producao', () => {
    expect(() => loadEnv({ ...PROD_BASE, JWT_REFRESH_SECRET: undefined })).toThrow(
      /JWT_REFRESH_SECRET/,
    );
  });

  it('recusa o valor de exemplo do .env.example em producao', () => {
    expect(() =>
      loadEnv({ ...PROD_BASE, JWT_SECRET: 'troque-este-valor-em-producao' }),
    ).toThrow(/valor de exemplo/);
  });

  it('recusa segredo curto em producao', () => {
    expect(() => loadEnv({ ...PROD_BASE, JWT_SECRET: 'curto' })).toThrow(/32 caracteres/);
  });

  it('exige CHANNEL_SECRET_KEY em producao, com 32+ caracteres (D-076)', () => {
    expect(() => loadEnv({ ...PROD_BASE, CHANNEL_SECRET_KEY: undefined })).toThrow(
      /CHANNEL_SECRET_KEY/,
    );
    expect(() => loadEnv({ ...PROD_BASE, CHANNEL_SECRET_KEY: 'curta' })).toThrow(
      /32 caracteres/,
    );
    // Fora de producao continua opcional: dev e CI sobem sem chave nenhuma.
    expect(loadEnv({ NODE_ENV: 'development' }).CHANNEL_SECRET_KEY).toBeUndefined();
  });

  it('exige MEDIA_DIR em producao (Onda 8 §4.1)', () => {
    expect(() => loadEnv({ ...PROD_BASE, MEDIA_DIR: undefined })).toThrow(/MEDIA_DIR/);
    // Fora de producao continua opcional: default por ambiente resolve sozinho.
    expect(loadEnv({ NODE_ENV: 'development' }).MEDIA_DIR.length).toBeGreaterThan(0);
  });

  it('exige DATABASE_URL em producao', () => {
    expect(() => loadEnv({ ...PROD_BASE, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
  });

  it('configuracao de producao valida passa', () => {
    const env = loadEnv(PROD_BASE);
    expect(env.isProduction).toBe(true);
    expect(env.DATABASE_URL).toBe(PROD_BASE.DATABASE_URL);
  });

  it('string vazia conta como ausente (o .env.example traz chaves vazias)', () => {
    const env = loadEnv({ NODE_ENV: 'development', WHATSAPP_API_URL: '', REDIS_URL: '' });
    expect(env.WHATSAPP_API_URL).toBeUndefined();
    expect(env.REDIS_URL).toBeUndefined();
  });

  it('CORS_ORIGIN aceita lista separada por virgula', () => {
    const env = loadEnv({
      NODE_ENV: 'development',
      CORS_ORIGIN: 'http://a.local, http://b.local',
    });
    expect(env.corsOrigins).toEqual(['http://a.local', 'http://b.local']);
  });

  it('safeEnv nunca expoe segredos', () => {
    const env = loadEnv(PROD_BASE);
    const safe = safeEnv(env);
    expect(safe.JWT_SECRET).toBe('***');
    expect(safe.JWT_REFRESH_SECRET).toBe('***');
    expect(safe.DATABASE_URL).toBe('***');
    expect(safe.CHANNEL_SECRET_KEY).toBe('***');
    expect(JSON.stringify(safe)).not.toContain(PROD_BASE.JWT_SECRET);
  });
});
