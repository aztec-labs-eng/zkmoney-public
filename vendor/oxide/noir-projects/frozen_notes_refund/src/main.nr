//! See [Frozen Notes Refund](../../../engineering-design-docs/oxide.md#3-frozen-notes-refund) in engineering-design-docs/oxide.md.

use std::embedded_curve_ops::fixed_base_scalar_mul as derive_public_key;

use aztec::protocol::{
    abis::{block_header::BlockHeader, nullifier_leaf_preimage::NullifierLeafPreimage},
    address::{AztecAddress, EthAddress},
    constants::{ARCHIVE_HEIGHT, DOM_SEP__NHK_M, NOTE_HASH_TREE_HEIGHT, NULLIFIER_TREE_HEIGHT},
    hash::{
        compute_app_siloed_secret_key, compute_siloed_note_hash, compute_siloed_nullifier, compute_unique_note_hash,
        poseidon2_hash_with_separator,
    },
    merkle_tree::{check_membership, check_non_membership_with_hasher, MembershipWitness, nullifier_merkle_hash},
    public_keys::{hash_public_key, PublicKeys},
    scalar::Scalar,
    traits::ToField,
};
use oxide_lib::account_address::AccountInstancePreimage;
use oxide_lib::constants::{BALANCES_STORAGE_SLOT, DOM_SEP__FROZEN_NOTES_AUTH, MAX_FROZEN_NOTES_PER_REFUND};
use oxide_token_lib::note::{compute_inner_note_hash, compute_inner_nullifier};
use refund_lib::{assert_is_frozen_tip, assert_refund_authorized, RefundAuthorization};

pub struct InputNote {
    pub amount: u128,
    pub randomness: Field,
    pub note_nonce: Field,
    pub note_membership_witness: MembershipWitness<NOTE_HASH_TREE_HEIGHT>,
    pub low_nullifier_preimage: NullifierLeafPreimage,
    pub low_nullifier_membership_witness: MembershipWitness<NULLIFIER_TREE_HEIGHT>,
}

// Mirrored by `computeFrozenNotesRefundAuthMessage` in `yarn-project/oxide-lib`.
pub fn compute_frozen_notes_refund_auth_message(
    unique_note_hashes: [Field; MAX_FROZEN_NOTES_PER_REFUND],
    executor: EthAddress,
    user_payload_hash: Field,
) -> Field {
    poseidon2_hash_with_separator(
        [executor.to_field(), user_payload_hash].concat(unique_note_hashes),
        DOM_SEP__FROZEN_NOTES_AUTH,
    )
}

fn main(
    // ===== Public inputs =====
    // The following 3 values are not used in the circuit logic but we need them to be a public input such that
    // the proof is not replayable on a different deployment.
    _chain_id: pub Field,
    _rollup_version: pub Field,
    _l1_portal: pub EthAddress,
    l2_token: pub AztecAddress,
    frozen_archive_root: pub Field,
    amount: pub u128,
    // Executor the L1 portal hands `amount` to and calls. Public so that an attacker cannot replay the proof
    // against a different executor.
    executor: pub EthAddress,
    // `sha256_to_field` of the payload the executor runs. Public for the same reason.
    user_payload_hash: pub Field,
    // ===== Private inputs =====
    // Tip of the chain at the time of `frozen_archive`. Can be private as below we constrain it's the tip.
    frozen_tip: BlockHeader,
    frozen_tip_sibling_path: [Field; ARCHIVE_HEIGHT],
    notes: [InputNote; MAX_FROZEN_NOTES_PER_REFUND],
    // The owner of every active note.
    owner: AztecAddress,
    owner_public_keys: PublicKeys,
    owner_instance: AccountInstancePreimage,
    owner_nhk_m: Scalar,
    // The owner's authorization of the refund auth message.
    auth: RefundAuthorization,
) -> pub [Field; MAX_FROZEN_NOTES_PER_REFUND] {
    assert(executor != EthAddress::zero(), "executor must be non-zero");

    // 1. CONSTRAINING THE FROZEN TIP to be the rightmost leaf of the frozen archive.
    assert_is_frozen_tip(frozen_tip, frozen_tip_sibling_path, frozen_archive_root);
    let note_hash_tree_root = frozen_tip.state.partial.note_hash_tree.root;
    let nullifier_tree_root = frozen_tip.state.partial.nullifier_tree.root;

    // 2. BINDING THE NULLIFIER HIDING KEY TO THE OWNER.
    //
    // The rest of the owner's address preimage is opened in step 4, once the auth message is known.

    // Constrain that the provided nhk_m belongs to the owner, then silo it to the token once for every note.
    assert_eq(
        hash_public_key(derive_public_key(owner_nhk_m)),
        owner_public_keys.npk_m_hash,
        "owner_nhk_m does not match owner's npk_m_hash",
    );
    let nhk_app = compute_app_siloed_secret_key(owner_nhk_m, l2_token, DOM_SEP__NHK_M as Field);

    // 3. CONSTRAINING EACH NOTE

    let mut siloed_nullifiers = [0; MAX_FROZEN_NOTES_PER_REFUND];
    let mut authorized_note_hashes = [0; MAX_FROZEN_NOTES_PER_REFUND];
    let mut sum: u128 = 0;

    for i in 0..MAX_FROZEN_NOTES_PER_REFUND {
        let n = notes[i];

        // Verify the note exists in the note hash tree and that it has not been spent (nullifier non-inclusion).
        // The hash is computed under the refund `owner`, so the membership check below proves the note belongs to it.
        let inner_note_hash = compute_inner_note_hash(n.amount, owner, BALANCES_STORAGE_SLOT, n.randomness);
        let siloed_note_hash = compute_siloed_note_hash(l2_token, inner_note_hash);
        let unique_note_hash = compute_unique_note_hash(n.note_nonce, siloed_note_hash);

        let inner_nullifier = compute_inner_nullifier(unique_note_hash, nhk_app);
        let siloed_nullifier = compute_siloed_nullifier(l2_token, inner_nullifier);

        let note_in_tree = check_membership(
            unique_note_hash,
            n.note_membership_witness,
            note_hash_tree_root,
        );
        let low_leaf_present = !n.low_nullifier_preimage.is_empty();
        let (nullifier_not_in_tree, _, _) = check_non_membership_with_hasher(
            siloed_nullifier,
            n.low_nullifier_preimage,
            n.low_nullifier_membership_witness,
            nullifier_tree_root,
            nullifier_merkle_hash,
        );

        // Run the checks only for real non-padding notes
        let is_not_padding_note = n.amount != 0;
        if is_not_padding_note {
            assert(note_in_tree, "note not present in note hash tree");
            assert(low_leaf_present, "low nullifier preimage is empty");
            assert(nullifier_not_in_tree, "nullifier already exists in nullifier tree");
        }

        // Active notes contribute their nullifier and their note hash; padding emits 0 (matching the L1 padding
        // layout). `sum` adds `n.amount` unconditionally because padding notes have amount 0 by definition.
        siloed_nullifiers[i] = if is_not_padding_note {
            siloed_nullifier
        } else {
            0
        };
        authorized_note_hashes[i] = if is_not_padding_note {
            unique_note_hash
        } else {
            0
        };
        sum += n.amount;
    }

    assert_eq(sum, amount, "amount does not match sum of notes");

    // 4. VERIFYING THE OWNER'S AUTHORIZATION

    let auth_message = compute_frozen_notes_refund_auth_message(authorized_note_hashes, executor, user_payload_hash);
    assert_refund_authorized(owner, owner_public_keys, owner_instance, auth_message, auth);

    siloed_nullifiers
}
