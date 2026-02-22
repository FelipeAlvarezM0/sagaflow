import { trace, SpanStatusCode } from '@opentelemetry/api';
import {
  computeBackoffMs,
  createMetricHelpers,
  executeHttpRequest,
  getMetrics,
  isTransientFailure,
  logger,
  query,
  renderTemplate,
  type OutboxPayloadCompensate,
  type OutboxPayloadExecuteStep,
  type OutboxRecord,
  type StepDefinition,
  type WorkflowDefinition,
  withTransaction
} from '@sagaflow/shared';

interface RunExecutionRow {
  id: string;
  workflow_name: string;
  workflow_version: string;
  status: string;
  input_json: Record<string, unknown>;
  context_json: Record<string, unknown>;
}

interface StepRow {
  step_id: string;
  status: string;
  attempts: number;
  compensation_status: string;
  compensation_attempts: number;
}

function nextStep(definition: WorkflowDefinition, stepId: string): StepDefinition | null {
  const index = definition.steps.findIndex((step) => step.stepId === stepId);
  if (index < 0 || index >= definition.steps.length - 1) {
    return null;
  }
  return definition.steps[index + 1] ?? null;
}

function buildCompensationQueue(definition: WorkflowDefinition, succeededStepIds: string[]): string[] {
  const succeededSet = new Set(succeededStepIds);
  return definition.steps
    .map((step) => step.stepId)
    .filter((stepId) => succeededSet.has(stepId))
    .reverse();
}

