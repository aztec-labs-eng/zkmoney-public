import { EthAddress } from '@aztec/foundation/eth-address';

import {
  ACROSS_INPUT_TOKEN_DECIMALS,
  type AcrossBridgeEscrowArgs,
  assertAcrossOutputTokenDecimals,
  encodeAcrossBridgeEscrowArgs,
  encodeAcrossBridgeEscrowDeploy,
} from '@oxide/l1-contracts/across_bridge_on_withdraw.js';
import { MAINNET_USDC, MAINNET_USDT } from '@oxide/l1-contracts/deposit_tokens.js';

import type { AcrossFees } from './across_api.js';
import {
  type EscrowFundingArgs,
  type EscrowWithdrawal,
  type EscrowWithdrawalArgs,
  buildEscrowWithdrawal,
  swappedAtFloor,
  swappedAtPeg,
} from './escrow_withdrawal.js';

/** `acrossInputToken` is USDC or USDT. */
export type AcrossBridgeRoute = {
  acrossInputToken: EthAddress;
  destinationChainId: bigint;
  acrossOutputToken: EthAddress;
  acrossOutputTokenDecimals: number;
};

/** For a route that is not here, build the `AcrossBridgeRoute` yourself. */
export const ACROSS_EVM_DESTINATIONS = {
  USDT: {
    arbitrum: { chainId: 42_161n, address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
    avalanche: { chainId: 43_114n, address: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', decimals: 6 },
    base: { chainId: 8_453n, address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', decimals: 6 },
    bnb: { chainId: 56n, address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
    hyperEvm: { chainId: 999n, address: '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb', decimals: 6 },
    ink: { chainId: 57_073n, address: '0x0200C29006150606B650577BBE7B6248F58470c1', decimals: 6 },
    linea: { chainId: 59_144n, address: '0xA219439258ca9da29E9Cc4cE5596924745e12B93', decimals: 6 },
    monad: { chainId: 143n, address: '0xe7cd86e13AC4309349F30B3435a9d337750fC82D', decimals: 6 },
    opMainnet: { chainId: 10n, address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', decimals: 6 },
    plasma: { chainId: 9_745n, address: '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb', decimals: 6 },
    polygon: { chainId: 137n, address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6 },
    unichain: { chainId: 130n, address: '0x9151434b16b9763660705744891fA906F660EcC5', decimals: 6 },
  },
  USDC: {
    arbitrum: { chainId: 42_161n, address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
    arc: { chainId: 5_042n, address: '0x3600000000000000000000000000000000000000', decimals: 6 },
    avalanche: { chainId: 43_114n, address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', decimals: 6 },
    base: { chainId: 8_453n, address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
    // Binance-Peg USDC (18 decimals). Circle does not issue USDC on BNB.
    bnb: { chainId: 56n, address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 },
    hyperEvm: { chainId: 999n, address: '0xb88339CB7199b77E23DB6E890353E22632Ba630f', decimals: 6 },
    ink: { chainId: 57_073n, address: '0x2D270e6886d130D724215A266106e6832161EAEd', decimals: 6 },
    linea: { chainId: 59_144n, address: '0x176211869cA2b568f2A7D4EE941E073a821EE1ff', decimals: 6 },
    monad: { chainId: 143n, address: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603', decimals: 6 },
    opMainnet: { chainId: 10n, address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6 },
    polygon: { chainId: 137n, address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
    unichain: { chainId: 130n, address: '0x078D782b760474a361dDA0AF3839290b0EF57AD6', decimals: 6 },
    worldChain: { chainId: 480n, address: '0x79A02482A880bCE3F13e09Da970dC34db4CD24d1', decimals: 6 },
  },
} as const;

export type AcrossInputToken = keyof typeof ACROSS_EVM_DESTINATIONS;

export type AcrossEvmChain<TInputToken extends AcrossInputToken> = keyof (typeof ACROSS_EVM_DESTINATIONS)[TInputToken];

const ACROSS_INPUT_TOKENS: Record<AcrossInputToken, EthAddress> = { USDC: MAINNET_USDC, USDT: MAINNET_USDT };

export function acrossEvmDestination<TInputToken extends AcrossInputToken>(
  acrossInputToken: TInputToken,
  chain: AcrossEvmChain<TInputToken>,
): AcrossBridgeRoute {
  const destination = ACROSS_EVM_DESTINATIONS[acrossInputToken][chain] as
    | { chainId: bigint; address: string; decimals: number }
    | undefined;
  if (!destination) {
    throw new Error(`Across has no ${acrossInputToken} route to ${String(chain)}`);
  }
  const { chainId, address, decimals } = destination;
  return {
    acrossInputToken: ACROSS_INPUT_TOKENS[acrossInputToken],
    destinationChainId: chainId,
    acrossOutputToken: EthAddress.fromString(address),
    acrossOutputTokenDecimals: decimals,
  };
}

const ACROSS_PCT_SCALE = 10n ** 18n;
/**
 * The gas fee can rise in the hours between the quote and the execution. The margin also covers the percentage fees
 * on the extra that the 3pool can pay above 1:1.
 */
const ACROSS_GAS_FEE_MARGIN = 2n;

export type AcrossBridgeQuoteArgs = EscrowFundingArgs & Pick<AcrossBridgeOnWithdrawArgs, 'route'>;

export type AcrossBridgeQuote = {
  /** In Across input token units. */
  acrossFee: bigint;
  /** In Across output token units, at the swap floor. */
  minReceived: bigint;
};

/** Throws if the escrow would revert, or if Across would not fill its deposit. */
export function quoteAcrossBridge(args: AcrossBridgeQuoteArgs, fees: AcrossFees): AcrossBridgeQuote {
  const { route } = args;
  if (!Object.values(ACROSS_INPUT_TOKENS).some(token => token.equals(route.acrossInputToken))) {
    throw new Error(`the route's acrossInputToken (${route.acrossInputToken}) must be USDC or USDT on Ethereum`);
  }
  if (route.acrossOutputTokenDecimals !== fees.acrossOutputTokenDecimals) {
    throw new Error(
      `the route's acrossOutputTokenDecimals (${route.acrossOutputTokenDecimals}) must match Across (${fees.acrossOutputTokenDecimals})`,
    );
  }
  const deposit = swappedAtPeg(args);
  if (deposit > fees.maxDeposit) {
    throw new Error(`the deposit (${deposit}) is above the Across maxDeposit (${fees.maxDeposit})`);
  }
  const minDeposit = swappedAtFloor(args);
  if (minDeposit < fees.minDeposit) {
    throw new Error(
      `the deposit at the swap floor (${minDeposit}) is below the Across minDeposit (${fees.minDeposit})`,
    );
  }
  const pctFee = ceilDiv(deposit * (fees.totalRelayFeePct - fees.relayerGasFeePct), ACROSS_PCT_SCALE);
  const acrossFee = pctFee + ACROSS_GAS_FEE_MARGIN * fees.relayerGasFee;
  return { acrossFee, minReceived: checkedMinReceived({ ...args, acrossFee }) };
}

export interface AcrossBridgeOnWithdrawArgs extends EscrowWithdrawalArgs {
  acrossBridgeEscrowFactory: EthAddress;
  route: AcrossBridgeRoute;
  recipient: EthAddress;
  /** From `quoteAcrossBridge`. */
  acrossFee: bigint;
}

export type AcrossBridgeOnWithdraw = EscrowWithdrawal<AcrossBridgeEscrowArgs>;

/** Builds the withdrawal to a counterfactual `AcrossBridgeEscrow` and the L1 operation that bridges it, for one L2 tx. */
export function buildAcrossBridgeOnWithdraw(args: AcrossBridgeOnWithdrawArgs): AcrossBridgeOnWithdraw {
  const { route } = args;
  checkedMinReceived(args);

  return buildEscrowWithdrawal(
    ({ nonce, recoveryCommitment }) => {
      const escrowArgs: AcrossBridgeEscrowArgs = {
        acrossInputToken: route.acrossInputToken.toString(),
        destinationChainId: route.destinationChainId,
        recipient: args.recipient.toString(),
        acrossOutputToken: route.acrossOutputToken.toString(),
        acrossOutputTokenDecimals: route.acrossOutputTokenDecimals,
        acrossFee: args.acrossFee,
        recoveryCommitment,
        relayerTip: args.relayerTip,
        nonce,
      };
      return {
        escrowArgs,
        encodedArgs: encodeAcrossBridgeEscrowArgs(escrowArgs),
        deployCalldata: encodeAcrossBridgeEscrowDeploy(escrowArgs),
      };
    },
    { args, factory: args.acrossBridgeEscrowFactory },
  );
}

function checkedMinReceived(args: EscrowFundingArgs & Pick<AcrossBridgeOnWithdrawArgs, 'acrossFee' | 'route'>): bigint {
  const { acrossOutputTokenDecimals } = args.route;
  const minDeposit = swappedAtFloor(args);
  if (minDeposit <= args.acrossFee) {
    throw new Error(
      `the deposit at the swap floor (${minDeposit}) must be above acrossFee (${args.acrossFee}), or the escrow reverts`,
    );
  }
  assertAcrossOutputTokenDecimals(acrossOutputTokenDecimals);
  return (minDeposit - args.acrossFee) * 10n ** BigInt(acrossOutputTokenDecimals - ACROSS_INPUT_TOKEN_DECIMALS);
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}
