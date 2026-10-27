import { Fr, GrumpkinScalar } from '@aztec-labs/aztec.js/fields';
import { DomainSeparator, L1_TO_L2_MSG_TREE_HEIGHT } from '@aztec-labs/constants';
import { Buffer32 } from '@aztec-labs/foundation/buffer';
import { Grumpkin } from '@aztec-labs/foundation/crypto/grumpkin';
import { poseidon2Hash } from '@aztec-labs/foundation/crypto/poseidon';
import { sha256 } from '@aztec-labs/foundation/crypto/sha256';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import { CompleteAddress } from '@aztec-labs/stdlib/contract';
import { computeL2ToL1MessageHash } from '@aztec-labs/stdlib/hash';
import { type PublicKeys, computeAddress, deriveKeys, derivePublicKeyFromSecretKey } from '@aztec-labs/stdlib/keys';
import { AppendOnlyTreeSnapshot, NullifierLeaf, NullifierLeafPreimage } from '@aztec-labs/stdlib/trees';
import { BlockHeader, GlobalVariables, PartialStateReference, StateReference, TxEffect } from '@aztec-labs/stdlib/tx';

import {
  type AccountInstancePreimage,
  type PasskeyPublicKey,
  type WebAuthnAuth,
  computeAccountAddress,
  computePasskeySetImmutablesHash,
  computeWebAuthnChallenge,
} from '@oxide/oxide-lib-tee/account_address.js';
import { getWithdrawContentHash } from '@oxide/oxide-lib-tee/content_hash.js';
import {
  computeDepositMessageHash,
  computeSiloedDepositMessageNullifier,
} from '@oxide/oxide-lib-tee/deposit_message_hashing.js';
import { SCHNORR_CHALLENGE_DST } from '@oxide/oxide-lib-tee/grumpkin_schnorr_signature.js';
import { computeSiloedNoteHash } from '@oxide/oxide-lib-tee/hash.js';
import {
  type MigrationSignature,
  type PasskeyMigrationSignature,
  computeRefundCommitment,
} from '@oxide/oxide-lib-tee/migration_signature.js';
import {
  FROZEN_DEPOSITS_REFUND_PUBLIC_INPUT_COUNT,
  MAX_FROZEN_DEPOSITS_PER_REFUND,
  WEBAUTHN_AUTHENTICATOR_DATA_LEN,
  WEBAUTHN_FLAGS_OFFSET,
  WEBAUTHN_FLAG_USER_PRESENT,
  WEBAUTHN_FLAG_USER_VERIFIED,
} from '@oxide/oxide-lib-tee/oxide_constants.gen.js';
import {
  type FrozenDepositsRefundFinalizationInput,
  type FrozenNotesRefundFinalizationInput,
  type K1NoteSignature,
  type NoteData,
  type OutboxWithdrawal,
  type PortalDomain,
  PortalLink,
  type SecpPublicKey,
  type SpendValidationData,
  type SpentDeposit,
  type TokenOperation,
  type UnprocessedDepositRefundFinalizationInput,
} from '@oxide/oxide-lib-tee/types.js';
import { computePasskeySetSlots } from '@oxide/oxide-lib/account_address.js';
import { frozenTipFixture } from '@oxide/oxide-lib/testing/frozen_tip.js';
import { nullifierTreeFixture } from '@oxide/oxide-lib/testing/nullifier_tree.js';
import { SparseTree } from '@oxide/oxide-lib/testing/sparse_tree.js';

import { describe, expect, it, jest } from '@jest/globals';

import { buildNoteOperationDigest, buildWithdrawalOperationDigest } from './digest.js';
import { verifyEcdsa } from './libsecp256k1_signer.js';
import { SignatureBudget } from './signature_budget.js';
import { LocalTeeSigner, k1NoteSignatureToRS } from './signer.js';

const portalDomain: PortalDomain = {
  l1Portal: EthAddress.fromField(new Fr(0x1101)),
  l1ChainId: 7n,
  l2Token: AztecAddress.fromFieldUnsafe(new Fr(1)),
  teeRegistry: EthAddress.fromField(new Fr(0x7e9)),
  rollupVersion: 9n,
};
const portalLink = PortalLink.from(portalDomain);

const createdNote = (amount: bigint, owner = AztecAddress.ZERO, randomness = Fr.ZERO): NoteData => ({
  amount,
  owner,
  randomness,
});

const withdrawal = (
  amount: bigint,
  executor: EthAddress = EthAddress.fromField(new Fr(1)),
  randomness = Fr.ZERO,
): OutboxWithdrawal => ({
  executor,
  userPayloadHash: Fr.ZERO,
  amount,
  proverTip: 0n,
  randomness,
});

// The signer reads chain id and rollup version from the header, so fixture headers must name the
// values the expected hashes use.
const globalsFrom = (domain: PortalDomain) =>
  GlobalVariables.empty({ chainId: new Fr(domain.l1ChainId), version: new Fr(domain.rollupVersion) });

const operation = (overrides: Partial<TokenOperation> = {}): TokenOperation => ({
  anchorBlockHeader: BlockHeader.empty({ globalVariables: globalsFrom(portalDomain) }),
  spentNotes: [],
  createdNotes: [],
  deposits: [],
  withdrawals: [],
  ...overrides,
});

