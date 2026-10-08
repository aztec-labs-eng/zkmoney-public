import type { AztecAddress } from '@aztec/aztec.js/addresses';
import type { ContractFunctionInteraction } from '@aztec/aztec.js/contracts';
import { Fr } from '@aztec/aztec.js/fields';
import { EthAddress } from '@aztec/foundation/eth-address';

import { THREE_POOL_SWAP_MAX_SLIPPAGE_BPS } from '@oxide/l1-contracts/deposit_tokens.js';
import { predictEscrowAddressLocally } from '@oxide/l1-contracts/escrow.js';
import { type BroadcastL1Operation, L1OperationCondition } from '@oxide/oxide-lib/l1_operation_calldata.js';
import { encodePlainWithdrawalPayload, plainWithdrawalExecutorAmount } from '@oxide/oxide-lib/plain_withdrawal.js';
import { deriveRecoveryCommitment } from '@oxide/oxide-lib/sipa_recovery.js';

import type { Hex } from 'viem';

import { type L1OperationBroadcaster, broadcastL1Operation } from '../broadcaster_calls.js';
import type { Operation } from '../l2_operations.js';

/** What every withdrawal into a counterfactual escrow needs. */
export interface EscrowWithdrawalArgs {
  broadcaster: L1OperationBroadcaster;
  dai: EthAddress;
  from: AztecAddress;
  /** PlainWithdrawalExecutor the withdrawal settles into. It pays the tip and forwards the rest to the escrow. */
  plainWithdrawalExecutor: EthAddress;
  amount: bigint;
  /** DAI the executor pays the relayer that finalizes the withdrawal on L1. */
  withdrawalRelayerTip: bigint;
  proverTip: bigint;
  /** The portal's `FPC_FUNDING_CUT`, which it takes from the withdrawal before it pays the executor. */
  fpcFundingCut: bigint;
  /** Signs the escrow's recovery: ERC-1271 if it has code, else an EOA `personal_sign`. */
  recoveryAccount: EthAddress;
  /** DAI the escrow pays the relayer that calls `deployAndExecute`. */
  relayerTip: bigint;
  /** Fresh randomness if omitted. Give it when you derive `recoverySalt` from it. Never reuse it. */
  nonce?: Hex;
  /**
   * Secret that hides `recoveryAccount` in the escrow address. Give it when the wallet derives it from its own secret
   * and `nonce`, so that a wallet restored from its seed can recover the escrow, as it recovers a SIPA from its shared
   * secret. If you do not give it, the build uses fresh randomness. Do not use one salt for two withdrawals.
   */
  recoverySalt?: Fr;
}

export type EscrowWithdrawal<TEscrowArgs> = {
  /** The counterfactual escrow the withdrawal pays into. */
  escrow: EthAddress;
  /** The values the escrow address commits to. They rebuild the factory call if the broadcast must be sent again. */
  escrowArgs: TEscrowArgs;
  /** The nonce that makes the escrow address unique and unlinkable per withdrawal. */
  nonce: Hex;
  /** Recovery needs it, and nothing on chain reveals it. */
  recoverySalt: Fr;
  /** Pass in `submit`'s `operations`: the withdrawal, addressed to the escrow. */
  operation: Operation;
  /** For `broadcastL1OperationPair` with the withdrawal's own L1 operation. */
  l1Operation: BroadcastL1Operation;
  /** Pass in `submit`'s `teeUnsignedInteractions`: the L1 operation broadcast that executes the escrow. */
  broadcast: ContractFunctionInteraction;
};

type EscrowDeployment<TEscrowArgs> = {
  escrowArgs: TEscrowArgs;
  encodedArgs: Hex;
  deployCalldata: Hex;
};

export type EscrowFundingArgs = Pick<
  EscrowWithdrawalArgs,
  'amount' | 'withdrawalRelayerTip' | 'proverTip' | 'fpcFundingCut' | 'relayerTip'
>;

/** The DAI the withdrawal leaves at the escrow. Throws if `relayerTip` is not below it. */
export function checkedEscrowFunding(args: EscrowFundingArgs): bigint {
  // The factory only executes above the tip, so a tip at or above the funding would leave the operation deferring.
  // A frozen portal takes no cut, so the escrow gets at least this.
  const executorAmount = plainWithdrawalExecutorAmount(args.amount, args.proverTip, args.fpcFundingCut, false);
  const funding = executorAmount - args.withdrawalRelayerTip;
  if (args.relayerTip >= funding) {
    throw new Error(
      `relayerTip (${args.relayerTip}) must be below the escrow funding of ` +
        `amount - proverTip - fpcFundingCut - withdrawalRelayerTip (${funding})`,
    );
  }
  return funding;
}

/** USDC and USDT have 6 decimals. */
const DAI_TO_STABLECOIN_SCALE = 10n ** 12n;
const BPS_DENOMINATOR = 10_000n;

/** The USDC or USDT that the escrow's 3pool swap pays at a 1:1 rate. */
export function swappedAtPeg(args: EscrowFundingArgs): bigint {
  return (checkedEscrowFunding(args) - args.relayerTip) / DAI_TO_STABLECOIN_SCALE;
}

/** The USDC or USDT that the escrow's 3pool swap pays at the swap floor. */
export function swappedAtFloor(args: EscrowFundingArgs): bigint {
  const afterTip = checkedEscrowFunding(args) - args.relayerTip;
  return (afterTip * (BPS_DENOMINATOR - THREE_POOL_SWAP_MAX_SLIPPAGE_BPS)) / BPS_DENOMINATOR / DAI_TO_STABLECOIN_SCALE;
}

/** Builds the withdrawal to the escrow that `escrowFor` returns, and the L1 operation that executes it. */
export function buildEscrowWithdrawal<TEscrowArgs>(
  escrowFor: (escrow: { nonce: Hex; recoveryCommitment: Hex }) => EscrowDeployment<TEscrowArgs>,
  { args, factory }: { args: EscrowWithdrawalArgs; factory: EthAddress },
): EscrowWithdrawal<TEscrowArgs> {
  const { nonce = Fr.random().toString(), recoverySalt = Fr.random() } = args;

  checkedEscrowFunding(args);

  const recoveryCommitment = deriveRecoveryCommitment(recoverySalt, args.recoveryAccount).toString();
  const { escrowArgs, encodedArgs, deployCalldata } = escrowFor({ nonce, recoveryCommitment });
  const escrow = EthAddress.fromString(predictEscrowAddressLocally(factory.toString(), encodedArgs));

  const operation: Operation = {
    kind: 'withdraw',
    from: args.from,
    executor: args.plainWithdrawalExecutor,
    userPayload: encodePlainWithdrawalPayload({ recipient: escrow, relayerTip: args.withdrawalRelayerTip }),
    amount: args.amount,
    proverTip: args.proverTip,
  };
  const l1Operation: BroadcastL1Operation = {
    target: factory,
    payoutToken: args.dai,
    calldata: Buffer.from(deployCalldata.slice(2), 'hex'),
    condition: L1OperationCondition.balance(args.dai, escrow),
  };
  const broadcast = broadcastL1Operation(args.broadcaster, l1Operation);

  return { escrow, escrowArgs, nonce, recoverySalt, operation, l1Operation, broadcast };
}
