//! See [Frozen Deposit Refund](../../../engineering-design-docs/oxide.md#2-frozen-deposit-refund) in engineering-design-docs/oxide.md.

use std::embedded_curve_ops::fixed_base_scalar_mul as derive_public_key;

use aztec::protocol::{
    abis::{block_header::BlockHeader, nullifier_leaf_preimage::NullifierLeafPreimage},
    address::{AztecAddress, EthAddress},
    constants::{ARCHIVE_HEIGHT, DOM_SEP__NHK_M, L1_TO_L2_MSG_TREE_HEIGHT, NULLIFIER_TREE_HEIGHT},
    hash::{compute_app_siloed_secret_key, compute_siloed_nullifier, poseidon2_hash_with_separator},
    merkle_tree::{check_membership, check_non_membership_with_hasher, MembershipWitness, nullifier_merkle_hash},
    public_keys::{hash_public_key, PublicKeys},
    scalar::Scalar,
    traits::ToField,
};
use oxide_lib::account_address::AccountInstancePreimage;
use oxide_lib::constants::DOM_SEP__FROZEN_DEPOSIT_AUTH;
use oxide_token_lib::deposit_message_hashing::{compute_deposit_message_hash, compute_deposit_message_nullifier};
use refund_lib::{assert_is_frozen_tip, assert_refund_authorized, RefundAuthorization};

// Mirrored by `computeFrozenDepositRefundAuthMessage` in `yarn-project/oxide-lib`.
pub fn compute_frozen_deposit_refund_auth_message(
    message_hash: Field,
    executor: EthAddress,
    user_payload_hash: Field,
) -> Field {
    poseidon2_hash_with_separator(
        [message_hash, executor.to_field(), user_payload_hash],
        DOM_SEP__FROZEN_DEPOSIT_AUTH,
    )
}

fn main(
    // ===== Public inputs =====
    chain_id: pub Field,
    rollup_version: pub Field,
    l1_portal: pub EthAddress,
    frozen_archive_root: pub Field,
    amount: pub u128,
    // Executor the L1 portal hands `amount` to and calls. Public so that an attacker cannot replay the proof
    // against a different executor.
    executor: pub EthAddress,
    // `sha256_to_field` of the payload the executor runs. Public for the same reason.
    user_payload_hash: pub Field,
    // ===== Private inputs =====
    // Can be private as we trust OxidePortal to not create a message for a different L2 token.
    l2_token: AztecAddress,
    // Tip of the chain at the time of `frozen_archive`. Can be private as below we constrain it's the tip.
    frozen_tip: BlockHeader,
    frozen_tip_sibling_path: [Field; ARCHIVE_HEIGHT],
    shared_secret_salt: Field,
    l2_recipient: AztecAddress,
    l2_recipient_public_keys: PublicKeys,
    l2_recipient_instance: AccountInstancePreimage,
    l2_recipient_nhk_m: Scalar,
    message_leaf_index: Field,
    message_membership_sibling_path: [Field; L1_TO_L2_MSG_TREE_HEIGHT],
    low_nullifier_preimage: NullifierLeafPreimage,
    low_nullifier_membership_witness: MembershipWitness<NULLIFIER_TREE_HEIGHT>,
    // The recipient's authorization of the refund auth message.
    auth: RefundAuthorization,
) -> pub Field {
    assert(executor != EthAddress::zero(), "executor must be non-zero");

    // 1. CONSTRAINING MESSAGE WAS PROCESSED AND NOT YET SPENT

    // 1.1 Constrain `frozen_tip` to be the rightmost leaf of the frozen archive.
    assert_is_frozen_tip(frozen_tip, frozen_tip_sibling_path, frozen_archive_root);

    let l1_to_l2_root = frozen_tip.state.l1_to_l2_message_tree.root;
    let nullifier_tree_root = frozen_tip.state.partial.nullifier_tree.root;

    // 1.2 Recompute the L1->L2 deposit message exactly as `OxidePortal.sol::deposit` did and prove it's in
    //     the inbox tree of the frozen archive tip at `message_leaf_index`.
    let message_hash = compute_deposit_message_hash(
        l1_portal,
        chain_id,
        l2_token,
        rollup_version,
        shared_secret_salt,
        l2_recipient,
        amount,
        message_leaf_index,
    );
    assert(
        check_membership(
            message_hash,
            MembershipWitness { leaf_index: message_leaf_index, sibling_path: message_membership_sibling_path },
            l1_to_l2_root,
        ),
        "deposit message not in l1_to_l2_message_tree at archive",
    );

    // 1.3 Prove the deposit has never been spent by proving the corresponding nullifier does not exist in the
    //     nullifier tree of the frozen archive tip.

    // Constrain that the provided nhk_m belongs to the recipient
    assert_eq(
        hash_public_key(derive_public_key(l2_recipient_nhk_m)),
        l2_recipient_public_keys.npk_m_hash,
        "provided nhk_m does not match l2_recipient's npk_m_hash",
    );

    // Now we derive the nhk_app that goes into the nullifier preimage
    let nhk_app = compute_app_siloed_secret_key(l2_recipient_nhk_m, l2_token, DOM_SEP__NHK_M as Field);
    let inner_nullifier = compute_deposit_message_nullifier(message_hash, nhk_app);
    let siloed_nullifier = compute_siloed_nullifier(l2_token, inner_nullifier);

    // Empty preimages pad nullifier batches and would trivially satisfy the low-leaf check, so the prover must supply
    // a real low-leaf for this unspent deposit.
    assert(!low_nullifier_preimage.is_empty(), "low nullifier preimage is empty");
    let (nullifier_not_in_tree, _, _) = check_non_membership_with_hasher(
        siloed_nullifier,
        low_nullifier_preimage,
        low_nullifier_membership_witness,
        nullifier_tree_root,
        nullifier_merkle_hash,
    );
    assert(nullifier_not_in_tree, "deposit has already been spent (nullifier exists in nullifier tree)");

    // 2. VERIFYING L2_RECIPIENT AUTHORIZATION

    let auth_message = compute_frozen_deposit_refund_auth_message(message_hash, executor, user_payload_hash);
    assert_refund_authorized(
        l2_recipient,
        l2_recipient_public_keys,
        l2_recipient_instance,
        auth_message,
        auth,
    );

    // 3. RETURN THE SILOED DEPOSIT NULLIFIER

    siloed_nullifier
}

