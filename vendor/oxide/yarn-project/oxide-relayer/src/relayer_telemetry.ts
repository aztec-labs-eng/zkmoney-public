// Relayer metrics: application code calls these methods instead of OpenTelemetry types directly.
// Methods do not throw. With no OTLP endpoint configured, recording is a no-op.
import { Attributes, type Counter, type Meter, Metrics, type TelemetryClient } from '@oxide/telemetry';

export type RelayerSubsystem = NonNullable<(typeof Attributes.RELAYER_SUBSYSTEM)['_value']>;
export type RelayerOutcome = NonNullable<(typeof Attributes.RELAYER_OUTCOME)['_value']>;
export type RelayerDeferReason = NonNullable<(typeof Attributes.RELAYER_DEFER_REASON)['_value']>;
export type RelayerStream = NonNullable<(typeof Attributes.RELAYER_STREAM)['_value']>;

export class RelayerTelemetry {
  private readonly meter: Meter;
  private readonly l1OperationCount: Counter<typeof Metrics.RELAYER_L1_OPERATION_COUNT>;
  private readonly gasSpent: Counter<typeof Metrics.RELAYER_GAS_SPENT>;
  /** Epoch ms of each stream's last successful poll; the age gauge reads it at every export. */
  private readonly watcherPolls = new Map<RelayerStream, number>();
  constructor(
    client: TelemetryClient,
    private readonly clock: () => number = Date.now,
  ) {
    this.meter = client.getMeter('oxide-relayer');
    this.l1OperationCount = this.meter.createCounter(Metrics.RELAYER_L1_OPERATION_COUNT);
    this.gasSpent = this.meter.createCounter(Metrics.RELAYER_GAS_SPENT);
    this.meter.createObservableGauge(Metrics.RELAYER_WATCHER_AGE, result => {
      for (const [stream, polledAt] of this.watcherPolls) {
        result.observe((this.clock() - polledAt) / 1000, { [Attributes.RELAYER_STREAM.name]: stream });
      }
    });
  }

  /** Seed with the process start so a stream that never completes a poll still exports a growing age. */
  watcherStarted(stream: RelayerStream): void {
    if (!this.watcherPolls.has(stream)) {
      this.watcherPolls.set(stream, this.clock());
    }
  }

  watcherPolled(stream: RelayerStream): void {
    this.watcherPolls.set(stream, this.clock());
  }

  l1OperationOutcome(outcome: RelayerOutcome, deferReason?: RelayerDeferReason): void {
    this.l1OperationCount.add(1, outcomeAttributes(outcome, deferReason));
  }

  gasSpentWei(subsystem: RelayerSubsystem, wei: bigint): void {
    if (wei > 0n) {
      this.gasSpent.add(Number(wei) / 1e18, { [Attributes.RELAYER_SUBSYSTEM.name]: subsystem });
    }
  }

  observeSignerBalance(readBalanceWei: () => Promise<bigint>): void {
    this.meter.createObservableGauge(Metrics.RELAYER_ETH_BALANCE, async result => {
      result.observe(Number(await readBalanceWei()) / 1e18);
    });
  }

  observeSdnListAge(lastRefreshedAt: () => Date): void {
    this.meter.createObservableGauge(Metrics.RELAYER_SDN_LIST_AGE, result => {
      result.observe((this.clock() - lastRefreshedAt().getTime()) / 1000);
    });
  }

  observeL1OperationBacklog(countPending: () => Promise<number>): void {
    this.meter.createObservableGauge(Metrics.RELAYER_L1_OPERATION_PENDING, async result => {
      result.observe(await countPending());
    });
  }

  /** Separate from the pending backlog: a waiting operation costs a row, never a simulation. */
  observeL1OperationWaiting(countWaiting: () => Promise<number>): void {
    this.meter.createObservableGauge(Metrics.RELAYER_L1_OPERATION_WAITING, async result => {
      result.observe(await countWaiting());
    });
  }
}

function outcomeAttributes(outcome: RelayerOutcome, deferReason?: RelayerDeferReason) {
  return {
    [Attributes.RELAYER_OUTCOME.name]: outcome,
    ...(deferReason !== undefined ? { [Attributes.RELAYER_DEFER_REASON.name]: deferReason } : {}),
  };
}
