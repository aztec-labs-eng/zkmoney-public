import type { AztecAddress, EthAddress } from '@aztec/aztec.js/addresses';
import type { AuthWitness } from '@aztec/aztec.js/authorization';
import {
  BatchCall,
  type Contract,
  type ContractFunctionInteraction,
  type WaitOpts,
  toSimulateOptions,
} from '@aztec/aztec.js/contracts';
import type { FeePaymentMethod } from '@aztec/aztec.js/fee';
import { Fr } from '@aztec/aztec.js/fields';
import type { Wallet } from '@aztec/aztec.js/wallet';
import type { ContractArtifact } from '@aztec/stdlib/abi';
import { Capsule, type SimulationStats, type TxReceipt } from '@aztec/stdlib/tx';

import { getUserPayloadHash } from '@oxide/oxide-lib/content_hash.js';
import { assertPlainWithdrawalTip, decodePlainWithdrawalPayload } from '@oxide/oxide-lib/plain_withdrawal.js';
import type { SignTokenOperationOutput, SpentDeposit, TeeSigner, TokenOperation } from '@oxide/oxide-lib/types.js';
import { TEEMetadata } from '@oxide/oxide-lib/types.js';

import {
  buildNoteSignatureCapsule,
  buildPlainExecutorUserPayloadCapsules,
  buildSeedCapsule,
  buildStrictModeCapsule,
  buildTeeMetadataCapsule,
  buildTeeNotesCapsule,
  buildTeeRequiredNullifiersCapsule,
  buildTeeWithdrawalMessageHashesCapsule,
  buildWithdrawalSignatureCapsule,
} from './capsules.js';
import type { ChainDataSource } from './chain_data_source.js';
import {
  type DepositSpendMetadataResolver,
  type SpendMetadataResolver,
  buildTokenOperation,
  collectAccountingEffects,
} from './token_operations_collector.js';

/**
 * Wallet + node context shared across submissions.
 */
export interface L2SubmitContext {
  wallet: Wallet;
  chain: ChainDataSource;
  /**
   * Fee payment for the submission; unset pays from the sender's own fee-juice balance. Configurable because the
   * deployment scripts pay the fee directly and the operation scripts use the FPC.
   */
  paymentMethod?: FeePaymentMethod;
}

/**
 * One contract call within a submission's operation list. Each variant maps to exactly one
 * `OxideTokenContract` method; the portal assertions (deposits, withdrawals) the TEE balance
 * invariant checks are inferred from the variants present.
 */
export type Operation =
  | {
      kind: 'transfer';
      from: AztecAddress;
      to: AztecAddress;
      amount: bigint;
      meta?: Fr[];
      authwitNonce?: Fr;
    }
  | {
      kind: 'withdraw';
      from: AztecAddress;
      executor: EthAddress;
      userPayload: Buffer;
      amount: bigint;
      proverTip: bigint;
      /** `withdraw`'s passthrough blob, delivered back to `from` as the `Withdraw` event. Zero-filled when absent. */
      meta?: Fr[];
      authwitNonce?: Fr;
    };

/**
 * Pipeline phases of {@link submit}, in order. `prove-and-send` re-executes the private calls inside the wallet
 * before broadcasting; the PXE serves that re-execution from cache when no block has landed since `simulate`.
 */
export type SubmitPhase = 'simulate' | 'hydrate' | 'prove-and-send';

export interface SubmitResult {
  receipt: TxReceipt;
  /** Fully hydrated and signed operation for this token (notes, withdrawals, deposits, etc.). */
  tokenOperation: TokenOperation;
  /** TEE signatures, indexed in operation order. */
  signOutput: SignTokenOperationOutput;
  /** PXE timings + node-call stats for the simulation pass; populated when `collectStats` is set. */
  simulationStats?: SimulationStats;
}

export function getTransferMetaLen(artifact: ContractArtifact): number {
  return getMetaLen(artifact, 'transfer');
}

export function getWithdrawMetaLen(artifact: ContractArtifact): number {
  return getMetaLen(artifact, 'withdraw');
}

