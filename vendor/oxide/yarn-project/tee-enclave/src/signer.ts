import { Fr, GrumpkinScalar } from '@aztec/aztec.js/fields';
import { ARCHIVE_HEIGHT, L1_TO_L2_MSG_TREE_HEIGHT, MAX_L2_TO_L1_MSGS_PER_TX } from '@aztec/constants';
import { Buffer32 } from '@aztec/foundation/buffer';
import { sha256 } from '@aztec/foundation/crypto/sha256';
import type { EthAddress } from '@aztec/foundation/eth-address';
import { MembershipWitness } from '@aztec/foundation/trees';
import type { AztecAddress } from '@aztec/stdlib/aztec-address';
import { BlockHash } from '@aztec/stdlib/block';
import type { CompleteAddress } from '@aztec/stdlib/contract';
import { computeL2ToL1MessageHash, computeNoteHashNonce, computeUniqueNoteHash } from '@aztec/stdlib/hash';
import { type PublicKeys, computeAddress, derivePublicKeyFromSecretKey, hashPublicKey } from '@aztec/stdlib/keys';
import type { NullifierMembershipWitness, PublicDataWitness } from '@aztec/stdlib/trees';
import type { BlockHeader, TxEffect } from '@aztec/stdlib/tx';

import type { AccountInstancePreimage } from '@oxide/oxide-lib/account_address.js';
import { type Constrained, derive, publicInput } from '@oxide/oxide-lib/constrained.js';
import { getWithdrawContentHash } from '@oxide/oxide-lib/content_hash.js';
import {
  extractMetadata,
  extractRequiredNullifiers,
  extractTeeNotes,
  extractWithdrawalMessageHashes,
} from '@oxide/oxide-lib/da_extractors.js';
import {
  computeDepositMessageHash,
  computeSiloedDepositMessageNullifier,
} from '@oxide/oxide-lib/deposit_message_hashing.js';
import { computeNoteNullifier, computeSignerApprovalLeafSlot, computeSiloedNoteHash } from '@oxide/oxide-lib/hash.js';
import {
  assertIsFrozenTip,
  verifyArchiveMembership,
  verifyL1ToL2MessageMembership,
  verifyNullifierNonMembership,
  verifyPublicDataMembership,
} from '@oxide/oxide-lib/membership.js';
import { MAX_FROZEN_NOTES_PER_REFUND, TX_AMOUNT_CAP } from '@oxide/oxide-lib/oxide_constants.gen.js';
import {
  computeFrozenDepositRefundAuthMessage,
  computeFrozenNotesRefundAuthMessage,
  computeUnprocessedDepositRefundAuthMessage,
} from '@oxide/oxide-lib/refund_auth_message.js';
import { type RefundAuthorization, verifyRefundAuthorization } from '@oxide/oxide-lib/refund_authorization.js';
import {
  FrozenDepositRefundFinalizationInput,
  FrozenDepositRefundFinalizationOutput,
  FrozenNotesRefundFinalizationInput,
  FrozenNotesRefundFinalizationOutput,
  type K1NoteSignature,
  type OutboxWithdrawal,
  P256PublicKey,
  PortalContext,
  type SecpPublicKey,
  SignTokenOperationOutput,
  type SpendValidationData,
  type SpentDeposit,
  type TEEMetadata,
  type TeeSigner,
  TokenOperation,
  UnprocessedDepositRefundFinalizationInput,
  UnprocessedDepositRefundFinalizationOutput,
  WithdrawalFinalizationInput,
  WithdrawalFinalizationOutput,
  splitSecpCoord,
} from '@oxide/oxide-lib/types.js';

import {
  buildFrozenDepositRefundFinalDigest,
  buildFrozenNotesRefundFinalDigest,
  buildNoteOperationDigest,
  buildUnprocessedDepositRefundFinalDigest,
  buildWithdrawalFinalDigest,
  buildWithdrawalOperationDigest,
} from './digest.js';
import { Secp256k1Signer, secpPublicKeyFromPrivateKey, verifyEcdsa } from './libsecp256k1_signer.js';
import { SignatureBudget } from './signature_budget.js';
import { SignerWithBudget } from './signer_with_budget.js';
import { verifyAndDecodeArchivedTxEffects, verifyAndDecodeTxEffectsAtAnchor } from './verify_and_decode_tx_effects.js';

/**
 * Convert a `(r, s)` ECDSA `Signature` (32-byte big-endian halves) into the field-pair shape
 * the L2 contract reads from a capsule. Each 32-byte scalar splits into a `Fr`-wrapped pair of
 * 128-bit halves (high = bytes 0..16, low = bytes 16..32, big-endian); the corresponding Noir
 * struct deserialises these four fields as `Signature { s_lo, s_hi, r_lo, r_hi }`.
 */
export function k1SignatureToK1NoteSignature(signature: { r: Buffer32; s: Buffer32 }): K1NoteSignature {
  const { hi: rHi, lo: rLo } = splitSecpCoord(signature.r);
  const { hi: sHi, lo: sLo } = splitSecpCoord(signature.s);
  return { rHi, rLo, sHi, sLo };
}

/** Inverse of `k1SignatureToK1NoteSignature`: reassemble the `(r, s)` 32-byte halves from the
 *  field-pair shape (e.g. when reading a published withdrawal signature back from a private log). */
