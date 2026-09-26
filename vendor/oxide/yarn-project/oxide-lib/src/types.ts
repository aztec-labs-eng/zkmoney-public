import { Fr, GrumpkinScalar } from '@aztec/aztec.js/fields';
import { SpongeBlob } from '@aztec/blob-lib';
import {
  ARCHIVE_HEIGHT,
  L1_TO_L2_MSG_TREE_HEIGHT,
  MAX_L2_TO_L1_MSGS_PER_TX,
  MAX_NOTE_HASHES_PER_TX,
  MAX_NULLIFIERS_PER_TX,
  NULLIFIER_TREE_HEIGHT,
  PUBLIC_DATA_TREE_HEIGHT,
} from '@aztec/constants';
import { Buffer32 } from '@aztec/foundation/buffer';
import { padArrayEnd } from '@aztec/foundation/collection';
import { Point as GrumpkinPoint } from '@aztec/foundation/curves/grumpkin';
import { Signature } from '@aztec/foundation/eth-signature';
import { type ZodFor, schemas, zodFor } from '@aztec/foundation/schemas';
import type { Tuple } from '@aztec/foundation/serialize';
import { isHex } from '@aztec/foundation/string';
import { MembershipWitness, SiblingPath } from '@aztec/foundation/trees';
import { AztecAddress } from '@aztec/stdlib/aztec-address';
import { type BlockHash, EthAddress } from '@aztec/stdlib/block';
import { CompleteAddress } from '@aztec/stdlib/contract';
import { PublicKeys } from '@aztec/stdlib/keys';
import {
  NullifierLeafPreimage,
  NullifierMembershipWitness,
  PublicDataTreeLeafPreimage,
  PublicDataWitness,
} from '@aztec/stdlib/trees';
import { BlockHeader } from '@aztec/stdlib/tx';

import { z } from 'zod';

import {
  type AccountInstancePreimage,
  AccountInstancePreimageSchema,
  type PasskeyPublicKey,
  type WebAuthnAuth,
} from './account_address.js';
import { P256PublicKey } from './encryption.js';
import {
  MAX_FROZEN_NOTES_PER_REFUND,
  WEBAUTHN_AUTHENTICATOR_DATA_LEN,
  WEBAUTHN_MAX_CLIENT_DATA_JSON_LEN,
} from './oxide_constants.gen.js';
import type { RefundAuthorization } from './refund_authorization.js';

export { P256PublicKey } from './encryption.js';

// TODO(alvaro): `schemas.Buffer32` upstream is `z.string().transform(Buffer32.fromString)`. `Buffer32.fromString`
// reads `this.SIZE`, so zod calling it unbound as `effect.transform(...)` makes `this` the effect
// descriptor and the length check always blows up with "Expected NaN characters long". Wrap the
// static call in an arrow so the class context is preserved. Drop this and use `schemas.Buffer32`
// once upstream switches to `Buffer32.SIZE` (or a bound reference).
const buffer32Schema = z
  .string()
  .refine(isHex, 'Not a valid hex string')
  .transform(s => Buffer32.fromString(s));

// ---------------------------------------------------------------------------
// Zod schema helpers used to encode the types below for the enclave RPC.
// Composed with `jsonStringify` (operator) and `jsonParseWithSchema` /
// `parseAsync` (enclave) from `@aztec/foundation/json-rpc`.
// ---------------------------------------------------------------------------

// Checks that an array has less than `max` elements or exactly `max` elements if `exact` is provided.
//
// Without this a crafted request with a huge array of invalid entries would otherwise make Zod build one issue per
// element — an amplification vector that could crash the enclave.
function boundedArray<T extends z.ZodTypeAny>(element: T, max: number, field: string, opts?: { exact?: boolean }) {
  return z.preprocess(
    value => {
      if (Array.isArray(value) && value.length > max) {
        throw new Error(`${field} has ${value.length} entries, exceeds max ${max}`);
      }
      return value;
    },
    // eslint-disable-next-line no-restricted-syntax -- the guard above rejects oversized input before this runs.
    opts?.exact ? z.array(element).length(max) : z.array(element),
  );
}

const u128Schema = schemas.BigInt.pipe(
  z
    .bigint()
    .min(0n)
    .max(2n ** 128n - 1n),
);

const LEAF_INDEX_BYTES = 32;
const VECTOR_COUNT_BYTES = 4;