function getMetaLen(artifact: ContractArtifact, fn: string): number {
  const meta = artifact.functions.find(f => f.name === fn)?.parameters.find(p => p.name === 'meta');
  if (meta?.type.kind !== 'array') {
    throw new Error(`${fn}(meta) array parameter not found in contract artifact`);
  }
  return meta.type.length;
}

function buildOperationCall(
  contract: Contract,
  op: Operation,
  authwitNonce: Fr,
  capsules: Capsule[],
  authWitnesses: AuthWitness[] = [],
): ContractFunctionInteraction {
  switch (op.kind) {
    case 'transfer':
      return contract.methods
        .transfer(
          op.from,
          op.to,
          op.amount,
          op.meta ?? Array(getTransferMetaLen(contract.artifact)).fill(Fr.ZERO),
          authwitNonce,
        )
        .with({ capsules, authWitnesses });
    case 'withdraw':
      return contract.methods
        .withdraw(
          op.from,
          op.executor,
          getUserPayloadHash(op.userPayload),
          op.amount,
          op.proverTip,
          op.meta ?? Array(getWithdrawMetaLen(contract.artifact)).fill(Fr.ZERO),
          authwitNonce,
        )
        .with({ capsules, authWitnesses });
  }
}

/**
 * Build, simulate, sign, and submit a batched operation against one token as a single tx.
 */
