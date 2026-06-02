import { pathToFileURL } from 'node:url';
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
 * What: Build the mock carrier API used by the poller.
 * Why: Tests should exercise the endpoint contract without importing this module causing
 * a listening server to start as a side effect.
 */
export function buildMockCarrierApp(
  options: { chooseStatus?: () => CarrierStatus; logger?: boolean } = {},
) {
  const chooseStatus = options.chooseStatus ?? (() => chooseCarrierStatus());
  const app = Fastify({
    logger: options.logger ?? true,
    ajv: {
      customOptions: {
        coerceTypes: false,
        removeAdditional: false,
      },
    },
  });

  app.get('/health', async () => ({ status: 'ok' }));
  app.get<{ Querystring: { userId: string } }>(
    '/mock/carrier/plan',
    { schema: { querystring: querySchema } },
    async () => ({ status: chooseStatus() }),
  );

  return app;
}

/**
 * What: Start the mock carrier API used by the poller.
 * Why: Local and Docker runs need a running endpoint without depending on a real
 * carrier integration.
 */
export async function startMockCarrier(): Promise<void> {
  const config = readMockCarrierConfig();
  const app = buildMockCarrierApp({
    logger: config.nodeEnv !== 'test',
  });

  await app.listen({ host: config.mockCarrierHost, port: config.mockCarrierPort });
}

/**
 * What: Randomly choose a mock carrier plan status.
 * Why: Poller behavior should exercise active, inactive, and retryable API-error paths
 * during local runs.
 */
export function chooseCarrierStatus(random: () => number = Math.random): CarrierStatus {
  const roll = random();
  if (roll < 0.85) {
    return 'active';
  }

  if (roll < 0.95) {
    return 'inactive';
  }

  return 'api_error';
}

if (isMainModule()) {
  // Surface startup failures to container logs while letting Node exit with failure.
  startMockCarrier().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

/**
 * What: Detect whether this file is the current Node entrypoint.
 * Why: ES modules do not have require.main, so direct execution needs URL comparison.
 */
function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
}
