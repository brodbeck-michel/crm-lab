/**
 * CRMLAB-38 item 4 (D-148) — verifica a LISTA de redact, não a saída
 * renderizada: o logger fica `enabled: false` em `NODE_ENV=test`
 * (`lib/logger.ts`), então não há como capturar o log real neste processo.
 */
import { describe, expect, it } from 'vitest';
import { REDACT_PATHS } from '../../src/lib/logger.js';

describe('logger — redact ampliado (CRMLAB-38)', () => {
  it.each([
    'apikey',
    'apiKey',
    'secret',
    'webhookSecret',
    'contentBase64',
    'email',
    'phone',
    '*.apikey',
    '*.apiKey',
    '*.secret',
    '*.webhookSecret',
    '*.contentBase64',
    '*.email',
    '*.phone',
  ])('redige "%s"', (path) => {
    expect(REDACT_PATHS).toContain(path);
  });

  it('mantem os campos ja redigidos antes do CRMLAB-38 (nao regride)', () => {
    for (const path of ['password', 'token', 'req.headers.authorization', 'req.headers.cookie']) {
      expect(REDACT_PATHS).toContain(path);
    }
  });
});
