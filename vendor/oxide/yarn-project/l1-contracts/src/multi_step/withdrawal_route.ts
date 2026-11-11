import { type Address, isAddressEqual } from 'viem';

import { type BuildLane, type CompiledLane, LaneBuilder, type LaneSpec, compileLane, laneSteps } from './lane.js';
import type { MultiStepCall, MultiStepTransfer } from './payload.js';

/** The payload fields the route decides. */
export type CompiledRoute = {
  transfers: MultiStepTransfer[];
  remainderRecipient: Address;
  steps: MultiStepCall[];
};

/** Fixed lanes run in order, the remainder lane last. */
export function withdrawalRoute<Token extends Address>(p: { token: Token }) {
  return new WithdrawalRouteBuilder(p.token);
}

export class WithdrawalRouteBuilder<Token extends Address = Address> {
  private readonly fixedLanes: (LaneSpec & { amount: bigint })[] = [];

  constructor(private readonly token: Token) {}

  /** A lane that gets `amount`. */
  fixed(amount: bigint, build: BuildLane<Token>) {
    if (amount <= 0n) {
      throw new Error(`A fixed lane must have an amount above 0, got ${amount}`);
    }
    this.fixedLanes.push({ amount, ...build(new LaneBuilder<Token>([])) });
    return this;
  }

  /** The lane that gets the rest. Throws on a route the executor or an adapter would reject, or that leaves funds unprotected. */
  remainder(build: BuildLane<Token>) {
    const specs = [...this.fixedLanes, build(new LaneBuilder<Token>([]))];
    const adapters = specs.flatMap(spec => laneSteps(spec).map(step => step.adapter));
    const lanes = specs.map(spec => compileLane(this.token, spec, adapters));
    assertDistinctStarts(lanes);
    assertNoTokenIntoALaterStart(this.token, specs, lanes);
    return {
      transfers: this.fixedLanes.map((fixed, i) => ({ amount: fixed.amount, recipient: lanes[i].start })),
      remainderRecipient: lanes[lanes.length - 1].start,
      steps: lanes.flatMap(lane => lane.calls),
    };
  }
}

/** The executor pays each lane to its start before any step runs, so two lanes with one start are one balance there, and the first step spends both. */
function assertDistinctStarts(lanes: readonly CompiledLane[]) {
  for (let i = 0; i < lanes.length; i++) {
    for (let j = i + 1; j < lanes.length; j++) {
      if (isAddressEqual(lanes[i].start, lanes[j].start)) {
        throw new Error(
          `Lanes ${i} and ${j} both start at ${lanes[i].start}; the first step there would spend the funds of both`,
        );
      }
    }
  }
}

/** The executor pays each lane at its start before any lane runs, so no earlier lane may make or pay the token there. */
function assertNoTokenIntoALaterStart(token: Address, specs: readonly LaneSpec[], lanes: readonly CompiledLane[]) {
  for (let i = 0; i < specs.length; i++) {
    const laterStarts = lanes.slice(i + 1).map(lane => lane.start);
    const steps = laneSteps(specs[i]);
    for (let s = 0; s < specs[i].steps.length; s++) {
      const step = specs[i].steps[s];
      const holders = [step.adapter, steps[s + 1]?.adapter];
      const start = holders.find(holder => holder && laterStarts.some(start => isAddressEqual(start, holder)));
      if (start && isAddressEqual(step.out, token)) {
        throw new Error(`Lane ${i} puts ${token} on the adapter ${start}, where a later lane starts`);
      }
    }
  }
}
