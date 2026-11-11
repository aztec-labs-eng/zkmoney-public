import { type Address, type Hex, encodeAbiParameters, encodeFunctionData, keccak256, parseAbiParameters } from 'viem';

import { MultiStepExecutorAbi } from '../artifacts.js';
import type { WithdrawArgs } from '../oxide_portal.js';

export type MultiStepRecovery = {
  portal: Address;
  /** `recover` ignores `relayerPayload`. */
  args: WithdrawArgs;
  recoverySalt: Hex;
  account: Address;
  /** Over the digest: `personal_sign` by an EOA, or ERC-1271 by an account with code. */
  signature: Hex;
  recipient: Address;
  /** Unix seconds. */
  deadline: bigint;
};

/** As `MultiStepExecutor.recover` computes it. */
export function multiStepRecoveryDigest(p: {
  executor: Address;
  chainId: bigint;
  withdrawalId: Hex;
  recipient: Address;
  deadline: bigint;
}): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters('address, uint256, bytes32, address, uint256'), [
      p.executor,
      p.chainId,
      p.withdrawalId,
      p.recipient,
      p.deadline,
    ]),
  );
}

/** Anyone can send it to the executor. */
export function encodeMultiStepRecover(r: MultiStepRecovery): Hex {
  return encodeFunctionData({
    abi: MultiStepExecutorAbi,
    functionName: 'recover',
    args: [r.portal, r.args, r.recoverySalt, r.account, r.signature, r.recipient, r.deadline],
  });
}
