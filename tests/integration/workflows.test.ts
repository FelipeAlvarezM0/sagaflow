import { describe, expect, it } from 'vitest';

const baseUrl = process.env.INTEGRATION_BASE_URL;
const inventoryUrl = process.env.INTEGRATION_INVENTORY_URL;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTerminal(runId: string): Promise<{ status: string; payload: unknown }> {
  if (!baseUrl) {
    throw new Error('baseUrl missing');
  }

  for (let i = 0; i < 60; i += 1) {
    const response = await fetch(`${baseUrl}/v1/runs/${runId}`);
    const payload = (await response.json()) as { run: { status: string } };
    const status = payload.run.status;

    if (['COMPLETED', 'FAILED', 'COMPENSATED', 'CANCELLED'].includes(status)) {
      return { status, payload };
    }

    await sleep(500);
  }

  throw new Error(`run ${runId} did not reach terminal status`);
}

const integration = baseUrl ? describe : describe.skip;

integration('workflow integration', () => {
  it('completes order workflow', async () => {
    const response = await fetch(`${baseUrl}/v1/workflows/order-processing/start`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-correlation-id': 'integration-success'
      },
      body: JSON.stringify({
        version: '1.0.0',
        input: {
          orderId: 'it-success-1',
          amount: 100,
          sku: 'sku-1',
          email: 'it@example.com'
        },
        context: {
          tenantId: 'acme',
          correlationId: 'integration-success'
        }
      })
    });

    expect(response.status).toBe(202);
    const body = (await response.json()) as { runId: string };

    const terminal = await waitForTerminal(body.runId);
    expect(terminal.status).toBe('COMPLETED');
  });

  it('compensates when inventory fails', async () => {
    if (!inventoryUrl) {
      throw new Error('INTEGRATION_INVENTORY_URL is required');
    }

    await fetch(`${inventoryUrl}/admin/failure`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ failRate: 0, failOnce: true, failEndpoints: ['reserve-inventory'] })
    });

    const response = await fetch(`${baseUrl}/v1/workflows/order-processing/start`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-correlation-id': 'integration-comp'
      },
      body: JSON.stringify({
        version: '1.0.0',
        input: {
          orderId: 'it-comp-1',
          amount: 100,
          sku: 'sku-2',
          email: 'it@example.com'
        },
        context: {
          tenantId: 'acme',
          correlationId: 'integration-comp'
        }
      })
    });

    expect(response.status).toBe(202);
    const body = (await response.json()) as { runId: string };

    const terminal = await waitForTerminal(body.runId);
    expect(terminal.status).toBe('COMPENSATED');

    await fetch(`${inventoryUrl}/admin/failure`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ failRate: 0, failOnce: false, failEndpoints: [] })
    });
  });
});
