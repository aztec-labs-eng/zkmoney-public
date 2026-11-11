import { type Address, isAddressEqual, maxUint256, zeroAddress } from 'viem';

import type { MultiStepCall } from './payload.js';
import { type AnyStep, type Step, type TerminalStep, UNBOUNDED } from './steps/step.js';

/** The steps of a lane, and where it ends. */
export type LaneSpec = LaneToRecipient | LaneToTerminal;

export type LaneToRecipient = { steps: Step[]; recipient: Address };

export type LaneToTerminal = { steps: Step[]; terminal: TerminalStep };

export type BuildLane<Token extends Address = Address> = (lane: LaneBuilder<Token>) => LaneSpec;

/** Ends at an address with `to`, or at a terminal step with `end`. */
export class LaneBuilder<Token extends Address = Address> {
  constructor(private readonly steps: Step[]) {}

  step<In extends Address, Out extends Address>(
    s: Takes<Token, In> extends true ? Step<In, Out> : Step<Token, Out>,
  ): LaneBuilder<Out> {
    return new LaneBuilder<Out>([...this.steps, s]);
  }

  to(recipient: Address) {
    return { steps: this.steps, recipient };
  }

  end<In extends Address>(terminal: Takes<Token, In> extends true ? TerminalStep<In> : TerminalStep<Token>): LaneSpec {
    return { steps: this.steps, terminal };
  }
}

export type CompiledLane = {
  /** Where the lane starts: the first adapter in the lane, or the recipient when there is no step. */
  start: Address;
  calls: MultiStepCall[];
};

/** Checks the lane and encodes its calls. A recipient must not be one of `adapters`. */
export function compileLane(token: Address, lane: LaneSpec, adapters: readonly Address[]) {
  assertOutputIsBounded(lane);
  let currentToken: Address = token;
  for (const step of lane.steps) {
    assertStepTakes(step, currentToken);
    currentToken = step.out;
  }
  if (endsAtTerminal(lane)) {
    assertStepTakes(lane.terminal, currentToken);
  } else {
    assertValidRecipient(lane.recipient, adapters);
  }
  return { start: lane.steps[0]?.adapter ?? laneEnd(lane), calls: encodeLane(lane) };
}

export function laneSteps(lane: LaneSpec) {
  return endsAtTerminal(lane) ? [...lane.steps, lane.terminal] : lane.steps;
}

/** True unless both are literals and differ. On a mismatch the parameter falls back to `Token`, so the error names both. */
type Takes<Token extends Address, In extends Address> = [Token] extends [In]
  ? true
  : [In] extends [Token]
    ? true
    : false;

function endsAtTerminal(lane: LaneSpec): lane is LaneToTerminal {
  return 'terminal' in lane;
}

/** The last bounded step protects the output, so it must not be `UNBOUNDED`. */
function assertOutputIsBounded(lane: LaneSpec) {
  const bounded = laneSteps(lane).filter(step => step.minOut !== undefined);
  const last = bounded[bounded.length - 1];
  if (last && last.minOut === UNBOUNDED) {
    throw new Error(`The last swap of a lane (${stepName(last)}) must have a bound, else the output is unprotected`);
  }
}

function assertStepTakes(step: AnyStep, token: Address) {
  if (!isAddressEqual(step.in, token)) {
    throw new Error(`Step ${stepName(step)} takes ${step.in}, but the lane holds ${token}`);
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

/** The terminal adapter, or the recipient. */
function laneEnd(lane: LaneSpec) {
  return endsAtTerminal(lane) ? lane.terminal.adapter : lane.recipient;
}

/** Adapters read it as their whole balance. */
const ALL_BALANCE = maxUint256;

/** Whom step `i` pays: the next adapter, or the end of the lane. */
function payTo(lane: LaneSpec, i: number) {
  return lane.steps[i + 1]?.adapter ?? laneEnd(lane);
}

function encodeLane(lane: LaneSpec) {
  const calls = lane.steps.map((step, i) => ({
    target: step.adapter,
    data: step.encode({ amount: ALL_BALANCE, recipient: payTo(lane, i) }),
  }));
  if (endsAtTerminal(lane)) {
    calls.push({ target: lane.terminal.adapter, data: lane.terminal.encode({ amount: ALL_BALANCE }) });
  }
  return calls;
}

function stepName(step: AnyStep) {
  return `${step.fn} on ${step.adapter}`;
}
