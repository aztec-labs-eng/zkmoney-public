import { type Address, isAddressEqual, maxUint256, zeroAddress } from 'viem';

import type { MultiStepCall } from './payload.js';
import { NO_TOKEN, type Step, UNBOUNDED } from './steps/step.js';

/** The steps of a lane, and the recipient of what the last step pays. */
export type LaneSpec = {
  steps: Step[];
  /** Undefined when the lane ends with `end`. */
  recipient: Address | undefined;
};

export type BuildLane<Token extends Address = Address> = (lane: LaneBuilder<Token>) => LaneSpec;

/** Ends at an address with `to`, or with `end` at a step that puts out `NO_TOKEN`. */
export class LaneBuilder<Token extends Address = Address> {
  constructor(private readonly steps: Step[]) {}

  step<In extends Address, Out extends Address>(
    s: Takes<Token, In> extends true ? Step<In, Out> : Step<Token, Out>,
  ): LaneBuilder<Out> {
    return new LaneBuilder<Out>([...this.steps, s]);
  }

  to(recipient: Recipient<Token>): LaneSpec {
    return { steps: this.steps, recipient };
  }

  end<In extends Address>(s: Takes<Token, In> extends true ? Step<In, NO_TOKEN> : Step<Token, NO_TOKEN>): LaneSpec {
    return { steps: [...this.steps, s], recipient: undefined };
  }
}

export function buildFromEmptyLane<Token extends Address>(build: BuildLane<Token>): LaneSpec {
  return build(new LaneBuilder<Token>([]));
}

/**
 * Checks a lane that is paid `token` before its steps run, and encodes its calls. The lane is paid at its first
 * adapter, or at the recipient when there is no step. A recipient must not be one of `adapters`.
 */
export function compilePaidLane(token: Address, lane: LaneSpec, adapters: readonly Address[]) {
  const calls = encodeCheckedLane(token, lane, adapters);
  const paidAt = lane.steps[0]?.adapter ?? lane.recipient;
  if (paidAt === undefined) {
    throw new Error('A lane needs a step or a recipient');
  }
  return { paidAt, calls };
}

/** Checks a call lane and encodes its calls. The executor pays it nothing. */
export function compileCalls(lane: LaneSpec, adapters: readonly Address[]): MultiStepCall[] {
  if (lane.steps.length === 0) {
    throw new Error('A call lane needs a step');
  }
  return encodeCheckedLane(NO_TOKEN, lane, adapters);
}

/** True unless both are literals and differ. On a mismatch the parameter falls back to `Token`, so the error names both. */
type Takes<Token extends Address, In extends Address> = [Token] extends [In]
  ? true
  : [In] extends [Token]
    ? true
    : false;

/** `never` on a lane of `NO_TOKEN`, which has nothing to pay, so it ends with `end`. */
type Recipient<Token extends Address> = [Token] extends [NO_TOKEN] ? never : Address;

function encodeCheckedLane(token: Address, lane: LaneSpec, adapters: readonly Address[]) {
  assertOutputIsBounded(lane);
  let currentToken: Address = token;
  for (const step of lane.steps) {
    assertStepTakes(step, currentToken);
    currentToken = step.out;
  }
  if (lane.recipient === undefined) {
    assertNothingHeld(currentToken);
  } else {
    assertValidRecipient(lane.recipient, adapters);
  }
  return encodeLane(lane);
}

/** The last bounded step protects the output, so it must not be `UNBOUNDED`. */
function assertOutputIsBounded(lane: LaneSpec) {
  const bounded = lane.steps.filter(step => step.minOut !== undefined);
  const last = bounded[bounded.length - 1];
  if (last && last.minOut === UNBOUNDED) {
    throw new Error(`The last swap of a lane (${stepName(last)}) must have a bound, else the output is unprotected`);
  }
}

function assertStepTakes(step: Step, token: Address) {
  if (!isAddressEqual(step.in, token)) {
    throw new Error(`Step ${stepName(step)} takes ${step.in}, but the lane holds ${token}`);
  }
}

function assertNothingHeld(token: Address) {
  if (!isAddressEqual(token, NO_TOKEN)) {
    throw new Error(`The lane ends holding ${token} and has no recipient`);
  }
}

/** Anyone can sweep an adapter, so a recipient is never one. */
function assertValidRecipient(recipient: Address, adapters: readonly Address[]) {
  if (isAddressEqual(recipient, zeroAddress)) {
    throw new Error('The recipient of a lane must not be zero');
  }
  if (adapters.some(adapter => isAddressEqual(adapter, recipient))) {
    throw new Error(`The recipient ${recipient} is an adapter, which would leave the funds for anyone to take`);
  }
}

/** Adapters read it as their whole balance. */
const ALL_BALANCE = maxUint256;

/** Whom step `i` pays: the next adapter, or the recipient. Zero after `end`, where nothing is paid. */
function payTo(lane: LaneSpec, i: number) {
  return lane.steps[i + 1]?.adapter ?? lane.recipient ?? zeroAddress;
}

function encodeLane(lane: LaneSpec) {
  return lane.steps.map((step, i) => ({
    target: step.adapter,
    data: step.encode({ amount: ALL_BALANCE, recipient: payTo(lane, i) }),
  }));
}

function stepName(step: Step) {
  return `${step.fn} on ${step.adapter}`;
}
