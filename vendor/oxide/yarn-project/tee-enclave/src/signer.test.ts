import { Fr, GrumpkinScalar } from '@aztec/aztec.js/fields';
import { ARCHIVE_HEIGHT, DomainSeparator, L1_TO_L2_MSG_TREE_HEIGHT } from '@aztec/constants';
import { Buffer32 } from '@aztec/foundation/buffer';
import { Grumpkin } from '@aztec/foundation/crypto/grumpkin';
import { poseidon2Hash, poseidon2HashWithSeparator } from '@aztec/foundation/crypto/poseidon';
import { sha256 } from '@aztec/foundation/crypto/sha256';
import { EthAddress } from '@aztec/foundation/eth-address';
import type { Tuple } from '@aztec/foundation/serialize';
import { MembershipWitness } from '@aztec/foundation/trees';
import { AztecAddress } from '@aztec/stdlib/aztec-address';
import { CompleteAddress } from '@aztec/stdlib/contract';
import { computeL2ToL1MessageHash } from '@aztec/stdlib/hash';
import { type PublicKeys, computeAddress, deriveKeys, derivePublicKeyFromSecretKey } from '@aztec/stdlib/keys';
import { AppendOnlyTreeSnapshot } from '@aztec/stdlib/trees';
import { BlockHeader, StateReference, TxEffect } from '@aztec/stdlib/tx';

import {
  type AccountInstancePreimage,
  type PasskeyPublicKey,
  type WebAuthnAuth,
  computeAccountAddress,
  computePasskeyAccountAddress,
  computeWebAuthnChallenge,
} from '@oxide/oxide-lib/account_address.js';
import { getWithdrawContentHash } from '@oxide/oxide-lib/content_hash.js';
import {
  computeDepositMessageHash,
  computeSiloedDepositMessageNullifier,
} from '@oxide/oxide-lib/deposit_message_hashing.js';
import { SCHNORR_CHALLENGE_DST } from '@oxide/oxide-lib/grumpkin_schnorr_signature.js';
import { computeSiloedNoteHash } from '@oxide/oxide-lib/hash.js';
import {
  TX_AMOUNT_CAP,
  WEBAUTHN_AUTHENTICATOR_DATA_LEN,
  WEBAUTHN_FLAGS_OFFSET,
  WEBAUTHN_FLAG_USER_PRESENT,
  WEBAUTHN_FLAG_USER_VERIFIED,
} from '@oxide/oxide-lib/oxide_constants.gen.js';
import { computeUnprocessedDepositRefundAuthMessage } from '@oxide/oxide-lib/refund_auth_message.js';
import type { RefundAuthorization } from '@oxide/oxide-lib/refund_authorization.js';
import type {
  FrozenDepositRefundFinalizationInput,
  FrozenNotesRefundFinalizationInput,
  K1NoteSignature,
  NoteData,
  OutboxWithdrawal,
  PortalContext,
  SecpPublicKey,
  SpendValidationData,
  SpentDeposit,
  TokenOperation,
  UnprocessedDepositRefundFinalizationInput,
} from '@oxide/oxide-lib/types.js';

import { describe, expect, it, jest } from '@jest/globals';

import { buildNoteOperationDigest, buildWithdrawalOperationDigest } from './digest.js';
import { verifyEcdsa } from './libsecp256k1_signer.js';
import { SignatureBudget } from './signature_budget.js';
import { LocalTeeSigner, k1NoteSignatureToRS } from './signer.js';

const portalContext: PortalContext = {
  l1Portal: EthAddress.ZERO,
  l1ChainId: 1n,
  l2Portal: AztecAddress.fromFieldUnsafe(new Fr(1)),
  rollupVersion: 1n,
};

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

const operation = (overrides: Partial<TokenOperation> = {}): TokenOperation => ({
  anchorBlockHeader: BlockHeader.empty(),
  spentNotes: [],
  createdNotes: [],
  deposits: [],
  withdrawals: [],
  ...overrides,
});

