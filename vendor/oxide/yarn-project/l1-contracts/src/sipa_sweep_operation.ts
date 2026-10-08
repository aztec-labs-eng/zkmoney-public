import { MULTI_CALL_3_ADDRESS } from '@aztec/ethereum/contracts';
import { EthAddress } from '@aztec/foundation/eth-address';

import type { BroadcastL1Operation, L1OperationCondition } from '@oxide/oxide-lib/l1_operation_calldata.js';

import {
  type Address,
  type Hex,
  type PublicClient,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  keccak256,
  multicall3Abi,
} from 'viem';

import { DepositSubsidyAbi, SIPAAbi, SIPAFactoryAbi } from './artifacts.js';
import { type LegacySipaDeployArgs, encodeLegacySipaDeploy } from './legacy_sipa.js';
import { type SweepArgs, encodeDeployAndSweepForSubsidy, encodeSweep, encodeSweepForSubsidy } from './sipa.js';
import { type SipaDeployArgs, type SipaIntent, encodeDeploySIPA } from './sipa_factory.js';

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
  /** The SIPA's intent. The deposit subsidy uses it to find the implementation. */
  intent: SipaIntent;
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
 * Deploys a SIPA and sweeps it in one L1 call: `deployAndSweepForSubsidy` with a deposit subsidy and non-legacy
 * `deployArgs`, otherwise a Multicall3 batch. Use `buildSipaSweepOperation` for a SIPA that already has code.
 */
export function buildSipaDeployAndSweepOperation(params: BuildSipaDeployAndSweepOperationParams): BroadcastL1Operation {
  if (params.depositSubsidy && !('recoveryAddress' in params.deployArgs)) {
    const callData = encodeDeployAndSweepForSubsidy(
      {
        intent: params.intent,
        recoveryCommitment: params.deployArgs.recoveryCommitment,
        resweepable: params.deployArgs.resweepable,
      },
      params.sweepArgs,
    );
    return {
      target: EthAddress.fromString(params.depositSubsidy),
      payoutToken: EthAddress.fromString(params.payoutToken),
      calldata: Buffer.from(callData.slice(2), 'hex'),
      condition: params.condition,
    };
  }
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

/** The `deploySIPA` call of a deploy-and-sweep batch: the factory it targets and the args that fix the SIPA address. */
export interface SipaDeployCall {
  factory: Address;
  args: SipaDeployArgs;
}

/** The SIPA and the token a broadcast sweep operation drains, for any of the three sweep shapes. */
export interface SipaSweepTarget {
  sipa: Address;
  token: Address;
  /** Present for a deploy-and-sweep batch, so a reader can predict the SIPA before it has code. */
  deploy?: SipaDeployCall;
}

/**
 * Decode the SIPA and the token of a sweep operation: `sweep(...)` on the SIPA, `sweepForSubsidy(sipa, ...)` on the
 * deposit subsidy, or a Multicall3 `aggregate3` batch that holds one of the two. Undefined for any other operation.
 */
export function decodeSipaSweepOperation(operation: BroadcastL1Operation): SipaSweepTarget | undefined {
  const target = getAddress(operation.target.toString());
  const data: Hex = `0x${operation.calldata.toString('hex')}`;
  const batch = decodeAggregate3(data);
  if (batch === undefined) {
    return decodeSweepCall(target, data);
  }
  const sweep = batch
    .map(call => decodeSweepCall(getAddress(call.target), call.callData))
    .find(call => call !== undefined);
  const deploy = batch
    .map(call => decodeDeployCall(getAddress(call.target), call.callData))
    .find(call => call !== undefined);
  return sweep === undefined || deploy === undefined ? sweep : { ...sweep, deploy };
}

/** A `deployAndSweepForSubsidy` operation. The call carries no SIPA address, so a reader derives it on chain. */
export interface SubsidizedDeployAndSweep {
  depositSubsidy: Address;
  token: Address;
  intent: SipaIntent;
  intentHash: Hex;
  recoveryCommitment: Hex;
  resweepable: boolean;
}

/** Decode a `deployAndSweepForSubsidy` operation. Undefined for any other operation. */
export function decodeSubsidizedDeployAndSweep(operation: BroadcastL1Operation): SubsidizedDeployAndSweep | undefined {
  try {
    const decoded = decodeFunctionData({ abi: DepositSubsidyAbi, data: `0x${operation.calldata.toString('hex')}` });
    if (decoded.functionName === 'deployAndSweepForSubsidy') {
      const [intent, recoveryCommitment, resweepable, token, , intentData] = decoded.args;
      return {
        depositSubsidy: getAddress(operation.target.toString()),
        token: getAddress(token),
        intent: intent as SipaIntent,
        intentHash: keccak256(intentData),
        recoveryCommitment,
        resweepable,
      };
    }
  } catch {
    /* not a subsidized deploy-and-sweep */
  }
  return undefined;
}

function decodeDeployCall(factory: Address, data: Hex): SipaDeployCall | undefined {
  try {
    const decoded = decodeFunctionData({ abi: SIPAFactoryAbi, data });
    if (decoded.functionName === 'deploySIPA') {
      const [implementation, intentHash, recoveryCommitment, rollupVersion, resweepable] = decoded.args;
      return {
        factory,
        args: {
          implementation: getAddress(implementation),
          intentHash,
          recoveryCommitment,
          rollupVersion,
          resweepable,
        },
      };
    }
  } catch {
    /* not a deploy call */
  }
  return undefined;
}

function decodeAggregate3(data: Hex): Aggregate3Call[] | undefined {
  try {
    const decoded = decodeFunctionData({ abi: multicall3Abi, data });
    return decoded.functionName === 'aggregate3' ? [...decoded.args[0]] : undefined;
  } catch {
    return undefined;
  }
}

function decodeSweepCall(target: Address, data: Hex): SipaSweepTarget | undefined {
  try {
    const subsidy = decodeFunctionData({ abi: DepositSubsidyAbi, data });
    if (subsidy.functionName === 'sweepForSubsidy') {
      return { sipa: getAddress(subsidy.args[0]), token: getAddress(subsidy.args[1]) };
    }
  } catch {
    /* not a subsidy call */
  }
  try {
    const sweep = decodeFunctionData({ abi: SIPAAbi, data });
    if (sweep.functionName === 'sweep') {
      return { sipa: target, token: getAddress(sweep.args[0]) };
    }
  } catch {
    /* not a sweep call */
  }
  return undefined;
}
