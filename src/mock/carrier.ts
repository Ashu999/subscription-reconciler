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

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
