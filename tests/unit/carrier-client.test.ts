import { describe, expect, it } from 'vitest';

import { HttpCarrierClient } from '../../src/clients/carrier.js';

describe('HttpCarrierClient', () => {
  it('returns carrier statuses from valid 2xx responses and builds the expected URL', async () => {
    const requestedUrls: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      requestedUrls.push(String(url));
      return jsonResponse({ status: 'inactive' });
    };
    const client = new HttpCarrierClient({
      baseUrl: 'http://carrier.example/',
      timeoutMs: 100,
      fetchImpl,
    });

    await expect(client.getPlan('user 42')).resolves.toEqual({ status: 'inactive' });
    expect(requestedUrls).toEqual(['http://carrier.example/mock/carrier/plan?userId=user+42']);
  });

  it('returns api_error for non-2xx responses and invalid response bodies', async () => {
    const nonOkClient = new HttpCarrierClient({
      baseUrl: 'http://carrier.example',
      timeoutMs: 100,
      fetchImpl: async () => jsonResponse({ status: 'active' }, { status: 503 }),
    });
    await expect(nonOkClient.getPlan('user_non_ok')).resolves.toEqual({ status: 'api_error' });

    const invalidBodyClient = new HttpCarrierClient({
      baseUrl: 'http://carrier.example',
      timeoutMs: 100,
      fetchImpl: async () => jsonResponse({ status: 'unknown' }),
    });
    await expect(invalidBodyClient.getPlan('user_bad_body')).resolves.toEqual({
      status: 'api_error',
    });
  });

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

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      'content-type': 'application/json',
      ...init.headers,
    },
  });
}
