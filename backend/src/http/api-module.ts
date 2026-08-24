/**
 * ============================================================================
 * PONTO DE EXTENSAO DE ROTAS — leia antes de plugar um modulo novo.
 * ============================================================================
 *
 * Cada agente de API entrega UM `ApiModule` e o registra em UM unico lugar:
 * `src/http/modules.ts`. Nada mais no kernel precisa mudar. Tres agentes podem
 * trabalhar em paralelo tocando arquivos diferentes.
 *
 * Passo a passo:
 *
 *  1. No seu dominio, exporte um factory que recebe as dependencias:
 *
 *       // src/controllers/proposal.routes.ts
 *       import { Router } from 'express';
 *       import type { ApiModule, ApiModuleDeps } from '../http/api-module.js';
 *
 *       export function proposalModule(deps: ApiModuleDeps): ApiModule {
 *         const router = Router();
 *         router.get('/', requireAuth(), listProposals(deps));
 *         return { basePath: '/proposals', router, requiresAuth: true };
 *       }
 *
 *  2. Adicione UMA linha em `src/http/modules.ts`:
 *
 *       export const apiModuleFactories: ApiModuleFactory[] = [
 *         proposalModule,   // <- sua linha
 *       ];
 *
 * O router fica montado em `/api/v1/<basePath>`.
 *
 * Regras:
 * - `basePath` comeca com `/`, e kebab-case e plural (CONVENTIONS.md).
 * - Rotas autenticadas usam `requireAuth()` (e `requireRoles(...)` quando o
 *   contrato exigir papel). O kernel NAO autentica por voce: ha rotas publicas
 *   (login, refresh, webhook do WhatsApp).
 * - Nunca leia `tenantId` do request: use `getContext(req).tenantId`.
 */
import type { Router } from 'express';
import type { DbClient } from '../db/types.js';
import type { CacheService } from '../lib/cache.js';
import type { WsHub } from '../lib/ws-hub.js';

/** Dependencias que o kernel entrega a todo modulo de API. */
export interface ApiModuleDeps {
  db: DbClient;
  cache: CacheService;
  wsHub: WsHub;
}

export interface ApiModule {
  /** Caminho relativo a `/api/v1`. Ex.: `/proposals`, `/internal-chat`. */
  basePath: string;
  router: Router;
  /** Documental: indica se o modulo exige token em todas as rotas. */
  requiresAuth?: boolean;
}

export type ApiModuleFactory = (deps: ApiModuleDeps) => ApiModule;