mod tests {
    use super::main;
    use aztec::protocol::{
        abis::{nullifier_leaf_preimage::NullifierLeafPreimage, state_reference::StateReference},
        address::{AztecAddress, EthAddress},
        constants::{DOM_SEP__NHK_M, L1_TO_L2_MSG_TREE_HEIGHT, NULLIFIER_TREE_HEIGHT},
        hash::{compute_app_siloed_secret_key, compute_siloed_nullifier},
        merkle_tree::{MembershipWitness, nullifier_merkle_hash, test_utils::SingleSubtreeMerkleTree},
        public_keys::{hash_public_key, IvpkM, PublicKeys},
        traits::{Empty, FromField, Hash},
    };
    use oxide_token_lib::deposit_message_hashing::{compute_deposit_message_hash, compute_deposit_message_nullifier};
    use refund_lib::test_fixtures::{
        frozen_tip_with, FrozenTip, older_block_with, unread_authorization, unread_instance,
    };
    use std::embedded_curve_ops::{EmbeddedCurvePoint, EmbeddedCurveScalar, fixed_base_scalar_mul};

    global CHAIN_ID: Field = 1;
    global ROLLUP_VERSION: Field = 1;
    global AMOUNT: u128 = 10;
    global SHARED_SECRET_SALT: Field = 42;
    global MESSAGE_LEAF_INDEX: Field = 3;

    fn l1_portal() -> EthAddress {
        EthAddress::from_field(0xa)
    }

    fn l2_token() -> AztecAddress {
        AztecAddress::from_field(1)
    }

    fn l2_recipient() -> AztecAddress {
        AztecAddress::from_field(2)
    }

    fn nhk_m() -> EmbeddedCurveScalar {
        EmbeddedCurveScalar::new(5, 0)
    }

    // The keys commit to `nhk_m`; the checks these tests target run before anything else in them is read.
    fn recipient_public_keys() -> PublicKeys {
        PublicKeys {
            npk_m_hash: hash_public_key(fixed_base_scalar_mul(nhk_m())),
            ivpk_m: IvpkM { inner: EmbeddedCurvePoint::generator() },
            ovpk_m_hash: 0,
            tpk_m_hash: 0,
            mspk_m_hash: 0,
            fbpk_m_hash: 0,
        }
    }

