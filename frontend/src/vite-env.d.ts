/// <reference types="vite/client" />

/** Injetada em build-time por `vite.config.ts` a partir do `package.json` da raiz. */
declare const __APP_VERSION__: string;

/**
 * Ambiente do build — injetado como `VITE_APP_ENV` pelo `docker-compose.prod.yml`
 * (build arg `APP_ENV`). Declarado aqui, e nao consumido pelo index signature
 * do vite/client, para nao virar `any` (CLAUDE.md §6).
 * `undefined`/`production` = producao; ver docs/guides/ENVIRONMENTS.md.
 */
interface ImportMetaEnv {
  readonly VITE_APP_ENV?: string;
}
