import type { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { EthAddress } from '@aztec-labs/foundation/eth-address';

import { type CompiledRoute, encodeMultiStepPayload } from '@oxide/l1-contracts/multi_step/index.js';
import { withdrawalExecutionAmount } from '@oxide/oxide-lib/executor.js';
import { deriveRecoveryCommitment } from '@oxide/oxide-lib/sipa_recovery.js';

import type { WithdrawOperation } from '../l2_operations.js';
import type { FinalizationRequestBroadcastParams } from '../withdrawal_finalization_request.js';

export type MultiStepWithdrawalArgs = {
  from: AztecAddress;
  /** The deployment's `MultiStepExecutor`. */
  executor: EthAddress;
  amount: bigint;
  proverTip: bigint;
  /** Paid to the relayer that finalizes on L1. 0 for self-relay. */
  relayerTip: bigint;
  /** Paid to the fee pool after `relayerTip` and before the route's transfers. With a zero amount, the build ignores `beneficiary`. */
  feePoolCut: FeePoolCut;
  compiledRoute: CompiledRoute;
  /** Signs `recover`: ERC-1271 if it has code, else `personal_sign`. */
  recoveryAccount: EthAddress;
  /** Hides `recoveryAccount` in the payload. Fresh randomness if omitted. Do not use one salt for two withdrawals. */
  recoverySalt?: Fr;
  finalizationRequestBroadcastParams?: FinalizationRequestBroadcastParams;
  recoveryMemo?: Buffer;
  authwitNonce?: Fr;
};

export type FeePoolCut = {
  amount: bigint;
  beneficiary: EthAddress;
};

export type MultiStepWithdrawal = {
  operation: WithdrawOperation;
  /** Recovery needs it, and nothing on chain reveals it. */
  recoverySalt: Fr;
};

/** The amount less the prover tip, `relayerTip`, `feePoolCut` and the fixed lanes. Throws at zero, since steps need funds. */
export function checkedMultiStepRemainder(p: {
  amount: bigint;
  proverTip: bigint;
  relayerTip: bigint;
  feePoolCut: bigint;
  fixed: readonly bigint[];
}) {
  const netAmount = withdrawalExecutionAmount(p.amount, p.proverTip);
  const fixedSpend = p.fixed.reduce((sum, amount) => sum + amount, p.relayerTip + p.feePoolCut);
  if (fixedSpend >= netAmount) {
    throw new Error(
      `relayerTip, feePoolCut and the fixed lanes (${fixedSpend}) must be below amount - proverTip (${netAmount})`,
    );
  }
  return netAmount - fixedSpend;
}

/** A withdrawal through the `MultiStepExecutor`. */
export function buildMultiStepWithdrawal(args: MultiStepWithdrawalArgs): MultiStepWithdrawal {
  if (args.recoveryAccount.isZero()) {
    throw new Error('A zero recoveryAccount cannot sign recover, so stuck funds would be lost');
  }
  // Run only for its throw: the remainder lane must get something.
  checkedMultiStepRemainder({
    amount: args.amount,
    proverTip: args.proverTip,
    relayerTip: args.relayerTip,
    feePoolCut: args.feePoolCut.amount,
    fixed: args.compiledRoute.transfers.map(t => t.amount),
  });
  const recoverySalt = args.recoverySalt ?? Fr.random();
  const userPayload = encodeMultiStepPayload({
    ...args.compiledRoute,
    transfers: [...feePoolCutTransfers(args.feePoolCut), ...args.compiledRoute.transfers],
    relayerTip: args.relayerTip,
    recoveryCommitment: deriveRecoveryCommitment(recoverySalt, args.recoveryAccount).toString(),
  });
  const operation: WithdrawOperation = {
    kind: 'withdraw',
    from: args.from,
    executor: args.executor,
    userPayload,
    amount: args.amount,
    proverTip: args.proverTip,
    finalizationRequestBroadcastParams: args.finalizationRequestBroadcastParams,
    recoveryMemo: args.recoveryMemo,
    authwitNonce: args.authwitNonce,
  };
  return { operation, recoverySalt };
}

function feePoolCutTransfers(cut: FeePoolCut) {
  if (cut.amount === 0n) {
    return [];
  }
  if (cut.beneficiary.isZero()) {
    throw new Error('A fee pool cut needs a beneficiary, else the executor rejects the transfer');
  }
  return [{ amount: cut.amount, recipient: cut.beneficiary.toChecksumString() }];
}
