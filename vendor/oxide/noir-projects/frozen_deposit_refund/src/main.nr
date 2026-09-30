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
