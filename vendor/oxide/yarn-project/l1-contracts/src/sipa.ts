import { type Address, type Hex, type PublicClient, encodeFunctionData } from 'viem';

import { DepositSubsidyAbi, SIPAAbi } from './artifacts.js';

/** Inputs for `SIPA.sweep(token, relayer, intentData, proofs)`. */
export interface SweepArgs {
  token: Address;
  /** Address credited the pool's tip. */
  relayer: Address;
  /** The abi-encoded intent record; MUST hash to the SIPA's committed `intentHash`. */
  intentData: Hex;
  /** Extra non-committed data the intent's `_execute` consumes; empty (`0x`) for a plain deposit. */
  proofs: Hex;
}

/** `SIPA.sweep(...)` calldata: reveals the intent, runs its executor, and routes the swept balance into the pool. */
export function encodeSweep(args: SweepArgs): Hex {
  return encodeFunctionData({
    abi: SIPAAbi,
    functionName: 'sweep',
    args: [args.token, args.relayer, args.intentData, args.proofs],
  });
}

/**
 * `DepositSubsidy.sweepForSubsidy(sipa, ...)` calldata: the same sweep, driven by the deposit subsidy so it is
 * clocked and paid for the gas it burns. A bare `encodeSweep` still bridges the deposit; it just earns nothing on
 * top of the fee.
 */
export function encodeSweepForSubsidy(sipa: Address, args: SweepArgs): Hex {
  return encodeFunctionData({
    abi: DepositSubsidyAbi,
    functionName: 'sweepForSubsidy',
    args: [sipa, args.token, args.relayer, args.intentData, args.proofs],
  });
}

/** The portal and sweep fee an intent implementation pins. Every clone of it settles into the one and charges the
 *  other, so reading them off the implementation is how a deploy checks what it just blessed. */
export async function readSipaPlumbing(
  publicClient: PublicClient,
  implementation: Address,
): Promise<{ portal: Address; depositFee: bigint }> {
  const [portal, depositFee] = await Promise.all([
    publicClient.readContract({ address: implementation, abi: SIPAAbi, functionName: 'PORTAL' }),
    publicClient.readContract({ address: implementation, abi: SIPAAbi, functionName: 'DEPOSIT_FEE' }),
  ]);
  return { portal: portal as Address, depositFee: depositFee as bigint };
}

/** A SIPA `Sweep(index, amount)` event. `index` is the L1→L2 inbox leaf; `amount` is the L2-credited amount. */
export interface SweepEvent {
  index: bigint;
  amount: bigint;
  blockNumber: bigint;
}

/** Read a SIPA's `Sweep` events from `fromBlock` on. */
export async function getSipaSweeps(
  publicClient: PublicClient,
  sipa: Address,
  fromBlock: bigint | 'earliest' = 'earliest',
): Promise<SweepEvent[]> {
  const logs = await publicClient.getContractEvents({
    address: sipa,
    abi: SIPAAbi,
    eventName: 'Sweep',
    fromBlock,
    toBlock: 'latest',
  });
  return logs.map(log => ({ index: log.args.index!, amount: log.args.amount!, blockNumber: log.blockNumber! }));
}
