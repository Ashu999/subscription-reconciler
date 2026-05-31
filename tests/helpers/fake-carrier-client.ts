import type {
  CarrierClient,
  CarrierPlanResult,
  CarrierPlanStatus,
} from '../../src/clients/carrier.js';

export type FakeCarrierOutcome = CarrierPlanStatus | Error;

export interface FakeCarrierClientOptions {
  defaultOutcome?: FakeCarrierOutcome;
  delayMs?: number;
}

export class FakeCarrierClient implements CarrierClient {
  readonly calls: string[] = [];

  maxInFlight = 0;

  private readonly outcomes: ReadonlyMap<string, FakeCarrierOutcome>;
  private readonly defaultOutcome: FakeCarrierOutcome;
  private readonly delayMs: number;
  private inFlight = 0;

  constructor(
    outcomes: ReadonlyMap<string, FakeCarrierOutcome> = new Map(),
    options: FakeCarrierClientOptions = {},
  ) {
    this.outcomes = outcomes;
    this.defaultOutcome = options.defaultOutcome ?? 'active';
    this.delayMs = options.delayMs ?? 0;
  }

  async getPlan(userId: string): Promise<CarrierPlanResult> {
    this.calls.push(userId);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);

    try {
      if (this.delayMs > 0) {
        await sleep(this.delayMs);
      }

      const outcome = this.outcomes.get(userId) ?? this.defaultOutcome;
      if (outcome instanceof Error) {
        throw outcome;
      }

      return { status: outcome };
    } finally {
      this.inFlight -= 1;
    }
  }
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}
