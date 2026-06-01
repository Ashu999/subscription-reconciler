import { describe, expect, it } from 'vitest';

import { HttpCarrierClient } from '../../src/clients/carrier.js';

describe('HttpCarrierClient', () => {
  it('returns api_error when the request is aborted by the timeout', async () => {
    let abortObserved = false;
    const fetchImpl: typeof fetch = async (_url, init) => {
      const signal = init?.signal;
      if (!(signal instanceof AbortSignal)) {
        throw new Error('expected carrier fetch to receive an abort signal');
      }

      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            abortObserved = true;
            reject(new Error('carrier request aborted'));
          },
          { once: true },
        );
      });
    };
    const client = new HttpCarrierClient({
      baseUrl: 'http://carrier.example',
      timeoutMs: 1,
      fetchImpl,
    });

    await expect(client.getPlan('user_timeout')).resolves.toEqual({ status: 'api_error' });
    expect(abortObserved).toBe(true);
  });
});
