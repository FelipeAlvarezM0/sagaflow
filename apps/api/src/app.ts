import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { Redis } from 'ioredis';
import { z } from 'zod';
import {
  getMetrics,
  query,
  withTransaction,
  initTracing,
  type StartRunRequest,
  type WorkflowDefinition,
  type OutboxPayloadCompensate,
  type OutboxPayloadExecuteStep
} from '@sagaflow/shared';

const startRunSchema = z.object({
  version: z.string(),
  input: z.record(z.string(), z.unknown()),
  context: z.record(z.string(), z.unknown()).optional()
});

const cancelSchema = z.object({
  compensate: z.boolean().optional()
});

const workflowDefinitionSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  steps: z
    .array(
      z.object({
        stepId: z.string().min(1),
        action: z.object({
          method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
          url: z.string().url(),
          headers: z.record(z.string(), z.string()).optional(),
          body: z.unknown().optional(),
          timeoutMs: z.number().int().positive().optional()
        }),
        compensation: z
          .object({
            method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
            url: z.string().url(),
            headers: z.record(z.string(), z.string()).optional(),
            body: z.unknown().optional(),
            timeoutMs: z.number().int().positive().optional()
          })
          .optional(),
        timeoutMs: z.number().int().positive(),
        retryPolicy: z.object({
          maxAttempts: z.number().int().min(1),
          initialDelayMs: z.number().int().min(0),
          maxDelayMs: z.number().int().min(0),
          multiplier: z.number().positive(),
          jitter: z.number().min(0).max(1),
          retryOn409: z.boolean().optional()
        }),
        idempotencyScope: z.enum(['run', 'step']),
        onFailure: z.enum(['compensate', 'halt'])
      })
    )
    .min(1)
});

interface RunRow {
  id: string;
  workflow_name: string;
  workflow_version: string;
  status: string;
  input_json: Record<string, unknown>;
  context_json: Record<string, unknown>;
  error_code: string | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
}

interface StepRow {
  step_id: string;
  status: string;
  attempts: number;
  last_error: string | null;
  started_at: Date | null;
  ended_at: Date | null;
  output_json: Record<string, unknown> | null;
  compensation_status: string;
  compensation_attempts: number;
  compensation_error: string | null;
}

async function getDefinition(name: string, version: string): Promise<WorkflowDefinition | null> {
  const result = await query<{ definition_json: WorkflowDefinition }>(
    `SELECT definition_json
     FROM workflow_definitions
     WHERE name = $1 AND version = $2`,
    [name, version]
  );

  return result.rows[0]?.definition_json ?? null;
}

function buildCompensationQueue(definition: WorkflowDefinition, steps: StepRow[]): string[] {
  const succeeded = new Set(steps.filter((step) => step.status === 'SUCCEEDED').map((step) => step.step_id));
  return [...definition.steps]
    .map((step) => step.stepId)
    .filter((stepId) => succeeded.has(stepId))
    .reverse();
}

function adminAuthorized(token: string | undefined): boolean {
  const expected = process.env.ADMIN_TOKEN;
  return Boolean(expected) && token === expected;
}

