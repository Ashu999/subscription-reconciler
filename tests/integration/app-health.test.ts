import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { IntegrationHarness } from '../helpers/integration.js';
import { createIntegrationHarness, requireHarness } from '../helpers/integration.js';

describe('GET /health', () => {
  let harness: IntegrationHarness | undefined;

  beforeAll(async () => {
    harness = await createIntegrationHarness();
  }, 120_000);

  afterAll(async () => {
    await harness?.stop();
  });

  it('returns ok after confirming database connectivity', async () => {
    const response = await requireHarness(harness).app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});