function base64CharsFor(bytes: number): number {
  return 4 * Math.ceil(bytes / 3);
}

// Includes "0x"
function hexCharsFor(bytes: number): number {
  return 2 + 2 * bytes;
}

function boundedBytes(expectedBytes: number, maxChars: number, charUnit: string, field: string) {
  return (value: unknown) => {
    if (typeof value === 'string' && value.length > maxChars) {
      throw new Error(`${field} is ${value.length} ${charUnit} chars, exceeds max ${maxChars}`);
    }
    const data = (value as { data?: unknown } | null | undefined)?.data;
    if (Array.isArray(data) && data.length > expectedBytes) {
      throw new Error(`${field} has ${data.length} bytes, exceeds max ${expectedBytes}`);
    }
    return value;
  };
}

function fixedSizeBufferSchema(expectedBytes: number, field: string) {
  return z
    .preprocess(boundedBytes(expectedBytes, base64CharsFor(expectedBytes), 'base64', field), schemas.Buffer)
    .refine(buf => buf.length === expectedBytes, `${field} must be exactly ${expectedBytes} bytes`);
}

function boundedBufferSchema(maxBytes: number, field: string) {
  return z
    .preprocess(boundedBytes(maxBytes, base64CharsFor(maxBytes), 'base64', field), schemas.Buffer)
    .refine(buf => buf.length <= maxBytes, `${field} must be at most ${maxBytes} bytes`);
}

const aztecAddressSchema = (field: string): ZodFor<AztecAddress> =>
  z.preprocess(
    boundedBytes(AztecAddress.SIZE_IN_BYTES, hexCharsFor(AztecAddress.SIZE_IN_BYTES), 'hex', field),
    AztecAddress.schema,
  );

const membershipWitnessSchema = <N extends number>(height: N, field: string) =>
  fixedSizeBufferSchema(LEAF_INDEX_BYTES + height * Fr.SIZE_IN_BYTES, field).transform(buf =>
    MembershipWitness.fromBuffer(buf, height),
  );

const siblingPathSchema = <N extends number>(height: N, field: string) =>
  fixedSizeBufferSchema(VECTOR_COUNT_BYTES + height * Fr.SIZE_IN_BYTES, field)
    .refine(
      buf => buf.length >= VECTOR_COUNT_BYTES && buf.readUInt32BE(0) === height,
      `${field} must declare exactly ${height} entries`,
    )
    .transform(buf => SiblingPath.fromBuffer(buf) as SiblingPath<N>);

export const publicDataWitnessSchema = z
  .object({
    index: schemas.BigInt,
    leafPreimage: PublicDataTreeLeafPreimage.schema,
    siblingPath: siblingPathSchema(PUBLIC_DATA_TREE_HEIGHT, 'publicDataWitness.siblingPath'),
  })
  .transform(({ index, leafPreimage, siblingPath }) => new PublicDataWitness(index, leafPreimage, siblingPath));

export const nullifierMembershipWitnessSchema = z
  .object({
    index: schemas.BigInt,
    leafPreimage: NullifierLeafPreimage.schema,
    siblingPath: siblingPathSchema(NULLIFIER_TREE_HEIGHT, 'nullifierMembershipWitness.siblingPath'),
  })
  .transform(
    ({ index, leafPreimage, siblingPath }) => new NullifierMembershipWitness(index, leafPreimage, siblingPath),
  );

export const archiveMembershipWitnessSchema = membershipWitnessSchema(ARCHIVE_HEIGHT, 'archiveMembershipWitness');

// CompleteAddress.schema returns ZodType<never, ...> because its `fromString` is async and
// the inferred output type collapses to `never`. Wrap async parse explicitly so the schema
// produces an actual `CompleteAddress` instance under `parseAsync`. Validation against the
// owner is rerun by the signer in `validateOwnerPreimage`.
const completeAddressSchema = z
  .string()
  .transform(s => CompleteAddress.fromString(s)) as unknown as ZodFor<CompleteAddress>;

// The passkey schemas in `account_address.ts` read hex buffers. The enclave RPC carries buffers as base64
// (`jsonStringify`), so the finalization inputs use these transport variants with the same size limits.
const passkeyPublicKeySchema = (field: string) =>
  zodFor<PasskeyPublicKey>()(
    z.object({
      x: fixedSizeBufferSchema(32, `${field}.x`),
      y: fixedSizeBufferSchema(32, `${field}.y`),
    }),
  );

