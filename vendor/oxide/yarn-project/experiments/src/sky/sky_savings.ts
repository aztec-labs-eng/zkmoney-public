// TS surface of the experimental Sky savings escrow for the clients and the tests. Its ABIs come from the
// `@oxide/l1-contracts` generator targets, the experiment's hook in that package.
import { SkyEscrowFactoryAbi } from '@oxide/l1-contracts/abis/SkyEscrowFactory.js';
import { assertRecoveryCommitment, predictEscrowAddressLocally } from '@oxide/l1-contracts/escrow.js';

import { type Address, type Hex, type PublicClient, encodeAbiParameters, encodeFunctionData } from 'viem';

export { SkyEscrowAbi } from '@oxide/l1-contracts/abis/SkyEscrow.js';
export { SkyEscrowFactoryAbi } from '@oxide/l1-contracts/abis/SkyEscrowFactory.js';
export { SkyWithdrawalExecutorAbi } from '@oxide/l1-contracts/abis/SkyWithdrawalExecutor.js';

/** `SkyEscrow`'s routes: which portal the escrow deposits into. */
export enum SkyRoute {
  /** DAI converted to sUSDS and deposited into the sUSDS portal. */
  Stake = 0,
  /** DAI, redeemed from sUSDS on the way out, deposited into the DAI portal. */
  Unstake = 1,
}

/** Mirror of `SkyEscrow.Args` — the values a Sky escrow's CREATE2 address commits to, in struct order. */
export interface SkyEscrowArgs {
  route: SkyRoute;
  /** The secret hash of the deposit the escrow makes into the destination portal. */
  recipientCommitment: Hex;
  /** `deriveRecoveryCommitment(recoverySalt, account)`: the account signs recovery of funds the route cannot deliver. */
  recoveryCommitment: Hex;
  relayerTip: bigint;
  /** Wallet randomness for per-withdrawal uniqueness/privacy. */
  nonce: Hex;
}

export function assertSkyEscrowArgs(args: SkyEscrowArgs): void {
  assertRecoveryCommitment(args.recoveryCommitment);
}

/** Must match `abi.encode(_args)` in `SkyEscrowFactory` exactly: it is the CREATE2 commitment. */
export function encodeSkyEscrowArgs(args: SkyEscrowArgs): Hex {
  assertSkyEscrowArgs(args);
  return encodeAbiParameters(
    [{ type: 'uint8' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes32' }],
    [args.route, args.recipientCommitment, args.recoveryCommitment, args.relayerTip, args.nonce],
  );
}

export async function predictSkyEscrowAddress(
  publicClient: PublicClient,
  factory: Address,
  args: SkyEscrowArgs,
): Promise<Address> {
  return (await publicClient.readContract({
    address: factory,
    abi: SkyEscrowFactoryAbi,
    functionName: 'predictEscrowAddress',
    args: [args],
  } as any)) as Address;
}

export function predictSkyEscrowAddressLocally(factory: Address, args: SkyEscrowArgs): Address {
  return predictEscrowAddressLocally(factory, encodeSkyEscrowArgs(args));
}

/** `deployAndExecute`: deploys the escrow and runs its route. */
export function encodeSkyEscrowDeploy(args: SkyEscrowArgs): Hex {
  assertSkyEscrowArgs(args);
  return encodeFunctionData({ abi: SkyEscrowFactoryAbi, functionName: 'deployAndExecute', args: [args] });
}
