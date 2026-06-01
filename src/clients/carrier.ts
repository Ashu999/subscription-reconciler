export type CarrierPlanStatus = 'active' | 'inactive' | 'api_error';

export interface CarrierPlanResult {
  status: CarrierPlanStatus;
}

export interface CarrierClient {
  getPlan(userId: string): Promise<CarrierPlanResult>;
}

export interface HttpCarrierClientOptions {
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

interface CarrierPlanResponseBody {
  status: CarrierPlanStatus;
}

/**
 * What: Fetch carrier plan status through the HTTP mock-compatible API.
 * Why: The poller should depend on a small client interface that turns network,
 * timeout, and response-shape failures into retryable api_error outcomes.
 */
export class HttpCarrierClient implements CarrierClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpCarrierClientOptions) {
    this.baseUrl = options.baseUrl;
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * What: Read the current plan status for one user.
   * Why: Carrier state is external and can fail independently, so callers receive a
   * domain status instead of transport exceptions.
   */
  async getPlan(userId: string): Promise<CarrierPlanResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      const url = new URL('/mock/carrier/plan', `${this.baseUrl}/`);
      url.searchParams.set('userId', userId);

      const response = await this.fetchImpl(url, { signal: controller.signal });
      if (!response.ok) {
        // Treat non-2xx responses like carrier uncertainty so the poller can retry
        // without revoking access based on a bad response.
        return { status: 'api_error' };
      }

      const body: unknown = await response.json();
      if (!isCarrierPlanResponseBody(body)) {
        return { status: 'api_error' };
      }

      return { status: body.status };
    } catch {
      return { status: 'api_error' };
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * What: Validate the carrier response body at runtime.
 * Why: JSON from another service is untyped, and invalid statuses should be retried
 * instead of trusted as entitlement state.
 */
function isCarrierPlanResponseBody(value: unknown): value is CarrierPlanResponseBody {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const status = Reflect.get(value, 'status');
  return status === 'active' || status === 'inactive' || status === 'api_error';
}
