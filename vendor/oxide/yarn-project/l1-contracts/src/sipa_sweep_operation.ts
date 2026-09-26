import { MULTI_CALL_3_ADDRESS } from '@aztec/ethereum/contracts';
import { EthAddress } from '@aztec/foundation/eth-address';

import type { BroadcastL1Operation, L1OperationCondition } from '@oxide/oxide-lib/l1_operation_calldata.js';

import { type Address, type Hex, type PublicClient, encodeFunctionData, multicall3Abi } from 'viem';

import { type LegacySipaDeployArgs, encodeLegacySipaDeploy } from './legacy_sipa.js';
import { type SweepArgs, encodeSweep, encodeSweepForSubsidy } from './sipa.js';
import { type SipaDeployArgs, encodeDeploySIPA } from './sipa_factory.js';

/** Canonical Multicall3 deployment; batches the deploy+sweep into one atomic L1 call. */
export const MULTICALL3_ADDRESS = MULTI_CALL_3_ADDRESS as Address;

/** One sub-call in an `aggregate3` batch. */
export interface Aggregate3Call {
  target: Address;
  /** When false, a reverting sub-call reverts the whole batch (the deploy+sweep is all-or-nothing). */
  allowFailure: boolean;
  callData: Hex;
}

/** Encode the `aggregate3(calls)` calldata for a Multicall3 batch. */
export function encodeAggregate3(calls: Aggregate3Call[]): Hex {
  return encodeFunctionData({ abi: multicall3Abi, functionName: 'aggregate3', args: [calls] });
}

/** Whether an address has contract code on chain, i.e. the SIPA has already been deployed. */
export async function isContractDeployed(publicClient: PublicClient, address: Address): Promise<boolean> {
  const code = await publicClient.getCode({ address });
  return code !== undefined && code !== '0x';
}

export interface BuildSipaSweepOperationParams {
  sipa: Address;
  /** `relayer` MUST be the operation executor: it is the address the sweep pays, and the executor forwards the payout. */
  sweepArgs: SweepArgs;
  /**
   * The deposit subsidy that drives the sweep through `sweepForSubsidy`, so the sweep is measured and paid the
   * subsidy on top of the fee. Without one the SIPA is swept directly and the operation earns the fee alone.
   */
  depositSubsidy?: Address;
  /** The token the sweep pays the fee and the subsidy in; see `depositPayoutTokenFor`. */
  payoutToken: Address;
  condition: L1OperationCondition;
}

export interface BuildSipaDeployAndSweepOperationParams extends BuildSipaSweepOperationParams {
  /** SIPAFactory the SIPA is deployed through in the deploy+sweep multicall. */
  sipaFactory: Address;
  deployArgs: SipaDeployArgs | LegacySipaDeployArgs;
  multicall3?: Address;
}

/** The sweep sub-call: through the deposit subsidy when there is one, straight at the SIPA otherwise. */
function sweepCall(params: BuildSipaSweepOperationParams): Aggregate3Call {
  return params.depositSubsidy
    ? {
        target: params.depositSubsidy,
        allowFailure: false,
        callData: encodeSweepForSubsidy(params.sipa, params.sweepArgs),
      }
    : { target: params.sipa, allowFailure: false, callData: encodeSweep(params.sweepArgs) };
}

/** Sweeps a SIPA that already has code, in one call. */
export function buildSipaSweepOperation(params: BuildSipaSweepOperationParams): BroadcastL1Operation {
  const sweep = sweepCall(params);
  return {
    target: EthAddress.fromString(sweep.target),
    payoutToken: EthAddress.fromString(params.payoutToken),
    calldata: Buffer.from(sweep.callData.slice(2), 'hex'),
    condition: params.condition,
  };
}

/**
 * Deploys a SIPA and sweeps it in one atomic Multicall3 batch. A SIPA that already has code must be swept with
 * `buildSipaSweepOperation` instead, because a second `deploySIPA` reverts on the create2 collision.
 */
export function buildSipaDeployAndSweepOperation(params: BuildSipaDeployAndSweepOperationParams): BroadcastL1Operation {
  const deploy: Aggregate3Call = {
    target: params.sipaFactory,
    // We allow failure to prevent relayer grief attack where just deploying could prevent relayers from sweeping.
    allowFailure: true,
    callData:
      'recoveryAddress' in params.deployArgs
        ? encodeLegacySipaDeploy(params.deployArgs)
        : encodeDeploySIPA(params.deployArgs),
  };
  return {
    target: EthAddress.fromString(params.multicall3 ?? MULTICALL3_ADDRESS),
    payoutToken: EthAddress.fromString(params.payoutToken),
    calldata: Buffer.from(encodeAggregate3([deploy, sweepCall(params)]).slice(2), 'hex'),
    condition: params.condition,
  };
}