const webAuthnAssertionSchema = (field: string) =>
  zodFor<WebAuthnAuth>()(
    z.object({
      authenticatorData: fixedSizeBufferSchema(WEBAUTHN_AUTHENTICATOR_DATA_LEN, `${field}.authenticatorData`),
      clientDataJSON: boundedBufferSchema(WEBAUTHN_MAX_CLIENT_DATA_JSON_LEN, `${field}.clientDataJSON`),
      signature: fixedSizeBufferSchema(64, `${field}.signature`),
    }),
  );

const grumpkinPointSchema = (field: string): ZodFor<GrumpkinPoint> =>
  z.preprocess(
    boundedBytes(GrumpkinPoint.SIZE_IN_BYTES, hexCharsFor(GrumpkinPoint.SIZE_IN_BYTES), 'hex', field),
    GrumpkinPoint.schema,
  );

// The owner authorizes a refund either with the passkey its address commits to, or - when the address commits to no
// passkey - with its master fallback key. See `refund_authorization.ts`.
const refundAuthorizationSchema = (field: string) =>
  zodFor<RefundAuthorization>()(
    z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('passkey'),
        passkey: passkeyPublicKeySchema(`${field}.passkey`),
        webauthn: webAuthnAssertionSchema(`${field}.webauthn`),
      }),
      z.object({
        kind: z.literal('fallbackKey'),
        fbpkM: grumpkinPointSchema(`${field}.fbpkM`),
        signature: GrumpkinPoseidonSignatureSchema,
      }),
    ]),
  );

// ---------------------------------------------------------------------------
// Types + their schemas.
// ---------------------------------------------------------------------------

/** Hints proving a specific tx effect lives at a given index in a target block. */
export interface TxEffectsHints {
  /** Header of the block containing the target tx. */
  txBlockHeader: BlockHeader;
  /** Header of the block immediately preceding the tx block. */
  previousBlockHeader: BlockHeader;
  /** Merkle proof that previousBlockHeader's hash is a leaf under the verifier-supplied archive root. */
  previousBlockArchiveMembershipWitness: MembershipWitness<typeof ARCHIVE_HEIGHT>;
  /** Blob fields from checkpoint start through the end of the target block. */
  checkpointBlobFields: Fr[];
  /** Index of the target block's first field in checkpointBlobFields. Zero for the first block. */
  txBlockStartOffset: number;
  /** Index of the target tx within the block's body. */
  txIndexInBlock: number;
}

export const TxEffectsHintsSchema = zodFor<TxEffectsHints>()(
  z.object({
    txBlockHeader: BlockHeader.schema,
    previousBlockHeader: BlockHeader.schema,
    previousBlockArchiveMembershipWitness: archiveMembershipWitnessSchema,
    checkpointBlobFields: boundedArray(schemas.Fr, SpongeBlob.MAX_FIELDS, 'checkpointBlobFields'),
    txBlockStartOffset: schemas.UInt32,
    txIndexInBlock: schemas.Integer,
  }),
);

/** Relation of the tx block to the anchor block, carrying the proof material that relation requires. */
export type TxBlockAnchorRelation =
  | { kind: 'txBlockIsAnchor' }
  | {
      kind: 'txBlockIsAncestorOfAnchor';
      /** Merkle proof that the tx block's hash is a leaf in the anchor block's `lastArchive`. */
      archiveMembershipWitness: MembershipWitness<typeof ARCHIVE_HEIGHT>;
    };

/** Hints for proving that a tx's effects are in the anchor block or one of its ancestors. */
export interface TxEffectsAtAnchorHints {
  anchorRelation: TxBlockAnchorRelation;
  txEffectsHints: TxEffectsHints;
}

export const TxEffectsAtAnchorHintsSchema = zodFor<TxEffectsAtAnchorHints>()(
  z.object({
    anchorRelation: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('txBlockIsAnchor') }),
      z.object({
        kind: z.literal('txBlockIsAncestorOfAnchor'),
        archiveMembershipWitness: archiveMembershipWitnessSchema,
      }),
    ]),
    txEffectsHints: TxEffectsHintsSchema,
  }),
);

/** Hints for proving that a tx's effects are in a block whose hash is a leaf in some archive root.
 *  The archive root itself is supplied by the consumer (e.g. `WithdrawalFinalizationInput.archiveRoot`);
 *  the witness here is checked against that root. */
