import dotenv from 'dotenv';
import { buildApiServer } from './app.js';
import { closePool, logger, shutdownTracing } from '@sagaflow/shared';

dotenv.config();

const port = Number(process.env.API_PORT ?? 3000);
const host = process.env.API_HOST ?? '0.0.0.0';

const app = await buildApiServer();

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'shutting down api');
  await app.close();
  await closePool();
  await shutdownTracing();
  process.exit(0);
};

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

await app.listen({ port, host });
logger.info({ port, host }, 'api listening');