    fn message_hash() -> Field {
        compute_deposit_message_hash(
            l1_portal(),
            CHAIN_ID,
            l2_token(),
            ROLLUP_VERSION,
            SHARED_SECRET_SALT,
            l2_recipient(),
            AMOUNT,
            MESSAGE_LEAF_INDEX,
        )
    }

    fn deposit_nullifier() -> Field {
        let nhk_app = compute_app_siloed_secret_key(nhk_m(), l2_token(), DOM_SEP__NHK_M as Field);
        compute_siloed_nullifier(
            l2_token(),
            compute_deposit_message_nullifier(message_hash(), nhk_app),
        )
    }

    /// The nullifier tree of the frozen tip before the deposit nullifier `n` is in it. The low leaf `n - 1` at index 0
    /// skips over `n` to the leaf `n + 1` at index 1, so it is the low leaf of `n` and of no other key.
    fn unspent_nullifier_leaves() -> [NullifierLeafPreimage; 4] {
        let n = deposit_nullifier();
        [
            NullifierLeafPreimage { nullifier: n - 1, next_nullifier: n + 1, next_index: 1 },
            NullifierLeafPreimage { nullifier: n + 1, next_nullifier: 0, next_index: 0 },
            NullifierLeafPreimage::empty(),
            NullifierLeafPreimage::empty(),
        ]
    }

    /// The nullifier tree after the spend of the deposit inserts `n` at index 2, between the leaves `n - 1` and
    /// `n + 1`.
    fn spent_nullifier_leaves() -> [NullifierLeafPreimage; 4] {
        let n = deposit_nullifier();
        [
            NullifierLeafPreimage { nullifier: n - 1, next_nullifier: n, next_index: 2 },
            NullifierLeafPreimage { nullifier: n + 1, next_nullifier: 0, next_index: 0 },
            NullifierLeafPreimage { nullifier: n, next_nullifier: n + 1, next_index: 1 },
            NullifierLeafPreimage::empty(),
        ]
    }

    /// The L1-to-L2 tree of the frozen tip, with earlier messages before `inbox_leaf` at the message index 3.
    fn message_tree(inbox_leaf: Field) -> SingleSubtreeMerkleTree<4, 2, L1_TO_L2_MSG_TREE_HEIGHT> {
        SingleSubtreeMerkleTree::new([0x5e0, 0x5e1, 0x5e2, inbox_leaf])
    }

    fn nullifier_tree(leaves: [NullifierLeafPreimage; 4]) -> SingleSubtreeMerkleTree<4, 2, NULLIFIER_TREE_HEIGHT> {
        SingleSubtreeMerkleTree::new_with_hasher(leaves.map(|leaf| leaf.hash()), nullifier_merkle_hash)
    }

    /// A state whose L1-to-L2 tree holds `inbox_leaf` at the message index and whose nullifier tree holds
    /// `nullifier_leaves`.
    fn frozen_state(inbox_leaf: Field, nullifier_leaves: [NullifierLeafPreimage; 4]) -> StateReference {
        let mut state = StateReference::empty();
        state.l1_to_l2_message_tree.root = message_tree(inbox_leaf).get_root();
        state.partial.nullifier_tree.root = nullifier_tree(nullifier_leaves).get_root();
        state
    }

    /// Runs the circuit against a frozen tip whose L1-to-L2 tree holds `inbox_leaf` at the message index and whose
    /// nullifier tree holds `frozen_nullifier_leaves`. The claim supplies the low leaf at index 0 of
    /// `witness_nullifier_leaves`.
    fn refund(
        inbox_leaf: Field,
        frozen_nullifier_leaves: [NullifierLeafPreimage; 4],
        witness_nullifier_leaves: [NullifierLeafPreimage; 4],
    ) {
        refund_at(
            frozen_tip_with(frozen_state(inbox_leaf, frozen_nullifier_leaves)),
            witness_nullifier_leaves,
        );
    }

    /// Runs the circuit against `frozen`. The claim supplies the low leaf at index 0 of `witness_nullifier_leaves`.
    fn refund_at(frozen: FrozenTip, witness_nullifier_leaves: [NullifierLeafPreimage; 4]) {
        refund_with_low_leaf_at(frozen, witness_nullifier_leaves, 0);
    }

