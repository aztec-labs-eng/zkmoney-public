// A hack until v6 handles multi-token Balance conditions properly:
// https://linear.app/aztec-labs/issue/OX-1877/for-v6-handle-multi-token-balance-condition-l1-operations-properly
import type { EthAddress } from '@aztec/aztec.js/addresses';

import {
  DepositSubsidyAbi,
  SIPAAbi,
  type SipaIntent,
  encodeAggregate3,
  encodeDeployAndSweepForSubsidy,
  encodeSweep,
  encodeSweepForSubsidy,
} from '@oxide/l1-contracts';
import {
  type BroadcastL1Operation,
  L1OperationCondition,
  L1OperationConditionKind,
} from '@oxide/oxide-lib/l1_operation_calldata.js';

import {
  type Abi,
  type Address,
  type DecodeFunctionDataReturnType,
  type Hex,
  decodeFunctionData,
  multicall3Abi,
} from 'viem';

/**
 * A client does not know which supported token a user sends to a SIPA, so it broadcasts one SIPA sweep with a Balance
 * condition on any one token. Returns that sweep and one copy of it for each other watched token. Returns every
 * other operation unchanged.
 */
export function copyForEachWatchedToken(
  operation: BroadcastL1Operation,
  watchedTokens: EthAddress[],
): BroadcastL1Operation[] {
  const { condition } = operation;
  if (condition.kind !== L1OperationConditionKind.Balance) {
    return [operation];
  }
  // Empty when the operation is not a SIPA sweep.
  const copies = watchedTokens
    .filter(token => !token.equals(condition.token))
    .flatMap(token => withSweepToken(operation, token) ?? []);
  return [operation, ...copies];
}

/** A copy of the SIPA sweep `operation` that sweeps `token` and waits for it. Undefined when it is not a sweep. */
function withSweepToken(operation: BroadcastL1Operation, token: EthAddress): BroadcastL1Operation | undefined {
  const calldata = replaceSweepToken(`0x${operation.calldata.toString('hex')}`, token.toString() as Address);
  if (calldata === undefined) {
    return undefined;
  }
  return {
    ...operation,
    calldata: Buffer.from(calldata.slice(2), 'hex'),
    condition: L1OperationCondition.balance(token, operation.condition.recipient),
  };
}

/** The sweep calldata `data` with `token` as the swept token. Undefined when `data` is not a sweep. */
function replaceSweepToken(data: Hex, token: Address): Hex | undefined {
  const sipaCall = tryDecode(SIPAAbi, data);
  if (sipaCall?.functionName === 'sweep') {
    const [, relayer, intentData, proofs] = sipaCall.args;
    return encodeSweep({ token, relayer, intentData, proofs });
  }

  const subsidyCall = tryDecode(DepositSubsidyAbi, data);
  if (subsidyCall?.functionName === 'sweepForSubsidy') {
    const [sipa, , relayer, intentData, proofs] = subsidyCall.args;
    return encodeSweepForSubsidy(sipa, { token, relayer, intentData, proofs });
  }
  if (subsidyCall?.functionName === 'deployAndSweepForSubsidy') {
    const [intent, recoveryCommitment, resweepable, , relayer, intentData, proofs] = subsidyCall.args;
    return encodeDeployAndSweepForSubsidy(
      { intent: intent as SipaIntent, recoveryCommitment, resweepable },
      { token, relayer, intentData, proofs },
    );
  }

  // A deploy-and-sweep batch: only its sweep sub-call changes.
  const batch = tryDecode(multicall3Abi, data);
  if (batch?.functionName === 'aggregate3') {
    let hasSweep = false;
    const calls = batch.args[0].map(call => {
      const callData = replaceSweepToken(call.callData, token);
      hasSweep ||= callData !== undefined;
      return { ...call, callData: callData ?? call.callData };
    });
    return hasSweep ? encodeAggregate3(calls) : undefined;
  }

  return undefined;
}

/** Decodes `data` as a call to a function of `abi`. Undefined when no function of `abi` has its selector. */
function tryDecode<const abi extends Abi>(abi: abi, data: Hex): DecodeFunctionDataReturnType<abi> | undefined {
  try {
    return decodeFunctionData({ abi, data });
  } catch {
    return undefined;
  }
}
