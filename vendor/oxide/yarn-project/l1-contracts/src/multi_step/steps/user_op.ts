import { UserOpAdapterAbi } from '../../artifacts.js';
import type { PackedUserOperation } from '../../entrypoint.js';
import { type AdapterConfig, NO_TOKEN, adapterSteps } from './step.js';

export function userOpSteps(c: AdapterConfig) {
  const define = adapterSteps(c.address, UserOpAdapterAbi);
  return {
    ...c,
    /** Sign the op with initCode, preVerificationGas, gasFees and paymasterAndData empty. */
    handle(op: Pick<PackedUserOperation, 'sender' | 'nonce' | 'callData' | 'accountGasLimits' | 'signature'>) {
      return define.noPayout({ fn: 'handleUserOp', in: NO_TOKEN, args: () => [op] as const });
    },
  };
}