export function k1NoteSignatureToRS(sig: K1NoteSignature): { r: Buffer32; s: Buffer32 } {
  return { r: joinHalves(sig.rHi, sig.rLo), s: joinHalves(sig.sHi, sig.sLo) };
}

function joinHalves(hi: Fr, lo: Fr): Buffer32 {
  const hiBuf = hi.toBuffer().subarray(16, 32);
  const loBuf = lo.toBuffer().subarray(16, 32);
  return Buffer32.fromBuffer(Buffer.concat([hiBuf, loBuf]));
}

/** Verify an ECDSA secp256k1 signature against a 32-byte digest under the given uncompressed
 *  pubkey. The equivalent constrained check happens inside Noir via
 *  `k1_verify::safe_verify_signature`. */
function verifyK1NoteSignature(signature: K1NoteSignature, digest: Fr, publicKey: SecpPublicKey): boolean {
  const { r, s } = k1NoteSignatureToRS(signature);
  const rs = Buffer.concat([r.toBuffer(), s.toBuffer()]);
  const pub = Buffer.concat([Buffer.from([0x04]), publicKey.x.toBuffer(), publicKey.y.toBuffer()]);
  return verifyEcdsa(rs, digest.toBuffer(), pub);
}

export class LocalTeeSigner implements TeeSigner {
  public readonly publicKey: SecpPublicKey;
  private readonly ecdsaSigner: SignerWithBudget;

  constructor(
    private readonly privateKey: Buffer32,
    private readonly portalContext: PortalContext,
    private readonly budget: SignatureBudget,
  ) {
    this.ecdsaSigner = new SignerWithBudget(new Secp256k1Signer(privateKey), budget);
    this.publicKey = secpPublicKeyFromPrivateKey(privateKey);
  }

  get ethAddress(): EthAddress {
    return this.ecdsaSigner.address;
  }

  /** Placeholder P-256 encryption pubkey published in `user_data`. The local signer doesn't
   *  actually hold an encryption keypair — fixtures and tests just need a deterministic
   *  non-secret `(X, Y)` to bind. The real enclave supplies a freshly-generated P-256 pubkey
   *  here. */
  get encryptionPublicKey(): P256PublicKey {
    return P256PublicKey.fromCoordinates({ x: Buffer32.ZERO, y: Buffer32.ZERO });
  }

  get tokenAddress(): AztecAddress {
    return this.portalContext.l2Portal;
  }

  static random(portalContext: PortalContext): LocalTeeSigner {
    return new LocalTeeSigner(Buffer32.random(), portalContext, SignatureBudget.create());
  }

  /**
   * Returns a new `LocalTeeSigner` with the same key material but a different `PortalContext`.
   * Used when a TEE is shared across multiple portals so the same secp256k1 identity (eth address
   * + pubkey) can be registered on each portal.
   */
  withPortalContext(portalContext: PortalContext): LocalTeeSigner {
    return new LocalTeeSigner(this.privateKey, portalContext, this.budget);
  }

  private async validateOwnerPreimage(owner: AztecAddress, ownerAddressPreimage: CompleteAddress): Promise<void> {
    const derivedOwner = await computeAddress(ownerAddressPreimage.publicKeys, ownerAddressPreimage.partialAddress);
    if (!derivedOwner.equals(owner)) {
      throw new Error(`Owner address preimage does not match note owner: expected ${owner}, rederived ${derivedOwner}`);
    }
  }

  /** Checks that `masterNullifierHidingKey` derives the `npk_m_hash` in `publicKeys`. */
  private async validateMasterNullifierHidingKey(
    masterNullifierHidingKey: GrumpkinScalar,
    publicKeys: PublicKeys,
  ): Promise<void> {
    const derivedNpk = await derivePublicKeyFromSecretKey(masterNullifierHidingKey);
    const derivedNpkHash = await hashPublicKey(derivedNpk);
    const committedNpkHash = publicKeys.npkMHash;
    if (!derivedNpkHash.equals(committedNpkHash)) {
      throw new Error(
        `Master nullifier hiding key does not hash to the npk_m_hash committed to by ${committedNpkHash}`,
      );
    }
  }

  /**
   * Checks that the owner of `account` authorized `authMessage`: `publicKeys` and `instance` must hash to `account`
   * under the immutables hash of the authorization mode, and that mode's authorization must verify. Mirrors
   * `refund_lib::assert_refund_authorized`, which covers both the passkey mode and the fallback-key mode.
   */
  private async validateRefundAuthorization(
    account: AztecAddress,
    publicKeys: PublicKeys,
    instance: AccountInstancePreimage,
    authMessage: Fr,
    auth: RefundAuthorization,
    what: string,
  ): Promise<void> {
    if (!(await verifyRefundAuthorization(publicKeys, instance, account, authMessage, auth))) {
      throw new Error(`${what} authorization does not verify for account ${account}`);
    }
  }

  /**
   * Validates the spend's anchor block hash is either equal the operation's anchor block header hash, or is in that
   * header's archive.
   *
   * Mirrors validate_anchor_block_hash_in_the_past
   */
  private async validateSpendAnchorBlockHash(
    spendAnchorBlockHash: BlockHash,
    operationAnchorBlockHeader: Constrained<BlockHeader>,
    membershipWitness: MembershipWitness<typeof ARCHIVE_HEIGHT>,
  ): Promise<void> {
    const operationAnchorHash = await operationAnchorBlockHeader.hash();
    if (operationAnchorHash.equals(spendAnchorBlockHash)) {
      return;
    }
    await verifyArchiveMembership(
      spendAnchorBlockHash,
      membershipWitness,
      derive(operationAnchorBlockHeader, h => h.lastArchive.root),
    );
  }