export interface ArchivedTxEffectsHints {
  /**
   * Merkle proof that the tx block's hash is a leaf in the consumer-supplied archive root.
   */
  archiveMembershipWitness: MembershipWitness<typeof ARCHIVE_HEIGHT>;

  txEffectsHints: TxEffectsHints;
}

export const ArchivedTxEffectsHintsSchema = zodFor<ArchivedTxEffectsHints>()(
  z.object({
    archiveMembershipWitness: archiveMembershipWitnessSchema,
    txEffectsHints: TxEffectsHintsSchema,
  }),
);

/**
 * Secp256k1 ECDSA signature `(r, s)` split into two big-endian 128-bit halves apiece, matching
 * `k1_verify::Signature` in `oxide_token_contract`. Each half is carried as an `Fr` whose value
 * is bounded to `[0, 2^128)`, so it serialises into one Noir `u128` field per slot.
 */
export interface K1NoteSignature {
  sLo: Fr;
  sHi: Fr;
  rLo: Fr;
  rHi: Fr;
}

export const K1NoteSignatureSchema = zodFor<K1NoteSignature>()(
  z.object({
    sLo: schemas.Fr,
    sHi: schemas.Fr,
    rLo: schemas.Fr,
    rHi: schemas.Fr,
  }),
);

/**
 * Grumpkin-Schnorr-Poseidon2 signature `(s, e)` split into two big-endian 128-bit halves apiece, matching the
 * `(EmbeddedCurveScalar, EmbeddedCurveScalar)` pair the `noir-lang/schnorr` verifier consumes.
 */
export interface GrumpkinPoseidonSignature {
  sLo: Fr;
  sHi: Fr;
  eLo: Fr;
  eHi: Fr;
}

export const GrumpkinPoseidonSignatureSchema = zodFor<GrumpkinPoseidonSignature>()(
  z.object({
    sLo: schemas.Fr,
    sHi: schemas.Fr,
    eLo: schemas.Fr,
    eHi: schemas.Fr,
  }),
);

export interface NoteData {
  amount: bigint;
  owner: AztecAddress;
  randomness: Fr;
}

export const NoteDataSchema = zodFor<NoteData>()(
  z.object({
    amount: u128Schema,
    owner: aztecAddressSchema('note.owner'),
    randomness: schemas.Fr,
  }),
);

export interface SpendValidationData {
  note: NoteData;
  ownerAddressPreimage: CompleteAddress;
  masterNullifierHidingKey: GrumpkinScalar;
  hints: TxEffectsAtAnchorHints;
  signature: K1NoteSignature;
  anchorBlockHashMembershipWitness: MembershipWitness<typeof ARCHIVE_HEIGHT>;
  /**
   * Public-data inclusion proof that the TEE signer's secp256k1 pubkey is in `approved_signers`
   * (value == 1) at the operation's anchor block. Authenticates the signer against the L1->L2
   * registration message that wrote the entry on L2.
   */
  signerApprovalWitness: PublicDataWitness;
}

export const SpendValidationDataSchema = zodFor<SpendValidationData>()(
  z.object({
    note: NoteDataSchema,
    ownerAddressPreimage: completeAddressSchema,
    masterNullifierHidingKey: GrumpkinScalar.schema,
    hints: TxEffectsAtAnchorHintsSchema,
    signature: K1NoteSignatureSchema,
    anchorBlockHashMembershipWitness: archiveMembershipWitnessSchema,
    signerApprovalWitness: publicDataWitnessSchema,
  }),
);

export interface SpentDeposit {
  recipient: AztecAddress;
  recipientAddressPreimage: CompleteAddress;
  masterNullifierHidingKey: GrumpkinScalar;
  amount: bigint;
  sharedSecretSalt: Fr;
  messageLeafIndex: bigint;
  siblingPath: Tuple<Fr, typeof L1_TO_L2_MSG_TREE_HEIGHT>;
}

export const SpentDepositSchema = zodFor<SpentDeposit>()(
  z.object({
    recipient: aztecAddressSchema('spentDeposit.recipient'),
    recipientAddressPreimage: completeAddressSchema,
    masterNullifierHidingKey: GrumpkinScalar.schema,
    amount: u128Schema,
    sharedSecretSalt: schemas.Fr,
    messageLeafIndex: schemas.BigInt,
    siblingPath: boundedArray(schemas.Fr, L1_TO_L2_MSG_TREE_HEIGHT, 'siblingPath', { exact: true }).transform(
      arr => arr as Tuple<Fr, typeof L1_TO_L2_MSG_TREE_HEIGHT>,
    ),
  }),
);

