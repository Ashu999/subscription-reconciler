import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildMockCarrierApp, chooseCarrierStatus } from '../../src/mock/carrier.js';

describe('mock carrier API', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('returns health and a configured carrier plan status', async () => {
    app = buildMockCarrierApp({
      chooseStatus: () => 'inactive',
      logger: false,
    });

    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok' });

    const plan = await app.inject({
      method: 'GET',
      url: '/mock/carrier/plan?userId=u_42',
    });
    expect(plan.statusCode).toBe(200);
    expect(plan.json()).toEqual({ status: 'inactive' });
  });

  it('validates the carrier plan query string', async () => {
    app = buildMockCarrierApp({
      chooseStatus: () => 'active',
      logger: false,
    });

    const missingUser = await app.inject({ method: 'GET', url: '/mock/carrier/plan' });
    expect(missingUser.statusCode).toBe(400);

    const extraProperty = await app.inject({
      method: 'GET',
      url: '/mock/carrier/plan?userId=u_42&ignored=true',
    });
    expect(extraProperty.statusCode).toBe(400);
  });

  it('maps random rolls to the documented 85/10/5 status distribution', () => {
    expect(chooseCarrierStatus(() => 0)).toBe('active');
    expect(chooseCarrierStatus(() => 0.849)).toBe('active');
    expect(chooseCarrierStatus(() => 0.85)).toBe('inactive');
    expect(chooseCarrierStatus(() => 0.949)).toBe('inactive');
    expect(chooseCarrierStatus(() => 0.95)).toBe('api_error');
  });
});
