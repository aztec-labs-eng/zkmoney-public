import type { EthAddress } from '@aztec/foundation/eth-address';

import {
  CCTP_HYPEREVM_DOMAIN,
  type CctpBridgeEscrowArgs,
  CctpBridgeRoute,
  type CctpFinality,
  encodeCctpBridgeEscrowArgs,
  encodeCctpBridgeEscrowDeploy,
} from '@oxide/l1-contracts/cctp_bridge_on_withdraw.js';

import type { CctpFee } from './cctp_api.js';
import {
  type EscrowFundingArgs,
  type EscrowWithdrawal,
  type EscrowWithdrawalArgs,
  buildEscrowWithdrawal,
  swappedAtFloor,
  swappedAtPeg,
} from './escrow_withdrawal.js';
import { type HyperliquidApiOptions, fetchHyperCoreAccountExists } from './hypercore_api.js';

export type CctpBridgeDestination = {
  name: string;
  domain: number;
  route: CctpBridgeRoute;
  /** The smallest USDC (6 decimals) the recipient must receive, after all fees. */
  minReceived: bigint;
  /** USDC (6 decimals) that the destination takes from the delivery. */
  deliveryFee: bigint;
};

/** The CCTP domains of the EVM chains the Circle Forwarding Service delivers to. */
export const CCTP_FORWARDING_EVM_DOMAINS = {
  arbitrum: 3,
  arc: 26,
  avalanche: 1,
  base: 6,
  codex: 12,
  edge: 28,
  hyperEvm: CCTP_HYPEREVM_DOMAIN,
  ink: 21,
  linea: 11,
  monad: 15,
  opMainnet: 2,
  plume: 22,
  polygon: 7,
  sei: 16,
  sonic: 13,
  unichain: 10,
  worldChain: 14,
  xdc: 18,
} as const;

export type CctpForwardingEvmChain = keyof typeof CCTP_FORWARDING_EVM_DOMAINS;

export function cctpEvmDestination(chain: CctpForwardingEvmChain): CctpBridgeDestination {
  return {
    name: chain,
    domain: CCTP_FORWARDING_EVM_DOMAINS[chain],
    route: CctpBridgeRoute.Direct,
    minReceived: 1_000_000n,
    deliveryFee: 0n,
  };
}

/** Hyperliquid takes this USDC from the first deposit to a new HyperCore account. */
export const HYPERCORE_ACCOUNT_ACTIVATION_FEE = 1_000_000n;

/** Asks Hyperliquid whether `account` exists, because the first deposit to a new account pays the activation fee. */
export async function hyperCoreDestination(
  account: EthAddress,
  options: HyperliquidApiOptions = {},
): Promise<CctpBridgeDestination> {
  const accountExists = await fetchHyperCoreAccountExists(account, options);
  return {
    name: 'HyperCore',
    domain: CCTP_HYPEREVM_DOMAIN,
    route: CctpBridgeRoute.HyperCoreSpot,
    minReceived: 1_000_000n,
    deliveryFee: accountExists ? 0n : HYPERCORE_ACCOUNT_ACTIVATION_FEE,
  };
}

const BPS_DENOMINATOR = 10_000n;
/** `CctpFee.minimumFee` is fractional, so it is scaled to hundredths of a basis point. */
const MINIMUM_FEE_SCALE = 100;

export type CctpBridgeQuoteArgs = EscrowFundingArgs &
  Pick<CctpBridgeOnWithdrawArgs, 'destination' | 'minFinalityThreshold'>;

/** In USDC units (6 decimals). */
export type CctpBridgeQuote = {
  /** The protocol fee at a 1:1 swap plus the high forwarding fee. A larger burn eats into the forwarding margin. */
  maxFee: bigint;
  /** What the recipient receives at the swap floor. */
  minReceived: bigint;
};

/** Throws if the escrow would revert or deliver less than `destination.minReceived`. */
export function quoteCctpBridge(args: CctpBridgeQuoteArgs, fees: CctpFee[]): CctpBridgeQuote {
  const maxFee = computeMaxFee(args, fees);
  return { maxFee, minReceived: checkedMinReceived({ ...args, maxFee }) };
}

export interface CctpBridgeOnWithdrawArgs extends EscrowWithdrawalArgs {
  cctpBridgeEscrowFactory: EthAddress;
  destination: CctpBridgeDestination;
  /** For `hyperCoreDestination`, the HyperCore account. */
  recipient: EthAddress;
  minFinalityThreshold: CctpFinality;
  /** From `quoteCctpBridge`. */
  maxFee: bigint;
}

export type CctpBridgeOnWithdraw = EscrowWithdrawal<CctpBridgeEscrowArgs>;

/** Builds the withdrawal to a counterfactual `CCTPBridgeEscrow` and the L1 operation that bridges it, for one L2 tx. */
export function buildCctpBridgeOnWithdraw(args: CctpBridgeOnWithdrawArgs): CctpBridgeOnWithdraw {
  const { destination, maxFee } = args;
  checkedMinReceived(args);

  return buildEscrowWithdrawal(
    ({ nonce, recoveryCommitment }) => {
      const escrowArgs: CctpBridgeEscrowArgs = {
        route: destination.route,
        destinationDomain: destination.domain,
        recipient: args.recipient.toString(),
        minFinalityThreshold: args.minFinalityThreshold,
        maxFee,
        recoveryCommitment,
        relayerTip: args.relayerTip,
        nonce,
      };
      return {
        escrowArgs,
        encodedArgs: encodeCctpBridgeEscrowArgs(escrowArgs),
        deployCalldata: encodeCctpBridgeEscrowDeploy(escrowArgs),
      };
    },
    { args, factory: args.cctpBridgeEscrowFactory },
  );
}

function computeMaxFee(args: CctpBridgeQuoteArgs, fees: CctpFee[]): bigint {
  const finalityThreshold: number = args.minFinalityThreshold;
  const fee = fees.find(entry => entry.finalityThreshold === finalityThreshold);
  if (!fee?.forwardFee) {
    throw new Error(`CCTP fees have no forwardFee at finality ${args.minFinalityThreshold}`);
  }
  const burnAmount = swappedAtPeg(args);
  const minimumFee = BigInt(Math.ceil(Number((fee.minimumFee * MINIMUM_FEE_SCALE).toFixed(6))));
  const denominator = BPS_DENOMINATOR * BigInt(MINIMUM_FEE_SCALE);
  const protocolFee = (burnAmount * minimumFee + denominator - 1n) / denominator;
  return protocolFee + fee.forwardFee.high;
}

function checkedMinReceived(
  args: EscrowFundingArgs & Pick<CctpBridgeOnWithdrawArgs, 'destination' | 'maxFee'>,
): bigint {
  const { destination, maxFee } = args;
  const minBurnAmount = swappedAtFloor(args);
  if (minBurnAmount <= maxFee) {
    throw new Error(
      `the burn at the swap floor (${minBurnAmount}) must be above maxFee (${maxFee}), or the escrow reverts`,
    );
  }
  const minReceived = minBurnAmount - maxFee - destination.deliveryFee;
  if (minReceived < destination.minReceived) {
    throw new Error(
      `${destination.name} needs at least ${destination.minReceived} USDC units to arrive, but at the swap floor, ` +
        `after a maxFee of ${maxFee} and a delivery fee of ${destination.deliveryFee}, only ${minReceived} would`,
    );
  }
  return minReceived;
}