describe('LocalTeeSigner token operations', () => {
  const signer = LocalTeeSigner.random(portalLink);

  it('rejects an operation whose deposited value does not balance outputs', async () => {
    const deposits = await depositFixture([7n]);

    await expect(
      signer.signTokenOperation(
        operation({
          anchorBlockHeader: deposits.anchorBlockHeader,
          deposits: deposits.deposits,
          createdNotes: [createdNote(6n)],
          withdrawals: [withdrawal(2n)],
        }),
      ),
    ).rejects.toThrow(/Balance mismatch: spent=0 deposited=7 created=6 withdrawn=2/);
  });

  it('signs a balanced operation with deposits, created notes, and withdrawals', async () => {
    const deposits = await depositFixture([11n]);
    const output = await signer.signTokenOperation(
      operation({
        anchorBlockHeader: deposits.anchorBlockHeader,
        deposits: deposits.deposits,
        createdNotes: [createdNote(7n, AztecAddress.fromFieldUnsafe(new Fr(2)), new Fr(3))],
        withdrawals: [withdrawal(4n, EthAddress.fromField(new Fr(4)), new Fr(5))],
      }),
    );

    expect(output.signatures).toHaveLength(1);
    expect(output.withdrawalSignatures).toHaveLength(1);
    expectFields(output.requiredNullifiers, deposits.nullifiers);
  });

  it('signs multiple outputs balanced by multiple deposits', async () => {
    const deposits = await depositFixture([10n, 7n]);
    const output = await signer.signTokenOperation(
      operation({
        anchorBlockHeader: deposits.anchorBlockHeader,
        deposits: deposits.deposits,
        createdNotes: [
          createdNote(9n, AztecAddress.fromFieldUnsafe(new Fr(2)), new Fr(11)),
          createdNote(7n, AztecAddress.fromFieldUnsafe(new Fr(3)), new Fr(12)),
        ],
        withdrawals: [withdrawal(1n, EthAddress.fromField(new Fr(5)), new Fr(13))],
      }),
    );

    expect(output.signatures).toHaveLength(2);
    expect(output.withdrawalSignatures).toHaveLength(1);
    expectFields(output.requiredNullifiers, deposits.nullifiers);
  });

  it('produces verifiable signatures over the operation public-input layout', async () => {
    const deposits = await depositFixture([13n]);
    const note = createdNote(8n, AztecAddress.fromFieldUnsafe(new Fr(6)), new Fr(7));
    const outgoing = withdrawal(5n, EthAddress.fromField(new Fr(8)), new Fr(9));
    const op = operation({
      anchorBlockHeader: deposits.anchorBlockHeader,
      deposits: deposits.deposits,
      createdNotes: [note],
      withdrawals: [outgoing],
    });

    const output = await signer.signTokenOperation(op);
    const anchorBlockHash = await op.anchorBlockHeader.hash();
    const noteHash = await computeSiloedNoteHash({ ...note, l2Token: portalDomain.l2Token });
    const withdrawalMessageHash = computeL2ToL1MessageHash({
      l2Sender: portalDomain.l2Token,
      l1Recipient: portalDomain.l1Portal,
      content: getWithdrawContentHash(
        outgoing.executor,
        outgoing.userPayloadHash,
        outgoing.amount,
        outgoing.proverTip,
        outgoing.randomness,
      ),
      rollupVersion: new Fr(portalDomain.rollupVersion),
      chainId: new Fr(portalDomain.l1ChainId),
    });

    expectFields(output.requiredNullifiers, deposits.nullifiers);
    expectFields(output.teeNotes, [noteHash]);
    expectFields(output.withdrawalMessageHashes, [withdrawalMessageHash]);

    const noteDigest = await buildNoteOperationDigest({
      anchorBlockHash,
      tokenAddress: portalDomain.l2Token,
      l1Portal: portalDomain.l1Portal,
      teeRegistry: portalDomain.teeRegistry,
      requiredNullifiers: output.requiredNullifiers,
      siloedNoteHashes: output.teeNotes,
      withdrawalMessageHashes: output.withdrawalMessageHashes,
      siloedNoteHash: noteHash,
    });
    expect(verifiesK1Signature(output.signatures[0]!, noteDigest, signer.publicKey)).toBe(true);

    const withdrawalDigest = await buildWithdrawalOperationDigest({
      anchorBlockHash,
      tokenAddress: portalDomain.l2Token,
      l1Portal: portalDomain.l1Portal,
      teeRegistry: portalDomain.teeRegistry,
      requiredNullifiers: output.requiredNullifiers,
      siloedNoteHashes: output.teeNotes,
      withdrawalMessageHashes: output.withdrawalMessageHashes,
      messageHash: withdrawalMessageHash,
    });
    expect(verifiesK1Signature(output.withdrawalSignatures[0]!, withdrawalDigest, signer.publicKey)).toBe(true);

    const otherPortalHash = computeL2ToL1MessageHash({
      l2Sender: portalDomain.l2Token,
      l1Recipient: EthAddress.fromField(new Fr(99)),
      content: getWithdrawContentHash(
        outgoing.executor,
        outgoing.userPayloadHash,
        outgoing.amount,
        outgoing.proverTip,
        outgoing.randomness,
      ),
      rollupVersion: new Fr(portalDomain.rollupVersion),
      chainId: new Fr(portalDomain.l1ChainId),
    });
    const wrongWithdrawalDigest = await buildWithdrawalOperationDigest({
      anchorBlockHash,
      tokenAddress: portalDomain.l2Token,
      l1Portal: portalDomain.l1Portal,
      teeRegistry: portalDomain.teeRegistry,
      requiredNullifiers: output.requiredNullifiers,
      siloedNoteHashes: output.teeNotes,
      withdrawalMessageHashes: [otherPortalHash],
      messageHash: otherPortalHash,
    });
    expect(verifiesK1Signature(output.withdrawalSignatures[0]!, wrongWithdrawalDigest, signer.publicKey)).toBe(false);
  });

  it('commits withdrawal hashes to the anchor header chain id and rollup version, not the signer construction', async () => {
    const otherChain: PortalDomain = { ...portalDomain, l1ChainId: 31337n, rollupVersion: 3n };
    const deposits = await depositFixture([5n], otherChain);
    const outgoing = withdrawal(5n);
    const output = await signer.signTokenOperation(
      operation({
        anchorBlockHeader: deposits.anchorBlockHeader,
        deposits: deposits.deposits,
        withdrawals: [outgoing],
      }),
    );

    const expected = computeL2ToL1MessageHash({
      l2Sender: portalDomain.l2Token,
      l1Recipient: portalDomain.l1Portal,
      content: getWithdrawContentHash(
        outgoing.executor,
        outgoing.userPayloadHash,
        outgoing.amount,
        outgoing.proverTip,
        outgoing.randomness,
      ),
      rollupVersion: new Fr(otherChain.rollupVersion),
      chainId: new Fr(otherChain.l1ChainId),
    });
    expectFields(output.withdrawalMessageHashes, [expected]);
  });

  it('signs an empty operation without producing commitments', async () => {
    const output = await signer.signTokenOperation(operation());

    expect(output.signatures).toHaveLength(0);
    expect(output.withdrawalSignatures).toHaveLength(0);
    expect(output.requiredNullifiers).toHaveLength(0);
    expect(output.teeNotes).toHaveLength(0);
    expect(output.withdrawalMessageHashes).toHaveLength(0);
  });

  it('signs zero-amount notes and commits to their owner and randomness', async () => {
    const owner = AztecAddress.fromFieldUnsafe(new Fr(21));
    const otherOwner = AztecAddress.fromFieldUnsafe(new Fr(22));
    const notes = [
      createdNote(0n, owner, new Fr(31)),
      createdNote(0n, owner, new Fr(32)),
      createdNote(0n, otherOwner, new Fr(31)),
    ];

    const output = await signer.signTokenOperation(operation({ createdNotes: notes }));
    const expectedHashes = await Promise.all(
      notes.map(note => computeSiloedNoteHash({ ...note, l2Token: portalDomain.l2Token })),
    );

    expect(output.signatures).toHaveLength(notes.length);
    expectFields(output.teeNotes, expectedHashes);
    expect(new Set(output.teeNotes.map(noteHash => noteHash.toString())).size).toBe(notes.length);
  });

  it('rejects duplicate zero-amount notes with the same owner and randomness', async () => {
    const note = createdNote(0n, AztecAddress.fromFieldUnsafe(new Fr(33)), new Fr(34));

    await expect(signer.signTokenOperation(operation({ createdNotes: [note, note] }))).rejects.toThrow(
      /Duplicate tee notes/,
    );
  });

  it('refuses to sign a withdrawal to the zero address', async () => {
    await expect(
      signer.signTokenOperation(operation({ withdrawals: [withdrawal(1n, EthAddress.ZERO)] })),
    ).rejects.toThrow(/executor is the zero address/);
  });

  it('refuses to sign a withdrawal whose prover tip exceeds the amount', async () => {
    await expect(
      signer.signTokenOperation(operation({ withdrawals: [{ ...withdrawal(0n), proverTip: 1n }] })),
    ).rejects.toThrow(/prover tip exceeds amount/);
  });
});