export async function submit(
  ctx: L2SubmitContext,
  from: AztecAddress,
  args: {
    contract: Contract;
    signer: TeeSigner;
    operations: Operation[];
    resolveSpendMetadata?: SpendMetadataResolver;
    resolveDepositSpendMetadata?: DepositSpendMetadataResolver;
    /**
     * Extra calls appended after the `Operation` calls in both the simulation and the real batch. Not covered by
     * the TEE signature (effects collection filters by the token contract address). Main use case: broadcasting
     * an L1 operation to relayers alongside a withdrawal (see `buildSwapOnWithdraw`).
     */
    teeUnsignedInteractions?: ContractFunctionInteraction[];
    /** Observability hook fired as the pipeline enters each {@link SubmitPhase}. */
    onPhase?: (phase: SubmitPhase) => void;
    /** Ask the wallet for simulation metadata; exposed as {@link SubmitResult.simulationStats}. */
    collectStats?: boolean;
    /** Mining-wait options for the final send (timeout, poll interval). */
    wait?: WaitOpts;
    plainWithdrawalExecutor?: EthAddress;
    fpcFundingCut?: bigint;
    portalFrozen?: boolean;
  },
): Promise<SubmitResult> {
  const {
    contract,
    signer,
    operations,
    resolveSpendMetadata,
    resolveDepositSpendMetadata,
    teeUnsignedInteractions = [],
    onPhase,
    collectStats,
    wait,
    plainWithdrawalExecutor,
    fpcFundingCut,
    portalFrozen = false,
  } = args;
  if (operations.length === 0) {
    throw new Error('submit called with no operations');
  }
  const withdrawOps = operations.filter(isWithdrawOperation);
  assertPlainWithdrawals(withdrawOps, { plainWithdrawalExecutor, fpcFundingCut, portalFrozen });
  const { wallet, chain } = ctx;

  // Per-op authwit nonces are fixed up front: the witness signs the exact call args, so the sim and real
  // passes must share them.
  const authwitNonces = operations.map(op => (op.from.equals(from) ? Fr.zero() : (op.authwitNonce ?? Fr.random())));
  // Delegated owners' private state (account keys, notes) must be accessible while their account contracts
  // validate the authwits and their notes are spent.
  const additionalScopes = [
    ...new Map(operations.filter(op => !op.from.equals(from)).map(op => [op.from.toString(), op.from])).values(),
  ];
  // One witness per delegated op
  const authWitnesses: AuthWitness[][] = await Promise.all(
    operations.map(async (op, i) => {
      if (op.from.equals(from)) {
        return [];
      }
      const call = await buildOperationCall(contract, op, authwitNonces[i], []).getFunctionCall();
      return [await wallet.createAuthWit(op.from, { caller: from, call })];
    }),
  );

  const seedCapsule = buildSeedCapsule(contract.address);

  // 1. Build + run simulation.
  onPhase?.('simulate');
  const simBatchCalls: ContractFunctionInteraction[] = [];
  operations.forEach((op, i) => {
    simBatchCalls.push(buildOperationCall(contract, op, authwitNonces[i], [seedCapsule], authWitnesses[i]));
  });
  simBatchCalls.push(...teeUnsignedInteractions);

  const simPayload = await new BatchCall(wallet, simBatchCalls).request();
  const simResult = await wallet.simulateTx(
    simPayload,
    toSimulateOptions({ from, additionalScopes, includeMetadata: collectStats }),
  );
  const anchorBlockHeader = simResult.publicInputs.constants.anchorBlockHeader;
  const anchorBlockHash = await anchorBlockHeader.hash();

  // 2. Effects collection (filters offchain effects by contract address).
  onPhase?.('hydrate');
  const collected = collectAccountingEffects(contract.address, simResult.offchainEffects);

  const deposits: SpentDeposit[] = [];
  if (collected.deposits.length > 0 && !resolveDepositSpendMetadata) {
    throw new Error(
      `submit: produced ${collected.deposits.length} deposit spend(s) but no resolveDepositSpendMetadata was supplied`,
    );
  }
  for (const spent of collected.deposits) {
    const witness = await chain.getL1ToL2MessageMembershipWitness(anchorBlockHash, spent.messageHash);
    if (!witness) {
      throw new Error(`No L1->L2 membership witness for deposit message ${spent.messageHash}`);
    }
    const [witnessLeafIndex, siblingPath] = witness;
    if (witnessLeafIndex !== spent.inboxIndex) {
      throw new Error(
        `Deposit witness leaf index ${witnessLeafIndex} does not match deposit effect leaf index ${spent.inboxIndex}`,
      );
    }
    const metadata = await resolveDepositSpendMetadata!(spent.recipient);
    deposits.push({
      recipient: spent.recipient,
      recipientAddressPreimage: metadata.ownerAddressPreimage,
      masterNullifierHidingKey: metadata.masterNullifierHidingKey,
      amount: spent.amount,
      sharedSecretSalt: spent.sharedSecretSalt,
      messageLeafIndex: spent.inboxIndex,
      siblingPath: siblingPath.toTuple(),
    });
  }

  // Spend metadata for nullified notes.
  let spendMetadata: Awaited<ReturnType<SpendMetadataResolver>>[] = [];
  if (collected.nullifiedNotes.length > 0) {
    if (!resolveSpendMetadata) {
      throw new Error(
        `submit: produced ${collected.nullifiedNotes.length} nullified note(s) but no resolveSpendMetadata was supplied`,
      );
    }
    spendMetadata = await Promise.all(collected.nullifiedNotes.map(resolveSpendMetadata));
  }

  // 3. TokenOperation + TEE sign.
  const tokenOperation = await buildTokenOperation(
    chain,
    contract.address,
    anchorBlockHeader,
    collected,
    spendMetadata,
    { deposits },
  );
  const signOutput = await signer.signTokenOperation(tokenOperation);
  const { signatures, requiredNullifiers, teeNotes, withdrawalMessageHashes } = signOutput;

  // 4. Build + run the real send.
  // Real signature capsules cover post-squash insertions; dummies cover transient pairs.
  const sigCapsules = await Promise.all(
    tokenOperation.createdNotes.map((note, j) =>
      buildNoteSignatureCapsule(contract.address, note.randomness, signatures[j]),
    ),
  );
  const dummyCapsules = await Promise.all(
    collected.squashedTransientNotes.map(note =>
      buildNoteSignatureCapsule(contract.address, note.randomness, {
        sLo: Fr.zero(),
        sHi: Fr.zero(),
        rLo: Fr.zero(),
        rHi: Fr.zero(),
      }),
    ),
  );

  // `publish_withdrawal` (called from `withdraw`) reads the withdrawal signature from a capsule keyed
  // by the withdraw content hash and emits it in the published withdrawal log, so a third party
  // can finalize on L1 from just the burn tx hash. Source `randomness` from the collected
  // withdrawal effects (in contract-walk order) so the slot the client picks here is the slot
  // the contract's submit-pass `next_randomness` sequence lands on.
  const withdrawalSigCapsules = await Promise.all(
    tokenOperation.withdrawals.map((withdrawal, k) =>
      buildWithdrawalSignatureCapsule(contract.address, withdrawal, signOutput.withdrawalSignatures[k]),
    ),
  );
  // TEMPORARY: see the plain-executor user payload block in `capsules.ts`.
  const plainExecutorUserPayloadCapsules = await buildPlainExecutorUserPayloadCapsules(
    contract.address,
    tokenOperation.withdrawals,
    withdrawOps.map(op => op.userPayload),
    plainWithdrawalExecutor,
  );

  const realCallCapsules = [
    seedCapsule,
    buildStrictModeCapsule(contract.address),
    ...sigCapsules,
    ...dummyCapsules,
    ...withdrawalSigCapsules,
    ...plainExecutorUserPayloadCapsules,
  ];

  const realBatchCalls: ContractFunctionInteraction[] = [];
  operations.forEach((op, i) => {
    realBatchCalls.push(buildOperationCall(contract, op, authwitNonces[i], realCallCapsules, authWitnesses[i]));
  });
  realBatchCalls.push(...teeUnsignedInteractions);
  realBatchCalls.push(
    contract.methods.publish_da().with({
      capsules: [
        buildTeeNotesCapsule(contract.address, teeNotes),
        buildTeeRequiredNullifiersCapsule(contract.address, requiredNullifiers),
        buildTeeMetadataCapsule(
          contract.address,
          TEEMetadata.fromPublicKey(signer.publicKey, await tokenOperation.anchorBlockHeader.hash()),
        ),
        buildTeeWithdrawalMessageHashesCapsule(contract.address, withdrawalMessageHashes),
      ],
    }),
  );

  onPhase?.('prove-and-send');
  const { receipt } = await new BatchCall(wallet, realBatchCalls).send({
    from,
    additionalScopes,
    fee: ctx.paymentMethod && { paymentMethod: ctx.paymentMethod },
    wait,
  });

  return {
    receipt,
    tokenOperation,
    signOutput,
    simulationStats: simResult.stats,
  };
}

