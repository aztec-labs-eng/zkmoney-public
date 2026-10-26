//! See [Frozen Notes Refund](../../../engineering-design-docs/oxide.md#3-frozen-notes-refund) in engineering-design-docs/oxide.md.

use std::embedded_curve_ops::fixed_base_scalar_mul as derive_public_key;

use aztec::protocol::{
    abis::{block_header::BlockHeader, nullifier_leaf_preimage::NullifierLeafPreimage},
    address::{AztecAddress, EthAddress},
    constants::{ARCHIVE_HEIGHT, DOM_SEP__NHK_M, NOTE_HASH_TREE_HEIGHT, NULLIFIER_TREE_HEIGHT},
    hash::{compute_app_siloed_secret_key, compute_siloed_note_hash, compute_siloed_nullifier, compute_unique_note_hash},
    merkle_tree::{check_membership, check_non_membership_with_hasher, MembershipWitness, nullifier_merkle_hash},
    public_keys::{hash_public_key, PublicKeys},
    scalar::Scalar,
};
use oxide_lib::account_address::AccountInstancePreimage;
use oxide_lib::constants::{BALANCES_STORAGE_SLOT, MAX_FROZEN_NOTES_PER_REFUND};
use oxide_token_lib::note::{compute_inner_note_hash, compute_inner_nullifier};
use refund_lib::{assert_is_frozen_tip, assert_valid_migration_signature, MigrationSignature};

pub struct InputNote {
    pub amount: u128,
    pub randomness: Field,
    pub note_nonce: Field,
    pub note_membership_witness: MembershipWitness<NOTE_HASH_TREE_HEIGHT>,
    pub low_nullifier_preimage: NullifierLeafPreimage,
    pub low_nullifier_membership_witness: MembershipWitness<NULLIFIER_TREE_HEIGHT>,
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
    migration_signature: MigrationSignature,
) -> pub [Field; MAX_FROZEN_NOTES_PER_REFUND] {
    assert(executor != EthAddress::zero(), "executor must be non-zero");

    // 1. CONSTRAINING THE FROZEN TIP to be the rightmost leaf of the frozen archive.
    assert_is_frozen_tip(frozen_tip, frozen_tip_sibling_path, frozen_archive_root);
    let note_hash_tree_root = frozen_tip.state.partial.note_hash_tree.root;
    let nullifier_tree_root = frozen_tip.state.partial.nullifier_tree.root;

    // 2. BINDING THE NULLIFIER HIDING KEY TO THE OWNER.
    //
    // The rest of the owner's address preimage is opened in step 4.

    // Constrain that the provided nhk_m belongs to the owner, then silo it to the token once for every note.
    assert_eq(
        hash_public_key(derive_public_key(owner_nhk_m)),
        owner_public_keys.npk_m_hash,
        "owner_nhk_m does not match owner's npk_m_hash",
    );
    let nhk_app = compute_app_siloed_secret_key(owner_nhk_m, l2_token, DOM_SEP__NHK_M as Field);

    // 3. CONSTRAINING EACH NOTE

    let mut siloed_nullifiers = [0; MAX_FROZEN_NOTES_PER_REFUND];
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

        // Active notes contribute their nullifier; padding emits 0 (matching the L1 padding layout). `sum` adds
        // `n.amount` unconditionally because padding notes have amount 0 by definition.
        siloed_nullifiers[i] = if is_not_padding_note {
            siloed_nullifier
        } else {
            0
        };
        sum += n.amount;
    }

    assert_eq(sum, amount, "amount does not match sum of notes");

    // 4. VERIFYING THE OWNER'S MIGRATION SIGNATURE

    assert_valid_migration_signature(
        owner,
        owner_public_keys,
        owner_instance,
        executor,
        user_payload_hash,
        migration_signature,
    );

    siloed_nullifiers
}

mod tests {
    use super::{InputNote, main};
    use aztec::protocol::{
        abis::{nullifier_leaf_preimage::NullifierLeafPreimage, state_reference::StateReference},
        address::{AztecAddress, EthAddress},
        constants::{NOTE_HASH_TREE_HEIGHT, NULLIFIER_TREE_HEIGHT},
        hash::{compute_siloed_note_hash, compute_unique_note_hash},
        merkle_tree::{MembershipWitness, nullifier_merkle_hash, test_utils::SingleSubtreeMerkleTree},
        public_keys::{hash_public_key, IvpkM, PublicKeys},
        traits::{Empty, FromField, Hash},
    };
    use oxide_lib::constants::{BALANCES_STORAGE_SLOT, MAX_FROZEN_NOTES_PER_REFUND};
    use oxide_token_lib::note::compute_inner_note_hash;
    use refund_lib::test_fixtures::{frozen_tip_with, unread_instance, unread_migration_signature};
    use std::embedded_curve_ops::{EmbeddedCurvePoint, EmbeddedCurveScalar, fixed_base_scalar_mul};

    global CHAIN_ID: Field = 1;
    global ROLLUP_VERSION: Field = 1;

    fn l1_portal() -> EthAddress {
        EthAddress::from_field(0xa)
    }

    fn l2_token() -> AztecAddress {
        AztecAddress::from_field(1)
    }

    fn owner() -> AztecAddress {
        AztecAddress::from_field(2)
    }

    fn nhk_m() -> EmbeddedCurveScalar {
        EmbeddedCurveScalar::new(5, 0)
    }