  /**
   * Verifies the TEE signer that produced `metadata.pubKey{X,Y}` is registered in the token's `approved_signers` map.
   */
  private async validateSignerApproval(
    metadata: TEEMetadata,
    witness: PublicDataWitness,
    publicDataTreeRoot: Constrained<Fr>,
  ): Promise<void> {
    const expectedLeafSlot = await computeSignerApprovalLeafSlot(this.tokenAddress, metadata.publicKey());

    const { leaf } = witness.leafPreimage;
    if (!leaf.slot.equals(expectedLeafSlot)) {
      throw new Error(
        `Signer approval witness slot mismatch: expected ${expectedLeafSlot}, got ${leaf.slot}` +
          ` (signer pubkey x=${metadata.pubKeyXHi}|${metadata.pubKeyXLo}, y=${metadata.pubKeyYHi}|${metadata.pubKeyYLo})`,
      );
    }
    if (!leaf.value.equals(new Fr(1n))) {
      throw new Error(
        `Signer pubkey x=${metadata.pubKeyXHi}|${metadata.pubKeyXLo}, y=${metadata.pubKeyYHi}|${metadata.pubKeyYLo}` +
          ` is not approved (approved_signers value=${leaf.value})`,
      );
    }

    await verifyPublicDataMembership(witness, publicDataTreeRoot);
  }

  private async validateSiloedVsUniqueNoteHash(siloedNoteHash: Fr, creationEffects: TxEffect): Promise<Fr> {
    const firstNullifier = creationEffects.nullifiers[0];
    let foundUniqueNoteHash = undefined;
    for (let i = 0; i < creationEffects.noteHashes.length; i++) {
      const nonceForI = await computeNoteHashNonce(firstNullifier, i);
      const uniqueNoteHash = await computeUniqueNoteHash(nonceForI, siloedNoteHash);
      if (uniqueNoteHash.equals(creationEffects.noteHashes[i])) {
        if (foundUniqueNoteHash !== undefined) {
          throw new Error(`Multiple unique note hashes found for siloed note hash ${siloedNoteHash}`);
        }
        foundUniqueNoteHash = uniqueNoteHash;
      }
    }

    if (foundUniqueNoteHash === undefined) {
      throw new Error(`Unique note hash not found for siloed note hash ${siloedNoteHash}`);
    }

    return foundUniqueNoteHash;
  }

  private validateRequiredNullifiers(requiredNullifiers: Fr[], creationEffects: TxEffect): void {
    for (const requiredNullifier of requiredNullifiers) {
      if (!creationEffects.nullifiers.some(effectedNullifier => effectedNullifier.equals(requiredNullifier))) {
        throw new Error(`Required nullifier ${requiredNullifier} not found in creation effects`);
      }
    }
  }

  private validateSiloedNoteHashInTeeNotes(siloedNoteHash: Fr, teeNotes: Fr[]): void {
    if (teeNotes.filter(teeNote => teeNote.equals(siloedNoteHash)).length !== 1) {
      throw new Error(`Siloed note hash ${siloedNoteHash} not found once in tee notes`);
    }
  }

  /**
   * Validates that withdrawal messages are included in the tx effect of the tx corresponding to the current operation.
   */
  private validateWithdrawalMessageHashesInL2ToL1Msgs(withdrawalMessageHashes: Fr[], creationEffects: TxEffect): void {
    for (const withdrawalMessageHash of withdrawalMessageHashes) {
      if (!creationEffects.l2ToL1Msgs.some(msg => msg.equals(withdrawalMessageHash))) {
        throw new Error(
          `Attested withdrawal message hash ${withdrawalMessageHash} not found in creation tx l2ToL1Msgs`,
        );
      }
    }
  }

  /**
   * Validates spent deposits are legitimate and returns the resulting nullifiers and deposit amount.
   *
   * @dev The returned nullifiers are then checked to actually exist in the corresponding tx effect.
   * @dev The returned amount feeds the operation's balance invariant:
   *      sum(spent) + sum(deposits) == sum(created) + sum(withdrawals).
   */
  private async validateDeposits(
    deposits: SpentDeposit[],
    anchorBlockHeader: Constrained<BlockHeader>,
  ): Promise<{ depositMessageNullifiers: Fr[]; amountDeposited: bigint }> {
    if (deposits.length === 0) {
      return { depositMessageNullifiers: [], amountDeposited: 0n };
    }
    const portal = this.portalContext;
    const l1ToL2Root = derive(anchorBlockHeader, h => h.state.l1ToL2MessageTree.root);

    const depositMessageNullifiers: Fr[] = [];
    let amountDeposited = 0n;

    for (const deposit of deposits) {
      // For each deposit we first validate that the deposit message in the tree
      const preimage = {
        sharedSecretSalt: deposit.sharedSecretSalt,
        recipient: deposit.recipient,
        amount: deposit.amount,
        messageLeafIndex: new Fr(deposit.messageLeafIndex),
      };
      const messageHash = await computeDepositMessageHash(portal, preimage);

      const witness = new MembershipWitness(L1_TO_L2_MSG_TREE_HEIGHT, deposit.messageLeafIndex, deposit.siblingPath);
      await verifyL1ToL2MessageMembership(messageHash, witness, l1ToL2Root);

      // Then we recompute the nullifier
      // - first we need to constrain that the provided nullifier hiding key matches the recipient
      await this.validateOwnerPreimage(deposit.recipient, deposit.recipientAddressPreimage);
      await this.validateMasterNullifierHidingKey(
        deposit.masterNullifierHidingKey,
        deposit.recipientAddressPreimage.publicKeys,
      );

      const nullifier = await computeSiloedDepositMessageNullifier(
        portal.l2Portal,
        messageHash,
        deposit.masterNullifierHidingKey,
      );
      depositMessageNullifiers.push(nullifier);
      amountDeposited += deposit.amount;
    }

    return { depositMessageNullifiers, amountDeposited };
  }

