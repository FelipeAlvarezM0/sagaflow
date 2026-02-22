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
      service: 'inventory',
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

app.get('/health', async () => ({ status: 'ok', service: 'inventory' }));

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

app.post('/reserve-inventory', async (request, reply) =>
  handleEndpoint('reserve-inventory', request, reply, () => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    return {
      ok: true,
      action: 'reserve-inventory',
      reservationId: `rs_${crypto.randomUUID().slice(0, 8)}`,
      orderId: body.orderId ?? null,
      sku: body.sku ?? 'sku-default'
    };
  })
);

app.post('/release-inventory', async (request, reply) =>
  handleEndpoint('release-inventory', request, reply, () => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    return {
      ok: true,
      action: 'release-inventory',
      released: true,
      orderId: body.orderId ?? null,
      sku: body.sku ?? 'sku-default'
    };
  })
);

const port = Number(process.env.INVENTORY_PORT ?? 3002);
await app.listen({ host: '0.0.0.0', port });
logger.info({ port }, 'mock inventory listening');
