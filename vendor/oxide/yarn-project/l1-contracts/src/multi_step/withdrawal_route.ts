import { type Address, isAddressEqual } from 'viem';

import { type BuildLane, type LaneSpec, buildFromEmptyLane, compileCalls, compilePaidLane } from './lane.js';
import type { MultiStepCall, MultiStepTransfer } from './payload.js';
import { NO_TOKEN } from './steps/step.js';

/** The payload fields the route decides. */
export type CompiledRoute = {
  transfers: MultiStepTransfer[];
  /** Undefined when the route has no remainder lane. The tips and any fixed lanes then spend everything. */
  remainderRecipient: Address | undefined;
  steps: MultiStepCall[];
};

/** Fixed lanes and call lanes run in the order declared, the remainder lane last. */
export function withdrawalRoute<Token extends Address>(p: { token: Token }) {
  return new WithdrawalRouteBuilder(p.token);
}

export class WithdrawalRouteBuilder<Token extends Address = Address> {
  /** Fixed lanes and call lanes, in the order declared. */
  private readonly lanes: RouteLane[] = [];

  constructor(private readonly token: Token) {}

  /** A lane that starts with no token, for a call. The executor pays it nothing. */
  call(build: BuildLane<NO_TOKEN>) {
    this.lanes.push({ kind: 'call', ...buildFromEmptyLane(build) });
    return this;
  }

  /** A lane that gets `amount`. */
  fixed(amount: bigint, build: BuildLane<Token>) {
    if (amount <= 0n) {
      throw new Error(`A fixed lane must have an amount above 0, got ${amount}`);
    }
    this.lanes.push({ kind: 'fixed', amount, ...buildFromEmptyLane(build) });
    return this;
  }

  /** The lane that gets the rest. Throws on a route the executor or an adapter would reject, or that leaves funds unprotected. */
  remainder(build: BuildLane<Token>) {
    return this.compile([...this.lanes, { kind: 'remainder', ...buildFromEmptyLane(build) }]);
  }

  /**
   * Closes a route whose tips and any fixed lanes spend everything. The executor reverts if something remains.
   * Throws on a route that does nothing.
   */
  noRemainder() {
    if (this.lanes.length === 0) {
      throw new Error('A route with no remainder lane needs a fixed lane or a call lane');
    }
    return this.compile(this.lanes);
  }

  private compile(lanes: readonly RouteLane[]): CompiledRoute {
    const adapters = lanes.flatMap(lane => lane.steps.map(step => step.adapter));
    const compiled = lanes.map((lane): CompiledRouteLane => {
      switch (lane.kind) {
        case 'call':
          return { kind: 'call', calls: compileCalls(lane, adapters) };
        case 'fixed':
          return { kind: 'fixed', amount: lane.amount, ...compilePaidLane(this.token, lane, adapters) };
        case 'remainder':
          return { kind: 'remainder', ...compilePaidLane(this.token, lane, adapters) };
      }
    });
    const paidAt = compiled.map(lane => (lane.kind === 'call' ? undefined : lane.paidAt));
    assertDistinctPaidAt(paidAt);
    assertNoEarlierLanePaysIntoALaterLane(this.token, lanes, paidAt);
    const last = compiled.at(-1);
    return {
      transfers: compiled.flatMap(lane =>
        lane.kind === 'fixed' ? [{ amount: lane.amount, recipient: lane.paidAt }] : [],
      ),
      remainderRecipient: last?.kind === 'remainder' ? last.paidAt : undefined,
      steps: compiled.flatMap(lane => lane.calls),
    };
  }
}

/** Fixed lanes and call lanes in the order declared, then the remainder lane. */
type RouteLane = FixedLane | RemainderLane | CallLane;

type FixedLane = LaneSpec & { kind: 'fixed'; amount: bigint };

type RemainderLane = LaneSpec & { kind: 'remainder' };

type CallLane = LaneSpec & { kind: 'call' };

/** The executor pays a fixed lane and the remainder lane at `paidAt`, and a call lane nothing. */
type CompiledRouteLane =
  | { kind: 'fixed'; amount: bigint; paidAt: Address; calls: MultiStepCall[] }
  | { kind: 'remainder'; paidAt: Address; calls: MultiStepCall[] }
  | { kind: 'call'; calls: MultiStepCall[] };

/**
 * The executor pays each lane before any step runs, so two lanes paid at one adapter are one balance there, and the
 * first step spends both.
 */
function assertDistinctPaidAt(paidAt: readonly (Address | undefined)[]) {
  for (let i = 0; i < paidAt.length; i++) {
    const at = paidAt[i];
    for (let j = i + 1; j < paidAt.length; j++) {
      const later = paidAt[j];
      if (at && later && isAddressEqual(at, later)) {
        throw new Error(
          `Lanes ${i} and ${j} are both paid at ${at}; the first step there would spend the funds of both`,
        );
      }
    }
  }
}

/**
 * The executor pays each lane before any lane runs, so no earlier lane may make or pay the token where a later lane is
 * paid.
 */
function assertNoEarlierLanePaysIntoALaterLane(
  token: Address,
  specs: readonly LaneSpec[],
  paidAt: readonly (Address | undefined)[],
) {
  for (let i = 0; i < specs.length; i++) {
    const laterPaidAt = paidAt.slice(i + 1).filter(at => at !== undefined);
    const steps = specs[i].steps;
    for (let s = 0; s < steps.length; s++) {
      const step = steps[s];
      const holders = [step.adapter, steps[s + 1]?.adapter];
      const at = holders.find(holder => holder && laterPaidAt.some(later => isAddressEqual(later, holder)));
      if (at && isAddressEqual(step.out, token)) {
        throw new Error(`Lane ${i} puts ${token} on the adapter ${at}, where a later lane is paid`);
      }
    }
  }
}