  /** Compute each withdrawal's L2->L1 message hash and enforce the per-withdrawal cap. */
  private validateWithdrawals(withdrawals: OutboxWithdrawal[]): {
    withdrawalMessageHashes: Fr[];
    amountWithdrawn: bigint;
  } {
    if (withdrawals.length === 0) {
      return { withdrawalMessageHashes: [], amountWithdrawn: 0n };
    }
    if (withdrawals.length > MAX_L2_TO_L1_MSGS_PER_TX) {
      throw new Error(`Too many withdrawals: got ${withdrawals.length}, max ${MAX_L2_TO_L1_MSGS_PER_TX}`);
    }
    const portal = this.portalContext;

    const withdrawalMessageHashes: Fr[] = [];
    let amountWithdrawn = 0n;
    for (const withdrawal of withdrawals) {
      if (withdrawal.executor.isZero()) {
        throw new Error('Withdrawal executor is the zero address');
      }
      if (withdrawal.proverTip > withdrawal.amount) {
        throw new Error('Withdrawal prover tip exceeds amount');
      }
      if (withdrawal.amount > TX_AMOUNT_CAP) {
        throw new Error(`Individual withdrawal amount ${withdrawal.amount} exceeds cap ${TX_AMOUNT_CAP}`);
      }
      withdrawalMessageHashes.push(
        computeL2ToL1MessageHash({
          l2Sender: portal.l2Portal,
          l1Recipient: portal.l1Portal,
          content: getWithdrawContentHash(
            withdrawal.executor,
            withdrawal.userPayloadHash,
            withdrawal.amount,
            withdrawal.proverTip,
            withdrawal.randomness,
          ),
          rollupVersion: new Fr(portal.rollupVersion),
          chainId: new Fr(portal.l1ChainId),
        }),
      );
      amountWithdrawn += withdrawal.amount;
    }
    return { withdrawalMessageHashes, amountWithdrawn };
  }

  private async validateSpends(
    spentNotes: SpendValidationData[],
    anchorBlockHeader: Constrained<BlockHeader>,
  ): Promise<{
    requiredNullifiers: Fr[];
    uniqueNoteHashes: Fr[];
    amountSpent: bigint;
  }> {
    const localNullifierSet = new Set<bigint>();
    const requiredNullifiers: Fr[] = [];
    const uniqueNoteHashes: Fr[] = [];
    let amountSpent = 0n;

    for (const spend of spentNotes) {
      // Validate the owner preimage we got
      await this.validateOwnerPreimage(spend.note.owner, spend.ownerAddressPreimage);
      // Validate that the master nullifier hiding key matches the one in the owner address
      await this.validateMasterNullifierHidingKey(
        spend.masterNullifierHidingKey,
        spend.ownerAddressPreimage.publicKeys,
      );

      const siloedNoteHash = await computeSiloedNoteHash({ ...spend.note, l2Portal: this.tokenAddress });

      // Authenticate the note's creation tx and decode its effects from the committed block blob fields.
      const creationEffects = await verifyAndDecodeTxEffectsAtAnchor(spend.hints, anchorBlockHeader);

      const uniqueNoteHash = await this.validateSiloedVsUniqueNoteHash(siloedNoteHash, creationEffects);

      const creationTeeNotes = await extractTeeNotes(creationEffects, this.tokenAddress);
      this.validateSiloedNoteHashInTeeNotes(siloedNoteHash, creationTeeNotes);

      const creationRequiredNullifiers = await extractRequiredNullifiers(creationEffects, this.tokenAddress);
      this.validateRequiredNullifiers(creationRequiredNullifiers, creationEffects);

      const creationWithdrawalMessageHashes = await extractWithdrawalMessageHashes(creationEffects, this.tokenAddress);
      // We do the whole TEE dance because we can't fully trust the outbox - it inherits
      // trust from circuits that may be buggy. So independently verify that every withdrawal
      // the TEE attested in the creation preimage actually shows up as an L2->L1 message
      // in the creation tx's effects. A rogue-or-broken TEE that signed a phantom withdrawal
      // gets caught here, at the first spend of any note produced by that tx.
      this.validateWithdrawalMessageHashesInL2ToL1Msgs(creationWithdrawalMessageHashes, creationEffects);

      const creationMetadata = await extractMetadata(creationEffects, this.tokenAddress);
      await this.validateSignerApproval(
        creationMetadata,
        spend.signerApprovalWitness,
        derive(anchorBlockHeader, h => h.state.partial.publicDataTree.root),
      );
      await this.validateSpendAnchorBlockHash(
        creationMetadata.anchorBlockHash,
        anchorBlockHeader,
        spend.anchorBlockHashMembershipWitness,
      );

      const digest = await buildNoteOperationDigest({
        anchorBlockHash: creationMetadata.anchorBlockHash,
        tokenAddress: this.tokenAddress,
        siloedNoteHash,
        requiredNullifiers: creationRequiredNullifiers,
        siloedNoteHashes: creationTeeNotes,
        withdrawalMessageHashes: creationWithdrawalMessageHashes,
      });
      const publicKey = creationMetadata.publicKey();
      if (!verifyK1NoteSignature(spend.signature, digest, publicKey)) {
        throw new Error(`Signature verification failed for note ${siloedNoteHash}`);
      }

      const nullifier = await computeNoteNullifier(uniqueNoteHash, this.tokenAddress, spend.masterNullifierHidingKey);

      // Guard against spending the same note twice within this operation.
      if (localNullifierSet.has(nullifier.toBigInt())) {
        throw new Error(`Duplicate spend nullifier ${nullifier} in operation`);
      }
      localNullifierSet.add(nullifier.toBigInt());

      requiredNullifiers.push(nullifier);
      uniqueNoteHashes.push(uniqueNoteHash);
      amountSpent += spend.note.amount;
    }

    return { requiredNullifiers, uniqueNoteHashes, amountSpent };
  }

