import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
  type LabelValues
} from 'prom-client';

export interface SagaMetrics {
  registry: Registry;
  workflowRunsStartedTotal: Counter;
  workflowRunsCompletedTotal: Counter;
  workflowRunsFailedTotal: Counter;
  workflowRunsCompensatedTotal: Counter;
  stepAttemptsTotal: Counter<'stepId' | 'status'>;
  stepLatencyMs: Histogram<'stepId'>;
  outboxBacklogTotal: Gauge;
  outboxLagSeconds: Gauge;
}

export interface MetricsSetters {
  setOutbox(backlog: number, lagSeconds: number): void;
  incStepAttempt(stepId: string, status: string): void;
}

let metricsCache: SagaMetrics | undefined;

export function getMetrics(): SagaMetrics {
  if (metricsCache) {
    return metricsCache;
  }

  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  metricsCache = {
    registry,
    workflowRunsStartedTotal: new Counter({
      name: 'workflow_runs_started_total',
      help: 'Total started workflow runs',
      registers: [registry]
    }),
    workflowRunsCompletedTotal: new Counter({
      name: 'workflow_runs_completed_total',
      help: 'Total completed workflow runs',
      registers: [registry]
    }),
    workflowRunsFailedTotal: new Counter({
      name: 'workflow_runs_failed_total',
      help: 'Total failed workflow runs',
      registers: [registry]
    }),
    workflowRunsCompensatedTotal: new Counter({
      name: 'workflow_runs_compensated_total',
      help: 'Total compensated workflow runs',
      registers: [registry]
    }),
    stepAttemptsTotal: new Counter({
      name: 'step_attempts_total',
      help: 'Total step attempts by step and status',
      labelNames: ['stepId', 'status'],
      registers: [registry]
    }),
    stepLatencyMs: new Histogram({
      name: 'step_latency_ms',
      help: 'Step execution latency in milliseconds',
      labelNames: ['stepId'],
      buckets: [10, 50, 100, 300, 500, 1000, 2000, 5000, 10000],
      registers: [registry]
    }),
    outboxBacklogTotal: new Gauge({
      name: 'outbox_backlog_total',
      help: 'Pending outbox entries',
      registers: [registry]
    }),
    outboxLagSeconds: new Gauge({
      name: 'outbox_lag_seconds',
      help: 'Lag in seconds for oldest pending outbox entry',
      registers: [registry]
    })
  };

  return metricsCache;
}

export function createMetricHelpers(): MetricsSetters {
  const metrics = getMetrics();
  return {
    setOutbox(backlog: number, lagSeconds: number) {
      metrics.outboxBacklogTotal.set(backlog);
      metrics.outboxLagSeconds.set(lagSeconds);
    },
    incStepAttempt(stepId: string, status: string) {
      metrics.stepAttemptsTotal.inc({ stepId, status } as LabelValues<'stepId' | 'status'>);
    }
  };
}
