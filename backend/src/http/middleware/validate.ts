/**
 * Validacao de DTO com zod.
 *
 * O controller declara o schema; o erro vira `VALIDATION_ERROR` com
 * `details.fields` pelo error-handler. O valor parseado fica guardado e e lido
 * com `validated()`, entao coercoes (`page` string -> number) chegam tipadas ao
 * controller.
 *
 *   router.post('/proposals', validate(createProposalSchema, 'body'), handler);
 *   const dto = validated<CreateProposalDTO>(req, 'body');
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodTypeAny, z } from 'zod';

export type ValidationSource = 'body' | 'query' | 'params';

const parsedValues = new WeakMap<Request, Partial<Record<ValidationSource, unknown>>>();

export function validate(schema: ZodTypeAny, source: ValidationSource = 'body'): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      // ZodError; o error-handler converte para VALIDATION_ERROR.
      next(result.error);
      return;
    }
    const bucket = parsedValues.get(req) ?? {};
    bucket[source] = result.data;
    parsedValues.set(req, bucket);

    // `req.query` e `req.params` podem ser getters no Express 4; por isso o
    // valor parseado fica no WeakMap e so `body` e reatribuido.
    if (source === 'body') {
      req.body = result.data;
    }
    next();
  };
}

/** Le o valor ja validado. Lanca se a rota esqueceu do `validate` correspondente. */
export function validated<T>(req: Request, source: ValidationSource = 'body'): T {
  const bucket = parsedValues.get(req);
  if (!bucket || !(source in bucket)) {
    throw new Error(`Nenhum schema validado para "${source}" nesta rota — falta validate()`);
  }
  return bucket[source] as T;
}

/** Acucar para tipar direto a partir do schema. */
export type Infer<S extends ZodTypeAny> = z.infer<S>;
