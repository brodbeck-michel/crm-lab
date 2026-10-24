/**
 * Migracao para o zod 4 (CRMLAB-115, D-281).
 *
 * GHSA-mrhx-c7xc-m3w5: o parse de array acumulava um issue por elemento, sem teto, e um corpo
 * com um array gigante esgotava a memoria. Na 4.6.6+ array com `.max()` falha ANTES de iterar —
 * so vale se o teto existir, por isso cada array de entrada tem o seu. Aqui tambem fica o
 * contrato do `VALIDATION_ERROR` (chaves de `details.fields`, `_root`) e o locale pt-BR.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { examPricesBodySchema } from '../../src/controllers/exam.routes.js';
import { examPackagePricesBodySchema } from '../../src/controllers/exam-package.routes.js';
import { updatePatientSchema } from '../../src/controllers/patient.routes.js';
import { toApiErrorBody } from '../../src/http/middleware/error-handler.js';
// Efeito colateral: configura o locale pt-BR (o app carrega o mesmo modulo em toda rota).
import '../../src/http/middleware/validate.js';

const INSURANCE_ID = 'a0000000-0000-4000-8000-000000000001';

function fieldsOf(result: { success: boolean; error?: z.ZodError }): Record<string, string> {
  expect(result.success).toBe(false);
  const { status, body } = toApiErrorBody(result.error);
  expect(status).toBe(400);
  expect(body.error.code).toBe('VALIDATION_ERROR');
  return (body.error.details as { fields: Record<string, string> }).fields;
}

describe('tetos de array (GHSA-mrhx-c7xc-m3w5)', () => {
  it.each([
    ['exame', examPricesBodySchema],
    ['pacote', examPackagePricesBodySchema],
  ])('prices de %s com 1.000.000 itens falha por too_big sem iterar', (_label, schema) => {
    // Itens invalidos: se o zod iterasse, sairia um issue por item (o bug).
    const prices = new Array<unknown>(1_000_000).fill('lixo');
    const started = performance.now();
    const result = schema.safeParse({ prices });
    const elapsed = performance.now() - started;

    expect(result.success).toBe(false);
    expect(result.error?.issues).toHaveLength(1);
    expect(result.error?.issues[0]?.code).toBe('too_big');
    expect(elapsed).toBeLessThan(500);
    expect(Object.keys(fieldsOf(result))).toEqual(['prices']);
  });

  it('prices aceita ate 500 itens e recusa 501', () => {
    const item = { insuranceId: INSURANCE_ID, price: 10 };
    expect(examPricesBodySchema.safeParse({ prices: new Array(500).fill(item) }).success).toBe(true);
    expect(examPricesBodySchema.safeParse({ prices: new Array(501).fill(item) }).success).toBe(false);
  });

  it('customFields com chaves demais e recusado antes de validar cada chave', () => {
    const customFields = Object.fromEntries(Array.from({ length: 100_000 }, (_, i) => [`k${i}`, 1]));
    const result = updatePatientSchema.safeParse({ customFields });
    expect(result.error?.issues).toHaveLength(1);
    expect(fieldsOf(result)).toEqual({ customFields: 'No maximo 30 campos personalizados' });
  });
});

describe('contrato do VALIDATION_ERROR no zod 4', () => {
  const schema = z
    .object({
      reason: z.string().min(3),
      items: z.array(z.object({ quantity: z.number() })).max(10),
    })
    .strict();

  it('chave = caminho com ponto; sem caminho = _root; mensagens padrao em portugues', () => {
    const fields = fieldsOf(schema.safeParse({ reason: 'x', items: [{ quantity: '1' }], extra: true }));

    expect(Object.keys(fields).sort()).toEqual(['_root', 'items.0.quantity', 'reason']);
    expect(fields.reason).toBe('Pequeno demais: esperava que o texto tivesse >= 3 caracteres');
    expect(fields['items.0.quantity']).toBe('Entrada inválida: esperava um número, recebeu um texto');
    expect(fields._root).toBe('Chave inválida: "extra"');
  });

  it('mensagem explicita no schema continua vencendo o locale', () => {
    const fields = fieldsOf(z.object({ id: z.uuid('Identificador inválido') }).safeParse({ id: 'x' }));
    expect(fields).toEqual({ id: 'Identificador inválido' });
  });
});