  /**
   * Assert that none of `nullifiers` are spent at `frozenTip`.
   *
   * TODO(benesjan): The terminology is broken here as generally note is spent and not nullifier.
   */
  private async validateNullifiersUnspentAtFrozenTip(
    nullifiers: Fr[],
    frozenTip: Constrained<BlockHeader>,
    lowNullifierMembershipWitnesses: NullifierMembershipWitness[],
  ): Promise<void> {
    if (lowNullifierMembershipWitnesses.length !== nullifiers.length) {
      throw new Error(
        `Expected ${nullifiers.length} low-nullifier witnesses, got ${lowNullifierMembershipWitnesses.length}`,
      );
    }
    const nullifierRoot = derive(frozenTip, h => h.state.partial.nullifierTree.root);
    for (let i = 0; i < nullifiers.length; i++) {
      await verifyNullifierNonMembership(nullifiers[i]!, lowNullifierMembershipWitnesses[i]!, nullifierRoot);
    }
  }

  private async buildOperationCommitments(operation: TokenOperation): Promise<{
    anchorBlockHash: BlockHash;
    siloedNoteHashes: Fr[];
    withdrawalMessageHashes: Fr[];
    requiredNullifiers: Fr[];
  }> {
    // This anchor block header is verified by:
    // 1. Future TEE calls when spending a note to be the ancestor of the future anchor,
    // 2. in the l2 token when verifying a note's TEE signature during note sync,
    // 3. on L1 when verifying a withdrawal.
    const anchorBlockHeader = publicInput(
      operation.anchorBlockHeader,
      "anchor block header is the operation's root of trust",
    );
    const anchorBlockHash = await anchorBlockHeader.hash();

    const { requiredNullifiers: spendNullifiers, amountSpent } = await this.validateSpends(
      operation.spentNotes,
      anchorBlockHeader,
    );
    const { depositMessageNullifiers, amountDeposited } = await this.validateDeposits(
      operation.deposits,
      anchorBlockHeader,
    );
    const { withdrawalMessageHashes, amountWithdrawn } = this.validateWithdrawals(operation.withdrawals);

    // Deposit-message nullifiers fold into `requiredNullifiers`, which every TEE signature commits to.
    const requiredNullifiers = [...spendNullifiers, ...depositMessageNullifiers];

    const amountCreated = operation.createdNotes.reduce((acc, createdNote) => {
      const amount = createdNote.amount;
      // Assert that each note amount doesn't cross per tx limits.
      if (amount > TX_AMOUNT_CAP) {
        throw new Error(`Created note amount ${amount} exceeds cap ${TX_AMOUNT_CAP}`);
      }
      return acc + amount;
    }, 0n);
    // Unified balance invariant: sum(spent) + sum(deposits) == sum(created) + sum(withdrawals).
    if (amountSpent + amountDeposited !== amountCreated + amountWithdrawn) {
      throw new Error(
        `Balance mismatch: spent=${amountSpent} deposited=${amountDeposited} created=${amountCreated} withdrawn=${amountWithdrawn}`,
      );
    }

    const siloedNoteHashes = await Promise.all(
      operation.createdNotes.map(async createdNote => {
        return await computeSiloedNoteHash({ ...createdNote, l2Portal: this.tokenAddress });
      }),
    );

    if (new Set(siloedNoteHashes.map(teeNote => teeNote.toBigInt())).size !== siloedNoteHashes.length) {
      throw new Error(`Duplicate tee notes found in operation`);
    }

    if (
      new Set(requiredNullifiers.map(requiredNullifier => requiredNullifier.toBigInt())).size !==
      requiredNullifiers.length
    ) {
      throw new Error(`Duplicate required nullifiers found in operation`);
    }

    if (
      new Set(withdrawalMessageHashes.map(withdrawalMessageHash => withdrawalMessageHash.toBigInt())).size !==
      withdrawalMessageHashes.length
    ) {
      throw new Error(`Duplicate withdrawal message hashes found in operation`);
    }

    return {
      anchorBlockHash,
      siloedNoteHashes,
      withdrawalMessageHashes,
      requiredNullifiers,
    };
  }

