// TS surface of the disposable swap-on-withdraw feature: everything the clients and tests need lives in this one
// purgeable file (plus the gen_abis / artifacts entries and the one-line index export).
import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  getAbiItem,
  parseAbi,
} from 'viem';

import { SwapEscrowFactoryAbi, SwapEscrowFactoryBytecode } from './artifacts.js';
import { deployContract } from './deploy/deploy_contract.js';
import { assertRecoveryCommitment, predictEscrowAddressLocally } from './escrow.js';

// Re-exported here (not from index.ts) so purging the feature stays a single-line index revert.
export { SwapEscrowAbi, SwapEscrowBytecode, SwapEscrowFactoryAbi, SwapEscrowFactoryBytecode } from './artifacts.js';
export { MockUniversalRouterAbi, MockUniversalRouterBytecode } from './artifacts.js';
export { MockCurve3PoolAbi, MockCurve3PoolBytecode } from './artifacts.js';
export { MockUniswapV2PairAbi, MockUniswapV2PairBytecode, MockWETH9Abi, MockWETH9Bytecode } from './artifacts.js';

/**
 * Events of the swap escrow factory and escrows deployed before `EscrowBase` renamed them to `EscrowExecuted` and
 * `EscrowRecovered`. Read these for escrows from those factories, since the generated ABIs no longer decode them.
 */
export const LegacySwapEscrowEventsAbi = parseAbi([
  'event SwapEscrowExecuted(address indexed escrow, address tipRecipient)',
  'event SwapEscrowRecovered(address indexed token, address indexed target, uint256 amount)',
]);

/** The hardcoded `SwapEscrow` routes: what the withdrawn DAI converts into on L1. */
export enum SwapRoute {
  USDC = 0,
  USDT = 1,
  ETH = 2,
  /** The escrow pays the DAI without a swap. */
  DAI = 3,
}

/** Mirror of `SwapEscrow.MAX_DAI_FOR_GAS`: the most DAI that one escrow swaps to ETH for gas. */
export const MAX_DAI_FOR_GAS = 50n * 10n ** 18n;

/** Mirror of `SwapEscrow.Args` — the values a swap escrow's CREATE2 address commits to, in struct order. */
export interface SwapEscrowArgs {
  route: SwapRoute;
  recipient: Address;
  /**
   * DAI that the escrow swaps to ETH for `recipient` on the Uniswap V2 DAI/WETH pair. The route gets the rest. Zero
   * skips the swap. The escrow reverts if it is above {@link MAX_DAI_FOR_GAS}, above the escrow balance after
   * `relayerTip`, or above 0 on the ETH route.
   */
  daiForGas: bigint;
  /**
   * The least ETH that the `daiForGas` swap must pay. The escrow reverts if the pair pays less. Zero accepts any
   * amount.
   */
  minEthForGas: bigint;
  /**
   * `deriveRecoveryCommitment(recoverySalt, account)`. The account signs `recoverERC20` / `recoverETH` for funds the
   * route cannot deliver. The wallet-secret salt keeps the account hidden.
   */
  recoveryCommitment: Hex;
  relayerTip: bigint;
  /** Wallet randomness for per-withdrawal uniqueness/privacy. */
  nonce: Hex;
}

export function assertSwapEscrowArgs(args: SwapEscrowArgs): void {
  assertRecoveryCommitment(args.recoveryCommitment);
}

/** Must match `abi.encode(_args)` in `SwapEscrowFactory` exactly: it is the CREATE2 commitment. */
export function encodeSwapEscrowArgs(args: SwapEscrowArgs): Hex {
  assertSwapEscrowArgs(args);
  return encodeAbiParameters(getAbiItem({ abi: SwapEscrowFactoryAbi, name: 'predictEscrowAddress' }).inputs, [args]);
}

export async function predictSwapEscrowAddress(
  publicClient: Pick<PublicClient, 'readContract'>,
  factory: Address,
  args: SwapEscrowArgs,
): Promise<Address> {
  return (await publicClient.readContract({
    address: factory,
    abi: SwapEscrowFactoryAbi,
    functionName: 'predictEscrowAddress',
    args: [args],
  } as any)) as Address;
}

export function predictSwapEscrowAddressLocally(factory: Address, args: SwapEscrowArgs): Address {
  return predictEscrowAddressLocally(factory, encodeSwapEscrowArgs(args));
}

export function encodeSwapEscrowDeploy(args: SwapEscrowArgs): Hex {
  assertSwapEscrowArgs(args);
  return encodeFunctionData({ abi: SwapEscrowFactoryAbi, functionName: 'deployAndExecute', args: [args] });
}

/**
 * Mirror of `SwapEscrow.Args` of a factory from before `daiForGas`, such as the factory under the `swapEscrowFactory`
 * manifest key. An escrow from such a factory commits to this layout. To run its swap or to recover its funds, encode
 * this layout and call that factory.
 */
export interface LegacySwapEscrowArgs {
  route: SwapRoute;
  recipient: Address;
  recoveryCommitment: Hex;
  relayerTip: bigint;
  nonce: Hex;
}

/** The functions of a swap escrow factory that takes {@link LegacySwapEscrowArgs}. */
export const LegacySwapEscrowFactoryAbi = parseAbi([
  'struct Args { uint8 route; address recipient; bytes32 recoveryCommitment; uint256 relayerTip; bytes32 nonce; }',
  'function deployAndExecute(Args _args) returns (address escrow)',
  'function deploy(Args _args) returns (address escrow)',
  'function predictEscrowAddress(Args _args) view returns (address)',
]);

/** Must match `abi.encode(_args)` in a legacy `SwapEscrowFactory` exactly: it is the CREATE2 commitment. */
export function encodeLegacySwapEscrowArgs(args: LegacySwapEscrowArgs): Hex {
  assertRecoveryCommitment(args.recoveryCommitment);
  return encodeAbiParameters(getAbiItem({ abi: LegacySwapEscrowFactoryAbi, name: 'predictEscrowAddress' }).inputs, [
    args,
  ]);
}

export function predictLegacySwapEscrowAddressLocally(factory: Address, args: LegacySwapEscrowArgs): Address {
  return predictEscrowAddressLocally(factory, encodeLegacySwapEscrowArgs(args));
}

/** `deployAndExecute(args)` calldata for a legacy factory. */
export function encodeLegacySwapEscrowDeploy(args: LegacySwapEscrowArgs): Hex {
  assertRecoveryCommitment(args.recoveryCommitment);
  return encodeFunctionData({ abi: LegacySwapEscrowFactoryAbi, functionName: 'deployAndExecute', args: [args] });
}

export async function deploySwapEscrowFactory(
  walletClient: WalletClient,
  publicClient: PublicClient,
  tokens: {
    dai: Address;
    usdc: Address;
    usdt: Address;
    weth: Address;
    router: Address;
    threePool: Address;
    ethUsdFeed: Address;
    daiWethPair: Address;
  },
): Promise<Address> {
  return await deployContract(walletClient, publicClient, SwapEscrowFactoryAbi, SwapEscrowFactoryBytecode, [
    tokens.dai,
    tokens.usdc,
    tokens.usdt,
    tokens.weth,
    tokens.router,
    tokens.threePool,
    tokens.ethUsdFeed,
    tokens.daiWethPair,
  ]);
}
