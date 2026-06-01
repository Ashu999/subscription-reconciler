import Fastify from 'fastify';

import { readMockCarrierConfig } from '../config.js';

type CarrierStatus = 'active' | 'inactive' | 'api_error';

const querySchema = {
  type: 'object',
  required: ['userId'],
  additionalProperties: false,
  properties: {
    userId: { type: 'string', minLength: 1 },
  },
} as const;

/**
 * What: Start the mock carrier API used by the poller.
 * Why: Local and Docker runs need a deterministic endpoint shape without depending on
 * a real carrier integration.
 */
async function main(): Promise<void> {
  const config = readMockCarrierConfig();
  const app = Fastify({
    logger: config.nodeEnv !== 'test',
  });

  app.get('/health', async () => ({ status: 'ok' }));
  app.get<{ Querystring: { userId: string } }>(
    '/mock/carrier/plan',
    { schema: { querystring: querySchema } },
    async () => ({ status: chooseCarrierStatus() }),
  );

  await app.listen({ host: config.mockCarrierHost, port: config.mockCarrierPort });
}

/**
 * What: Randomly choose a mock carrier plan status.
 * Why: Poller behavior should exercise active, inactive, and retryable API-error paths
 * during local runs.
 */
function chooseCarrierStatus(): CarrierStatus {
  const roll = Math.random();
  if (roll < 0.85) {
    return 'active';
  }

  if (roll < 0.95) {
    return 'inactive';
  }

  return 'api_error';
}

// Surface startup failures to container logs while letting Node exit with failure.
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
