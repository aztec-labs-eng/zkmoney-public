// TS surface of the disposable swap-on-withdraw feature: everything the clients and tests need lives in this one
// purgeable file (plus the gen_abis / artifacts entries and the one-line index export).
import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  getContractAddress,
  getCreate2Address,
  keccak256,
  pad,
  parseAbiParameters,
  size,
  toHex,
} from 'viem';

import { SwapEscrowAbi, SwapEscrowFactoryAbi, SwapEscrowFactoryBytecode } from './artifacts.js';
import { deployContract } from './deploy/deploy_contract.js';

// Re-exported here (not from index.ts) so purging the feature stays a single-line index revert.
export { SwapEscrowAbi, SwapEscrowBytecode, SwapEscrowFactoryAbi, SwapEscrowFactoryBytecode } from './artifacts.js';
export { MockUniversalRouterAbi, MockUniversalRouterBytecode } from './artifacts.js';
export { MockCurve3PoolAbi, MockCurve3PoolBytecode } from './artifacts.js';

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

/** A zero recovery commitment opens to no account, so funds the route cannot deliver would be stuck at the escrow. */
export function assertSwapEscrowArgs(args: SwapEscrowArgs): void {
  if (BigInt(args.recoveryCommitment) === 0n) {
    throw new Error('SwapEscrowArgs: recoveryCommitment must be nonzero');
  }
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
  // the implementation is the factory's first self-deploy (nonce 1)
  const implementation = getContractAddress({ from: factory, nonce: 1n });
  const blob = encodeSwapEscrowArgs(args);
  const initCode = concatHex([
    '0x61',
    pad(toHex(size(blob) + 0x2d), { size: 2 }),
    '0x3d81600a3d39f3363d3d373d3d3d363d73',
    implementation,
    '0x5af43d82803e903d91602b57fd5bf3',
    blob,
  ]);
  return getCreate2Address({ from: factory, salt: pad('0x', { size: 32 }), bytecode: initCode });
}

export function encodeSwapEscrowDeploy(args: SwapEscrowArgs): Hex {
  assertSwapEscrowArgs(args);
  return encodeFunctionData({ abi: SwapEscrowFactoryAbi, functionName: 'deployAndExecute', args: [args] });
}

export interface SwapEscrowRecoveryArgs {
  recoverySalt: Hex;
  account: Address;
  /**
   * ERC-1271 signature over `accountPersonalSignHash` of the recovery digest if the account has code, else the EOA's
   * `personal_sign` of the digest.
   */
  signature: Hex;
  target: Address;
  nonce: Hex;
  deadline: bigint;
}

export function swapEscrowERC20RecoveryDigest(
  escrow: Address,
  chainId: bigint,
  target: Address,
  token: Address,
  nonce: Hex,
  deadline: bigint,
): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters('address, uint256, address, address, bytes32, uint256'), [
      escrow,
      chainId,
      target,
      token,
      nonce,
      deadline,
    ]),
  );
}

export function swapEscrowETHRecoveryDigest(
  escrow: Address,
  chainId: bigint,
  target: Address,
  nonce: Hex,
  deadline: bigint,
): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters('address, uint256, address, bytes32, uint256'), [
      escrow,
      chainId,
      target,
      nonce,
      deadline,
    ]),
  );
}

export function encodeSwapEscrowRecoverERC20(args: SwapEscrowRecoveryArgs & { token: Address }): Hex {
  return encodeFunctionData({
    abi: SwapEscrowAbi,
    functionName: 'recoverERC20',
    args: [args.recoverySalt, args.account, args.signature, args.target, args.token, args.nonce, args.deadline],
  });
}

export function encodeSwapEscrowRecoverETH(args: SwapEscrowRecoveryArgs): Hex {
  return encodeFunctionData({
    abi: SwapEscrowAbi,
    functionName: 'recoverETH',
    args: [args.recoverySalt, args.account, args.signature, args.target, args.nonce, args.deadline],
  });
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
