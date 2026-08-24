/**
 * O envelope de erro e contrato com o frontend (docs/api/API_ERRORS.md).
 * Estes testes verificam o formato EXATO para cada classe de erro.
 */
import { Router } from 'express';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ApiErrorCode } from '@crm-lab/shared';
import type { ApiModule, ApiModuleDeps } from '../../src/http/api-module.js';
import { BusinessError, ERROR_CATALOG } from '../../src/http/errors.js';
import { validate } from '../../src/http/middleware/validate.js';
import { createTestApp } from '../helpers/test-app.js';

const bodySchema = z.object({
  discountPercent: z.number().min(0).max(100),
  reason: z.string().min(3),
});

function errorProbeModule(_deps: ApiModuleDeps): ApiModule {
  const router = Router();

  router.get('/business', () => {
    throw new BusinessError('DISCOUNT_EXCEEDS_LIMIT', {
      requestedDiscount: 25,
      userLimit: 15,
      approvalRequired: true,
    });
  });

  router.get('/not-found', () => {
    throw new BusinessError('NOT_FOUND');
  });

  router.post('/validate', validate(bodySchema, 'body'), (_req, res) => {
    res.json({ ok: true });
  });

  router.get('/boom', () => {
    throw new Error('detalhe sensivel que nao pode vazar');
  });

  return { basePath: '/probe', router };
}

describe('error-handler — envelope de API_ERRORS.md', () => {
  it('catalogo cobre todos os ApiErrorCode com statusCode e mensagem pt-BR', () => {
    for (const [code, definition] of Object.entries(ERROR_CATALOG)) {
      expect(definition.statusCode).toBeGreaterThanOrEqual(400);
      expect(definition.statusCode).toBeLessThan(600);
      expect(definition.message.length).toBeGreaterThan(0);
      expect(code).toBe(code.toUpperCase());
    }
    // Alguns codigos-chave com o status exato do doc:
    const expectations: Array<[ApiErrorCode, number]> = [
      ['INVALID_CREDENTIALS', 401],
      ['TOKEN_EXPIRED', 401],
      ['TOKEN_INVALID', 401],
      ['REFRESH_TOKEN_INVALID', 401],
      ['FORBIDDEN', 403],
      ['USER_INACTIVE', 403],
      ['TENANT_INACTIVE', 403],
      ['NOT_FOUND', 404],
      ['VALIDATION_ERROR', 400],
      ['CONFLICT', 409],
      ['DISCOUNT_EXCEEDS_LIMIT', 403],
      ['INVALID_STATUS_TRANSITION', 400],
      ['LOSS_REASON_REQUIRED', 400],
      ['INVALID_LOSS_REASON', 400],
      ['PROPOSAL_PENDING_APPROVAL', 409],
      ['PROPOSAL_ALREADY_CLOSED', 409],
      ['APPROVAL_NOT_ALLOWED', 403],
      ['EXAM_NOT_FOUND_OR_INACTIVE', 400],
      ['CONVERSATION_ALREADY_ASSIGNED', 409],
      ['CONVERSATION_ARCHIVED', 409],
      ['MESSAGE_SEND_FAILED', 502],
      ['RATE_LIMIT_EXCEEDED', 429],
      ['INTERNAL_ERROR', 500],
    ];
    for (const [code, status] of expectations) {
      expect(ERROR_CATALOG[code].statusCode, code).toBe(status);
    }
  });

  it('BusinessError -> code, message, statusCode e details', async () => {
    const { agent } = await createTestApp({ modules: [errorProbeModule] });
    const res = await agent.get('/api/v1/probe/business');

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: {
        code: 'DISCOUNT_EXCEEDS_LIMIT',
        message: ERROR_CATALOG.DISCOUNT_EXCEEDS_LIMIT.message,
        statusCode: 403,
        details: { requestedDiscount: 25, userLimit: 15, approvalRequired: true },
      },
    });
  });

  it('BusinessError sem details omite a chave details', async () => {
    const { agent } = await createTestApp({ modules: [errorProbeModule] });
    const res = await agent.get('/api/v1/probe/not-found');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { code: 'NOT_FOUND', message: ERROR_CATALOG.NOT_FOUND.message, statusCode: 404 },
    });
    expect('details' in res.body.error).toBe(false);
  });

  it('ZodError -> VALIDATION_ERROR com details.fields', async () => {
    const { agent } = await createTestApp({ modules: [errorProbeModule] });
    const res = await agent
      .post('/api/v1/probe/validate')
      .send({ discountPercent: 150, reason: 'x' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.statusCode).toBe(400);
    expect(Object.keys(res.body.error.details.fields).sort()).toEqual([
      'discountPercent',
      'reason',
    ]);
    expect(typeof res.body.error.details.fields.discountPercent).toBe('string');
  });

  it('erro desconhecido -> INTERNAL_ERROR sem stack e sem mensagem original', async () => {
    const { agent } = await createTestApp({ modules: [errorProbeModule] });
    const res = await agent.get('/api/v1/probe/boom');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: ERROR_CATALOG.INTERNAL_ERROR.message,
        statusCode: 500,
      },
    });
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('detalhe sensivel');
    expect(raw).not.toContain('stack');
  });

  it('rota inexistente -> NOT_FOUND no mesmo envelope', async () => {
    const { agent } = await createTestApp();
    const res = await agent.get('/api/v1/rota-que-nao-existe');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('toda resposta carrega o correlationId no header', async () => {
    const { agent } = await createTestApp({ modules: [errorProbeModule] });
    const res = await agent.get('/api/v1/probe/boom');
    expect(res.headers['x-correlation-id']).toBeTruthy();
  });

  it('GET /health e publico e responde ok', async () => {
    const { agent } = await createTestApp();
    const res = await agent.get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