/**
 * An L2 -> L1 withdrawal the TEE attests the operation emitted.
 * The content hash is computed from these values.
 */
export interface OutboxWithdrawal {
  executor: EthAddress;
  userPayloadHash: Fr;
  amount: bigint;
  proverTip: bigint;
  randomness: Fr;
}

export const OutboxWithdrawalSchema = zodFor<OutboxWithdrawal>()(
  z.object({
    executor: EthAddress.schema,
    userPayloadHash: schemas.Fr,
    amount: u128Schema,
    proverTip: u128Schema,
    randomness: schemas.Fr,
  }),
);

/**
 * Portal identity bound at signer construction time: every operation this signer
 * attests to is implicitly tied to this portal, so callers cannot smuggle in a
 * different `l2Portal`/`l1Portal`/etc. per operation. `l2Portal` doubles as the
 * token contract address used for note siloing and for the `tokenAddress` slot
 * in the signed preimage.
 */
export interface PortalContext {
  l1Portal: EthAddress;
  l1ChainId: bigint;
  l2Portal: AztecAddress;
  rollupVersion: bigint;
}

export const PortalContextSchema = zodFor<PortalContext>()(
  z.object({
    l1Portal: EthAddress.schema,
    l1ChainId: schemas.BigInt,
    l2Portal: aztecAddressSchema('portalContext.l2Portal'),
    rollupVersion: schemas.BigInt,
  }),
);

export interface TokenOperation {
  anchorBlockHeader: BlockHeader;
  spentNotes: SpendValidationData[];
  createdNotes: NoteData[];
  deposits: SpentDeposit[];
  withdrawals: OutboxWithdrawal[];
}

export const TokenOperationSchema = zodFor<TokenOperation>()(
  z.object({
    anchorBlockHeader: BlockHeader.schema,
    spentNotes: boundedArray(SpendValidationDataSchema, MAX_NULLIFIERS_PER_TX, 'spentNotes'),
    createdNotes: boundedArray(NoteDataSchema, MAX_NOTE_HASHES_PER_TX, 'createdNotes'),
    deposits: boundedArray(SpentDepositSchema, MAX_NULLIFIERS_PER_TX, 'deposits'),
    withdrawals: boundedArray(OutboxWithdrawalSchema, MAX_L2_TO_L1_MSGS_PER_TX, 'withdrawals'),
  }),
);

/**
 * Output of `signTokenOperation`: one per-note Schnorr signature per created note (in
 * `signatures`), one per-withdrawal Schnorr signature per L2->L1 withdrawal (in `withdrawalSignatures`), and the
 * three field arrays the L2 contract needs in DA capsules / the L1 finalizer needs to re-bind
 * (`requiredNullifiers`, `teeNotes`, `withdrawalMessageHashes`).
 */
export interface SignTokenOperationOutput {
  signatures: K1NoteSignature[];
  withdrawalSignatures: K1NoteSignature[];
  requiredNullifiers: Fr[];
  teeNotes: Fr[];
  withdrawalMessageHashes: Fr[];
}

export const SignTokenOperationOutputSchema = zodFor<SignTokenOperationOutput>()(
  z.object({
    signatures: z.array(K1NoteSignatureSchema),
    withdrawalSignatures: z.array(K1NoteSignatureSchema),
    requiredNullifiers: z.array(schemas.Fr),
    teeNotes: z.array(schemas.Fr),
    withdrawalMessageHashes: z.array(schemas.Fr),
  }),
);

export interface WithdrawalFinalizationInput {
  archiveRoot: Fr;
  hints: ArchivedTxEffectsHints;
  signature: K1NoteSignature;
  /** L2->L1 message hash of the withdrawal being finalized. */
  messageHash: Fr;
  // Path to check that the tx.anchorBlockHash in metadata is a member of archive root
  anchorBlockHashMembershipWitness: MembershipWitness<typeof ARCHIVE_HEIGHT>;
  /**
   * Public-data inclusion proof that the TEE signer's secp256k1 pubkey is approved at the burn
   * tx's block. Verified against `hints.txBlockHeader.state.partial.publicDataTree.root`, which is
   * already authenticated by `verifyAndDecodeArchivedTxEffects` (txBlockHeader's hash is
   * proven to be a leaf of `archiveRoot`).
   */
  signerApprovalWitness: PublicDataWitness;
}

