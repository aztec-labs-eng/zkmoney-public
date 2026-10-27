import { type Address, type Hex, type PublicClient, encodeFunctionData } from 'viem';

import { DepositSubsidyAbi, SIPAAbi } from './artifacts.js';
import type { SipaIntent } from './sipa_factory.js';

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
 * `DepositSubsidy.sweepForSubsidy(sipa, ...)` calldata: the same sweep, driven by the deposit subsidy. The subsidy
 * pays for the gas of the sweep when a code-free EOA sends it through the bound executor. A bare `encodeSweep` still
 * bridges the deposit; it just earns nothing on top of the fee.
 */
export function encodeSweepForSubsidy(sipa: Address, args: SweepArgs): Hex {
  return encodeFunctionData({
    abi: DepositSubsidyAbi,
    functionName: 'sweepForSubsidy',
    args: [sipa, args.token, args.relayer, args.intentData, args.proofs],
  });
}

/** The SIPA that `deployAndSweepForSubsidy` deploys. The deposit subsidy gets the implementation from the table, the
 *  rollup version from its portal, and the intent hash from the sweep's `intentData`. */
export interface SubsidizedDeployArgs {
  forwardingTable: Address;
  intent: SipaIntent;
  recoveryCommitment: Hex;
  resweepable: boolean;
}

/** `DepositSubsidy.deployAndSweepForSubsidy(...)` calldata: deploys the SIPA if it has no code, then sweeps it. */
export function encodeDeployAndSweepForSubsidy(deploy: SubsidizedDeployArgs, args: SweepArgs): Hex {
  return encodeFunctionData({
    abi: DepositSubsidyAbi,
    functionName: 'deployAndSweepForSubsidy',
    args: [
      deploy.forwardingTable,
      deploy.intent,
      deploy.recoveryCommitment,
      deploy.resweepable,
      args.token,
      args.relayer,
      args.intentData,
      args.proofs,
    ],
  });
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
