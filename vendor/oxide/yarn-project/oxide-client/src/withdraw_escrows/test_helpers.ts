import type { ContractFunctionInteraction } from '@aztec/aztec.js/contracts';

import { L1_OPERATION_BROADCAST_TIERS } from '@oxide/oxide-lib/l1_operation_calldata.js';

import type { L1OperationBroadcaster } from '../broadcaster_calls.js';

export function fakeBroadcaster(): L1OperationBroadcaster {
  type Methods = L1OperationBroadcaster['methods'];
  const broadcast: Methods[keyof Methods] = () => ({}) as ContractFunctionInteraction;
  const methods = Object.fromEntries(L1_OPERATION_BROADCAST_TIERS.map(tier => [tier.method, broadcast])) as Methods;
  return { methods };
}