// These tests are mirrored in noir-projects/oxide_token_contract/src/validation.nr: every case here has a same-named
// test there with equivalent behavior. This helps ensure the enclave and the client perform equivalent validation
// checks.
describe('LocalTeeSigner creation-effect checks', () => {
  const signer = LocalTeeSigner.random(portalLink) as unknown as {
    validateWithdrawalMessageHashesInL2ToL1Msgs(withdrawalMessageHashes: Fr[], creationEffects: TxEffect): void;
    validateMessageHashInWithdrawalMessageHashes(messageHash: Fr, withdrawalMessageHashes: Fr[]): void;
    validateRequiredNullifiers(requiredNullifiers: Fr[], creationEffects: TxEffect): void;
    validateSiloedNoteHashInTeeNotes(siloedNoteHash: Fr, teeNotes: Fr[]): void;
  };
  const h1 = new Fr(0x1111);
  const h2 = new Fr(0x2222);
  const h3 = new Fr(0x3333);

  const effectWithL2ToL1Msgs = (l2ToL1Msgs: Fr[]): TxEffect => {
    const effect = TxEffect.empty();
    effect.l2ToL1Msgs = l2ToL1Msgs;
    return effect;
  };

  it('accepts attested withdrawal messages present in the tx', () => {
    expect(() =>
      signer.validateWithdrawalMessageHashesInL2ToL1Msgs([h1, h2], effectWithL2ToL1Msgs([h2, h1])),
    ).not.toThrow();
  });

  it('rejects an attested withdrawal message absent from the tx', () => {
    expect(() => signer.validateWithdrawalMessageHashesInL2ToL1Msgs([h1, h2], effectWithL2ToL1Msgs([h1]))).toThrow(
      /not found in creation tx l2ToL1Msgs/,
    );
  });

  it('accepts a repeated withdrawal message', () => {
    expect(() =>
      signer.validateWithdrawalMessageHashesInL2ToL1Msgs([h1], effectWithL2ToL1Msgs([h1, h1])),
    ).not.toThrow();
  });

  it('accepts an empty attested withdrawal list', () => {
    expect(() => signer.validateWithdrawalMessageHashesInL2ToL1Msgs([], effectWithL2ToL1Msgs([h1, h1]))).not.toThrow();
  });

  // `signWithdrawalFinalization` takes the message hash from its caller, so this membership check is the only
  // thing that ties that hash to a withdrawal the creation tx attested.
  it('rejects a finalization message hash the creation tx never attested', () => {
    expect(() => signer.validateMessageHashInWithdrawalMessageHashes(h2, [h1, h2])).not.toThrow();
    expect(() => signer.validateMessageHashInWithdrawalMessageHashes(h3, [h1, h2])).toThrow(
      /not found in withdrawal message hashes/,
    );
    expect(() => signer.validateMessageHashInWithdrawalMessageHashes(Fr.ZERO, [])).toThrow(
      /not found in withdrawal message hashes/,
    );
  });

  it('rejects a required nullifier absent from the tx', () => {
    const effect = TxEffect.empty();
    effect.nullifiers = [h1];
    expect(() => signer.validateRequiredNullifiers([h1, h2], effect)).toThrow(/not found in creation effects/);
    effect.nullifiers = [h1, h2];
    expect(() => signer.validateRequiredNullifiers([h1, h2], effect)).not.toThrow();
  });

  it('counts a note only within the emitted tee notes', () => {
    // Only h1 and h3 were emitted, so neither h2 nor a zero counts as present.
    const teeNotes = [h1, h3];
    expect(() => signer.validateSiloedNoteHashInTeeNotes(h1, teeNotes)).not.toThrow();
    expect(() => signer.validateSiloedNoteHashInTeeNotes(h2, teeNotes)).toThrow(/not found once in tee notes/);
    expect(() => signer.validateSiloedNoteHashInTeeNotes(Fr.ZERO, teeNotes)).toThrow(/not found once in tee notes/);
  });
});

describe('LocalTeeSigner refund executors', () => {
  const signer = LocalTeeSigner.random(portalLink);

  // The zero-executor guard is the first statement in each refund signer, so a minimal input with only
  // `executor` set exercises it without building a full refund witness.
  it('refuses to finalize a frozen-notes refund to the zero executor', async () => {
    await expect(
      signer.signFrozenNotesRefundFinalization({
        executor: EthAddress.ZERO,
      } as unknown as FrozenNotesRefundFinalizationInput),
    ).rejects.toThrow(/Refund executor is the zero address/);
  });

  it('refuses to finalize a frozen-deposit refund to the zero executor', async () => {
    await expect(
      signer.signFrozenDepositsRefundFinalization({
        executor: EthAddress.ZERO,
      } as unknown as FrozenDepositsRefundFinalizationInput),
    ).rejects.toThrow(/Refund executor is the zero address/);
  });

  it('refuses to finalize an unprocessed-deposit refund to the zero executor', async () => {
    await expect(
      signer.signUnprocessedDepositRefundFinalization({
        executor: EthAddress.ZERO,
      } as unknown as UnprocessedDepositRefundFinalizationInput),
    ).rejects.toThrow(/Refund executor is the zero address/);
  });

  it('refuses to finalize a frozen-notes refund that spends no note', async () => {
    const frozen = await frozenTipFixture({ domain: portalDomain });
    await expect(
      signer.signFrozenNotesRefundFinalization({
        ...frozen,
        executor: EthAddress.fromField(new Fr(1)),
        userPayloadHash: Fr.ZERO,
        notes: [],
      } as unknown as FrozenNotesRefundFinalizationInput),
    ).rejects.toThrow(/must spend at least one note/);
  });
});

