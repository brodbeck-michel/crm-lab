/**
 * Entrypoint do servidor: HTTP + WebSocket, com shutdown limpo.
 */
import http from 'node:http';
import { createApp } from './app.js';
import { env, safeEnv } from './config/env.js';
import { closeDb, getDb } from './db/index.js';
import { createCache, verifyCacheReady } from './lib/cache.js';
import { logger } from './lib/logger.js';
import { refreshSessionIsLive } from './services/auth.service.js';
import { createWsHub } from './lib/ws-hub.js';
import { deleteExpiredOrRevoked } from './repositories/refresh-token.repository.js';
import { deleteExpiredOrUsed as deleteExpiredResetTokens } from './repositories/password-reset-token.repository.js';

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function bootstrap(): Promise<void> {
  const db = await getDb();
  const cache = createCache();
  // FAIL-CLOSED (D-058): com REDIS_URL setado e Redis fora do ar, o boot para
  // aqui. Degradar para memoria em silencio quebraria rate limit, lockout de
  // login e invalidacao de analytics em qualquer deploy com mais de 1 instancia.
  await verifyCacheReady(cache);
  const wsHub = createWsHub({
    allowedOrigins: env.corsOrigins,
    // O handshake do WS confere a sessao no banco, nao so a assinatura do JWT
    // (correcao da revisao do CRMLAB-33) — senao um refresh revogado no logout
    // abria realtime por ate JWT_REFRESH_TTL.
    validateSession: (token) => refreshSessionIsLive(db, token),
  });

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
  // Codigo com que o processo VAI sair. Um erro fatal que chega no meio de um
  // shutdown por SIGTERM (ja em andamento, `shuttingDown = true`) precisa
  // forcar 1 mesmo assim — senao `docker inspect` mostra saida limpa para uma
  // queda (revisao do PR #24).
  let finalExitCode = 0;
  /**
   * `exitCode` distingue a saida PEDIDA (SIGTERM/SIGINT, codigo 0) da saida por
   * defeito (`uncaughtException`, codigo 1). O codigo importa: o
   * `restart: unless-stopped` do Compose reinicia nos dois casos, mas o codigo
   * e o que diz, no `docker inspect`, se o processo saiu ou se caiu.
   */
  const shutdown = (signal: string, exitCode = 0): void => {
    finalExitCode = Math.max(finalExitCode, exitCode);
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
          logger.info('server.shutdown_complete', { signal, exitCode: finalExitCode });
          clearTimeout(forceExit);
          process.exit(finalExitCode);
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
  // Limpeza de refresh_tokens expirados/revogados (CRMLAB-35, D-155)
  // =========================================================================
  // Best-effort: nunca deve derrubar o boot nem o processo. Sem scheduler novo
  // (nao existe um no projeto) — `setInterval` simples, `.unref()` para nao
  // impedir o processo de sair no shutdown.
  const runRefreshTokenCleanup = (): void => {
    deleteExpiredOrRevoked(db)
      .then((deleted) => {
        if (deleted > 0) logger.info('refresh_tokens.cleanup', { deleted });
      })
      .catch((err: unknown) => {
        logger.warn('refresh_tokens.cleanup_failed', {
          message: err instanceof Error ? err.message : String(err),
        });
      });
    // CRMLAB-39: mesmo padrao acima, para `password_reset_tokens`.
    deleteExpiredResetTokens(db)
      .then((deleted) => {
        if (deleted > 0) logger.info('password_reset_tokens.cleanup', { deleted });
      })
      .catch((err: unknown) => {
        logger.warn('password_reset_tokens.cleanup_failed', {
          message: err instanceof Error ? err.message : String(err),
        });
      });
  };
  runRefreshTokenCleanup();
  const cleanupInterval = setInterval(runRefreshTokenCleanup, CLEANUP_INTERVAL_MS);
  cleanupInterval.unref();

  // =========================================================================
  // Rede de seguranca do processo (CRMLAB-30, D-138)
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