export const WithdrawalFinalizationInputSchema = zodFor<WithdrawalFinalizationInput>()(
  z.object({
    archiveRoot: schemas.Fr,
    hints: ArchivedTxEffectsHintsSchema,
    signature: K1NoteSignatureSchema,
    messageHash: schemas.Fr,
    anchorBlockHashMembershipWitness: archiveMembershipWitnessSchema,
    signerApprovalWitness: publicDataWitnessSchema,
  }),
);

export interface WithdrawalFinalizationOutput {
  /**
   * Opaque 32-byte withdrawal identifier L1 stores in `$isWithdrawalSpent`. Derived as
   * `sha256(creation_tx_hash || message_hash)`, so it uniquely identifies this withdrawal
   * finalization independently of the outbox leaf used to prove message membership.
   */
  withdrawalId: Buffer32;
  /** 32-byte ECDSA preimage hash `OxidePortal.withdraw` recomputes. */
  finalDigest: Buffer32;
  /** ECDSA signature the portal recovers. */
  signature: Signature;
}

export const WithdrawalFinalizationOutputSchema = zodFor<WithdrawalFinalizationOutput>()(
  z.object({
    withdrawalId: buffer32Schema,
    finalDigest: buffer32Schema,
    signature: Signature.schema,
  }),
);

export interface FrozenNotesRefundFinalizationInput {
  frozenArchiveRoot: Fr;
  frozenTip: BlockHeader;
  frozenTipMembershipWitness: MembershipWitness<typeof ARCHIVE_HEIGHT>;
  notes: SpendValidationData[];
  executor: EthAddress;
  userPayloadHash: Fr;
  lowNullifierMembershipWitnesses: NullifierMembershipWitness[];
  owner: AztecAddress;
  ownerPublicKeys: PublicKeys;
  ownerInstance: AccountInstancePreimage;
  auth: RefundAuthorization;
}

export const FrozenNotesRefundFinalizationInputSchema = zodFor<FrozenNotesRefundFinalizationInput>()(
  z.object({
    frozenArchiveRoot: schemas.Fr,
    frozenTip: BlockHeader.schema,
    frozenTipMembershipWitness: archiveMembershipWitnessSchema,
    notes: boundedArray(SpendValidationDataSchema, MAX_FROZEN_NOTES_PER_REFUND, 'notes'),
    executor: EthAddress.schema,
    userPayloadHash: schemas.Fr,
    lowNullifierMembershipWitnesses: boundedArray(
      nullifierMembershipWitnessSchema,
      MAX_FROZEN_NOTES_PER_REFUND,
      'lowNullifierMembershipWitnesses',
    ),
    owner: aztecAddressSchema('owner'),
    ownerPublicKeys: PublicKeys.schema,
    ownerInstance: AccountInstancePreimageSchema,
    auth: refundAuthorizationSchema('auth'),
  }),
);

export interface FrozenNotesRefundFinalizationOutput {
  /** Active source nullifiers to pass to `OxidePortal.refundFrozenNotes`. */
  nullifiers: Fr[];
  /** Public inputs signed for L1 and passed to the Noir verifier. */
  publicInputs: Fr[];
  /** 32-byte ECDSA preimage hash `OxidePortal.refundFrozenNotes` recomputes. */
  finalDigest: Buffer32;
  /** ECDSA signature the portal recovers. */
  signature: Signature;
}

export const FrozenNotesRefundFinalizationOutputSchema = zodFor<FrozenNotesRefundFinalizationOutput>()(
  z.object({
    nullifiers: z.array(schemas.Fr),
    publicInputs: z.array(schemas.Fr),
    finalDigest: buffer32Schema,
    signature: Signature.schema,
  }),
);