  // Sign a digest. The signature will be verified on L2.
  private signForL2(digest: Fr): K1NoteSignature {
    const ethSig = this.ecdsaSigner.sign(Buffer32.fromBuffer(digest.toBuffer()));
    return k1SignatureToK1NoteSignature(ethSig);
  }

  public async signTokenOperation(operation: TokenOperation): Promise<SignTokenOperationOutput> {
    const { anchorBlockHash, siloedNoteHashes, withdrawalMessageHashes, requiredNullifiers } =
      await this.buildOperationCommitments(operation);

    // This operation produces one TEE signature per created note and one per withdrawal. Every
    // such signature is built over the same operation-level preimage tail — `anchorBlockHash`,
    // `tokenAddress`, `requiredNullifiers`, all `siloedNoteHashes`, all `withdrawalMessageHashes`
    // and differs only in:
    //  (a) which single commitment is being signed (one specific note hash, or one specific
    //      withdrawal message hash) and
    //  (b) a domain byte the digest builder prepends.
    // We hoist the shared tail into `digestInput` so each `build*OperationDigest` call below can
    // splat it in alongside the one varying field.
    const digestInput = {
      anchorBlockHash,
      tokenAddress: this.tokenAddress,
      requiredNullifiers,
      siloedNoteHashes,
      withdrawalMessageHashes,
    };

    // These per-note / per-withdrawal signatures are L2-side attestations: they are what a
    // later TEE call checks before signing for that note's spend or that withdrawal's
    // finalization.
    const signatures = (
      await Promise.all(
        siloedNoteHashes.map(siloedNoteHash => buildNoteOperationDigest({ ...digestInput, siloedNoteHash })),
      )
    ).map(digest => this.signForL2(digest));

    const withdrawalSignatures = (
      await Promise.all(
        withdrawalMessageHashes.map(messageHash => buildWithdrawalOperationDigest({ ...digestInput, messageHash })),
      )
    ).map(digest => this.signForL2(digest));

    return {
      signatures,
      withdrawalSignatures,
      requiredNullifiers,
      teeNotes: siloedNoteHashes,
      withdrawalMessageHashes,
    };
  }

  private validateMessageHashInWithdrawalMessageHashes(messageHash: Fr, withdrawalMessageHashes: Fr[]): void {
    if (!withdrawalMessageHashes.some(withdrawalMessageHash => withdrawalMessageHash.equals(messageHash))) {
      throw new Error(`Message hash ${messageHash} not found in withdrawal message hashes`);
    }
  }

  /**
   * Oxide serves as a backup for L2 and for that reason we cannot trust that the L2 to L1 messages included in Outbox
   * are legitimate. To address this we verify that:
   * 1. At creation the withdrawal was signed by a legitimate TEE,
   * 2. the withdrawal message was included in a tx effect that was included in the archiveRoot we anchor to.
   *
   * TODO: Come up with unique names for the 2 kinds of TEE withdrawal signatures and rename `verifyK1NoteSignature`.
   */
  public async signWithdrawalFinalization(input: WithdrawalFinalizationInput): Promise<WithdrawalFinalizationOutput> {
    const { messageHash } = input;

    const archiveRoot = publicInput(input.archiveRoot, 'archive root is verified on L1 upon withdrawal finalization');
    const { txEffect: creationEffects, txBlockHeader } = await verifyAndDecodeArchivedTxEffects(
      input.hints,
      archiveRoot,
    );

    const creationWithdrawalMessageHashes = await extractWithdrawalMessageHashes(creationEffects, this.tokenAddress);
    this.validateMessageHashInWithdrawalMessageHashes(messageHash, creationWithdrawalMessageHashes);

    const creationRequiredNullifiers = await extractRequiredNullifiers(creationEffects, this.tokenAddress);
    this.validateRequiredNullifiers(creationRequiredNullifiers, creationEffects);

    this.validateWithdrawalMessageHashesInL2ToL1Msgs(creationWithdrawalMessageHashes, creationEffects);

    const creationTeeNotes = await extractTeeNotes(creationEffects, this.tokenAddress);

    const creationMetadata = await extractMetadata(creationEffects, this.tokenAddress);

    await this.validateSignerApproval(
      creationMetadata,
      input.signerApprovalWitness,
      derive(txBlockHeader, h => h.state.partial.publicDataTree.root),
    );

    await verifyArchiveMembership(
      creationMetadata.anchorBlockHash,
      input.anchorBlockHashMembershipWitness,
      archiveRoot,
    );

    // Verify that the creation of the message was signed by the TEE.
    const digest = await buildWithdrawalOperationDigest({
      anchorBlockHash: creationMetadata.anchorBlockHash,
      tokenAddress: this.tokenAddress,
      requiredNullifiers: creationRequiredNullifiers,
      siloedNoteHashes: creationTeeNotes,
      withdrawalMessageHashes: creationWithdrawalMessageHashes,
      messageHash,
    });
    const publicKey = creationMetadata.publicKey();
    if (!verifyK1NoteSignature(input.signature, digest, publicKey)) {
      throw new Error(`Signature verification failed for withdrawal ${messageHash}`);
    }

    // L1 stores this opaque id in `$isWithdrawalSpent` to prevent replay of the same withdrawal.
    const withdrawalId = new Buffer32(
      sha256(Buffer.concat([creationEffects.txHash, messageHash].map(f => f.toBuffer()))),
    );

    const finalDigest = buildWithdrawalFinalDigest({
      archiveRoot: input.archiveRoot,
      withdrawalId,
      messageHash,
    });

    const signature = this.ecdsaSigner.sign(finalDigest);

    return { withdrawalId, finalDigest, signature };
  }