    /// Runs the circuit against `frozen`. The claim supplies the low leaf at `low_leaf_index` of
    /// `witness_nullifier_leaves`.
    fn refund_with_low_leaf_at(
        frozen: FrozenTip,
        witness_nullifier_leaves: [NullifierLeafPreimage; 4],
        low_leaf_index: u32,
    ) {
        let low_leaf_path = nullifier_tree(witness_nullifier_leaves).get_sibling_path(low_leaf_index as Field);

        let _ = main(
            CHAIN_ID,
            ROLLUP_VERSION,
            l1_portal(),
            frozen.archive_root,
            AMOUNT,
            EthAddress::from_field(0xbeef),
            1,
            l2_token(),
            frozen.header,
            frozen.archive_path,
            SHARED_SECRET_SALT,
            l2_recipient(),
            recipient_public_keys(),
            unread_instance(),
            nhk_m(),
            MESSAGE_LEAF_INDEX,
            message_tree(message_hash()).get_sibling_path(MESSAGE_LEAF_INDEX),
            witness_nullifier_leaves[low_leaf_index],
            MembershipWitness { leaf_index: low_leaf_index as Field, sibling_path: low_leaf_path },
            unread_authorization(),
        );
    }

    // An unspent deposit passes every check of the frozen state, so only the unread authorization refuses it.
    #[test(should_fail_with = "refund authorization does not match owner address")]
    fn accepts_the_frozen_state_of_an_unspent_deposit() {
        refund(
            message_hash(),
            unspent_nullifier_leaves(),
            unspent_nullifier_leaves(),
        );
    }

    #[test(should_fail_with = "deposit message not in l1_to_l2_message_tree at archive")]
    fn rejects_a_deposit_message_the_frozen_tree_does_not_hold() {
        refund(
            message_hash() + 1,
            unspent_nullifier_leaves(),
            unspent_nullifier_leaves(),
        );
    }

    #[test(should_fail_with = "deposit has already been spent (nullifier exists in nullifier tree)")]
    fn rejects_a_deposit_whose_nullifier_the_frozen_tip_holds() {
        // Once the deposit nullifier is in the tree, its honest low leaf points at it and no longer skips over it.
        refund(
            message_hash(),
            spent_nullifier_leaves(),
            spent_nullifier_leaves(),
        );
    }

    #[test(should_fail_with = "deposit has already been spent (nullifier exists in nullifier tree)")]
    fn rejects_a_spent_deposit_behind_a_stale_low_leaf() {
        // The low leaf from before the insert still skips over the nullifier, so only the frozen root refuses it.
        refund(
            message_hash(),
            spent_nullifier_leaves(),
            unspent_nullifier_leaves(),
        );
    }

    #[test(should_fail_with = "low nullifier preimage is empty")]
    fn rejects_an_empty_leaf_as_the_low_leaf() {
        // The empty leaf at the unused index 3 is in the tree and skips over every key, so it would hide the spent
        // deposit nullifier.
        refund_with_low_leaf_at(
            frozen_tip_with(frozen_state(message_hash(), spent_nullifier_leaves())),
            spent_nullifier_leaves(),
            3,
        );
    }

    #[test(should_fail_with = "frozen tip is not in the archive")]
    fn rejects_a_frozen_tip_outside_the_frozen_archive() {
        // The header claims a state without the deposit nullifier, but the frozen archive ends at a block that
        // holds it.
        let mut forged = frozen_tip_with(frozen_state(message_hash(), unspent_nullifier_leaves()));
        forged.archive_root = frozen_tip_with(frozen_state(message_hash(), spent_nullifier_leaves())).archive_root;
        refund_at(forged, unspent_nullifier_leaves());
    }

    #[test(should_fail_with = "frozen tip is not the latest block in the frozen archive")]
    fn rejects_a_block_from_before_the_spend_as_the_frozen_tip() {
        // The deposit was spent in a later block of the frozen archive, so this block does not hold its nullifier yet.
        let spend_block = 0xb10c;
        refund_at(
            older_block_with(
                frozen_state(message_hash(), unspent_nullifier_leaves()),
                spend_block,
            ),
            unspent_nullifier_leaves(),
        );
    }
}
