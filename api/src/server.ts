import { createApp } from './app.js';
import { loadConfig } from './config/env.js';

const config = loadConfig();
const app = await createApp({ config });
let closing = false;

async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'graceful shutdown started');
  const forcedAbort = setTimeout(() => {
    app.log.error({ signal }, 'graceful shutdown deadline exceeded');
    app.abortActiveWork();
    app.server.closeAllConnections();
  }, 10_000);
  forcedAbort.unref();
  try {
    await app.close();
  } finally {
    clearTimeout(forcedAbort);
  }
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ host: '0.0.0.0', port: config.port });
} catch (error) {
  app.log.fatal({ error_category: 'startup_failed', error }, 'server failed to start');
  await app.close();
  process.exitCode = 1;
}
