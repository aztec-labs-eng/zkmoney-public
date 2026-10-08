// TS surface of the disposable swap-on-withdraw feature: everything the clients and tests need lives in this one
// purgeable file (plus the gen_abis / artifacts entries and the one-line index export).
import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  parseAbi,
} from 'viem';

import { SwapEscrowFactoryAbi, SwapEscrowFactoryBytecode } from './artifacts.js';
import { deployContract } from './deploy/deploy_contract.js';
import { assertRecoveryCommitment, predictEscrowAddressLocally } from './escrow.js';

// Re-exported here (not from index.ts) so purging the feature stays a single-line index revert.
export { SwapEscrowAbi, SwapEscrowBytecode, SwapEscrowFactoryAbi, SwapEscrowFactoryBytecode } from './artifacts.js';
export { MockUniversalRouterAbi, MockUniversalRouterBytecode } from './artifacts.js';
export { MockCurve3PoolAbi, MockCurve3PoolBytecode } from './artifacts.js';

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
}

/** Mirror of `SwapEscrow.Args` — the values a swap escrow's CREATE2 address commits to, in struct order. */
export interface SwapEscrowArgs {
  route: SwapRoute;
  recipient: Address;
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
  return encodeAbiParameters(
    [{ type: 'uint8' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes32' }],
    [args.route, args.recipient, args.recoveryCommitment, args.relayerTip, args.nonce],
  );
}

export async function predictSwapEscrowAddress(
  publicClient: PublicClient,
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
  ]);
}
