import { Fr, GrumpkinScalar } from '@aztec-labs/aztec.js/fields';
import { ARCHIVE_HEIGHT, L1_TO_L2_MSG_TREE_HEIGHT, MAX_L2_TO_L1_MSGS_PER_TX } from '@aztec-labs/constants';
import { Buffer32 } from '@aztec-labs/foundation/buffer';
import { sha256 } from '@aztec-labs/foundation/crypto/sha256';
import type { EthAddress } from '@aztec-labs/foundation/eth-address';
import { MembershipWitness } from '@aztec-labs/foundation/trees';
import type { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import { BlockHash } from '@aztec-labs/stdlib/block';
import type { CompleteAddress } from '@aztec-labs/stdlib/contract';
import { computeL2ToL1MessageHash, computeNoteHashNonce, computeUniqueNoteHash } from '@aztec-labs/stdlib/hash';
import { type PublicKeys, computeAddress, derivePublicKeyFromSecretKey, hashPublicKey } from '@aztec-labs/stdlib/keys';
import type { NullifierMembershipWitness } from '@aztec-labs/stdlib/trees';
import type { BlockHeader } from '@aztec-labs/stdlib/tx';

import { type Constrained, derive, publicInput } from '@oxide/oxide-lib-tee/constrained.js';
import { getWithdrawContentHash } from '@oxide/oxide-lib-tee/content_hash.js';
import {
  extractMetadata,
  extractRequiredNullifiers,
  extractTeeNotes,
  extractWithdrawalMessageHashes,
} from '@oxide/oxide-lib-tee/da_extractors.js';
import {
  computeDepositMessageHash,
  computeSiloedDepositMessageNullifier,
} from '@oxide/oxide-lib-tee/deposit_message_hashing.js';
import {
  computeNoteNullifier,
  computeSignerRegistrationMessageHash,
  computeSiloedNoteHash,
} from '@oxide/oxide-lib-tee/hash.js';
import {
  assertIsFrozenTip,
  verifyArchiveMembership,
  verifyL1ToL2MessageMembership,
  verifyNullifierNonMembership,
} from '@oxide/oxide-lib-tee/membership.js';
import { assertValidMigrationSignature } from '@oxide/oxide-lib-tee/migration_signature.js';
import {
  MAX_FROZEN_DEPOSITS_PER_REFUND,
  MAX_FROZEN_NOTES_PER_REFUND,
} from '@oxide/oxide-lib-tee/oxide_constants.gen.js';
import type { TeeTxEffect } from '@oxide/oxide-lib-tee/tx_effect_hint.js';
import {
  type EnclaveIdentity,
  FrozenDepositsRefundFinalizationInput,
  FrozenDepositsRefundFinalizationOutput,
  FrozenNotesRefundFinalizationInput,
  FrozenNotesRefundFinalizationOutput,
  type K1NoteSignature,
  type OutboxWithdrawal,
  P256PublicKey,
  PortalDomain,
  PortalLink,
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
} from '@oxide/oxide-lib-tee/types.js';

import {
  buildFrozenDepositsRefundFinalDigest,
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
 *  field-pair shape (e.g. when reading a withdrawal signature back from recovery data). */
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

export class LocalTeeSigner implements TeeSigner, EnclaveIdentity {
  public readonly publicKey: SecpPublicKey;
  private readonly ecdsaSigner: SignerWithBudget;
  constructor(
    private readonly privateKey: Buffer32,
    private readonly portalLink: PortalLink,
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
    return this.portalLink.l2Token;
  }

  get teeRegistry(): EthAddress {
    return this.portalLink.teeRegistry;
  }

  static random(link: { l1Portal: EthAddress; l2Token: AztecAddress; teeRegistry: EthAddress }): LocalTeeSigner {
    return new LocalTeeSigner(Buffer32.random(), PortalLink.from(link), SignatureBudget.create());
  }

  /** Returns a new `LocalTeeSigner` with the same key material bound to a different portal link. */
  withPortalLink(link: { l1Portal: EthAddress; l2Token: AztecAddress; teeRegistry: EthAddress }): LocalTeeSigner {
    return new LocalTeeSigner(this.privateKey, PortalLink.from(link), this.budget);
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
   * Verifies the TEE signer that produced `metadata.pubKey{X,Y}` is registered on the link's `TeeRegistry`: its
   * registration message is in the L1->L2 tree of `header`.
   */
  private async validateSignerRegistration(
    metadata: TEEMetadata,
    witness: MembershipWitness<typeof L1_TO_L2_MSG_TREE_HEIGHT>,
    header: Constrained<BlockHeader>,
  ): Promise<void> {
    const messageHash = computeSignerRegistrationMessageHash(
      resolvePortalDomain(this.portalLink, header),
      metadata.publicKey(),
      metadata.registrationLeafIndex,
    );
    await verifyL1ToL2MessageMembership(
      messageHash,
      witness,
      derive(header, h => h.state.l1ToL2MessageTree.root),
    );
  }

  private async validateSiloedVsUniqueNoteHash(siloedNoteHash: Fr, creationEffects: TeeTxEffect): Promise<Fr> {
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

  private validateRequiredNullifiers(requiredNullifiers: Fr[], creationEffects: TeeTxEffect): void {
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
  private validateWithdrawalMessageHashesInL2ToL1Msgs(
    withdrawalMessageHashes: Fr[],
    creationEffects: TeeTxEffect,
  ): void {
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
    portalDomain: PortalDomain,
  ): Promise<{ depositMessageNullifiers: Fr[]; amountDeposited: bigint }> {
    if (deposits.length === 0) {
      return { depositMessageNullifiers: [], amountDeposited: 0n };
    }
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
      const messageHash = await computeDepositMessageHash(portalDomain, preimage);

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
        portalDomain.l2Token,
        messageHash,
        deposit.masterNullifierHidingKey,
      );
      depositMessageNullifiers.push(nullifier);
      amountDeposited += deposit.amount;
    }

    return { depositMessageNullifiers, amountDeposited };
  }

  /** Compute each withdrawal's L2->L1 message hash and validate its executor and prover tip. */
  private validateWithdrawals(
    withdrawals: OutboxWithdrawal[],
    portalDomain: PortalDomain,
  ): {
    withdrawalMessageHashes: Fr[];
    amountWithdrawn: bigint;
  } {
    if (withdrawals.length === 0) {
      return { withdrawalMessageHashes: [], amountWithdrawn: 0n };
    }
    if (withdrawals.length > MAX_L2_TO_L1_MSGS_PER_TX) {
      throw new Error(`Too many withdrawals: got ${withdrawals.length}, max ${MAX_L2_TO_L1_MSGS_PER_TX}`);
    }

    const withdrawalMessageHashes: Fr[] = [];
    let amountWithdrawn = 0n;
    for (const withdrawal of withdrawals) {
      if (withdrawal.executor.isZero()) {
        throw new Error('Withdrawal executor is the zero address');
      }
      if (withdrawal.proverTip > withdrawal.amount) {
        throw new Error('Withdrawal prover tip exceeds amount');
      }
      withdrawalMessageHashes.push(
        computeL2ToL1MessageHash({
          l2Sender: portalDomain.l2Token,
          l1Recipient: portalDomain.l1Portal,
          content: getWithdrawContentHash(
            withdrawal.executor,
            withdrawal.userPayloadHash,
            withdrawal.amount,
            withdrawal.proverTip,
            withdrawal.randomness,
          ),
          rollupVersion: new Fr(portalDomain.rollupVersion),
          chainId: new Fr(portalDomain.l1ChainId),
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
    amountSpent: bigint;
  }> {
    const localNullifierSet = new Set<bigint>();
    const requiredNullifiers: Fr[] = [];
    let amountSpent = 0n;

    for (const spend of spentNotes) {
      // Validate the owner preimage we got
      await this.validateOwnerPreimage(spend.note.owner, spend.ownerAddressPreimage);
      // Validate that the master nullifier hiding key matches the one in the owner address
      await this.validateMasterNullifierHidingKey(
        spend.masterNullifierHidingKey,
        spend.ownerAddressPreimage.publicKeys,
      );

      const siloedNoteHash = await computeSiloedNoteHash({ ...spend.note, l2Token: this.tokenAddress });

      // Authenticate the note's creation tx and decode its effects from the fields its block's tx effects tree commits to.
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
      await this.validateSignerRegistration(creationMetadata, spend.signerRegistrationWitness, anchorBlockHeader);
      await this.validateSpendAnchorBlockHash(
        creationMetadata.anchorBlockHash,
        anchorBlockHeader,
        spend.anchorBlockHashMembershipWitness,
      );

      const digest = await buildNoteOperationDigest({
        anchorBlockHash: creationMetadata.anchorBlockHash,
        tokenAddress: this.tokenAddress,
        l1Portal: this.portalLink.l1Portal,
        teeRegistry: this.portalLink.teeRegistry,
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
      amountSpent += spend.note.amount;
    }

    return { requiredNullifiers, amountSpent };
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
    const portalDomain = resolvePortalDomain(this.portalLink, anchorBlockHeader);

    const { requiredNullifiers: spendNullifiers, amountSpent } = await this.validateSpends(
      operation.spentNotes,
      anchorBlockHeader,
    );
    const { depositMessageNullifiers, amountDeposited } = await this.validateDeposits(
      operation.deposits,
      anchorBlockHeader,
      portalDomain,
    );
    const { withdrawalMessageHashes, amountWithdrawn } = this.validateWithdrawals(operation.withdrawals, portalDomain);

    // Deposit-message nullifiers fold into `requiredNullifiers`, which every TEE signature commits to.
    const requiredNullifiers = [...spendNullifiers, ...depositMessageNullifiers];

    const amountCreated = operation.createdNotes.reduce((acc, createdNote) => acc + createdNote.amount, 0n);
    // Unified balance invariant: sum(spent) + sum(deposits) == sum(created) + sum(withdrawals).
    if (amountSpent + amountDeposited !== amountCreated + amountWithdrawn) {
      throw new Error(
        `Balance mismatch: spent=${amountSpent} deposited=${amountDeposited} created=${amountCreated} withdrawn=${amountWithdrawn}`,
      );
    }

    const siloedNoteHashes = await Promise.all(
      operation.createdNotes.map(async createdNote => {
        return await computeSiloedNoteHash({ ...createdNote, l2Token: this.tokenAddress });
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
      l1Portal: this.portalLink.l1Portal,
      teeRegistry: this.portalLink.teeRegistry,
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

    await this.validateSignerRegistration(creationMetadata, input.signerRegistrationWitness, txBlockHeader);

    await verifyArchiveMembership(
      creationMetadata.anchorBlockHash,
      input.anchorBlockHashMembershipWitness,
      archiveRoot,
    );

    // Verify that the creation of the message was signed by the TEE.
    const digest = await buildWithdrawalOperationDigest({
      anchorBlockHash: creationMetadata.anchorBlockHash,
      tokenAddress: this.tokenAddress,
      l1Portal: this.portalLink.l1Portal,
      teeRegistry: this.portalLink.teeRegistry,
      requiredNullifiers: creationRequiredNullifiers,
      siloedNoteHashes: creationTeeNotes,
      withdrawalMessageHashes: creationWithdrawalMessageHashes,
      messageHash,
    });
    const publicKey = creationMetadata.publicKey();
    if (!verifyK1NoteSignature(input.withdrawalSignature, digest, publicKey)) {
      throw new Error(`Signature verification failed for withdrawal ${messageHash}`);
    }

    // L1 stores this opaque id in `$isWithdrawalSpent` to prevent replay of the same withdrawal.
    const withdrawalId = new Buffer32(
      sha256(Buffer.concat([creationEffects.txHash, messageHash].map(f => f.toBuffer()))),
    );

    const finalDigest = buildWithdrawalFinalDigest({
      teeRegistry: this.portalLink.teeRegistry,
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

    const { requiredNullifiers, amountSpent } = await this.validateSpends(input.notes, frozenTip);
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

    // Verify the owner's migration signature. This also binds the owner's public keys and instance preimage to its
    // address, under the immutables hash of the signing mode.
    await assertValidMigrationSignature(
      input.owner,
      input.ownerPublicKeys,
      input.ownerInstance,
      input.executor,
      input.userPayloadHash,
      input.migrationSignature,
    );

    const nullifiers = requiredNullifiers.map(nullifier => nullifier);
    const { publicInputs, finalDigest } = buildFrozenNotesRefundFinalDigest({
      portalDomain: resolvePortalDomain(this.portalLink, frozenTip),
      frozenArchiveRoot: input.frozenArchiveRoot,
      amount: amountSpent,
      executor: input.executor,
      userPayloadHash: input.userPayloadHash,
      nullifiers,
    });
    const signature = this.ecdsaSigner.sign(finalDigest);

    return { nullifiers, publicInputs, finalDigest, signature };
  }

  /** Validates the frozen deposits of one recipient and signs one refund of their sum. */
  public async signFrozenDepositsRefundFinalization(
    input: FrozenDepositsRefundFinalizationInput,
  ): Promise<FrozenDepositsRefundFinalizationOutput> {
    if (input.executor.isZero()) {
      throw new Error('Refund executor is the zero address');
    }
    // 1. Constrain the frozen tip.
    // The following root is verified on L1 upon refund's finalization
    const frozenArchiveRoot = publicInput(input.frozenArchiveRoot, "frozen archive root is the refund's root of trust");
    const frozenTip = await assertIsFrozenTip(frozenArchiveRoot, input.frozenTip, input.frozenTipMembershipWitness);
    const portalDomain = resolvePortalDomain(this.portalLink, frozenTip);

    if (input.deposits.length === 0) {
      throw new Error('Frozen-deposit refund must refund at least one deposit');
    }
    if (input.deposits.length > MAX_FROZEN_DEPOSITS_PER_REFUND) {
      throw new Error(
        `Frozen-deposit refund refunds ${input.deposits.length} deposits, max ${MAX_FROZEN_DEPOSITS_PER_REFUND}`,
      );
    }
    await this.validateMasterNullifierHidingKey(input.l2RecipientNhkM, input.l2RecipientPublicKeys);

    const localNullifierSet = new Set<bigint>();
    const nullifiers: Fr[] = [];
    let amount = 0n;
    for (const deposit of input.deposits) {
      // The circuit skips the checks of a zero-amount deposit as padding, so such a deposit cannot be refunded.
      if (deposit.amount === 0n) {
        throw new Error('Frozen-deposit refund includes a deposit with a zero amount');
      }

      // 2. Recompute the deposit message hash and verify the message is in the tip.
      const messageHash = await computeDepositMessageHash(portalDomain, {
        sharedSecretSalt: deposit.sharedSecretSalt,
        recipient: input.l2Recipient,
        amount: deposit.amount,
        messageLeafIndex: new Fr(deposit.messageMembershipWitness.leafIndex),
      });
      await verifyL1ToL2MessageMembership(
        messageHash,
        deposit.messageMembershipWitness,
        derive(frozenTip, h => h.state.l1ToL2MessageTree.root),
      );

      // 3. Compute the siloed deposit-message nullifier. Guard against refunding the same deposit twice.
      const siloedNullifier = await computeSiloedDepositMessageNullifier(
        portalDomain.l2Token,
        messageHash,
        input.l2RecipientNhkM,
      );
      if (localNullifierSet.has(siloedNullifier.toBigInt())) {
        throw new Error(`Frozen-deposit refund includes the deposit with nullifier ${siloedNullifier} twice`);
      }
      localNullifierSet.add(siloedNullifier.toBigInt());
      nullifiers.push(siloedNullifier);
      amount += deposit.amount;
    }

    // Verify that no deposit nullifier is spent at the frozen tip.
    await this.validateNullifiersUnspentAtFrozenTip(
      nullifiers,
      frozenTip,
      input.deposits.map(deposit => deposit.lowNullifierMembershipWitness),
    );

    // 4. Verify the l2 recipient's migration signature.
    await assertValidMigrationSignature(
      input.l2Recipient,
      input.l2RecipientPublicKeys,
      input.l2RecipientInstance,
      input.executor,
      input.userPayloadHash,
      input.migrationSignature,
    );

    // 5. Build public inputs in the layout `OxidePortal.refundFrozenDeposits` rebuilds, digest, sign.
    const { publicInputs, finalDigest } = buildFrozenDepositsRefundFinalDigest({
      portalDomain,
      frozenArchiveRoot: input.frozenArchiveRoot,
      amount,
      executor: input.executor,
      userPayloadHash: input.userPayloadHash,
      nullifiers,
    });
    const signature = this.ecdsaSigner.sign(finalDigest);

    return { nullifiers, amount, publicInputs, finalDigest, signature };
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
    // 1. CONSTRAINING MESSAGE WAS NOT PROCESSED

    // 1.1 Constrain `frozen_tip` to be the rightmost leaf of the frozen archive.
    // The following root is verified on L1 upon refund's finalization
    const frozenArchiveRoot = publicInput(input.frozenArchiveRoot, "frozen archive root is the refund's root of trust");
    const frozenTip = await assertIsFrozenTip(frozenArchiveRoot, input.frozenTip, input.frozenTipMembershipWitness);
    const portalDomain = resolvePortalDomain(this.portalLink, frozenTip);

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

    // 2.1 Recompute the deposit's L1->L2 message hash from the addresses and the tip's chain claims. The
    // hash commits to the full context, so a false context yields a digest the real portal never accepts.
    const messageHash = await computeDepositMessageHash(portalDomain, {
      sharedSecretSalt: input.sharedSecretSalt,
      recipient: input.l2Recipient,
      amount: input.amount,
      messageLeafIndex: input.messageLeafIndex,
    });

    // 2.2 Verify the L2 recipient's migration signature.
    await assertValidMigrationSignature(
      input.l2Recipient,
      input.l2RecipientPublicKeys,
      input.l2RecipientInstance,
      input.executor,
      input.userPayloadHash,
      input.migrationSignature,
    );

    // 3. CONSTRUCT TEE SIGNATURE

    // 3.1 We could use the message hash directly as the OxidePortal nullifier, but computing the siloed message
    // nullifier and sharing the nullifier set with the frozen-deposit path acts as a secondary check that the two
    // paths cannot double-spend the same deposit.
    await this.validateMasterNullifierHidingKey(input.l2RecipientNhkM, input.l2RecipientPublicKeys);
    const siloedNullifier = await computeSiloedDepositMessageNullifier(
      portalDomain.l2Token,
      messageHash,
      input.l2RecipientNhkM,
    );

    // 3.2 Build public inputs in the layout `OxidePortal.refundUnprocessedDeposit` rebuilds, digest, sign.
    const { publicInputs, finalDigest } = buildUnprocessedDepositRefundFinalDigest({
      portalDomain,
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

function resolvePortalDomain(link: PortalLink, header: Constrained<BlockHeader>): PortalDomain {
  const globals = derive(header, h => h.globalVariables);
  return {
    ...link,
    l1ChainId: globals.chainId.toBigInt(),
    rollupVersion: globals.version.toBigInt(),
  };
}
