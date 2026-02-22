import dotenv from 'dotenv';
import Fastify from 'fastify';
import { logger } from '@sagaflow/shared';

dotenv.config();

interface StoredResponse {
  statusCode: number;
  body: Record<string, unknown>;
}

interface FailureConfig {
  failRate: number;
  failOnce: boolean;
  failEndpoints: Set<string>;
  consumedOnce: Set<string>;
}

const app = Fastify({ logger: true });
const idempotencyStore = new Map<string, StoredResponse>();

const failureConfig: FailureConfig = {
  failRate: Number(process.env.FAIL_RATE ?? 0),
  failOnce: String(process.env.FAIL_ONCE ?? 'false') === 'true',
  failEndpoints: new Set(
    String(process.env.FAIL_ENDPOINTS ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
  ),
  consumedOnce: new Set()
};

function parseFailureBody(body: unknown): Partial<{ failRate: number; failOnce: boolean; failEndpoints: string[] }> {
  if (!body || typeof body !== 'object') {
    return {};
  }

  const data = body as Record<string, unknown>;
  const output: Partial<{ failRate: number; failOnce: boolean; failEndpoints: string[] }> = {};

  if (typeof data.failRate === 'number') {
    output.failRate = data.failRate;
  }
  if (typeof data.failOnce === 'boolean') {
    output.failOnce = data.failOnce;
  }
  if (Array.isArray(data.failEndpoints)) {
    output.failEndpoints = data.failEndpoints.filter((entry): entry is string => typeof entry === 'string');
  }

  return output;
}

function endpointShouldFail(endpoint: string): boolean {
  const targeted = failureConfig.failEndpoints.size === 0 || failureConfig.failEndpoints.has(endpoint);
  if (!targeted) {
    return false;
  }

  if (failureConfig.failOnce && !failureConfig.consumedOnce.has(endpoint)) {
    failureConfig.consumedOnce.add(endpoint);
    return true;
  }

  return failureConfig.failRate > 0 && Math.random() < failureConfig.failRate;
}

interface RequestLike {
  headers: Record<string, unknown>;
  body?: unknown;
}

function idempotencyKeyFor(request: RequestLike, endpoint: string): string {
  const header = request.headers['x-idempotency-key'];
  const key = typeof header === 'string' ? header : 'missing-key';
  return `${endpoint}:${key}`;
}

async function handleEndpoint(
  endpoint: string,
  request: RequestLike,
  reply: { code: (statusCode: number) => unknown },
  producer: () => Record<string, unknown>
): Promise<Record<string, unknown>> {
  const dedupeKey = idempotencyKeyFor(request, endpoint);
  const cached = idempotencyStore.get(dedupeKey);
  if (cached) {
    reply.code(cached.statusCode);
    return cached.body;
  }

  if (endpointShouldFail(endpoint)) {
    const failure = {
      endpoint,
      service: 'payments',
      error: 'injected_failure',
      idempotencyKey: dedupeKey
    };

    idempotencyStore.set(dedupeKey, { statusCode: 500, body: failure });
    reply.code(500);
    return failure;
  }

  const response = producer();
  idempotencyStore.set(dedupeKey, { statusCode: 200, body: response });
  return response;
}

app.get('/health', async () => ({ status: 'ok', service: 'payments' }));

app.get('/admin/failure', async () => ({
  failRate: failureConfig.failRate,
  failOnce: failureConfig.failOnce,
  failEndpoints: [...failureConfig.failEndpoints]
}));

app.post('/admin/failure', async (request) => {
  const update = parseFailureBody(request.body);

  if (typeof update.failRate === 'number') {
    failureConfig.failRate = Math.max(0, Math.min(1, update.failRate));
  }
  if (typeof update.failOnce === 'boolean') {
    failureConfig.failOnce = update.failOnce;
    failureConfig.consumedOnce.clear();
  }
  if (update.failEndpoints) {
    failureConfig.failEndpoints = new Set(update.failEndpoints);
    failureConfig.consumedOnce.clear();
  }

  return {
    ok: true,
    failRate: failureConfig.failRate,
    failOnce: failureConfig.failOnce,
    failEndpoints: [...failureConfig.failEndpoints]
  };
});

app.post('/charge-payment', async (request, reply) =>
  handleEndpoint('charge-payment', request, reply, () => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    return {
      ok: true,
      action: 'charge-payment',
      chargeId: `ch_${crypto.randomUUID().slice(0, 8)}`,
      orderId: body.orderId ?? null,
      amount: body.amount ?? null
    };
  })
);

app.post('/refund-payment', async (request, reply) =>
  handleEndpoint('refund-payment', request, reply, () => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    return {
      ok: true,
      action: 'refund-payment',
      refundId: `rf_${crypto.randomUUID().slice(0, 8)}`,
      orderId: body.orderId ?? null,
      amount: body.amount ?? null
    };
  })
);

app.post('/validate-refund', async (request, reply) =>
  handleEndpoint('validate-refund', request, reply, () => ({
    ok: true,
    action: 'validate-refund',
    approved: true,
    request: request.body ?? {}
  }))
);

const port = Number(process.env.PAYMENTS_PORT ?? 3001);
await app.listen({ host: '0.0.0.0', port });
logger.info({ port }, 'mock payments listening');