export async function buildApiServer() {
  await initTracing('sagaflow-api');

  const app = Fastify({
    logger: true,
    genReqId: (req) => (req.headers['x-correlation-id'] as string | undefined) ?? crypto.randomUUID()
  });

  const redisUrl = process.env.REDIS_URL;
  const redis = redisUrl ? new Redis(redisUrl) : undefined;

  await app.register(rateLimit, {
    global: false,
    max: 30,
    timeWindow: '1 minute',
    redis
  });

  app.get('/health', async () => ({ status: 'ok', service: 'api' }));

  app.get('/ready', async (_req, reply) => {
    try {
      await query('SELECT 1');
      let redisDependency: 'ok' | 'disabled' = 'disabled';
      if (redis) {
        const pong = await redis.ping();
        if (pong !== 'PONG') {
          throw new Error(`unexpected redis ping response: ${pong}`);
        }
        redisDependency = 'ok';
      }

      return {
        status: 'ready',
        dependencies: {
          postgres: 'ok',
          redis: redisDependency
        }
      };
    } catch (error) {
      reply.code(503);
      return {
        status: 'not_ready',
        error: String(error),
        dependencies: {
          postgres: 'unknown',
          redis: redis ? 'unknown' : 'disabled'
        }
      };
    }
  });

  app.get('/metrics', async (_req, reply) => {
    const metrics = getMetrics();
    reply.header('Content-Type', metrics.registry.contentType);
    return metrics.registry.metrics();
  });

  app.post('/v1/admin/workflows', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const adminToken = req.headers['x-admin-token'];
    if (!adminAuthorized(typeof adminToken === 'string' ? adminToken : undefined)) {
      reply.code(401);
      return { message: 'unauthorized' };
    }

    const parse = workflowDefinitionSchema.safeParse(req.body);
    if (!parse.success) {
      reply.code(400);
      return { message: 'invalid body', issues: parse.error.flatten() };
    }

    const definition = parse.data;

    await query(
      `INSERT INTO workflow_definitions (name, version, definition_json)
       VALUES ($1, $2, $3)
       ON CONFLICT (name, version)
       DO UPDATE SET definition_json = EXCLUDED.definition_json`,
      [definition.name, definition.version, definition]
    );

    return { ok: true, name: definition.name, version: definition.version };
  });

  app.post('/v1/workflows/:name/start', async (req, reply) => {
    const params = z.object({ name: z.string().min(1) }).safeParse(req.params);
    const body = startRunSchema.safeParse(req.body);

    if (!params.success || !body.success) {
      reply.code(400);
      return { message: 'invalid request', params: params.success, body: body.success };
    }

    const workflowName = params.data.name;
    const payload = body.data as StartRunRequest;

    const definition = await getDefinition(workflowName, payload.version);
    if (!definition) {
      reply.code(404);
      return { message: `workflow ${workflowName}@${payload.version} not found` };
    }

    const metrics = getMetrics();

    const runId = await withTransaction(async (client) => {
      const runRes = await client.query<{ id: string }>(
        `INSERT INTO workflow_runs (workflow_name, workflow_version, status, input_json, context_json)
         VALUES ($1, $2, 'PENDING', $3, $4)
         RETURNING id`,
        [workflowName, payload.version, payload.input, payload.context ?? {}]
      );

      const createdRunId = runRes.rows[0]?.id;
      if (!createdRunId) {
        throw new Error('failed to create run');
      }

      for (const step of definition.steps) {
        await client.query(
          `INSERT INTO run_steps (run_id, step_id, status, attempts, compensation_status, compensation_attempts)
           VALUES ($1, $2, 'PENDING', 0, 'PENDING', 0)`,
          [createdRunId, step.stepId]
        );
      }

      const firstStep = definition.steps[0];
      if (!firstStep) {
        throw new Error('workflow has no steps');
      }

      const outboxPayload: OutboxPayloadExecuteStep = {
        runId: createdRunId,
        stepId: firstStep.stepId,
        scheduledBy: 'START'
      };

      await client.query(
        `INSERT INTO outbox (run_id, type, payload_json, status, next_attempt_at)
         VALUES ($1, 'EXECUTE_STEP', $2, 'PENDING', NOW())`,
        [createdRunId, outboxPayload]
      );

      return createdRunId;
    });

    metrics.workflowRunsStartedTotal.inc();

    req.log.info(
      {
        runId,
        workflowName,
        workflowVersion: payload.version,
        correlationId: req.id,
        input: process.env.LOG_SENSITIVE === 'true' ? payload.input : '[redacted]'
      },
      'run started'
    );

    reply.code(202);
    return { runId, status: 'PENDING' };
  });

  app.get('/v1/runs/:runId', async (req, reply) => {
    const params = z.object({ runId: z.string().uuid() }).safeParse(req.params);
    if (!params.success) {
      reply.code(400);
      return { message: 'invalid runId' };
    }

    const runResult = await query<RunRow>(
      `SELECT id, workflow_name, workflow_version, status, input_json, context_json, error_code, error_message, created_at, updated_at
       FROM workflow_runs
       WHERE id = $1`,
      [params.data.runId]
    );

    if (runResult.rowCount === 0) {
      reply.code(404);
      return { message: 'run not found' };
    }

    const stepsResult = await query<StepRow>(
      `SELECT step_id, status, attempts, last_error, started_at, ended_at, output_json,
              compensation_status, compensation_attempts, compensation_error
       FROM run_steps
       WHERE run_id = $1`,
      [params.data.runId]
    );

    const run = runResult.rows[0] as RunRow;

    return {
      run: {
        runId: run.id,
        workflowName: run.workflow_name,
        workflowVersion: run.workflow_version,
        status: run.status,
        error: run.error_message
          ? {
              code: run.error_code,
              message: run.error_message
            }
          : null,
        createdAt: run.created_at,
        updatedAt: run.updated_at
      },
      steps: stepsResult.rows.map((step) => ({
        stepId: step.step_id,
        status: step.status,
        attempts: step.attempts,
        lastError: step.last_error,
        startedAt: step.started_at,
        endedAt: step.ended_at,
        output: step.output_json,
        compensationStatus: step.compensation_status,
        compensationAttempts: step.compensation_attempts,
        compensationError: step.compensation_error
      }))
    };
  });

  app.post('/v1/runs/:runId/steps/:stepId/retry', async (req, reply) => {
    const params = z.object({ runId: z.string().uuid(), stepId: z.string().min(1) }).safeParse(req.params);
    if (!params.success) {
      reply.code(400);
      return { message: 'invalid params' };
    }

    const { runId, stepId } = params.data;

    await withTransaction(async (client) => {
      const runRes = await client.query<{ status: string }>(
        `SELECT status
         FROM workflow_runs
         WHERE id = $1
         FOR UPDATE`,
        [runId]
      );

      if (runRes.rowCount === 0) {
        throw new Error('run_not_found');
      }

      const stepRes = await client.query<{ status: string }>(
        `SELECT status
         FROM run_steps
         WHERE run_id = $1 AND step_id = $2
         FOR UPDATE`,
        [runId, stepId]
      );

      if (stepRes.rowCount === 0) {
        throw new Error('step_not_found');
      }

      await client.query(
        `UPDATE run_steps
         SET status = 'PENDING',
             last_error = NULL,
             ended_at = NULL
         WHERE run_id = $1 AND step_id = $2`,
        [runId, stepId]
      );

      await client.query(
        `UPDATE workflow_runs
         SET status = 'RUNNING',
             error_code = NULL,
             error_message = NULL,
             updated_at = NOW()
         WHERE id = $1`,
        [runId]
      );

      const outboxPayload: OutboxPayloadExecuteStep = {
        runId,
        stepId,
        scheduledBy: 'MANUAL_RETRY'
      };

      await client.query(
        `INSERT INTO outbox (run_id, type, payload_json, status, next_attempt_at)
         VALUES ($1, 'EXECUTE_STEP', $2, 'PENDING', NOW())`,
        [runId, outboxPayload]
      );
    }).catch((error) => {
      if ((error as Error).message === 'run_not_found') {
        reply.code(404).send({ message: 'run not found' });
        return;
      }
      if ((error as Error).message === 'step_not_found') {
        reply.code(404).send({ message: 'step not found' });
        return;
      }
      throw error;
    });

    reply.code(202);
    return { runId, stepId, status: 'RETRY_SCHEDULED' };
  });

  app.post('/v1/runs/:runId/cancel', async (req, reply) => {
    const params = z.object({ runId: z.string().uuid() }).safeParse(req.params);
    const body = cancelSchema.safeParse(req.body ?? {});

    if (!params.success || !body.success) {
      reply.code(400);
      return { message: 'invalid request' };
    }

    const runId = params.data.runId;
    const compensate = body.data.compensate ?? true;

    const terminalStatus = await withTransaction(async (client) => {
      const runRes = await client.query<RunRow>(
        `SELECT id, workflow_name, workflow_version, status, input_json, context_json, error_code, error_message, created_at, updated_at
         FROM workflow_runs
         WHERE id = $1
         FOR UPDATE`,
        [runId]
      );

      if (runRes.rowCount === 0) {
        throw new Error('run_not_found');
      }

      const run = runRes.rows[0] as RunRow;

      if (run.status === 'COMPLETED' || run.status === 'COMPENSATED') {
        throw new Error('run_terminal');
      }

      if (!compensate) {
        await client.query(
          `UPDATE workflow_runs
           SET status = 'CANCELLED',
               updated_at = NOW()
           WHERE id = $1`,
          [runId]
        );
        return 'CANCELLED' as const;
      }

      const definition = await getDefinition(run.workflow_name, run.workflow_version);
      if (!definition) {
        throw new Error('definition_not_found');
      }

      const stepsRes = await client.query<StepRow>(
        `SELECT step_id, status, attempts, last_error, started_at, ended_at, output_json,
                compensation_status, compensation_attempts, compensation_error
         FROM run_steps
         WHERE run_id = $1`,
        [runId]
      );

      const queue = buildCompensationQueue(definition, stepsRes.rows);

      if (queue.length === 0) {
        await client.query(
          `UPDATE workflow_runs
           SET status = 'CANCELLED', updated_at = NOW()
           WHERE id = $1`,
          [runId]
        );
        return 'CANCELLED' as const;
      }

      await client.query(
        `UPDATE workflow_runs
         SET status = 'COMPENSATING', updated_at = NOW(), error_code = 'CANCELLED_BY_USER', error_message = 'Run cancelled by user'
         WHERE id = $1`,
        [runId]
      );

      const payload: OutboxPayloadCompensate = { runId, queue, reason: 'CANCEL' };

      await client.query(
        `INSERT INTO outbox (run_id, type, payload_json, status, next_attempt_at)
         VALUES ($1, 'EXECUTE_COMPENSATION', $2, 'PENDING', NOW())`,
        [runId, payload]
      );
      return 'COMPENSATING' as const;
    }).catch((error) => {
      const message = (error as Error).message;
      if (message === 'run_not_found') {
        reply.code(404).send({ message: 'run not found' });
        return;
      }
      if (message === 'run_terminal') {
        reply.code(409).send({ message: 'run already terminal' });
        return;
      }
      if (message === 'definition_not_found') {
        reply.code(500).send({ message: 'workflow definition missing' });
        return;
      }
      throw error;
    });

    if (!terminalStatus) {
      return;
    }

    if (terminalStatus === 'CANCELLED') {
      const runRow = await query<{ workflow_name: string; created_at: Date }>(
        `SELECT workflow_name, created_at
         FROM workflow_runs
         WHERE id = $1`,
        [runId]
      );
      const row = runRow.rows[0];
      if (row) {
        const elapsedSeconds = Math.max(0, (Date.now() - row.created_at.getTime()) / 1000);
        getMetrics().workflowRunDurationSeconds.observe(
          { workflowName: row.workflow_name, status: 'CANCELLED' },
          elapsedSeconds
        );
      }
    }

    reply.code(202);
    return { runId, status: terminalStatus };
  });

  app.addHook('onClose', async () => {
    if (redis) {
      await redis.quit();
    }
  });

  return app;
}