/** The fields of a withdraw operation that the plain-withdrawal checks use. */
export type PlainWithdrawalOperation = Pick<
  Extract<Operation, { kind: 'withdraw' }>,
  'executor' | 'userPayload' | 'amount' | 'proverTip'
>;

/**
 * Reject a plain withdrawal whose relayer tip is more than the executor gets. The executor call reverts on L1 for
 * such a withdrawal, and nobody can release the burn. Withdrawals through other executors are not checked.
 */
export function assertPlainWithdrawals(
  withdrawals: PlainWithdrawalOperation[],
  args: { plainWithdrawalExecutor?: EthAddress; fpcFundingCut?: bigint; portalFrozen?: boolean },
): void {
  const { plainWithdrawalExecutor, fpcFundingCut, portalFrozen = false } = args;
  for (const withdrawal of withdrawals) {
    if (!plainWithdrawalExecutor || !withdrawal.executor.equals(plainWithdrawalExecutor)) {
      continue;
    }
    if (fpcFundingCut === undefined) {
      throw new Error('Plain withdrawals require the current Portal funding cut.');
    }
    assertPlainWithdrawalTip(
      withdrawal.amount,
      withdrawal.proverTip,
      decodePlainWithdrawalPayload(withdrawal.userPayload).relayerTip,
      fpcFundingCut,
      portalFrozen,
    );
  }
}

function isWithdrawOperation(op: Operation): op is Extract<Operation, { kind: 'withdraw' }> {
  return op.kind === 'withdraw';
}