  public async signFrozenNotesRefundFinalization(
    input: FrozenNotesRefundFinalizationInput,
  ): Promise<FrozenNotesRefundFinalizationOutput> {
    if (input.executor.isZero()) {
      throw new Error('Refund executor is the zero address');
    }

    // The following root is verified on L1 upon refund's finalization
    const frozenArchiveRoot = publicInput(input.frozenArchiveRoot, "frozen archive root is the refund's root of trust");
    const frozenTip = await assertIsFrozenTip(frozenArchiveRoot, input.frozenTip, input.frozenTipMembershipWitness);

    // Every note must belong to the single owner whose passkey authorizes the refund. This is checked before the
    // spends, so a mixed-owner note set is refused without the cost of validating it.
    // TODO(leila): Refactor the input to have a smaller SpendValidationData without owner information for each note,
    // and supply the single owner and check its NHK once.
    for (const noteSpend of input.notes) {
      if (!noteSpend.note.owner.equals(input.owner)) {
        throw new Error(`Note owner ${noteSpend.note.owner} does not match the refund owner ${input.owner}`);
      }
    }

    const { requiredNullifiers, uniqueNoteHashes, amountSpent } = await this.validateSpends(input.notes, frozenTip);
    if (requiredNullifiers.length === 0) {
      throw new Error('Frozen-notes refund operation must spend at least one note');
    }
    if (requiredNullifiers.length > MAX_FROZEN_NOTES_PER_REFUND) {
      throw new Error(
        `Frozen-notes refund spends ${requiredNullifiers.length} notes, max ${MAX_FROZEN_NOTES_PER_REFUND}`,
      );
    }

    await this.validateNullifiersUnspentAtFrozenTip(
      requiredNullifiers,
      frozenTip,
      input.lowNullifierMembershipWitnesses,
    );

    // Verify the owner's authorization over all notes (in nullifier order). This also binds the owner's public keys
    // and instance preimage to its address, under the immutables hash of the authorization mode.
    const authMessage = await computeFrozenNotesRefundAuthMessage(
      uniqueNoteHashes,
      input.executor,
      input.userPayloadHash,
    );
    await this.validateRefundAuthorization(
      input.owner,
      input.ownerPublicKeys,
      input.ownerInstance,
      authMessage,
      input.auth,
      'Frozen-notes refund',
    );

    const nullifiers = requiredNullifiers.map(nullifier => nullifier);
    const { publicInputs, finalDigest } = buildFrozenNotesRefundFinalDigest({
      portal: this.portalContext,
      frozenArchiveRoot: input.frozenArchiveRoot,
      amount: amountSpent,
      executor: input.executor,
      userPayloadHash: input.userPayloadHash,
      nullifiers,
    });
    const signature = this.ecdsaSigner.sign(finalDigest);

    return { nullifiers, publicInputs, finalDigest, signature };
  }

  /** Validates a frozen deposit and signs a refund. */
  public async signFrozenDepositRefundFinalization(
    input: FrozenDepositRefundFinalizationInput,
  ): Promise<FrozenDepositRefundFinalizationOutput> {
    if (input.executor.isZero()) {
      throw new Error('Refund executor is the zero address');
    }
    const portal = this.portalContext;
    const preimage = {
      sharedSecretSalt: input.sharedSecretSalt,
      recipient: input.l2Recipient,
      amount: input.amount,
      messageLeafIndex: new Fr(input.messageMembershipWitness.leafIndex),
    };

    // 1. Recompute the deposit message hash.
    const messageHash = await computeDepositMessageHash(portal, preimage);

    // 2. Constrain the frozen tip and verify the message is in it.
    // The following root is verified on L1 upon refund's finalization
    const frozenArchiveRoot = publicInput(input.frozenArchiveRoot, "frozen archive root is the refund's root of trust");
    const frozenTip = await assertIsFrozenTip(frozenArchiveRoot, input.frozenTip, input.frozenTipMembershipWitness);
    await verifyL1ToL2MessageMembership(
      messageHash,
      input.messageMembershipWitness,
      derive(frozenTip, h => h.state.l1ToL2MessageTree.root),
    );

    // 3. Compute the siloed deposit-message nullifier and verify it is unspent at the frozen tip.
    await this.validateMasterNullifierHidingKey(input.l2RecipientNhkM, input.l2RecipientPublicKeys);
    const siloedNullifier = await computeSiloedDepositMessageNullifier(
      portal.l2Portal,
      messageHash,
      input.l2RecipientNhkM,
    );
    await this.validateNullifiersUnspentAtFrozenTip([siloedNullifier], frozenTip, [
      input.lowNullifierMembershipWitness,
    ]);

    // 4. Verify the l2 recipient authorized this refund: the public keys and instance preimage must hash to
    //    `l2Recipient` under the immutables hash of the authorization mode, and that mode's authorization must verify.
    const authMessage = await computeFrozenDepositRefundAuthMessage(messageHash, input.executor, input.userPayloadHash);
    await this.validateRefundAuthorization(
      input.l2Recipient,
      input.l2RecipientPublicKeys,
      input.l2RecipientInstance,
      authMessage,
      input.auth,
      'Frozen-deposit refund',
    );

    // 5. Build public inputs in the layout `OxidePortal.refundFrozenDeposit` rebuilds, digest, sign.
    const { publicInputs, finalDigest } = buildFrozenDepositRefundFinalDigest({
      portal,
      frozenArchiveRoot: input.frozenArchiveRoot,
      amount: input.amount,
      executor: input.executor,
      userPayloadHash: input.userPayloadHash,
      siloedNullifier,
    });
    const signature = this.ecdsaSigner.sign(finalDigest);

    return { siloedNullifier, publicInputs, finalDigest, signature };
  }