describe('LocalTeeSigner frozen-notes refund', () => {
  const signer = LocalTeeSigner.random(portalLink);
  const executor = EthAddress.fromField(new Fr(0xbeef));

  it('rejects a note set that mixes owners', async () => {
    const owner = await makePasskeyAccount();
    const other = await makePasskeyAccount();
    const { frozenTip, frozenArchiveRoot, frozenTipMembershipWitness } = await frozenTipFixture({
      domain: portalDomain,
    });

    // The single-owner rule is checked before the spends are validated, so the notes here only have to carry an
    // owner. One note belongs to `owner`, the other to `other`; one passkey cannot authorize both.
    const notes = [owner.address, other.address].map(noteOwner => ({
      note: createdNote(1n, noteOwner),
    })) as unknown as SpendValidationData[];

    await expect(
      signer.signFrozenNotesRefundFinalization({
        frozenArchiveRoot,
        frozenTip,
        frozenTipMembershipWitness,
        notes,
        executor,
        userPayloadHash: Fr.ZERO,
        lowNullifierMembershipWitnesses: [],
        owner: owner.address,
        ownerPublicKeys: owner.publicKeys,
        ownerInstance: owner.instance,
        migrationSignature: await owner.signMigration(executor, Fr.ZERO),
      }),
    ).rejects.toThrow(`Note owner ${other.address} does not match the refund owner ${owner.address}`);
  });
});

describe('LocalTeeSigner unprocessed-deposit refund', () => {
  const signer = LocalTeeSigner.random(portalLink);
  const executor = EthAddress.fromField(new Fr(0xbeef));
  const amount = 10n;
  const userPayloadHash = new Fr(1);
  const sharedSecretSalt = new Fr(42);
  // The frozen tip has absorbed no message, so any leaf index is unprocessed.
  const messageLeafIndex = new Fr(5);

  async function refundInput(
    account: RefundAccountFixture,
    domain: PortalDomain = portalDomain,
  ): Promise<{
    input: UnprocessedDepositRefundFinalizationInput;
    messageHash: Fr;
  }> {
    const { frozenTip, frozenArchiveRoot, frozenTipMembershipWitness } = await frozenTipFixture({ domain });
    const messageHash = await computeDepositMessageHash(domain, {
      sharedSecretSalt,
      recipient: account.address,
      amount,
      messageLeafIndex,
    });
    const input: UnprocessedDepositRefundFinalizationInput = {
      frozenArchiveRoot,
      frozenTip,
      frozenTipMembershipWitness,
      amount,
      executor,
      userPayloadHash,
      sharedSecretSalt,
      l2Recipient: account.address,
      l2RecipientPublicKeys: account.publicKeys,
      l2RecipientInstance: account.instance,
      l2RecipientNhkM: account.masterNullifierHidingKey,
      messageLeafIndex,
      migrationSignature: await account.signMigration(executor, userPayloadHash),
    };
    return { input, messageHash };
  }

  it('signs a refund the recipient passkey authorized', async () => {
    const account = await makePasskeyAccount();
    const { input, messageHash } = await refundInput(account);

    const output = await signer.signUnprocessedDepositRefundFinalization(input);

    expect(output.messageHash).toEqual(messageHash);
    expect(output.siloedNullifier).toEqual(
      await computeSiloedDepositMessageNullifier(portalDomain.l2Token, messageHash, account.masterNullifierHidingKey),
    );
  });

  it('commits the refund message hash to the frozen tip chain id and rollup version, not the signer construction', async () => {
    const account = await makePasskeyAccount();
    const otherChain: PortalDomain = { ...portalDomain, l1ChainId: 999n, rollupVersion: 3n };
    const { input, messageHash } = await refundInput(account, otherChain);

    const output = await signer.signUnprocessedDepositRefundFinalization(input);

    expect(output.messageHash).toEqual(messageHash);
  });

  it('rejects a passkey the recipient address does not commit to', async () => {
    const account = await makePasskeyAccount();
    const other = await makePasskeyAccount();
    const { input } = await refundInput(account);
    const signature = input.migrationSignature as PasskeyMigrationSignature;

    await expect(
      signer.signUnprocessedDepositRefundFinalization({
        ...input,
        migrationSignature: { ...signature, passkey: other.passkey.publicKey },
      }),
    ).rejects.toThrow("passkey is not in the owner's passkey set");
  });

  it('rejects an assertion over a different user payload', async () => {
    const account = await makePasskeyAccount();
    const { input } = await refundInput(account);

    await expect(
      signer.signUnprocessedDepositRefundFinalization({ ...input, userPayloadHash: new Fr(2) }),
    ).rejects.toThrow('invalid WebAuthn signature');
  });

  it('rejects an assertion by another passkey', async () => {
    const account = await makePasskeyAccount();
    const other = await makePasskeyAccount();
    const { input } = await refundInput(account);
    const signature = input.migrationSignature as PasskeyMigrationSignature;

    await expect(
      signer.signUnprocessedDepositRefundFinalization({
        ...input,
        migrationSignature: {
          ...signature,
          webauthn: await other.passkey.sign(await computeRefundCommitment(executor, userPayloadHash)),
        },
      }),
    ).rejects.toThrow('invalid WebAuthn signature');
  });

  it('rejects a nullifier hiding key of another account', async () => {
    const account = await makePasskeyAccount();
    const other = await makePasskeyAccount();
    const { input } = await refundInput(account);

    await expect(
      signer.signUnprocessedDepositRefundFinalization({ ...input, l2RecipientNhkM: other.masterNullifierHidingKey }),
    ).rejects.toThrow(/Master nullifier hiding key does not hash/);
  });

  /** A frozen tip whose L1-to-L2 tree holds the leaves at indices below `nextAvailableLeafIndex`. */
  const frozenTipAbsorbingUpTo = (nextAvailableLeafIndex: number) =>
    frozenTipFixture({
      domain: portalDomain,
      state: new StateReference(
        new AppendOnlyTreeSnapshot(Fr.random(), nextAvailableLeafIndex),
        PartialStateReference.empty(),
      ),
    });

  it('rejects a message the frozen tip already absorbed', async () => {
    const account = await makePasskeyAccount();
    const { input } = await refundInput(account);

    await expect(
      signer.signUnprocessedDepositRefundFinalization({
        ...input,
        ...(await frozenTipAbsorbingUpTo(Number(messageLeafIndex.toBigInt()) + 1)),
      }),
    ).rejects.toThrow(/attempting to spend a processed message/);
  });

  it('signs a refund of the first message the frozen tip did not absorb', async () => {
    const account = await makePasskeyAccount();
    const { input, messageHash } = await refundInput(account);

    const output = await signer.signUnprocessedDepositRefundFinalization({
      ...input,
      ...(await frozenTipAbsorbingUpTo(Number(messageLeafIndex.toBigInt()))),
    });

    expect(output.messageHash).toEqual(messageHash);
  });

  it('rejects a frozen tip that is not in the frozen archive', async () => {
    const account = await makePasskeyAccount();
    const { input } = await refundInput(account);
    const { frozenArchiveRoot } = await frozenTipAbsorbingUpTo(Number(messageLeafIndex.toBigInt()) + 1);

    // The header claims that no message is absorbed, but the frozen archive ends at a block that absorbed it.
    await expect(signer.signUnprocessedDepositRefundFinalization({ ...input, frozenArchiveRoot })).rejects.toThrow(
      `Membership witness verification failed for block hash ${await input.frozenTip.hash()}`,
    );
  });

  it('rejects a frozen tip that is not the latest block of the frozen archive', async () => {
    const account = await makePasskeyAccount();
    const { input } = await refundInput(account);

    // A later block of the frozen archive absorbed the message.
    await expect(
      signer.signUnprocessedDepositRefundFinalization({
        ...input,
        ...(await frozenTipFixture({ domain: portalDomain, laterBlocks: 1 })),
      }),
    ).rejects.toThrow(`Membership witness verification failed for block hash ${Fr.ZERO}`);
  });

  // A fallback-key owner - an address that commits to no passkey, such as a shared-secret escrow - signs with its
  // master fallback key instead.
  it('signs a refund the recipient master fallback key authorized', async () => {
    const account = await makeFallbackKeyAccount();
    const { input, messageHash } = await refundInput(account);

    const output = await signer.signUnprocessedDepositRefundFinalization(input);

    expect(output.messageHash).toEqual(messageHash);
    expect(output.siloedNullifier).toEqual(
      await computeSiloedDepositMessageNullifier(portalDomain.l2Token, messageHash, account.masterNullifierHidingKey),
    );
  });

  it('rejects a fallback-key signature by a passkey-bound owner', async () => {
    const account = await makePasskeyAccount();
    const { input } = await refundInput(account);

    // The signature is the account's own, but its address commits to a passkey, so it does not derive from the zero
    // immutables hash the fallback-key mode uses.
    await expect(
      signer.signUnprocessedDepositRefundFinalization({
        ...input,
        migrationSignature: await fallbackKeyMigrationSignature(
          account.masterFallbackSecretKey,
          executor,
          userPayloadHash,
        ),
      }),
    ).rejects.toThrow('migration signature does not match owner address');
  });
});