describe('LocalTeeSigner token operations', () => {
  const signer = LocalTeeSigner.random(portalContext);

  it('rejects a created note one base-unit over the cap', async () => {
    await expect(
      signer.signTokenOperation(operation({ createdNotes: [createdNote(TX_AMOUNT_CAP + 1n)] })),
    ).rejects.toThrow(/exceeds cap/);
  });

  it('rejects a withdrawal one base-unit over the cap', async () => {
    await expect(
      signer.signTokenOperation(operation({ withdrawals: [withdrawal(TX_AMOUNT_CAP + 1n)] })),
    ).rejects.toThrow(/exceeds cap/);
  });

  it('signs a created note at exactly the cap when a deposit balances it', async () => {
    const deposits = await depositFixture([TX_AMOUNT_CAP]);
    const output = await signer.signTokenOperation(
      operation({
        anchorBlockHeader: deposits.anchorBlockHeader,
        deposits: deposits.deposits,
        createdNotes: [createdNote(TX_AMOUNT_CAP)],
      }),
    );

    expect(output.signatures).toHaveLength(1);
    expect(output.withdrawalSignatures).toHaveLength(0);
    expectFields(output.requiredNullifiers, deposits.nullifiers);
  });

  it('signs a withdrawal at exactly the cap when a deposit balances it', async () => {
    const deposits = await depositFixture([TX_AMOUNT_CAP]);
    const output = await signer.signTokenOperation(
      operation({
        anchorBlockHeader: deposits.anchorBlockHeader,
        deposits: deposits.deposits,
        withdrawals: [withdrawal(TX_AMOUNT_CAP)],
      }),
    );

    expect(output.signatures).toHaveLength(0);
    expect(output.withdrawalSignatures).toHaveLength(1);
    expectFields(output.requiredNullifiers, deposits.nullifiers);
  });

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

  it('signs mixed outputs whose aggregate value exceeds the single-output cap', async () => {
    const deposits = await depositFixture([TX_AMOUNT_CAP, TX_AMOUNT_CAP]);
    const output = await signer.signTokenOperation(
      operation({
        anchorBlockHeader: deposits.anchorBlockHeader,
        deposits: deposits.deposits,
        createdNotes: [
          createdNote(TX_AMOUNT_CAP, AztecAddress.fromFieldUnsafe(new Fr(2)), new Fr(11)),
          createdNote(TX_AMOUNT_CAP - 1n, AztecAddress.fromFieldUnsafe(new Fr(3)), new Fr(12)),
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
    const noteHash = await computeSiloedNoteHash({ ...note, l2Portal: portalContext.l2Portal });
    const withdrawalMessageHash = computeL2ToL1MessageHash({
      l2Sender: portalContext.l2Portal,
      l1Recipient: portalContext.l1Portal,
      content: getWithdrawContentHash(
        outgoing.executor,
        outgoing.userPayloadHash,
        outgoing.amount,
        outgoing.proverTip,
        outgoing.randomness,
      ),
      rollupVersion: new Fr(portalContext.rollupVersion),
      chainId: new Fr(portalContext.l1ChainId),
    });

    expectFields(output.requiredNullifiers, deposits.nullifiers);
    expectFields(output.teeNotes, [noteHash]);
    expectFields(output.withdrawalMessageHashes, [withdrawalMessageHash]);

    const noteDigest = await buildNoteOperationDigest({
      anchorBlockHash,
      tokenAddress: portalContext.l2Portal,
      requiredNullifiers: output.requiredNullifiers,
      siloedNoteHashes: output.teeNotes,
      withdrawalMessageHashes: output.withdrawalMessageHashes,
      siloedNoteHash: noteHash,
    });
    expect(verifiesK1Signature(output.signatures[0]!, noteDigest, signer.publicKey)).toBe(true);

    const withdrawalDigest = await buildWithdrawalOperationDigest({
      anchorBlockHash,
      tokenAddress: portalContext.l2Portal,
      requiredNullifiers: output.requiredNullifiers,
      siloedNoteHashes: output.teeNotes,
      withdrawalMessageHashes: output.withdrawalMessageHashes,
      messageHash: withdrawalMessageHash,
    });
    expect(verifiesK1Signature(output.withdrawalSignatures[0]!, withdrawalDigest, signer.publicKey)).toBe(true);

    const otherPortalHash = computeL2ToL1MessageHash({
      l2Sender: portalContext.l2Portal,
      l1Recipient: EthAddress.fromField(new Fr(99)),
      content: getWithdrawContentHash(
        outgoing.executor,
        outgoing.userPayloadHash,
        outgoing.amount,
        outgoing.proverTip,
        outgoing.randomness,
      ),
      rollupVersion: new Fr(portalContext.rollupVersion),
      chainId: new Fr(portalContext.l1ChainId),
    });
    const wrongWithdrawalDigest = await buildWithdrawalOperationDigest({
      anchorBlockHash,
      tokenAddress: portalContext.l2Portal,
      requiredNullifiers: output.requiredNullifiers,
      siloedNoteHashes: output.teeNotes,
      withdrawalMessageHashes: [otherPortalHash],
      messageHash: otherPortalHash,
    });
    expect(verifiesK1Signature(output.withdrawalSignatures[0]!, wrongWithdrawalDigest, signer.publicKey)).toBe(false);
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
      notes.map(note => computeSiloedNoteHash({ ...note, l2Portal: portalContext.l2Portal })),
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
  const signer = LocalTeeSigner.random(portalContext) as unknown as {
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
  const signer = LocalTeeSigner.random(portalContext);

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
      signer.signFrozenDepositRefundFinalization({
        executor: EthAddress.ZERO,
      } as unknown as FrozenDepositRefundFinalizationInput),
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
    const frozen = await frozenTipFixture();
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
  const signer = LocalTeeSigner.random(portalContext);
  const executor = EthAddress.fromField(new Fr(0xbeef));

  it('rejects a note set that mixes owners', async () => {
    const owner = await makePasskeyAccount();
    const other = await makePasskeyAccount();
    const { frozenTip, frozenArchiveRoot, frozenTipMembershipWitness } = await frozenTipFixture();

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
        auth: await owner.authorize(Fr.random()),
      }),
    ).rejects.toThrow(`Note owner ${other.address} does not match the refund owner ${owner.address}`);
  });
});

describe('LocalTeeSigner unprocessed-deposit refund', () => {
  const signer = LocalTeeSigner.random(portalContext);
  const executor = EthAddress.fromField(new Fr(0xbeef));
  const amount = 10n;
  const userPayloadHash = new Fr(1);
  const sharedSecretSalt = new Fr(42);
  // The frozen tip has absorbed no message, so any leaf index is unprocessed.
  const messageLeafIndex = new Fr(5);

  async function refundInput(account: RefundAccountFixture): Promise<{
    input: UnprocessedDepositRefundFinalizationInput;
    messageHash: Fr;
  }> {
    const { frozenTip, frozenArchiveRoot, frozenTipMembershipWitness } = await frozenTipFixture();
    const messageHash = await computeDepositMessageHash(portalContext, {
      sharedSecretSalt,
      recipient: account.address,
      amount,
      messageLeafIndex,
    });
    const authMessage = await computeUnprocessedDepositRefundAuthMessage(messageHash, executor, userPayloadHash);
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
      auth: await account.authorize(authMessage),
    };
    return { input, messageHash };
  }

  it('signs a refund the recipient passkey authorized', async () => {
    const account = await makePasskeyAccount();
    const { input, messageHash } = await refundInput(account);

    const output = await signer.signUnprocessedDepositRefundFinalization(input);

    expect(output.messageHash).toEqual(messageHash);
    expect(output.siloedNullifier).toEqual(
      await computeSiloedDepositMessageNullifier(portalContext.l2Portal, messageHash, account.masterNullifierHidingKey),
    );
  });

  it('rejects a passkey the recipient address does not commit to', async () => {
    const account = await makePasskeyAccount();
    const other = await makePasskeyAccount();
    const { input } = await refundInput(account);
    const auth = input.auth as Extract<RefundAuthorization, { kind: 'passkey' }>;

    await expect(
      signer.signUnprocessedDepositRefundFinalization({
        ...input,
        auth: { ...auth, passkey: other.passkey.publicKey },
      }),
    ).rejects.toThrow(/authorization does not verify/);
  });

  it('rejects an assertion over a different user payload', async () => {
    const account = await makePasskeyAccount();
    const { input } = await refundInput(account);

    await expect(
      signer.signUnprocessedDepositRefundFinalization({ ...input, userPayloadHash: new Fr(2) }),
    ).rejects.toThrow(/authorization does not verify/);
  });

  it('rejects an assertion by another passkey', async () => {
    const account = await makePasskeyAccount();
    const other = await makePasskeyAccount();
    const { input, messageHash } = await refundInput(account);
    const authMessage = await computeUnprocessedDepositRefundAuthMessage(messageHash, executor, userPayloadHash);
    const auth = input.auth as Extract<RefundAuthorization, { kind: 'passkey' }>;

    await expect(
      signer.signUnprocessedDepositRefundFinalization({
        ...input,
        auth: { ...auth, webauthn: await other.passkey.sign(authMessage) },
      }),
    ).rejects.toThrow(/authorization does not verify/);
  });

  it('rejects a nullifier hiding key of another account', async () => {
    const account = await makePasskeyAccount();
    const other = await makePasskeyAccount();
    const { input } = await refundInput(account);

    await expect(
      signer.signUnprocessedDepositRefundFinalization({ ...input, l2RecipientNhkM: other.masterNullifierHidingKey }),
    ).rejects.toThrow(/Master nullifier hiding key does not hash/);
  });

  // A fallback-key owner - an address that commits to no passkey, such as a shared-secret escrow - authorizes with
  // its master fallback key instead.
  it('signs a refund the recipient master fallback key authorized', async () => {
    const account = await makeFallbackKeyAccount();
    const { input, messageHash } = await refundInput(account);

    const output = await signer.signUnprocessedDepositRefundFinalization(input);

    expect(output.messageHash).toEqual(messageHash);
    expect(output.siloedNullifier).toEqual(
      await computeSiloedDepositMessageNullifier(portalContext.l2Portal, messageHash, account.masterNullifierHidingKey),
    );
  });

  it('rejects a fallback-key authorization by a passkey-bound owner', async () => {
    const account = await makePasskeyAccount();
    const { input, messageHash } = await refundInput(account);
    const authMessage = await computeUnprocessedDepositRefundAuthMessage(messageHash, executor, userPayloadHash);

    // The signature is the account's own, but its address commits to a passkey, so it does not derive from the zero
    // immutables hash the fallback-key mode uses.
    await expect(
      signer.signUnprocessedDepositRefundFinalization({
        ...input,
        auth: await fallbackKeyAuthorization(account.masterFallbackSecretKey, authMessage),
      }),
    ).rejects.toThrow(/authorization does not verify/);
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
    const signer = new LocalTeeSigner(Buffer32.random(), portalContext, budget);
    const output = await signer.signTokenOperation(zeroSumOperation(2, 1));
    expect(output.signatures).toHaveLength(2);
    expect(output.withdrawalSignatures).toHaveLength(1);
    expect(budget.remaining()).toBe(7);
  });

  it('rejects mid-operation when the budget runs out', async () => {
    const onExhausted = jest.fn();
    const budget = new SignatureBudget(2, undefined, onExhausted);
    const signer = new LocalTeeSigner(Buffer32.random(), portalContext, budget);
    await expect(signer.signTokenOperation(zeroSumOperation(3))).rejects.toThrow(/signature budget exhausted/);
    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(budget.remaining()).toBe(0);
  });

  it('shares the budget with clones made via withPortalContext', async () => {
    const budget = new SignatureBudget(10);
    const signer = new LocalTeeSigner(Buffer32.random(), portalContext, budget);
    const clone = signer.withPortalContext({ ...portalContext, rollupVersion: 2n });
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
  sign(authMessage: Fr): Promise<WebAuthnAuth>;
}

/** An account whose funds a refund recovers, with the authorizer of the mode its address selects. */
interface RefundAccountFixture {
  address: AztecAddress;
  publicKeys: PublicKeys;
  instance: AccountInstancePreimage;
  masterNullifierHidingKey: GrumpkinScalar;
  masterFallbackSecretKey: GrumpkinScalar;
  authorize(authMessage: Fr): Promise<RefundAuthorization>;
}

interface PasskeyAccountFixture extends RefundAccountFixture {
  passkey: TestPasskey;
}

/**
 * Grumpkin-Schnorr-Poseidon2 signature over `authMessage`, matching `schnorr::assert_valid_signature`. Mirrors
 * `signRefundAuthMessageWithFallbackKey` of `@oxide/oxide-client`, which the enclave may not depend on.
 */
async function fallbackKeyAuthorization(
  masterFallbackSecretKey: GrumpkinScalar,
  authMessage: Fr,
): Promise<RefundAuthorization> {
  const fbpkM = await derivePublicKeyFromSecretKey(masterFallbackSecretKey);
  const k = GrumpkinScalar.random();
  const R = await Grumpkin.mul(Grumpkin.generator, k);
  const e = await poseidon2Hash([SCHNORR_CHALLENGE_DST, R.x, fbpkM.x, fbpkM.y, authMessage]);
  const order = GrumpkinScalar.MODULUS;
  const eBig = e.toBigInt();
  const sBig = (((k.toBigInt() - ((eBig * masterFallbackSecretKey.toBigInt()) % order)) % order) + order) % order;
  const s = new GrumpkinScalar(sBig);
  return {
    kind: 'fallbackKey',
    fbpkM,
    signature: { sLo: s.lo, sHi: s.hi, eLo: new Fr(eBig & ((1n << 128n) - 1n)), eHi: new Fr(eBig >> 128n) },
  };
}

async function makeTestPasskey(): Promise<TestPasskey> {
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const raw = Buffer.from(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  return {
    publicKey: { x: raw.subarray(1, 33), y: raw.subarray(33, 65) },
    async sign(authMessage: Fr): Promise<WebAuthnAuth> {
      const clientDataJSON = Buffer.from(
        `{"type":"webauthn.get","challenge":"${computeWebAuthnChallenge(authMessage)}","origin":"https://stub.passkey.test","crossOrigin":false}`,
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
  const instance = randomInstance();
  return {
    address: await computePasskeyAccountAddress(publicKeys, instance, passkey.publicKey),
    publicKeys,
    instance,
    passkey,
    masterNullifierHidingKey: masterNullifierHidingSecretKey,
    masterFallbackSecretKey,
    authorize: async (authMessage: Fr) => ({
      kind: 'passkey',
      passkey: passkey.publicKey,
      webauthn: await passkey.sign(authMessage),
    }),
  };
}

/** An account whose address commits to no passkey, so its immutables hash is zero and it authorizes with `fbsk_m`. */
async function makeFallbackKeyAccount(): Promise<RefundAccountFixture> {
  const { masterNullifierHidingSecretKey, masterFallbackSecretKey, publicKeys } = await deriveKeys(Fr.random());
  const instance = randomInstance();
  return {
    address: await computeAccountAddress(publicKeys, instance, Fr.ZERO),
    publicKeys,
    instance,
    masterNullifierHidingKey: masterNullifierHidingSecretKey,
    masterFallbackSecretKey,
    authorize: (authMessage: Fr) => fallbackKeyAuthorization(masterFallbackSecretKey, authMessage),
  };
}

interface DepositFixture {
  anchorBlockHeader: BlockHeader;
  deposits: SpentDeposit[];
  nullifiers: Fr[];
}

class SparseTree {
  private constructor(
    private readonly height: number,
    private readonly levels: Fr[][],
    private readonly zeroHashes: Fr[],
  ) {}

  static async build(height: number, leaves: Fr[], separator: number): Promise<SparseTree> {
    const hash = (l: Fr, r: Fr) => poseidon2HashWithSeparator([l, r], separator);
    const zeroHashes: Fr[] = [Fr.ZERO];
    for (let i = 0; i < height; i++) {
      zeroHashes.push(await hash(zeroHashes[i]!, zeroHashes[i]!));
    }

    const levels: Fr[][] = [leaves.slice()];
    for (let lvl = 0; lvl < height; lvl++) {
      const cur = levels[lvl]!;
      const next: Fr[] = [];
      for (let i = 0; i * 2 < cur.length; i++) {
        next.push(await hash(cur[i * 2]!, cur[i * 2 + 1] ?? zeroHashes[lvl]!));
      }
      levels.push(next);
    }
    return new SparseTree(height, levels, zeroHashes);
  }

  get root(): Fr {
    return this.levels[this.height]?.[0] ?? this.zeroHashes[this.height]!;
  }

  siblingPath<N extends number>(leafIndex: number): Tuple<Fr, N> {
    if (leafIndex < 0 || leafIndex >= this.levels[0]!.length) {
      throw new Error(`leaf index ${leafIndex} out of range [0, ${this.levels[0]!.length})`);
    }

    const path: Fr[] = [];
    let idx = leafIndex;
    for (let lvl = 0; lvl < this.height; lvl++) {
      path.push(this.levels[lvl]![idx ^ 1] ?? this.zeroHashes[lvl]!);
      idx >>= 1;
    }
    return path as Tuple<Fr, N>;
  }
}

async function depositFixture(amounts: bigint[]): Promise<DepositFixture> {
  const recipients = await Promise.all(amounts.map(() => makeSyntheticOwner()));
  const salts = amounts.map((_, i) => new Fr(i + 1));
  const messageHashes = await Promise.all(
    recipients.map((recipient, i) =>
      computeDepositMessageHash(portalContext, {
        sharedSecretSalt: salts[i]!,
        recipient: recipient.completeAddress.address,
        amount: amounts[i]!,
        messageLeafIndex: new Fr(i),
      }),
    ),
  );
  const tree = await SparseTree.build(L1_TO_L2_MSG_TREE_HEIGHT, messageHashes, DomainSeparator.MERKLE_HASH);
  const anchorBlockHeader = depositAnchorBlockHeader(tree.root, amounts.length);

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
      computeSiloedDepositMessageNullifier(portalContext.l2Portal, messageHashes[i]!, deposit.masterNullifierHidingKey),
    ),
  );

  return { anchorBlockHeader, deposits, nullifiers };
}

// A one-block archive whose tip is block 0, so the same all-zero sibling path proves both archive checks.
async function frozenTipFixture() {
  const emptyArchive = await SparseTree.build(ARCHIVE_HEIGHT, [Fr.ZERO], DomainSeparator.MERKLE_HASH);
  const frozenTip = BlockHeader.empty({ lastArchive: new AppendOnlyTreeSnapshot(emptyArchive.root, 0) });
  const blockHash = new Fr((await frozenTip.hash()).toBuffer());
  const archive = await SparseTree.build(ARCHIVE_HEIGHT, [blockHash], DomainSeparator.MERKLE_HASH);
  return {
    frozenArchiveRoot: archive.root,
    frozenTip,
    frozenTipMembershipWitness: new MembershipWitness(
      ARCHIVE_HEIGHT,
      0n,
      archive.siblingPath<typeof ARCHIVE_HEIGHT>(0),
    ),
  };
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

function depositAnchorBlockHeader(l1ToL2Root: Fr, nextAvailableLeafIndex: number): BlockHeader {
  const emptyState = StateReference.empty();
  return BlockHeader.empty({
    state: new StateReference(new AppendOnlyTreeSnapshot(l1ToL2Root, nextAvailableLeafIndex), emptyState.partial),
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
