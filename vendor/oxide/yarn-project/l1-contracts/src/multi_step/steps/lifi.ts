import {
  type Address,
  type Hex,
  encodeAbiParameters,
  isAddressEqual,
  pad,
  parseAbiParameters,
  zeroAddress,
} from 'viem';

import { LifiIntentAdapterAbi } from '../../artifacts.js';
import { type BuildLane, buildFromEmptyLane, compilePaidLane } from '../lane.js';
import { type AdapterConfig, type Chain, ETH, adapterSteps } from './step.js';

export type LifiOpen<In extends Address = Address> = {
  token: In;
  destinationChainId: bigint;
  /** The LI.FI escrow on L1 that holds the input until the fill is proven. */
  inputSettler: Address;
  /** Proves the fill on L1. It must be on the same oracle network as `outputOracle`. */
  inputOracle: Address;
  /** Proves the fill on the destination chain. */
  outputOracle: Hex;
  /** Where the solver fills on the destination chain. */
  outputSettler: Hex;
  /** On the destination chain. `ETH` for its native token. */
  outputToken: Address;
  recipient: Address;
  minOut: bigint;
  /** Refunded on L1 when no solver fills. */
  refundTo: Address;
  nonce: bigint;
  /** Seconds after the order opens on L1 until solvers can no longer fill on the destination chain. */
  fillWindow: number;
  /** Seconds after the order opens on L1 until `refundTo` can take back the input of an unproven fill. Must be longer than `fillWindow`, so a solver has time to prove its fill. */
  expiryWindow: number;
  context: Hex;
};

/** When the order fills, `hook.target` gets the output and `hook.calldata`, or this adapter runs `hook.lane` and pays `hook.fallbackTo` if it fails. */
export type LifiOpenWithHook<In extends Address = Address> = Omit<LifiOpen<In>, 'recipient'> & {
  hook: { target: Address; calldata: Hex } | { lane: BuildLane; fallbackTo: Address };
};

/** A lane hook runs only on `chain`. */
export function lifiSteps(c: AdapterConfig, chain: Chain) {
  const define = adapterSteps(c.address, LifiIntentAdapterAbi);
  return {
    ...c,
    open<In extends Address>(p: LifiOpen<In>) {
      assertOrder(p);
      return define.noPayout({
        fn: 'lifiOpen',
        in: p.token,
        minOut: p.minOut,
        args: s => [{ ...openArgs(p), amount: s.amount }] as const,
      });
    },

    openWithHook<In extends Address>(p: LifiOpenWithHook<In>) {
      const { hook, ...open } = p;
      assertOrder(open);
      const { recipient, callbackData } =
        'lane' in hook
          ? laneHook(c.address, chain, hook, open)
          : { recipient: hook.target, callbackData: hook.calldata };
      return define.noPayout({
        fn: 'lifiOpenWithHook',
        in: p.token,
        minOut: p.minOut,
        args: s => [{ ...openArgs({ ...open, recipient }), callbackData, amount: s.amount }] as const,
      });
    },
  };
}

/** Builds a hook that runs a lane on the adapter itself. */
function laneHook(
  adapter: Address,
  chain: Chain,
  hook: { lane: BuildLane; fallbackTo: Address },
  open: { destinationChainId: bigint; outputToken: Address },
) {
  if (open.destinationChainId !== chain.chainId) {
    throw new Error(
      `A lane hook runs on the adapter, so it needs destinationChainId ${chain.chainId}, got ${open.destinationChainId}`,
    );
  }
  if (isAddressEqual(hook.fallbackTo, zeroAddress)) {
    throw new Error('fallbackTo must not be zero');
  }
  const spec = buildFromEmptyLane(hook.lane);
  const { paidAt, calls } = compilePaidLane(open.outputToken, spec, [adapter, ...spec.steps.map(step => step.adapter)]);
  return {
    recipient: adapter,
    callbackData: encodeAbiParameters(HOOK_PARAMETERS, [paidAt, hook.fallbackTo, calls]),
  };
}

/** What the adapter rejects at the finalization, or what would leave the order unfillable. */
function assertOrder(p: Pick<LifiOpen, 'refundTo' | 'fillWindow' | 'expiryWindow'>) {
  if (isAddressEqual(p.refundTo, zeroAddress)) {
    throw new Error('refundTo must not be zero');
  }
  if (p.expiryWindow <= p.fillWindow) {
    throw new Error(`expiryWindow (${p.expiryWindow}) must be longer than fillWindow (${p.fillWindow})`);
  }
}

/** As `LifiIntentAdapter.outputFilled` reads them. */
const HOOK_PARAMETERS = parseAbiParameters('address, address, (address target, bytes data)[]');

function openArgs({ recipient, minOut, refundTo, outputToken, ...p }: LifiOpen) {
  return {
    ...p,
    recipient: pad(recipient, { size: 32 }),
    outputToken: outputTokenOf(outputToken),
    minOutput: minOut,
    refundRecipient: refundTo,
  };
}

/** The order names the native token zero. */
function outputTokenOf(token: Address) {
  return pad(isAddressEqual(token, ETH) ? zeroAddress : token, { size: 32 });
}
