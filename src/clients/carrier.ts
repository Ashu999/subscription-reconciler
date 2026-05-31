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

export class HttpCarrierClient implements CarrierClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpCarrierClientOptions) {
    this.baseUrl = options.baseUrl;
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

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

function isCarrierPlanResponseBody(value: unknown): value is CarrierPlanResponseBody {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const status = Reflect.get(value, 'status');
  return status === 'active' || status === 'inactive' || status === 'api_error';
}