export interface FrozenDepositRefundFinalizationInput {
  frozenArchiveRoot: Fr;
  frozenTip: BlockHeader;
  frozenTipMembershipWitness: MembershipWitness<typeof ARCHIVE_HEIGHT>;
  amount: bigint;
  executor: EthAddress;
  userPayloadHash: Fr;
  sharedSecretSalt: Fr;
  l2Recipient: AztecAddress;
  l2RecipientPublicKeys: PublicKeys;
  l2RecipientInstance: AccountInstancePreimage;
  l2RecipientNhkM: GrumpkinScalar;
  messageMembershipWitness: MembershipWitness<typeof L1_TO_L2_MSG_TREE_HEIGHT>;
  lowNullifierMembershipWitness: NullifierMembershipWitness;
  auth: RefundAuthorization;
}

export const FrozenDepositRefundFinalizationInputSchema = zodFor<FrozenDepositRefundFinalizationInput>()(
  z.object({
    frozenArchiveRoot: schemas.Fr,
    frozenTip: BlockHeader.schema,
    frozenTipMembershipWitness: archiveMembershipWitnessSchema,
    amount: u128Schema,
    executor: EthAddress.schema,
    userPayloadHash: schemas.Fr,
    sharedSecretSalt: schemas.Fr,
    l2Recipient: aztecAddressSchema('l2Recipient'),
    l2RecipientPublicKeys: PublicKeys.schema,
    l2RecipientInstance: AccountInstancePreimageSchema,
    l2RecipientNhkM: GrumpkinScalar.schema,
    messageMembershipWitness: membershipWitnessSchema(L1_TO_L2_MSG_TREE_HEIGHT, 'messageMembershipWitness'),
    lowNullifierMembershipWitness: nullifierMembershipWitnessSchema,
    auth: refundAuthorizationSchema('auth'),
  }),
);

export interface FrozenDepositRefundFinalizationOutput {
  /** The siloed deposit-message nullifier the L1 portal marks spent and the verifier carries in public inputs. */
  siloedNullifier: Fr;
  /** Public inputs the L1 verifier receives. */
  publicInputs: Fr[];
  /** 32-byte ECDSA preimage hash `OxidePortal.refundFrozenDeposit` recomputes. */
  finalDigest: Buffer32;
  /** ECDSA signature the portal recovers. */
  signature: Signature;
}

export const FrozenDepositRefundFinalizationOutputSchema = zodFor<FrozenDepositRefundFinalizationOutput>()(
  z.object({
    siloedNullifier: schemas.Fr,
    publicInputs: z.array(schemas.Fr),
    finalDigest: buffer32Schema,
    signature: Signature.schema,
  }),
);

export interface UnprocessedDepositRefundFinalizationInput {
  frozenArchiveRoot: Fr;
  frozenTip: BlockHeader;
  frozenTipMembershipWitness: MembershipWitness<typeof ARCHIVE_HEIGHT>;
  amount: bigint;
  executor: EthAddress;
  userPayloadHash: Fr;
  sharedSecretSalt: Fr;
  l2Recipient: AztecAddress;
  l2RecipientPublicKeys: PublicKeys;
  l2RecipientInstance: AccountInstancePreimage;
  l2RecipientNhkM: GrumpkinScalar;
  messageLeafIndex: Fr;
  auth: RefundAuthorization;
}

export const UnprocessedDepositRefundFinalizationInputSchema = zodFor<UnprocessedDepositRefundFinalizationInput>()(
  z.object({
    frozenArchiveRoot: schemas.Fr,
    frozenTip: BlockHeader.schema,
    frozenTipMembershipWitness: archiveMembershipWitnessSchema,
    amount: u128Schema,
    executor: EthAddress.schema,
    userPayloadHash: schemas.Fr,
    sharedSecretSalt: schemas.Fr,
    l2Recipient: aztecAddressSchema('l2Recipient'),
    l2RecipientPublicKeys: PublicKeys.schema,
    l2RecipientInstance: AccountInstancePreimageSchema,
    l2RecipientNhkM: GrumpkinScalar.schema,
    messageLeafIndex: schemas.Fr,
    auth: refundAuthorizationSchema('auth'),
  }),
);

export interface UnprocessedDepositRefundFinalizationOutput {
  messageHash: Fr;
  siloedNullifier: Fr;
  publicInputs: Fr[];
  finalDigest: Buffer32;
  signature: Signature;
}

export const UnprocessedDepositRefundFinalizationOutputSchema = zodFor<UnprocessedDepositRefundFinalizationOutput>()(
  z.object({
    messageHash: schemas.Fr,
    siloedNullifier: schemas.Fr,
    publicInputs: z.array(schemas.Fr),
    finalDigest: buffer32Schema,
    signature: Signature.schema,
  }),
);

