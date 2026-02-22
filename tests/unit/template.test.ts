import { describe, expect, it } from 'vitest';
import { renderTemplate } from '@sagaflow/shared';

describe('template rendering', () => {
  it('renders nested template values', () => {
    const result = renderTemplate(
      {
        message: 'Order {{input.orderId}} for {{context.tenantId}}',
        amount: '{{input.amount}}',
        nested: {
          run: '{{run.id}}'
        }
      },
      {
        input: { orderId: 'o-1', amount: 120 },
        context: { tenantId: 'acme' },
        run: { id: 'run-123' }
      }
    );

    expect(result).toEqual({
      message: 'Order o-1 for acme',
      amount: '120',
      nested: { run: 'run-123' }
    });
  });
});
