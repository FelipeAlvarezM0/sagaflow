import dotenv from 'dotenv';
import Fastify from 'fastify';
import { closePool, getMetrics, initTracing, logger, query, shutdownTracing } from '@sagaflow/shared';
import { SagaEngine } from './engine.js';

dotenv.config();

await initTracing('sagaflow-engine');

const workerId = process.env.ENGINE_WORKER_ID ?? `engine-${process.pid}`;
const pollMs = Number(process.env.ENGINE_POLL_INTERVAL_MS ?? 500);
const leaseTtlMs = Number(process.env.ENGINE_LEASE_TTL_MS ?? 30000);
const metricsPort = Number(process.env.ENGINE_PORT ?? 3100);

const engine = new SagaEngine({ workerId, pollMs, leaseTtlMs });
engine.start();

const app = Fastify({ logger: true });

app.get('/health', async () => ({ status: 'ok', service: 'engine', workerId }));

app.get('/ready', async (_req, reply) => {
  try {
    await query('SELECT 1');
    return { status: 'ready', workerId };
  } catch (error) {
    reply.code(503);
    return { status: 'not_ready', workerId, error: String(error) };
  }
});

app.get('/metrics', async (_req, reply) => {
  const metrics = getMetrics();
  reply.header('Content-Type', metrics.registry.contentType);
  return metrics.registry.metrics();
});

await app.listen({ host: '0.0.0.0', port: metricsPort });
logger.info({ workerId, pollMs, leaseTtlMs, metricsPort }, 'engine started');

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'shutting down engine');
  engine.stop();
  await app.close();
  await closePool();
  await shutdownTracing();
  process.exit(0);
};

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