describe('LocalTeeSigner frozen-deposit refund', () => {
  const signer = LocalTeeSigner.random(portalLink);
  const executor = EthAddress.fromField(new Fr(0xbeef));
  const amount = 10n;
  const userPayloadHash = new Fr(1);
  const sharedSecretSalt = new Fr(42);
  const messageLeafIndex = 3;

  /**
   * A frozen-deposit refund of a deposit at `messageLeafIndex`, frozen in a tip whose L1-to-L2 tree holds `inTree`.
   * When the deposit is spent, the tip's nullifier tree also holds the deposit nullifier after its low leaf. A stale
   * low leaf is the witness from before that insert.
   */
  async function refundInput(
    account: RefundAccountFixture,
    opts: { inTree: 'message' | 'another message'; nullifier: 'unspent' | 'spent' | 'spent, stale low leaf' },
  ): Promise<FrozenDepositsRefundFinalizationInput> {
    const messageHash = await computeDepositMessageHash(portalDomain, {
      sharedSecretSalt,
      recipient: account.address,
      amount,
      messageLeafIndex: new Fr(messageLeafIndex),
    });
    const leaves = Array.from({ length: messageLeafIndex + 1 }, () => Fr.random());
    leaves[messageLeafIndex] = opts.inTree === 'message' ? messageHash : Fr.random();
    const messageTree = await SparseTree.build(L1_TO_L2_MSG_TREE_HEIGHT, leaves, DomainSeparator.MERKLE_HASH);

    const siloedNullifier = await computeSiloedDepositMessageNullifier(
      portalDomain.l2Token,
      messageHash,
      account.masterNullifierHidingKey,
    );
    // Before the insert, the low leaf `n - 1` skips over the deposit nullifier `n` to the leaf `n + 1`, so it is the
    // low leaf of `n` and of no other key. The insert appends `n` and points the low leaf at it.
    const low = siloedNullifier.sub(new Fr(1));
    const next = siloedNullifier.add(new Fr(1));
    const beforeInsert = [
      new NullifierLeafPreimage(new NullifierLeaf(low), next, 1n),
      new NullifierLeafPreimage(new NullifierLeaf(next), Fr.ZERO, 0n),
    ];
    const afterInsert = [
      new NullifierLeafPreimage(new NullifierLeaf(low), siloedNullifier, 2n),
      new NullifierLeafPreimage(new NullifierLeaf(next), Fr.ZERO, 0n),
      new NullifierLeafPreimage(new NullifierLeaf(siloedNullifier), next, 1n),
    ];
    const nullifierLeaves = opts.nullifier === 'unspent' ? beforeInsert : afterInsert;
    const witnessLeaves = opts.nullifier === 'spent' ? afterInsert : beforeInsert;
    const nullifierTree = await nullifierTreeFixture(nullifierLeaves);
    const witnessTree = await nullifierTreeFixture(witnessLeaves);

    const empty = PartialStateReference.empty();
    const frozen = await frozenTipFixture({
      domain: portalDomain,
      state: new StateReference(
        new AppendOnlyTreeSnapshot(messageTree.root, leaves.length),
        new PartialStateReference(
          empty.noteHashTree,
          new AppendOnlyTreeSnapshot(nullifierTree.root, nullifierLeaves.length),
          empty.publicDataTree,
        ),
      ),
    });
    return {
      ...frozen,
      executor,
      userPayloadHash,
      l2Recipient: account.address,
      l2RecipientPublicKeys: account.publicKeys,
      l2RecipientInstance: account.instance,
      l2RecipientNhkM: account.masterNullifierHidingKey,
      deposits: [
        {
          amount,
          sharedSecretSalt,
          messageMembershipWitness: messageTree.membershipWitness<typeof L1_TO_L2_MSG_TREE_HEIGHT>(messageLeafIndex),
          lowNullifierMembershipWitness: witnessTree.witness(0),
        },
      ],
      migrationSignature: await account.signMigration(executor, userPayloadHash),
    };
  }

  /**
   * A frozen-deposit refund of deposits with `amounts` at the message leaves 0, 1, ... of a tip that holds every
   * message and none of their nullifiers. One low leaf, below every key and with no next leaf, is the low leaf of every
   * deposit nullifier.
   */
  async function batchRefundInput(
    account: RefundAccountFixture,
    amounts: bigint[],
  ): Promise<{ input: FrozenDepositsRefundFinalizationInput; messageHashes: Fr[] }> {
    const salts = amounts.map((_, i) => new Fr(100 + i));
    const messageHashes = await Promise.all(
      amounts.map((depositAmount, i) =>
        computeDepositMessageHash(portalDomain, {
          sharedSecretSalt: salts[i]!,
          recipient: account.address,
          amount: depositAmount,
          messageLeafIndex: new Fr(i),
        }),
      ),
    );
    const leaves = messageHashes.length > 0 ? messageHashes : [Fr.random()];
    const messageTree = await SparseTree.build(L1_TO_L2_MSG_TREE_HEIGHT, leaves, DomainSeparator.MERKLE_HASH);
    const nullifierLeaves = [new NullifierLeafPreimage(new NullifierLeaf(new Fr(1)), Fr.ZERO, 0n)];
    const nullifierTree = await nullifierTreeFixture(nullifierLeaves);

    const empty = PartialStateReference.empty();
    const frozen = await frozenTipFixture({
      domain: portalDomain,
      state: new StateReference(
        new AppendOnlyTreeSnapshot(messageTree.root, leaves.length),
        new PartialStateReference(
          empty.noteHashTree,
          new AppendOnlyTreeSnapshot(nullifierTree.root, nullifierLeaves.length),
          empty.publicDataTree,
        ),
      ),
    });
    const input: FrozenDepositsRefundFinalizationInput = {
      ...frozen,
      executor,
      userPayloadHash,
      l2Recipient: account.address,
      l2RecipientPublicKeys: account.publicKeys,
      l2RecipientInstance: account.instance,
      l2RecipientNhkM: account.masterNullifierHidingKey,
      deposits: amounts.map((depositAmount, i) => ({
        amount: depositAmount,
        sharedSecretSalt: salts[i]!,
        messageMembershipWitness: messageTree.membershipWitness<typeof L1_TO_L2_MSG_TREE_HEIGHT>(i),
        lowNullifierMembershipWitness: nullifierTree.witness(0),
      })),
      migrationSignature: await account.signMigration(executor, userPayloadHash),
    };
    return { input, messageHashes };
  }

  it('signs one refund of the sum of a batch of deposits', async () => {
    const account = await makePasskeyAccount();
    const { input, messageHashes } = await batchRefundInput(account, [3n, 4n]);

    const output = await signer.signFrozenDepositsRefundFinalization(input);

    const nullifiers = await Promise.all(
      messageHashes.map(messageHash =>
        computeSiloedDepositMessageNullifier(portalDomain.l2Token, messageHash, account.masterNullifierHidingKey),
      ),
    );
    expect(output.nullifiers).toEqual(nullifiers);
    expect(output.amount).toBe(7n);
    expect(output.publicInputs).toHaveLength(FROZEN_DEPOSITS_REFUND_PUBLIC_INPUT_COUNT);
    expect(output.publicInputs[4]).toEqual(new Fr(7n));
    expect(output.publicInputs.slice(7)).toEqual([
      ...nullifiers,
      ...Array(MAX_FROZEN_DEPOSITS_PER_REFUND - nullifiers.length).fill(Fr.ZERO),
    ]);
  });

  it('signs a full batch of deposits', async () => {
    const account = await makePasskeyAccount();
    const amounts = Array.from({ length: MAX_FROZEN_DEPOSITS_PER_REFUND }, (_, i) => BigInt(i + 1));
    const { input, messageHashes } = await batchRefundInput(account, amounts);

    const output = await signer.signFrozenDepositsRefundFinalization(input);

    const nullifiers = await Promise.all(
      messageHashes.map(messageHash =>
        computeSiloedDepositMessageNullifier(portalDomain.l2Token, messageHash, account.masterNullifierHidingKey),
      ),
    );
    expect(output.nullifiers).toEqual(nullifiers);
    expect(output.amount).toBe(amounts.reduce((sum, amount) => sum + amount, 0n));
    expect(output.publicInputs.slice(7)).toEqual(nullifiers);
  });

  it('rejects a refund without deposits', async () => {
    const account = await makePasskeyAccount();
    const { input } = await batchRefundInput(account, []);

    await expect(signer.signFrozenDepositsRefundFinalization(input)).rejects.toThrow(
      'Frozen-deposit refund must refund at least one deposit',
    );
  });

  it('rejects more deposits than the circuit holds', async () => {
    const account = await makePasskeyAccount();
    const { input } = await batchRefundInput(
      account,
      Array.from({ length: MAX_FROZEN_DEPOSITS_PER_REFUND + 1 }, () => 1n),
    );

    await expect(signer.signFrozenDepositsRefundFinalization(input)).rejects.toThrow(
      `Frozen-deposit refund refunds ${MAX_FROZEN_DEPOSITS_PER_REFUND + 1} deposits, max ${MAX_FROZEN_DEPOSITS_PER_REFUND}`,
    );
  });

  // The circuit skips a zero-amount deposit as padding, so the enclave refuses to sign for one.
  it('rejects a deposit with a zero amount', async () => {
    const account = await makePasskeyAccount();
    const { input } = await batchRefundInput(account, [3n, 0n]);

    await expect(signer.signFrozenDepositsRefundFinalization(input)).rejects.toThrow(
      'Frozen-deposit refund includes a deposit with a zero amount',
    );
  });

  it('rejects the same deposit twice', async () => {
    const account = await makePasskeyAccount();
    const { input, messageHashes } = await batchRefundInput(account, [3n]);
    const nullifier = await computeSiloedDepositMessageNullifier(
      portalDomain.l2Token,
      messageHashes[0]!,
      account.masterNullifierHidingKey,
    );

    await expect(
      signer.signFrozenDepositsRefundFinalization({ ...input, deposits: [input.deposits[0]!, input.deposits[0]!] }),
    ).rejects.toThrow(`Frozen-deposit refund includes the deposit with nullifier ${nullifier} twice`);
  });

  it('signs a refund of a deposit that is in the frozen tree and unspent', async () => {
    const account = await makePasskeyAccount();

    const output = await signer.signFrozenDepositsRefundFinalization(
      await refundInput(account, { inTree: 'message', nullifier: 'unspent' }),
    );

    const messageHash = await computeDepositMessageHash(portalDomain, {
      sharedSecretSalt,
      recipient: account.address,
      amount,
      messageLeafIndex: new Fr(messageLeafIndex),
    });
    expect(output.nullifiers).toEqual([
      await computeSiloedDepositMessageNullifier(portalDomain.l2Token, messageHash, account.masterNullifierHidingKey),
    ]);
    expect(output.amount).toBe(amount);
  });

  it('rejects a deposit message the frozen L1-to-L2 tree does not hold', async () => {
    const account = await makePasskeyAccount();

    await expect(
      signer.signFrozenDepositsRefundFinalization(
        await refundInput(account, { inTree: 'another message', nullifier: 'unspent' }),
      ),
    ).rejects.toThrow(/Membership witness verification failed for L1->L2 message/);
  });

  it('rejects a deposit whose nullifier the frozen tip already holds', async () => {
    const account = await makePasskeyAccount();

    await expect(
      signer.signFrozenDepositsRefundFinalization(
        await refundInput(account, { inTree: 'message', nullifier: 'spent' }),
      ),
    ).rejects.toThrow(/does not skip over it/);
  });

  // The low leaf from before the insert passes every range check, so only the frozen nullifier root refuses it.
  it('rejects a spent deposit behind a stale low leaf', async () => {
    const account = await makePasskeyAccount();

    await expect(
      signer.signFrozenDepositsRefundFinalization(
        await refundInput(account, { inTree: 'message', nullifier: 'spent, stale low leaf' }),
      ),
    ).rejects.toThrow(/Membership witness verification failed for low-nullifier/);
  });

  it('rejects a frozen tip that is not in the frozen archive', async () => {
    const account = await makePasskeyAccount();
    const input = await refundInput(account, { inTree: 'message', nullifier: 'unspent' });
    const { frozenArchiveRoot } = await refundInput(account, { inTree: 'message', nullifier: 'spent' });

    // The header claims a state without the deposit nullifier, but the frozen archive ends at a block that holds it.
    await expect(signer.signFrozenDepositsRefundFinalization({ ...input, frozenArchiveRoot })).rejects.toThrow(
      `Membership witness verification failed for block hash ${await input.frozenTip.hash()}`,
    );
  });

  it('rejects a block from before the spend as the frozen tip', async () => {
    const account = await makePasskeyAccount();
    const input = await refundInput(account, { inTree: 'message', nullifier: 'unspent' });

    // The deposit was spent in a later block of the frozen archive, so this block does not hold its nullifier yet.
    const beforeSpend = await frozenTipFixture({ domain: portalDomain, state: input.frozenTip.state, laterBlocks: 1 });

    await expect(signer.signFrozenDepositsRefundFinalization({ ...input, ...beforeSpend })).rejects.toThrow(
      `Membership witness verification failed for block hash ${Fr.ZERO}`,
    );
  });
});