  /**
   * Mirror the checks in `noir-projects/unprocessed_deposit_refund/src/main.nr`, and if they all pass, sign
   * the unprocessed deposit.
   *
   * Note: We re-run the linked circuit's checks because the TEE acts as a backup not only for L2's private side but
   * for standard Noir circuits as well.
   */
  public async signUnprocessedDepositRefundFinalization(
    input: UnprocessedDepositRefundFinalizationInput,
  ): Promise<UnprocessedDepositRefundFinalizationOutput> {
    if (input.executor.isZero()) {
      throw new Error('Refund executor is the zero address');
    }
    const portal = this.portalContext;

    // 1. CONSTRAINING MESSAGE WAS NOT PROCESSED

    // 1.1 Constrain `frozen_tip` to be the rightmost leaf of the frozen archive.
    // The following root is verified on L1 upon refund's finalization
    const frozenArchiveRoot = publicInput(input.frozenArchiveRoot, "frozen archive root is the refund's root of trust");
    const frozenTip = await assertIsFrozenTip(frozenArchiveRoot, input.frozenTip, input.frozenTipMembershipWitness);

    // 1.2 Prove the rollup has never absorbed the message and hence that the message is unprocessed.
    //
    // We use ">=" and not ">" as next_available_leaf_index corresponds to the next smallest unused leaf index in
    // the tree of the provided block header.

    const nextAvailableLeafIndex = BigInt(frozenTip.state.l1ToL2MessageTree.nextAvailableLeafIndex);
    if (input.messageLeafIndex.toBigInt() < nextAvailableLeafIndex) {
      throw new Error(
        `attempting to spend a processed message via the unprocessed deposit refund: (messageLeafIndex ${input.messageLeafIndex} < nextAvailableLeafIndex ${nextAvailableLeafIndex})`,
      );
    }

    // 2. VERIFYING L2_RECIPIENT AUTHORIZATION

    // 2.1 Recompute the deposit's L1->L2 message hash using the bound portal context (never the caller's claim of
    // `l1_portal` — that's the implicit l1_portal binding we rely on).
    const messageHash = await computeDepositMessageHash(portal, {
      sharedSecretSalt: input.sharedSecretSalt,
      recipient: input.l2Recipient,
      amount: input.amount,
      messageLeafIndex: input.messageLeafIndex,
    });

    // 2.2 Verify the L2 recipient authorized this refund. The address commits to the passkey through its
    // `immutables_hash`, or - when that hash is zero - to the master fallback key through its public keys, so only
    // the holder of the key the address pins can authorize.
    const authMessage = await computeUnprocessedDepositRefundAuthMessage(
      messageHash,
      input.executor,
      input.userPayloadHash,
    );
    await this.validateRefundAuthorization(
      input.l2Recipient,
      input.l2RecipientPublicKeys,
      input.l2RecipientInstance,
      authMessage,
      input.auth,
      'Unprocessed-deposit refund',
    );

    // 3. CONSTRUCT TEE SIGNATURE

    // 3.1 We could use the message hash directly as the OxidePortal nullifier, but computing the siloed message
    // nullifier and sharing the nullifier set with the frozen-deposit path acts as a secondary check that the two
    // paths cannot double-spend the same deposit.
    await this.validateMasterNullifierHidingKey(input.l2RecipientNhkM, input.l2RecipientPublicKeys);
    const siloedNullifier = await computeSiloedDepositMessageNullifier(
      portal.l2Portal,
      messageHash,
      input.l2RecipientNhkM,
    );

    // 3.2 Build public inputs in the layout `OxidePortal.refundUnprocessedDeposit` rebuilds, digest, sign.
    const { publicInputs, finalDigest } = buildUnprocessedDepositRefundFinalDigest({
      portal,
      frozenArchiveRoot: input.frozenArchiveRoot,
      amount: input.amount,
      executor: input.executor,
      userPayloadHash: input.userPayloadHash,
      messageHash,
      messageLeafIndex: input.messageLeafIndex,
      siloedNullifier,
    });

    const signature = this.ecdsaSigner.sign(finalDigest);

    return { messageHash, siloedNullifier, publicInputs, finalDigest, signature };
  }
}
