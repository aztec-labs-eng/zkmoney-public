import type { AztecAddress } from '@aztec/aztec.js/addresses';
import type { ContractFunctionInteraction } from '@aztec/aztec.js/contracts';
import { Fr } from '@aztec/aztec.js/fields';
import { EthAddress } from '@aztec/foundation/eth-address';

import {
  type SwapEscrowArgs,
  type SwapRoute,
  encodeSwapEscrowDeploy,
  predictSwapEscrowAddressLocally,
} from '@oxide/l1-contracts';
import { type BroadcastL1Operation, L1OperationCondition } from '@oxide/oxide-lib/l1_operation_calldata.js';
import { encodePlainWithdrawalPayload } from '@oxide/oxide-lib/plain_withdrawal.js';
import { deriveRecoveryCommitment } from '@oxide/oxide-lib/sipa_recovery.js';

import type { Hex } from 'viem';

import { type L1OperationBroadcaster, broadcastL1Operation } from './broadcaster_calls.js';
import type { Operation } from './l2_operations.js';

export interface SwapOnWithdrawArgs {
  broadcaster: L1OperationBroadcaster;
  swapEscrowFactory: EthAddress;
  /** The withdrawn L1 token — the escrow's swap input and the relayer's payout token. */
  dai: EthAddress;
  from: AztecAddress;
  /** PlainWithdrawalExecutor the withdrawal settles into; it pays the tip and forwards the rest to the escrow. */
  plainWithdrawalExecutor: EthAddress;
  amount: bigint;
  /** DAI the executor pays the relayer that finalizes the withdrawal on L1. */
  withdrawalRelayerTip: bigint;
  proverTip: bigint;
  route: SwapRoute;
  /** Final L1 recipient of the swap output (must accept ETH on the ETH route). */
  l1Recipient: EthAddress;
  /**
   * Address that signs the recovery of funds the route cannot deliver: ERC-1271 if it has code, else an EOA
   * `personal_sign`.
   */
  recoveryAccount: EthAddress;
  /** DAI the escrow pays whoever completes the swap; the relayer's incentive to call `deployAndExecute`. */
  relayerTip: bigint;
  /**
   * Escrow nonce. Give it when you derive other values from the nonce before the build, for example `recoverySalt`.
   * If you do not give it, the build uses fresh randomness. Do not use one nonce for two withdrawals.
   */
  nonce?: Hex;
  /**
   * Secret that hides `recoveryAccount` in the escrow address. Give it when the wallet derives it from its own secret
   * and `nonce`, so that a wallet restored from its seed can recover the escrow, as it recovers a SIPA from its shared
   * secret. If you do not give it, the build uses fresh randomness. Do not use one salt for two withdrawals.
   */
  recoverySalt?: Fr;
}

export interface SwapOnWithdraw {
  /** The counterfactual escrow the withdrawal pays into. */
  escrow: EthAddress;
  /** The values the escrow address commits to. They rebuild the factory call if the broadcast must be sent again. */
  escrowArgs: SwapEscrowArgs;
  /** The nonce that makes the escrow address unique and unlinkable per withdrawal. */
  nonce: Hex;
  /**
   * The secret that hides `recoveryAccount` in the escrow address. Recovery needs it, and nothing on chain reveals it:
   * keep it with `nonce`, or derive it again from the wallet secret.
   */
  recoverySalt: Fr;
  /** Pass in `submit`'s `operations`: the withdrawal, addressed to the escrow. */
  operation: Operation;
  /**
   * The L1 operation that completes the swap. Use it to broadcast the swap in one pair with the withdrawal's own L1
   * operation (`broadcastL1OperationPair`).
   */
  l1Operation: BroadcastL1Operation;
  /** Pass in `submit`'s `teeUnsignedInteractions`: the L1 operation broadcast completing the swap. */
  broadcast: ContractFunctionInteraction;
}

/**
 * Build the two halves of a swap-on-withdraw so they ride one L2 tx: a withdrawal to the counterfactual
 * `SwapEscrow` address committed to `(route, l1Recipient, recoveryCommitment, relayerTip, nonce)`, and an L1 operation
 * broadcast telling the permissionless `SwapEscrowFactory` to deploy that escrow and run the swap once the withdrawal
 * lands.
 */
export function buildSwapOnWithdraw(args: SwapOnWithdrawArgs): SwapOnWithdraw {
  const {
    broadcaster,
    swapEscrowFactory,
    dai,
    from,
    plainWithdrawalExecutor,
    amount,
    withdrawalRelayerTip,
    proverTip,
    route,
    l1Recipient,
    recoveryAccount,
    relayerTip,
    nonce = Fr.random().toString(),
    recoverySalt = Fr.random(),
  } = args;

  // The escrow receives at most `amount - withdrawalRelayerTip - proverTip`; the factory only executes once that
  // balance covers the tip and buys the swap something, so a tip at or above the funding would leave the operation
  // deferring forever.
  const escrowFunding = amount - withdrawalRelayerTip - proverTip;
  if (relayerTip >= escrowFunding) {
    throw new Error(
      `buildSwapOnWithdraw: relayerTip (${relayerTip}) must be below the escrow funding of ` +
        `amount - withdrawalRelayerTip - proverTip (${escrowFunding})`,
    );
  }

  const escrowArgs: SwapEscrowArgs = {
    route,
    recipient: l1Recipient.toString(),
    recoveryCommitment: deriveRecoveryCommitment(recoverySalt, recoveryAccount).toString(),
    relayerTip,
    nonce,
  };
  const escrow = EthAddress.fromString(predictSwapEscrowAddressLocally(swapEscrowFactory.toString(), escrowArgs));

  const operation: Operation = {
    kind: 'withdraw',
    from,
    executor: plainWithdrawalExecutor,
    userPayload: encodePlainWithdrawalPayload({ recipient: escrow, relayerTip: withdrawalRelayerTip }),
    amount,
    proverTip,
  };
  const l1Operation: BroadcastL1Operation = {
    target: swapEscrowFactory,
    payoutToken: dai,
    calldata: Buffer.from(encodeSwapEscrowDeploy(escrowArgs).slice(2), 'hex'),
    condition: L1OperationCondition.balance(dai, escrow),
  };
  const broadcast = broadcastL1Operation(broadcaster, l1Operation);

  return { escrow, escrowArgs, nonce, recoverySalt, operation, l1Operation, broadcast };
}