describe('LocalTeeSigner signature budget', () => {
  // Zero-amount notes/withdrawals pass the balance invariant (0 == 0) without witnesses, so signing is reached.
  const zeroSumOperation = (notes: number, withdrawals_ = 0) =>
    operation({
      createdNotes: Array.from({ length: notes }, (_, i) => createdNote(0n, AztecAddress.ZERO, new Fr(i + 1))),
      withdrawals: Array.from({ length: withdrawals_ }, () => withdrawal(0n)),
    });

  it('decrements one unit per signature produced', async () => {
    const budget = new SignatureBudget(10);
    const signer = new LocalTeeSigner(Buffer32.random(), portalLink, budget);
    const output = await signer.signTokenOperation(zeroSumOperation(2, 1));
    expect(output.signatures).toHaveLength(2);
    expect(output.withdrawalSignatures).toHaveLength(1);
    expect(budget.remaining()).toBe(7);
  });

  it('rejects mid-operation when the budget runs out', async () => {
    const onExhausted = jest.fn();
    const budget = new SignatureBudget(2, undefined, onExhausted);
    const signer = new LocalTeeSigner(Buffer32.random(), portalLink, budget);
    await expect(signer.signTokenOperation(zeroSumOperation(3))).rejects.toThrow(/signature budget exhausted/);
    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(budget.remaining()).toBe(0);
  });

  it('shares the budget with clones made via withPortalLink', async () => {
    const budget = new SignatureBudget(10);
    const signer = new LocalTeeSigner(Buffer32.random(), portalLink, budget);
    const clone = signer.withPortalLink(PortalLink.from({ ...portalLink, l1Portal: EthAddress.fromField(new Fr(2)) }));
    await clone.signTokenOperation(zeroSumOperation(1));
    expect(budget.remaining()).toBe(9);
  });
});