    // The keys commit to `nhk_m`; the checks these tests target run before anything else in them is read.
    fn owner_public_keys() -> PublicKeys {
        PublicKeys {
            npk_m_hash: hash_public_key(fixed_base_scalar_mul(nhk_m())),
            ivpk_m: IvpkM { inner: EmbeddedCurvePoint::generator() },
            ovpk_m_hash: 0,
            tpk_m_hash: 0,
            mspk_m_hash: 0,
            fbpk_m_hash: 0,
        }
    }

    /// The amount, randomness and nonce of note `i`. Every note has a non-zero amount, so no slot is padding.
    fn note_data(i: u32) -> (u128, Field, Field) {
        (100 + i as u128, 0xabc000 + i as Field, 0x515000 + i as Field)
    }

    fn unique_note_hash(i: u32) -> Field {
        let (amount, randomness, nonce) = note_data(i);
        compute_unique_note_hash(
            nonce,
            compute_siloed_note_hash(
                l2_token(),
                compute_inner_note_hash(amount, owner(), BALANCES_STORAGE_SLOT, randomness),
            ),
        )
    }

    /// The note hash tree of the frozen tip, with note `i` at index `i`. The subtree has a power-of-two number of
    /// leaves, so empty leaves follow the notes.
    fn note_hash_tree(
        note_hashes: [Field; MAX_FROZEN_NOTES_PER_REFUND],
    ) -> SingleSubtreeMerkleTree<32, 5, NOTE_HASH_TREE_HEIGHT> {
        let mut leaves = [0; 32];
        for i in 0..MAX_FROZEN_NOTES_PER_REFUND {
            leaves[i] = note_hashes[i];
        }
        SingleSubtreeMerkleTree::new(leaves)
    }

    /// One low leaf, below every nullifier and with no next leaf, so it is the low leaf of every note's nullifier.
    fn nullifier_leaves() -> [NullifierLeafPreimage; 4] {
        [
            NullifierLeafPreimage { nullifier: 1, next_nullifier: 0, next_index: 0 },
            NullifierLeafPreimage::empty(),
            NullifierLeafPreimage::empty(),
            NullifierLeafPreimage::empty(),
        ]
    }

    fn nullifier_tree() -> SingleSubtreeMerkleTree<4, 2, NULLIFIER_TREE_HEIGHT> {
        SingleSubtreeMerkleTree::new_with_hasher(
            nullifier_leaves().map(|leaf| leaf.hash()),
            nullifier_merkle_hash,
        )
    }

    /// Runs the circuit on a full batch of real notes against a frozen tip whose note hash tree holds
    /// `frozen_note_hashes`.
    fn refund_full_batch(frozen_note_hashes: [Field; MAX_FROZEN_NOTES_PER_REFUND]) {
        let tree = note_hash_tree(frozen_note_hashes);
        let mut state = StateReference::empty();
        state.partial.note_hash_tree.root = tree.get_root();
        state.partial.nullifier_tree.root = nullifier_tree().get_root();
        let frozen = frozen_tip_with(state);

        let low_leaf_witness = MembershipWitness { leaf_index: 0, sibling_path: nullifier_tree().get_sibling_path(0) };
        let mut notes: [InputNote; MAX_FROZEN_NOTES_PER_REFUND] = std::mem::zeroed();
        let mut amount: u128 = 0;
        for i in 0..MAX_FROZEN_NOTES_PER_REFUND {
            let (note_amount, randomness, nonce) = note_data(i);
            notes[i] = InputNote {
                amount: note_amount,
                randomness,
                note_nonce: nonce,
                note_membership_witness: MembershipWitness {
                    leaf_index: i as Field,
                    sibling_path: tree.get_sibling_path(i as Field),
                },
                low_nullifier_preimage: nullifier_leaves()[0],
                low_nullifier_membership_witness: low_leaf_witness,
            };
            amount += note_amount;
        }

        let _ = main(
            CHAIN_ID,
            ROLLUP_VERSION,
            l1_portal(),
            l2_token(),
            frozen.archive_root,
            amount,
            EthAddress::from_field(0xbeef),
            1,
            frozen.header,
            frozen.archive_path,
            notes,
            owner(),
            owner_public_keys(),
            unread_instance(),
            nhk_m(),
            unread_migration_signature(),
        );
    }

    fn all_note_hashes() -> [Field; MAX_FROZEN_NOTES_PER_REFUND] {
        let mut note_hashes = [0; MAX_FROZEN_NOTES_PER_REFUND];
        for i in 0..MAX_FROZEN_NOTES_PER_REFUND {
            note_hashes[i] = unique_note_hash(i);
        }
        note_hashes
    }

    // Every note of a full batch passes every check of the frozen state, so only the unread migration signature
    // refuses it.
    #[test(should_fail_with = "migration signature does not match owner address")]
    fn accepts_the_frozen_state_of_a_full_batch_of_notes() {
        refund_full_batch(all_note_hashes());
    }

    // The circuit checks the last slot of a full batch like every other slot.
    #[test(should_fail_with = "note not present in note hash tree")]
    fn rejects_a_full_batch_whose_last_note_the_frozen_tree_does_not_hold() {
        let mut note_hashes = all_note_hashes();
        note_hashes[MAX_FROZEN_NOTES_PER_REFUND - 1] += 1;
        refund_full_batch(note_hashes);
    }
}