function nowPlusMs(ms: number): string {
  return `NOW() + (${Math.max(0, Math.floor(ms))} * interval '1 millisecond')`;
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

export class SagaEngine {
  private readonly workerId: string;
  private readonly pollMs: number;
  private readonly leaseTtlMs: number;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly tracer = trace.getTracer('sagaflow-engine');

  constructor(options: { workerId: string; pollMs: number; leaseTtlMs: number }) {
    this.workerId = options.workerId;
    this.pollMs = options.pollMs;
    this.leaseTtlMs = options.leaseTtlMs;
  }

  start(): void {
    this.stopped = false;
    this.scheduleNextTick(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNextTick(delayMs: number): void {
    this.timer = setTimeout(() => {
      void this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (this.stopped) {
      return;
    }

    try {
      for (let i = 0; i < 10; i += 1) {
        const message = await this.acquireOutboxMessage();
        if (!message) {
          break;
        }

        try {
          await this.processOutboxMessage(message);
          await this.markOutboxDone(message.id);
        } catch (error) {
          logger.error({ err: error, outboxId: message.id }, 'failed to process outbox message');
          await this.requeueOutboxMessage(message.id, 5000);
        }
      }

      await this.refreshOutboxMetrics();
    } catch (error) {
      logger.error({ err: error }, 'engine tick failure');
    } finally {
      this.scheduleNextTick(this.pollMs);
    }
  }

  private async acquireOutboxMessage(): Promise<OutboxRecord | null> {
    const result = await query<OutboxRecord>(
      `WITH candidate AS (
         SELECT id
         FROM outbox
         WHERE (
           (status = 'PENDING' AND next_attempt_at <= NOW())
           OR (status = 'IN_FLIGHT' AND lock_acquired_at < NOW() - ($2 * interval '1 millisecond'))
         )
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE outbox o
       SET status = 'IN_FLIGHT',
           lock_owner = $1,
           lock_acquired_at = NOW(),
           attempts = o.attempts + 1
       FROM candidate
       WHERE o.id = candidate.id
       RETURNING o.id, o.run_id, o.type, o.payload_json, o.status, o.attempts,
                 o.next_attempt_at, o.lock_owner, o.lock_acquired_at, o.created_at`,
      [this.workerId, this.leaseTtlMs]
    );

    return result.rows[0] ?? null;
  }

  private async markOutboxDone(outboxId: number): Promise<void> {
    await query(
      `UPDATE outbox
       SET status = 'DONE',
           lock_owner = NULL,
           lock_acquired_at = NULL
       WHERE id = $1`,
      [outboxId]
    );
  }

  private async requeueOutboxMessage(outboxId: number, delayMs: number): Promise<void> {
    await query(
      `UPDATE outbox
       SET status = 'PENDING',
           next_attempt_at = ${nowPlusMs(delayMs)},
           lock_owner = NULL,
           lock_acquired_at = NULL
       WHERE id = $1`,
      [outboxId]
    );
  }

  private async refreshOutboxMetrics(): Promise<void> {
    const metrics = createMetricHelpers();
    const result = await query<{ backlog: string; lag_seconds: string | null }>(
      `SELECT COUNT(*)::text AS backlog,
              COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at))), 0)::text AS lag_seconds
       FROM outbox
       WHERE status = 'PENDING'`
    );

    const row = result.rows[0];
    metrics.setOutbox(Number(row?.backlog ?? 0), Number(row?.lag_seconds ?? 0));
  }

  private async processOutboxMessage(message: OutboxRecord): Promise<void> {
    if (message.type === 'EXECUTE_STEP') {
      await this.handleExecuteStep(message.payload_json as OutboxPayloadExecuteStep);
      return;
    }

    if (message.type === 'EXECUTE_COMPENSATION') {
      await this.handleExecuteCompensation(message.payload_json as OutboxPayloadCompensate);
      return;
    }

    logger.warn({ type: message.type }, 'unknown outbox type, skipping');
  }

  private async handleExecuteStep(payload: OutboxPayloadExecuteStep): Promise<void> {
    const runResult = await query<RunExecutionRow>(
      `SELECT id, workflow_name, workflow_version, status, input_json, context_json
       FROM workflow_runs
       WHERE id = $1`,
      [payload.runId]
    );

    const run = runResult.rows[0];
    if (!run) {
      logger.warn({ runId: payload.runId }, 'run not found for step execution');
      return;
    }

    if (run.status === 'COMPLETED' || run.status === 'COMPENSATED' || run.status === 'CANCELLED') {
      return;
    }

    const definition = await getDefinition(run.workflow_name, run.workflow_version);
    if (!definition) {
      await this.failRun(run.id, 'WORKFLOW_NOT_FOUND', 'Workflow definition not found');
      return;
    }

    const stepDefinition = definition.steps.find((step) => step.stepId === payload.stepId);
    if (!stepDefinition) {
      await this.failRun(run.id, 'STEP_NOT_FOUND', `Step ${payload.stepId} not found in workflow definition`);
      return;
    }

    const reserve = await withTransaction(async (client) => {
      const runLock = await client.query<{ status: string }>(
        `SELECT status
         FROM workflow_runs
         WHERE id = $1
         FOR UPDATE`,
        [run.id]
      );

      const currentRunStatus = runLock.rows[0]?.status;
      if (!currentRunStatus || ['COMPLETED', 'COMPENSATED', 'CANCELLED'].includes(currentRunStatus)) {
        return { skip: true, attemptNo: 0 };
      }

      const stepLock = await client.query<{ status: string; attempts: number }>(
        `SELECT status, attempts
         FROM run_steps
         WHERE run_id = $1 AND step_id = $2
         FOR UPDATE`,
        [run.id, payload.stepId]
      );

      const stepRow = stepLock.rows[0];
      if (!stepRow || stepRow.status === 'SUCCEEDED' || stepRow.status === 'COMPENSATED') {
        return { skip: true, attemptNo: stepRow?.attempts ?? 0 };
      }

      if (stepRow.status === 'RUNNING') {
        return { skip: true, attemptNo: stepRow.attempts };
      }

      await client.query(
        `UPDATE workflow_runs
         SET status = 'RUNNING', updated_at = NOW(), error_code = NULL, error_message = NULL
         WHERE id = $1 AND status IN ('PENDING', 'FAILED', 'RUNNING')`,
        [run.id]
      );

      const updateStep = await client.query<{ attempts: number }>(
        `UPDATE run_steps
         SET status = 'RUNNING',
             attempts = attempts + 1,
             started_at = COALESCE(started_at, NOW())
         WHERE run_id = $1 AND step_id = $2
         RETURNING attempts`,
        [run.id, payload.stepId]
      );

      return { skip: false, attemptNo: updateStep.rows[0]?.attempts ?? 1 };
    });

    if (reserve.skip) {
      return;
    }

    const attemptNo = reserve.attemptNo;
    const execution = await this.tracer.startActiveSpan('execute_step', async (span) => {
      span.setAttribute('runId', run.id);
      span.setAttribute('stepId', payload.stepId);
      span.setAttribute('attemptNo', attemptNo);

      const rendered = {
        ...stepDefinition.action,
        headers: renderTemplate(stepDefinition.action.headers ?? {}, {
          input: run.input_json,
          context: run.context_json,
          run: { id: run.id }
        }),
        body: renderTemplate(stepDefinition.action.body, {
          input: run.input_json,
          context: run.context_json,
          run: { id: run.id }
        })
      };

      const idempotencyKey = `${run.id}:${payload.stepId}:${attemptNo}`;

      const result = await executeHttpRequest(rendered, {
        timeoutMs: stepDefinition.timeoutMs,
        headers: {
          'x-idempotency-key': idempotencyKey,
          'x-correlation-id': String(run.context_json.correlationId ?? run.id)
        }
      });

      if (result.statusCode) {
        span.setAttribute('http.status', result.statusCode);
      }

      if (!result.ok) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: result.errorMessage ?? `HTTP ${result.statusCode}` });
      }

      span.end();
      return result;
    });

    const metrics = getMetrics();
    metrics.stepLatencyMs.observe({ stepId: payload.stepId }, execution.durationMs);

    if (execution.ok) {
      await withTransaction(async (client) => {
        await client.query(
          `INSERT INTO step_attempts (run_id, step_id, attempt_no, attempt_type, status, http_status, duration_ms, error_message)
           VALUES ($1, $2, $3, 'ACTION', 'SUCCESS', $4, $5, NULL)
           ON CONFLICT (run_id, step_id, attempt_no, attempt_type)
           DO NOTHING`,
          [run.id, payload.stepId, attemptNo, execution.statusCode ?? null, execution.durationMs]
        );

        await client.query(
          `UPDATE run_steps
           SET status = 'SUCCEEDED',
               ended_at = NOW(),
               last_error = NULL,
               output_json = $3
           WHERE run_id = $1 AND step_id = $2`,
          [run.id, payload.stepId, execution.body ?? null]
        );

        const next = nextStep(definition, payload.stepId);
        if (next) {
          const nextPayload: OutboxPayloadExecuteStep = {
            runId: run.id,
            stepId: next.stepId,
            scheduledBy: 'NEXT_STEP'
          };

          await client.query(
            `INSERT INTO outbox (run_id, type, payload_json, status, next_attempt_at)
             VALUES ($1, 'EXECUTE_STEP', $2, 'PENDING', NOW())`,
            [run.id, nextPayload]
          );
        } else {
          await client.query(
            `UPDATE workflow_runs
             SET status = 'COMPLETED', updated_at = NOW(), error_code = NULL, error_message = NULL
             WHERE id = $1`,
            [run.id]
          );

          metrics.workflowRunsCompletedTotal.inc();
        }
      });

      metrics.stepAttemptsTotal.inc({ stepId: payload.stepId, status: 'SUCCESS' });

      logger.info(
        {
          runId: run.id,
          workflowName: run.workflow_name,
          stepId: payload.stepId,
          attemptNo,
          durationMs: execution.durationMs,
          status: 'SUCCEEDED'
        },
        'step execution succeeded'
      );

      return;
    }

    const transientInput: {
      timedOut: boolean;
      networkError: boolean;
      statusCode?: number;
      retryOn409?: boolean;
    } = {
      timedOut: execution.timedOut,
      networkError: execution.networkError
    };
    if (execution.statusCode !== undefined) {
      transientInput.statusCode = execution.statusCode;
    }
    if (stepDefinition.retryPolicy.retryOn409 !== undefined) {
      transientInput.retryOn409 = stepDefinition.retryPolicy.retryOn409;
    }

    const decision = isTransientFailure(transientInput);

    const shouldRetry = decision.retryable && attemptNo < stepDefinition.retryPolicy.maxAttempts;

    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO step_attempts (run_id, step_id, attempt_no, attempt_type, status, http_status, duration_ms, error_message)
         VALUES ($1, $2, $3, 'ACTION', 'FAIL', $4, $5, $6)
         ON CONFLICT (run_id, step_id, attempt_no, attempt_type)
         DO NOTHING`,
        [
          run.id,
          payload.stepId,
          attemptNo,
          execution.statusCode ?? null,
          execution.durationMs,
          execution.errorMessage ?? `HTTP ${execution.statusCode ?? 'unknown'}`
        ]
      );

      await client.query(
        `UPDATE run_steps
         SET status = 'FAILED',
             ended_at = NOW(),
             last_error = $3
         WHERE run_id = $1 AND step_id = $2`,
        [run.id, payload.stepId, execution.errorMessage ?? `HTTP ${execution.statusCode ?? 'unknown'}`]
      );

      if (shouldRetry) {
        const delay = computeBackoffMs(stepDefinition.retryPolicy, attemptNo);
        const retryPayload: OutboxPayloadExecuteStep = {
          runId: run.id,
          stepId: payload.stepId,
          scheduledBy: 'RETRY'
        };

        await client.query(
          `INSERT INTO outbox (run_id, type, payload_json, status, next_attempt_at)
           VALUES ($1, 'EXECUTE_STEP', $2, 'PENDING', ${nowPlusMs(delay)})`,
          [run.id, retryPayload]
        );

        logger.warn(
          {
            runId: run.id,
            stepId: payload.stepId,
            attemptNo,
            retryInMs: delay,
            reason: decision.reason
          },
          'step failed, retry scheduled'
        );

        return;
      }

      if (stepDefinition.onFailure === 'compensate') {
        const succeededSteps = await client.query<{ step_id: string }>(
          `SELECT step_id
           FROM run_steps
           WHERE run_id = $1 AND status = 'SUCCEEDED'`,
          [run.id]
        );

        const queue = buildCompensationQueue(
          definition,
          succeededSteps.rows.map((row) => row.step_id)
        );

        if (queue.length > 0) {
          await client.query(
            `UPDATE workflow_runs
             SET status = 'COMPENSATING',
                 updated_at = NOW(),
                 error_code = 'STEP_FAILED',
                 error_message = $2
             WHERE id = $1`,
            [run.id, execution.errorMessage ?? `Step ${payload.stepId} failed`]
          );

          const compensationPayload: OutboxPayloadCompensate = {
            runId: run.id,
            queue,
            reason: 'STEP_FAILURE'
          };

          await client.query(
            `INSERT INTO outbox (run_id, type, payload_json, status, next_attempt_at)
             VALUES ($1, 'EXECUTE_COMPENSATION', $2, 'PENDING', NOW())`,
            [run.id, compensationPayload]
          );

          logger.warn(
            {
              runId: run.id,
              stepId: payload.stepId,
              queue
            },
            'step failed, compensation started'
          );

          return;
        }
      }

      await client.query(
        `UPDATE workflow_runs
         SET status = 'FAILED', updated_at = NOW(), error_code = 'STEP_FAILED', error_message = $2
         WHERE id = $1`,
        [run.id, execution.errorMessage ?? `Step ${payload.stepId} failed`]
      );

      metrics.workflowRunsFailedTotal.inc();
    });

    metrics.stepAttemptsTotal.inc({ stepId: payload.stepId, status: 'FAIL' });
  }

  private async handleExecuteCompensation(payload: OutboxPayloadCompensate): Promise<void> {
    if (payload.queue.length === 0) {
      await this.markRunCompensated(payload.runId);
      return;
    }

    const currentStepId = payload.queue[0] as string;
    const remaining = payload.queue.slice(1);

    const runResult = await query<RunExecutionRow>(
      `SELECT id, workflow_name, workflow_version, status, input_json, context_json
       FROM workflow_runs
       WHERE id = $1`,
      [payload.runId]
    );

    const run = runResult.rows[0];
    if (!run) {
      return;
    }

    const definition = await getDefinition(run.workflow_name, run.workflow_version);
    if (!definition) {
      await this.failRun(run.id, 'WORKFLOW_NOT_FOUND', 'Workflow definition not found during compensation');
      return;
    }

    const stepDefinition = definition.steps.find((step) => step.stepId === currentStepId);
    if (!stepDefinition) {
      await this.scheduleCompensation(run.id, remaining, payload.reason, 0);
      return;
    }

    const compensationSpec = stepDefinition.compensation;

    if (!compensationSpec) {
      await query(
        `UPDATE run_steps
         SET compensation_status = 'SKIPPED',
             compensation_error = NULL
         WHERE run_id = $1 AND step_id = $2`,
        [run.id, currentStepId]
      );

      if (remaining.length === 0) {
        await this.markRunCompensated(run.id);
      } else {
        await this.scheduleCompensation(run.id, remaining, payload.reason, 0);
      }

      return;
    }

    const reserve = await withTransaction(async (client) => {
      const row = await client.query<{ compensation_status: string; compensation_attempts: number }>(
        `SELECT compensation_status, compensation_attempts
         FROM run_steps
         WHERE run_id = $1 AND step_id = $2
         FOR UPDATE`,
        [run.id, currentStepId]
      );

      const step = row.rows[0];
      if (!step) {
        return { skip: true, attemptNo: 0 };
      }

      if (step.compensation_status === 'COMPENSATED' || step.compensation_status === 'SKIPPED') {
        return { skip: true, attemptNo: step.compensation_attempts };
      }

      if (step.compensation_status === 'RUNNING') {
        return { skip: true, attemptNo: step.compensation_attempts };
      }

      const update = await client.query<{ compensation_attempts: number }>(
        `UPDATE run_steps
         SET compensation_status = 'RUNNING',
             compensation_attempts = compensation_attempts + 1
         WHERE run_id = $1 AND step_id = $2
         RETURNING compensation_attempts`,
        [run.id, currentStepId]
      );

      return { skip: false, attemptNo: update.rows[0]?.compensation_attempts ?? 1 };
    });

    if (reserve.skip) {
      if (remaining.length === 0) {
        await this.markRunCompensated(run.id);
      } else {
        await this.scheduleCompensation(run.id, remaining, payload.reason, 0);
      }
      return;
    }

    const attemptNo = reserve.attemptNo;

    const execution = await this.tracer.startActiveSpan('execute_compensation', async (span) => {
      span.setAttribute('runId', run.id);
      span.setAttribute('stepId', currentStepId);
      span.setAttribute('attemptNo', attemptNo);

      const rendered = {
        method: compensationSpec.method,
        url: compensationSpec.url,
        headers: renderTemplate(compensationSpec.headers ?? {}, {
          input: run.input_json,
          context: run.context_json,
          run: { id: run.id }
        }),
        body: renderTemplate(compensationSpec.body, {
          input: run.input_json,
          context: run.context_json,
          run: { id: run.id }
        })
      };

      const result = await executeHttpRequest(rendered, {
        timeoutMs: stepDefinition.timeoutMs,
        headers: {
          'x-idempotency-key': `${run.id}:${currentStepId}:compensation:${attemptNo}`,
          'x-correlation-id': String(run.context_json.correlationId ?? run.id)
        }
      });

      if (result.statusCode) {
        span.setAttribute('http.status', result.statusCode);
      }

      if (!result.ok) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: result.errorMessage ?? `HTTP ${result.statusCode}` });
      }

      span.end();
      return result;
    });

    const metrics = getMetrics();
    metrics.stepLatencyMs.observe({ stepId: currentStepId }, execution.durationMs);

    if (execution.ok) {
      await withTransaction(async (client) => {
        await client.query(
          `INSERT INTO step_attempts (run_id, step_id, attempt_no, attempt_type, status, http_status, duration_ms, error_message)
           VALUES ($1, $2, $3, 'COMPENSATION', 'SUCCESS', $4, $5, NULL)
           ON CONFLICT (run_id, step_id, attempt_no, attempt_type)
           DO NOTHING`,
          [run.id, currentStepId, attemptNo, execution.statusCode ?? null, execution.durationMs]
        );

        await client.query(
          `UPDATE run_steps
           SET compensation_status = 'COMPENSATED',
               compensation_error = NULL,
               status = CASE WHEN status = 'SUCCEEDED' THEN 'COMPENSATED' ELSE status END
           WHERE run_id = $1 AND step_id = $2`,
          [run.id, currentStepId]
        );
      });

      metrics.stepAttemptsTotal.inc({ stepId: currentStepId, status: 'SUCCESS' });

      if (remaining.length === 0) {
        await this.markRunCompensated(run.id);
      } else {
        await this.scheduleCompensation(run.id, remaining, payload.reason, 0);
      }

      logger.info(
        {
          runId: run.id,
          stepId: currentStepId,
          attemptNo,
          status: 'COMPENSATED'
        },
        'compensation succeeded'
      );

      return;
    }

    const compensationTransientInput: {
      timedOut: boolean;
      networkError: boolean;
      statusCode?: number;
      retryOn409?: boolean;
    } = {
      timedOut: execution.timedOut,
      networkError: execution.networkError
    };
    if (execution.statusCode !== undefined) {
      compensationTransientInput.statusCode = execution.statusCode;
    }
    if (stepDefinition.retryPolicy.retryOn409 !== undefined) {
      compensationTransientInput.retryOn409 = stepDefinition.retryPolicy.retryOn409;
    }

    const decision = isTransientFailure(compensationTransientInput);

    const shouldRetry = decision.retryable && attemptNo < stepDefinition.retryPolicy.maxAttempts;

    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO step_attempts (run_id, step_id, attempt_no, attempt_type, status, http_status, duration_ms, error_message)
         VALUES ($1, $2, $3, 'COMPENSATION', 'FAIL', $4, $5, $6)
         ON CONFLICT (run_id, step_id, attempt_no, attempt_type)
         DO NOTHING`,
        [
          run.id,
          currentStepId,
          attemptNo,
          execution.statusCode ?? null,
          execution.durationMs,
          execution.errorMessage ?? `HTTP ${execution.statusCode ?? 'unknown'}`
        ]
      );

      await client.query(
        `UPDATE run_steps
         SET compensation_status = 'FAILED',
             compensation_error = $3
         WHERE run_id = $1 AND step_id = $2`,
        [run.id, currentStepId, execution.errorMessage ?? `HTTP ${execution.statusCode ?? 'unknown'}`]
      );
    });

    metrics.stepAttemptsTotal.inc({ stepId: currentStepId, status: 'FAIL' });

    if (shouldRetry) {
      const delay = computeBackoffMs(stepDefinition.retryPolicy, attemptNo);
      await this.scheduleCompensation(run.id, payload.queue, payload.reason, delay);
      logger.warn(
        {
          runId: run.id,
          stepId: currentStepId,
          attemptNo,
          retryInMs: delay,
          reason: decision.reason
        },
        'compensation failed, retry scheduled'
      );
      return;
    }

    await this.failRun(
      run.id,
      'COMPENSATION_FAILED',
      execution.errorMessage ?? `Compensation ${currentStepId} failed after ${attemptNo} attempts`
    );
  }

  private async scheduleCompensation(
    runId: string,
    queue: string[],
    reason: 'STEP_FAILURE' | 'CANCEL',
    delayMs: number
  ): Promise<void> {
    if (queue.length === 0) {
      await this.markRunCompensated(runId);
      return;
    }

    const payload: OutboxPayloadCompensate = { runId, queue, reason };
    const queryText =
      delayMs > 0
        ? `INSERT INTO outbox (run_id, type, payload_json, status, next_attempt_at)
           VALUES ($1, 'EXECUTE_COMPENSATION', $2, 'PENDING', ${nowPlusMs(delayMs)})`
        : `INSERT INTO outbox (run_id, type, payload_json, status, next_attempt_at)
           VALUES ($1, 'EXECUTE_COMPENSATION', $2, 'PENDING', NOW())`;

    await query(queryText, [runId, payload]);
  }

  private async markRunCompensated(runId: string): Promise<void> {
    const result = await query(
      `UPDATE workflow_runs
       SET status = 'COMPENSATED',
           updated_at = NOW()
       WHERE id = $1
         AND status <> 'COMPENSATED'`,
      [runId]
    );

    if (result.rowCount && result.rowCount > 0) {
      getMetrics().workflowRunsCompensatedTotal.inc();
    }
  }

  private async failRun(runId: string, code: string, message: string): Promise<void> {
    const result = await query(
      `UPDATE workflow_runs
       SET status = 'FAILED',
           updated_at = NOW(),
           error_code = $2,
           error_message = $3
       WHERE id = $1
         AND status <> 'FAILED'`,
      [runId, code, message]
    );

    if (result.rowCount && result.rowCount > 0) {
      getMetrics().workflowRunsFailedTotal.inc();
    }
  }
}
