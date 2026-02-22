import dotenv from 'dotenv';
import { Client } from 'pg';
import type { WorkflowDefinition } from '@sagaflow/shared';

dotenv.config();

function baseUrls() {
  return {
    payments: process.env.PAYMENTS_BASE_URL ?? 'http://localhost:3001',
    inventory: process.env.INVENTORY_BASE_URL ?? 'http://localhost:3002',
    notifications: process.env.NOTIFICATIONS_BASE_URL ?? 'http://localhost:3003'
  };
}

function workflows(): WorkflowDefinition[] {
  const urls = baseUrls();

  return [
    {
      name: 'order-processing',
      version: '1.0.0',
      steps: [
        {
          stepId: 'charge-payment',
          action: {
            method: 'POST',
            url: `${urls.payments}/charge-payment`,
            body: {
              orderId: '{{input.orderId}}',
              amount: '{{input.amount}}'
            }
          },
          compensation: {
            method: 'POST',
            url: `${urls.payments}/refund-payment`,
            body: {
              orderId: '{{input.orderId}}',
              amount: '{{input.amount}}'
            }
          },
          timeoutMs: 2000,
          retryPolicy: {
            maxAttempts: 3,
            initialDelayMs: 300,
            maxDelayMs: 5000,
            multiplier: 2,
            jitter: 0.2
          },
          idempotencyScope: 'step',
          onFailure: 'compensate'
        },
        {
          stepId: 'reserve-inventory',
          action: {
            method: 'POST',
            url: `${urls.inventory}/reserve-inventory`,
            body: {
              orderId: '{{input.orderId}}',
              sku: '{{input.sku}}'
            }
          },
          compensation: {
            method: 'POST',
            url: `${urls.inventory}/release-inventory`,
            body: {
              orderId: '{{input.orderId}}',
              sku: '{{input.sku}}'
            }
          },
          timeoutMs: 2000,
          retryPolicy: {
            maxAttempts: 3,
            initialDelayMs: 300,
            maxDelayMs: 5000,
            multiplier: 2,
            jitter: 0.2
          },
          idempotencyScope: 'step',
          onFailure: 'compensate'
        },
        {
          stepId: 'send-confirmation-email',
          action: {
            method: 'POST',
            url: `${urls.notifications}/send-confirmation-email`,
            body: {
              orderId: '{{input.orderId}}',
              email: '{{input.email}}'
            }
          },
          timeoutMs: 2000,
          retryPolicy: {
            maxAttempts: 2,
            initialDelayMs: 200,
            maxDelayMs: 2000,
            multiplier: 2,
            jitter: 0.1
          },
          idempotencyScope: 'step',
          onFailure: 'halt'
        }
      ]
    },
    {
      name: 'refund-flow',
      version: '1.0.0',
      steps: [
        {
          stepId: 'validate-refund',
          action: {
            method: 'POST',
            url: `${urls.payments}/validate-refund`,
            body: {
              orderId: '{{input.orderId}}',
              reason: '{{input.reason}}'
            }
          },
          timeoutMs: 2000,
          retryPolicy: {
            maxAttempts: 2,
            initialDelayMs: 200,
            maxDelayMs: 2000,
            multiplier: 2,
            jitter: 0.1
          },
          idempotencyScope: 'step',
          onFailure: 'halt'
        },
        {
          stepId: 'refund-payment',
          action: {
            method: 'POST',
            url: `${urls.payments}/refund-payment`,
            body: {
              orderId: '{{input.orderId}}',
              amount: '{{input.amount}}'
            }
          },
          timeoutMs: 2000,
          retryPolicy: {
            maxAttempts: 3,
            initialDelayMs: 300,
            maxDelayMs: 5000,
            multiplier: 2,
            jitter: 0.2
          },
          idempotencyScope: 'step',
          onFailure: 'halt'
        },
        {
          stepId: 'notify-customer',
          action: {
            method: 'POST',
            url: `${urls.notifications}/notify-customer`,
            body: {
              orderId: '{{input.orderId}}',
              type: 'refund'
            }
          },
          timeoutMs: 2000,
          retryPolicy: {
            maxAttempts: 2,
            initialDelayMs: 200,
            maxDelayMs: 2000,
            multiplier: 2,
            jitter: 0.1
          },
          idempotencyScope: 'step',
          onFailure: 'halt'
        }
      ]
    },
    {
      name: 'invoice-issuance',
      version: '1.0.0',
      steps: [
        {
          stepId: 'create-invoice',
          action: {
            method: 'POST',
            url: `${urls.notifications}/create-invoice`,
            body: {
              orderId: '{{input.orderId}}',
              amount: '{{input.amount}}'
            }
          },
          compensation: {
            method: 'POST',
            url: `${urls.notifications}/archive`,
            body: {
              orderId: '{{input.orderId}}',
              kind: 'invoice-draft'
            }
          },
          timeoutMs: 2000,
          retryPolicy: {
            maxAttempts: 3,
            initialDelayMs: 300,
            maxDelayMs: 5000,
            multiplier: 2,
            jitter: 0.2
          },
          idempotencyScope: 'step',
          onFailure: 'compensate'
        },
        {
          stepId: 'emit-fiscal-doc',
          action: {
            method: 'POST',
            url: `${urls.notifications}/emit-fiscal-doc`,
            body: {
              orderId: '{{input.orderId}}',
              amount: '{{input.amount}}'
            }
          },
          compensation: {
            method: 'POST',
            url: `${urls.notifications}/archive`,
            body: {
              orderId: '{{input.orderId}}',
              kind: 'fiscal-doc'
            }
          },
          timeoutMs: 2000,
          retryPolicy: {
            maxAttempts: 3,
            initialDelayMs: 300,
            maxDelayMs: 5000,
            multiplier: 2,
            jitter: 0.2
          },
          idempotencyScope: 'step',
          onFailure: 'compensate'
        },
        {
          stepId: 'archive',
          action: {
            method: 'POST',
            url: `${urls.notifications}/archive`,
            body: {
              orderId: '{{input.orderId}}',
              kind: 'final'
            }
          },
          timeoutMs: 2000,
          retryPolicy: {
            maxAttempts: 2,
            initialDelayMs: 200,
            maxDelayMs: 2000,
            multiplier: 2,
            jitter: 0.1
          },
          idempotencyScope: 'step',
          onFailure: 'halt'
        }
      ]
    }
  ];
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    for (const wf of workflows()) {
      await client.query(
        `INSERT INTO workflow_definitions (name, version, definition_json)
         VALUES ($1, $2, $3)
         ON CONFLICT (name, version)
         DO UPDATE SET definition_json = EXCLUDED.definition_json`,
        [wf.name, wf.version, wf]
      );
      console.log(`seeded ${wf.name}@${wf.version}`);
    }
  } finally {
    await client.end();
  }
}

await main();
