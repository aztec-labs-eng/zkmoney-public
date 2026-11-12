import {
  type Abi,
  type Address,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type ContractFunctionReturnType,
  type EncodeFunctionDataParameters,
  type EncodeFunctionResultParameters,
  encodeFunctionData,
  encodeFunctionResult,
  keccak256,
} from 'viem';

import { CheckAdapterAbi } from '../../artifacts.js';
import { type AdapterConfig, NO_TOKEN, adapterSteps } from './step.js';

export function checkSteps(c: AdapterConfig) {
  const define = adapterSteps(c.address, CheckAdapterAbi);
  return {
    ...c,
    /** Reverts unless `read` returns `result`. */
    holds<const abi extends Abi, fn extends ContractFunctionName<abi, 'pure' | 'view'>>(
      read: { address: Address; abi: abi; functionName: fn; args: ContractFunctionArgs<abi, 'pure' | 'view', fn> },
      result: ContractFunctionReturnType<abi, 'pure' | 'view', fn>,
    ) {
      const { address, ...call } = read;
      const data = encodeFunctionData(call as EncodeFunctionDataParameters);
      const resultHash = keccak256(encodeFunctionResult({ ...call, result } as EncodeFunctionResultParameters));
      return define.noPayout({ fn: 'check', in: NO_TOKEN, args: () => [address, data, resultHash] as const });
    },
  };
}
