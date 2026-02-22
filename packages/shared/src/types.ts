export type RunStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'COMPENSATING'
  | 'COMPENSATED'
  | 'CANCELLED';

export type StepStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'COMPENSATED'
  | 'SKIPPED';

export type CompensationStatus = 'PENDING' | 'RUNNING' | 'COMPENSATED' | 'FAILED' | 'SKIPPED';

export type OutboxStatus = 'PENDING' | 'IN_FLIGHT' | 'DONE' | 'FAILED';

export type OutboxType = 'EXECUTE_STEP' | 'EXECUTE_COMPENSATION';

export interface RetryPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
  jitter: number;
  retryOn409?: boolean;
}

export interface HttpRequestSpec {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

export interface StepDefinition {
  stepId: string;
  action: HttpRequestSpec;
  compensation?: HttpRequestSpec;
  timeoutMs: number;
  retryPolicy: RetryPolicy;
  idempotencyScope: 'run' | 'step';
  onFailure: 'compensate' | 'halt';
}

export interface WorkflowDefinition {
  name: string;
  version: string;
  steps: StepDefinition[];
}

export interface RunContext {
  tenantId?: string;
  correlationId?: string;
  [key: string]: unknown;
}

export interface StartRunRequest {
  version: string;
  input: Record<string, unknown>;
  context?: RunContext;
}

export interface OutboxPayloadExecuteStep {
  runId: string;
  stepId: string;
  scheduledBy: 'START' | 'NEXT_STEP' | 'RETRY' | 'MANUAL_RETRY';
}

export interface OutboxPayloadCompensate {
  runId: string;
  queue: string[];
  reason: 'STEP_FAILURE' | 'CANCEL';
}

export interface OutboxRecord {
  id: number;
  run_id: string;
  type: OutboxType;
  payload_json: OutboxPayloadExecuteStep | OutboxPayloadCompensate;
  status: OutboxStatus;
  attempts: number;
  next_attempt_at: Date;
  lock_owner: string | null;
  lock_acquired_at: Date | null;
  created_at: Date;
}

export interface RunStepView {
  stepId: string;
  status: StepStatus;
  attempts: number;
  lastError: string | null;
  startedAt: string | null;
  endedAt: string | null;
  compensationStatus: CompensationStatus;
  compensationAttempts: number;
  compensationError: string | null;
}