interface SyntheticOwner {
  completeAddress: CompleteAddress;
  masterNullifierHidingKey: GrumpkinScalar;
}

/** A P-256 passkey held in WebCrypto that produces assertions with the layout the refund circuits verify. */
interface TestPasskey {
  publicKey: PasskeyPublicKey;
  sign(challenge: Fr): Promise<WebAuthnAuth>;
}

/** An account whose funds a refund recovers, with the signer of the mode its address selects. */
interface RefundAccountFixture {
  address: AztecAddress;
  publicKeys: PublicKeys;
  instance: AccountInstancePreimage;
  masterNullifierHidingKey: GrumpkinScalar;
  masterFallbackSecretKey: GrumpkinScalar;
  signMigration(executor: EthAddress, userPayloadHash: Fr): Promise<MigrationSignature>;
}

interface PasskeyAccountFixture extends RefundAccountFixture {
  passkey: TestPasskey;
}

/**
 * Grumpkin-Schnorr-Poseidon2 signature of the migration to `executor` with `userPayloadHash`, matching
 * `schnorr::assert_valid_signature`. Mirrors the fallback-key mode of `signMigration` of `@oxide/oxide-client`, which
 * the enclave may not depend on.
 */
async function fallbackKeyMigrationSignature(
  masterFallbackSecretKey: GrumpkinScalar,
  executor: EthAddress,
  userPayloadHash: Fr,
): Promise<MigrationSignature> {
  const fbpkM = await derivePublicKeyFromSecretKey(masterFallbackSecretKey);
  const message = await computeRefundCommitment(executor, userPayloadHash);
  const k = GrumpkinScalar.random();
  const R = await Grumpkin.mul(Grumpkin.generator, k);
  const e = await poseidon2Hash([SCHNORR_CHALLENGE_DST, R.x, fbpkM.x, fbpkM.y, message]);
  const order = GrumpkinScalar.MODULUS;
  const eBig = e.toBigInt();
  const sBig = (((k.toBigInt() - ((eBig * masterFallbackSecretKey.toBigInt()) % order)) % order) + order) % order;
  const s = new GrumpkinScalar(sBig);
  return {
    kind: 'fallbackKey',
    fbpkM,
    fallbackSignature: { sLo: s.lo, sHi: s.hi, eLo: new Fr(eBig & ((1n << 128n) - 1n)), eHi: new Fr(eBig >> 128n) },
  };
}

