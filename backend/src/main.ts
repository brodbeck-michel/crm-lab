/**
 * Entrypoint do servidor: HTTP + WebSocket, com shutdown limpo.
 */
import http from 'node:http';
import { createApp } from './app.js';
import { env, safeEnv } from './config/env.js';
import { closeDb, getDb } from './db/index.js';
import { createCache, verifyCacheReady } from './lib/cache.js';
import { logger } from './lib/logger.js';
import { createWsHub } from './lib/ws-hub.js';

async function bootstrap(): Promise<void> {
  const db = await getDb();
  const cache = createCache();
  // FAIL-CLOSED (D-058): com REDIS_URL setado e Redis fora do ar, o boot para
  // aqui. Degradar para memoria em silencio quebraria rate limit, lockout de
  // login e invalidacao de analytics em qualquer deploy com mais de 1 instancia.
  await verifyCacheReady(cache);
  const wsHub = createWsHub();

  const { app, modules } = createApp({ db, cache, wsHub });
  const server = http.createServer(app);
  wsHub.attach(server);

  await new Promise<void>((resolve) => server.listen(env.PORT, resolve));
  logger.info('server.started', {
    port: env.PORT,
    nodeEnv: env.NODE_ENV,
    dbDriver: db.driver,
    apiModules: modules.map((m) => m.basePath),
  });
  logger.debug('server.config', safeEnv());

  let shuttingDown = false;
  /**
   * `exitCode` distingue a saida PEDIDA (SIGTERM/SIGINT, codigo 0) da saida por
   * defeito (`uncaughtException`, codigo 1). O codigo importa: o
   * `restart: unless-stopped` do Compose reinicia nos dois casos, mas o codigo
   * e o que diz, no `docker inspect`, se o processo saiu ou se caiu.
   */
  const shutdown = (signal: string, exitCode = 0): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('server.shutdown_started', { signal });

    const forceExit = setTimeout(() => {
      logger.error('server.shutdown_timeout', { signal });
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    server.close(() => {
      void (async () => {
        try {
          await wsHub.close();
          await cache.close();
          await closeDb();
          logger.info('server.shutdown_complete', { signal });
          clearTimeout(forceExit);
          process.exit(exitCode);
        } catch (err) {
          logger.error('server.shutdown_failed', {
            signal,
            message: err instanceof Error ? err.message : String(err),
          });
          process.exit(1);
        }
      })();
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // =========================================================================
  // Rede de seguranca do processo (CRMLAB-30, D-136)
  // =========================================================================
  // Sem estes dois handlers, qualquer excecao ou promise rejeitada fora de um
  // handler do Express derrubava o processo SEM UMA LINHA DE LOG — e derrubar
  // o processo aqui nao e um detalhe: e uma instancia unica, entao vai junto o
  // WebSocket de todas as atendentes de todos os tenants e toda requisicao em
  // voo. O incidente de 17/09 (Postgres piscou, `withTenant` ficou preso
  // esperando o gateway Evolution) e exatamente esse caminho: uma rejeicao ou
  // excecao sem handler explicito matando o Node inteiro sem diagnostico.
  //
  // As duas cardas usam o MESMO tratamento por pedido explicito do card: logar
  // com `event: 'process.fatal'` e sair pelo MESMO shutdown controlado do
  // SIGTERM (fecha WS, cache e pool antes de sair), em vez de deixar o
  // processo em estado indeterminado. O `exitCode = 1` sinaliza no
  // `docker inspect` que foi queda, nao parada pedida.
  const onFatal = (source: 'unhandledRejection' | 'uncaughtException') => (err: unknown): void => {
    logger.fatal('process.fatal', {
      source,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    shutdown(source, 1);
  };

  process.on('unhandledRejection', onFatal('unhandledRejection'));
  process.on('uncaughtException', onFatal('uncaughtException'));
}

bootstrap().catch((err: unknown) => {
  logger.fatal('server.bootstrap_failed', {
    message: err instanceof Error ? err.message : String(err),
  });
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
