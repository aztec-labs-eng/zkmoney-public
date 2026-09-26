import type { AztecAddress } from '@aztec/aztec.js/addresses';
import type { AztecNode } from '@aztec/aztec.js/node';
import type { Wallet } from '@aztec/aztec.js/wallet';

import { BroadcasterContract } from '@oxide/noir-contracts.js/Broadcaster';

import type { L1OperationBroadcaster, L1OperationPairBroadcaster } from './broadcaster_calls.js';

export { broadcastL1Operation, broadcastL1OperationPair } from './broadcaster_calls.js';

// Compile-time check: the generated bindings satisfy the structural types of `broadcaster_calls.ts`.
// A contract or codegen change that breaks them fails this build.
type Satisfies<T extends U, U> = T;
type _BindingsSatisfyStructuralTypes = Satisfies<
  BroadcasterContract,
  L1OperationBroadcaster & L1OperationPairBroadcaster
>;

/**
 * Register the Broadcaster with the wallet's PXE and return a handle to it.
 */
export async function registerBroadcaster(
  node: AztecNode,
  wallet: Wallet,
  broadcaster: AztecAddress,
): Promise<BroadcasterContract> {
  const instance = await node.getContract(broadcaster);
  if (!instance) {
    throw new Error(`Broadcaster instance not found at ${broadcaster.toString()}`);
  }
  await wallet.registerContract(instance, BroadcasterContract.artifact);
  return BroadcasterContract.at(broadcaster, wallet);
}