async function makeTestPasskey(): Promise<TestPasskey> {
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const raw = Buffer.from(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  return {
    publicKey: { x: raw.subarray(1, 33), y: raw.subarray(33, 65) },
    async sign(challenge: Fr): Promise<WebAuthnAuth> {
      const clientDataJSON = Buffer.from(
        `{"type":"webauthn.get","challenge":"${computeWebAuthnChallenge(challenge)}","origin":"https://stub.passkey.test","crossOrigin":false}`,
        'utf8',
      );
      const authenticatorData = Buffer.alloc(WEBAUTHN_AUTHENTICATOR_DATA_LEN, 1);
      // The verifier requires the user-presence and the user-verification flags.
      authenticatorData[WEBAUTHN_FLAGS_OFFSET] = WEBAUTHN_FLAG_USER_PRESENT | WEBAUTHN_FLAG_USER_VERIFIED;
      const signedData = Buffer.concat([authenticatorData, sha256(clientDataJSON)]);
      // WebCrypto emits the raw `r || s` encoding the circuits consume.
      const signature = Buffer.from(
        await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keyPair.privateKey, signedData),
      );
      return { authenticatorData, clientDataJSON, signature };
    },
  };
}

function randomInstance(): AccountInstancePreimage {
  return {
    contractClassId: Fr.random(),
    salt: Fr.random(),
    initializationHash: Fr.random(),
    deployer: AztecAddress.ZERO,
  };
}

async function makePasskeyAccount(): Promise<PasskeyAccountFixture> {
  const { masterNullifierHidingSecretKey, masterFallbackSecretKey, publicKeys } = await deriveKeys(Fr.random());
  const passkey = await makeTestPasskey();
  const passkeySet = await computePasskeySetSlots([passkey.publicKey]);
  const immutablesHash = await computePasskeySetImmutablesHash(passkeySet);
  const instance = randomInstance();
  return {
    address: await computeAccountAddress(publicKeys, instance, immutablesHash),
    publicKeys,
    instance,
    passkey,
    masterNullifierHidingKey: masterNullifierHidingSecretKey,
    masterFallbackSecretKey,
    signMigration: async (executor: EthAddress, userPayloadHash: Fr) => ({
      kind: 'passkey',
      passkey: passkey.publicKey,
      passkeySet,
      webauthn: await passkey.sign(await computeRefundCommitment(executor, userPayloadHash)),
    }),
  };
}

/** An account whose address commits to no passkey, so its immutables hash is zero and it signs with `fbsk_m`. */
async function makeFallbackKeyAccount(): Promise<RefundAccountFixture> {
  const { masterNullifierHidingSecretKey, masterFallbackSecretKey, publicKeys } = await deriveKeys(Fr.random());
  const instance = randomInstance();
  return {
    address: await computeAccountAddress(publicKeys, instance, Fr.ZERO),
    publicKeys,
    instance,
    masterNullifierHidingKey: masterNullifierHidingSecretKey,
    masterFallbackSecretKey,
    signMigration: (executor: EthAddress, userPayloadHash: Fr) =>
      fallbackKeyMigrationSignature(masterFallbackSecretKey, executor, userPayloadHash),
  };
}

interface DepositFixture {
  anchorBlockHeader: BlockHeader;
  deposits: SpentDeposit[];
  nullifiers: Fr[];
}

async function depositFixture(amounts: bigint[], domain: PortalDomain = portalDomain): Promise<DepositFixture> {
  const recipients = await Promise.all(amounts.map(() => makeSyntheticOwner()));
  const salts = amounts.map((_, i) => new Fr(i + 1));
  const messageHashes = await Promise.all(
    recipients.map((recipient, i) =>
      computeDepositMessageHash(domain, {
        sharedSecretSalt: salts[i]!,
        recipient: recipient.completeAddress.address,
        amount: amounts[i]!,
        messageLeafIndex: new Fr(i),
      }),
    ),
  );
  const tree = await SparseTree.build(L1_TO_L2_MSG_TREE_HEIGHT, messageHashes, DomainSeparator.MERKLE_HASH);
  const anchorBlockHeader = depositAnchorBlockHeader(tree.root, amounts.length, domain);

  const deposits = recipients.map((recipient, i) => ({
    recipient: recipient.completeAddress.address,
    recipientAddressPreimage: recipient.completeAddress,
    masterNullifierHidingKey: recipient.masterNullifierHidingKey,
    amount: amounts[i]!,
    sharedSecretSalt: salts[i]!,
    messageLeafIndex: BigInt(i),
    siblingPath: tree.siblingPath<typeof L1_TO_L2_MSG_TREE_HEIGHT>(i),
  }));
  const nullifiers = await Promise.all(
    deposits.map((deposit, i) =>
      computeSiloedDepositMessageNullifier(portalDomain.l2Token, messageHashes[i]!, deposit.masterNullifierHidingKey),
    ),
  );

  return { anchorBlockHeader, deposits, nullifiers };
}

async function makeSyntheticOwner(): Promise<SyntheticOwner> {
  const { masterNullifierHidingSecretKey, publicKeys } = await deriveKeys(Fr.random());
  const partialAddress = Fr.random();
  const address = await computeAddress(publicKeys, partialAddress);
  return {
    completeAddress: await CompleteAddress.create(address, publicKeys, partialAddress),
    masterNullifierHidingKey: masterNullifierHidingSecretKey,
  };
}

function depositAnchorBlockHeader(
  l1ToL2Root: Fr,
  nextAvailableLeafIndex: number,
  domain: PortalDomain = portalDomain,
): BlockHeader {
  const emptyState = StateReference.empty();
  return BlockHeader.empty({
    state: new StateReference(new AppendOnlyTreeSnapshot(l1ToL2Root, nextAvailableLeafIndex), emptyState.partial),
    globalVariables: globalsFrom(domain),
  });
}

function verifiesK1Signature(signature: K1NoteSignature, digest: Fr, publicKey: SecpPublicKey): boolean {
  const { r, s } = k1NoteSignatureToRS(signature);
  const rs = Buffer.concat([r.toBuffer(), s.toBuffer()]);
  const uncompressedPublicKey = Buffer.concat([Buffer.from([0x04]), publicKey.x.toBuffer(), publicKey.y.toBuffer()]);
  return verifyEcdsa(rs, digest.toBuffer(), uncompressedPublicKey);
}

function expectFields(actual: Fr[], expected: Fr[]): void {
  expect(actual.map(field => field.toString())).toEqual(expected.map(field => field.toString()));
}
