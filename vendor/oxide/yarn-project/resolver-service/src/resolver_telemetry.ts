import { Attributes, type Counter, type Histogram, type Meter, Metrics, type TelemetryClient } from '@oxide/telemetry';

export type ResolveOutcome = NonNullable<(typeof Attributes.RESOLVER_OUTCOME)['_value']>;

const FLUSH_TIMEOUT_MS = 500;

export class ResolverTelemetry {
  private readonly meter: Meter;
  private readonly resolveCount: Counter<typeof Metrics.RESOLVER_RESOLVE_COUNT>;
  private readonly resolveDuration: Histogram<typeof Metrics.RESOLVER_RESOLVE_DURATION>;
  private readonly proofDurationHistogram: Histogram<typeof Metrics.RESOLVER_PROOF_DURATION>;

  constructor(private readonly client: TelemetryClient) {
    this.meter = client.getMeter('oxide-resolver');
    this.resolveCount = this.meter.createCounter(Metrics.RESOLVER_RESOLVE_COUNT);
    this.resolveDuration = this.meter.createHistogram(Metrics.RESOLVER_RESOLVE_DURATION);
    this.proofDurationHistogram = this.meter.createHistogram(Metrics.RESOLVER_PROOF_DURATION);
  }

  resolveCompleted(outcome: ResolveOutcome, durationSeconds: number): void {
    const attributes = { [Attributes.RESOLVER_OUTCOME.name]: outcome };
    this.resolveCount.add(1, attributes);
    this.resolveDuration.record(durationSeconds, attributes);
  }

  proofGenerated(durationSeconds: number): void {
    this.proofDurationHistogram.record(durationSeconds);
  }

  async flushBounded(): Promise<void> {
    await Promise.race([
      this.client.flush(),
      new Promise<void>(resolve => setTimeout(resolve, FLUSH_TIMEOUT_MS).unref()),
    ]);
  }
}
