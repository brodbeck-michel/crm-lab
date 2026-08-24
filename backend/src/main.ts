/**
 * Entrypoint do servidor: HTTP + WebSocket, com shutdown limpo.
 */
import http from 'node:http';
import { createApp } from './app.js';
import { env, safeEnv } from './config/env.js';
import { closeDb, getDb } from './db/index.js';
import { createCache } from './lib/cache.js';
import { logger } from './lib/logger.js';
import { createWsHub } from './lib/ws-hub.js';

async function bootstrap(): Promise<void> {
  const db = await getDb();
  const cache = createCache();
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
  const shutdown = (signal: string): void => {
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
          process.exit(0);
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
}

bootstrap().catch((err: unknown) => {
  logger.fatal('server.bootstrap_failed', {
    message: err instanceof Error ? err.message : String(err),
  });
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