/** Noir `BoundedVec` layout: zero-padded storage, then the element count */
function boundedVecFields(items: Fr[], maxLen: number): Fr[] {
  return [
    ...padArrayEnd(items, Fr.zero(), maxLen, `Set of ${items.length} exceeds max ${maxLen}`),
    new Fr(items.length),
  ];
}

export class TeeSignedData {
  constructor(
    public readonly domain: number,
    public readonly anchorBlockHash: BlockHash,
    public readonly tokenAddress: AztecAddress,
    public readonly signedCommitment: Fr,
    public readonly requiredNullifiers: Fr[],
    public readonly committedSiloedNoteHashes: Fr[],
    public readonly withdrawalMessageHashes: Fr[],
  ) {}

  toFields(): Fr[] {
    return [
      new Fr(this.domain),
      this.anchorBlockHash.toFr(),
      this.tokenAddress.toField(),
      this.signedCommitment,
      ...boundedVecFields(this.requiredNullifiers, MAX_NULLIFIERS_PER_TX),
      ...boundedVecFields(this.committedSiloedNoteHashes, MAX_NOTE_HASHES_PER_TX),
      ...boundedVecFields(this.withdrawalMessageHashes, MAX_L2_TO_L1_MSGS_PER_TX),
    ];
  }
}

export interface SecpPublicKey {
  x: Buffer32;
  y: Buffer32;
}

export function splitSecpCoord(coord: Buffer32): { hi: Fr; lo: Fr } {
  const buf = coord.toBuffer();
  const hiBuf = Buffer.alloc(32);
  buf.copy(hiBuf, 16, 0, 16);
  const loBuf = Buffer.alloc(32);
  buf.copy(loBuf, 16, 16, 32);
  return { hi: Fr.fromBuffer(hiBuf), lo: Fr.fromBuffer(loBuf) };
}
export interface TeeSigner {
  readonly publicKey: SecpPublicKey;
  readonly ethAddress: EthAddress;
  readonly encryptionPublicKey: P256PublicKey;

  signTokenOperation(operation: TokenOperation): Promise<SignTokenOperationOutput>;
  signWithdrawalFinalization(input: WithdrawalFinalizationInput): Promise<WithdrawalFinalizationOutput>;
  signFrozenNotesRefundFinalization(
    input: FrozenNotesRefundFinalizationInput,
  ): Promise<FrozenNotesRefundFinalizationOutput>;
  signFrozenDepositRefundFinalization(
    input: FrozenDepositRefundFinalizationInput,
  ): Promise<FrozenDepositRefundFinalizationOutput>;
  signUnprocessedDepositRefundFinalization(
    input: UnprocessedDepositRefundFinalizationInput,
  ): Promise<UnprocessedDepositRefundFinalizationOutput>;
}

export class TEEMetadata {
  constructor(
    public readonly pubKeyXHi: Fr,
    public readonly pubKeyXLo: Fr,
    public readonly pubKeyYHi: Fr,
    public readonly pubKeyYLo: Fr,
    public readonly anchorBlockHash: BlockHash,
  ) {}

  static fromPublicKey(publicKey: SecpPublicKey, anchorBlockHash: BlockHash): TEEMetadata {
    const x = splitSecpCoord(publicKey.x);
    const y = splitSecpCoord(publicKey.y);
    return new TEEMetadata(x.hi, x.lo, y.hi, y.lo, anchorBlockHash);
  }

  /** Reassemble the enclave's k1 pubkey from the four `(hi, lo)` field halves. Inverse of
   *  `fromPublicKey`. */
  publicKey(): SecpPublicKey {
    return {
      x: joinSecpCoord(this.pubKeyXHi, this.pubKeyXLo),
      y: joinSecpCoord(this.pubKeyYHi, this.pubKeyYLo),
    };
  }

  toFields(): Fr[] {
    return [this.pubKeyXHi, this.pubKeyXLo, this.pubKeyYHi, this.pubKeyYLo, this.anchorBlockHash.toFr()];
  }
}

function joinSecpCoord(hi: Fr, lo: Fr): Buffer32 {
  const hiBuf = hi.toBuffer().subarray(16, 32);
  const loBuf = lo.toBuffer().subarray(16, 32);
  return Buffer32.fromBuffer(Buffer.concat([hiBuf, loBuf]));
}
