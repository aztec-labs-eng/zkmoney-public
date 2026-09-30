//! See [Unprocessed Deposit Refund](../../../engineering-design-docs/oxide.md#1-unprocessed-deposit-refund) in engineering-design-docs/oxide.md.

use std::embedded_curve_ops::fixed_base_scalar_mul as derive_public_key;

use aztec::protocol::{
    abis::block_header::BlockHeader,
    address::{AztecAddress, EthAddress},
    constants::{ARCHIVE_HEIGHT, DOM_SEP__NHK_M},
    hash::{compute_app_siloed_secret_key, compute_siloed_nullifier, poseidon2_hash_with_separator},
    public_keys::{hash_public_key, PublicKeys},
    scalar::Scalar,
    traits::ToField,
};
use oxide_lib::account_address::AccountInstancePreimage;
use oxide_lib::constants::DOM_SEP__UNPROCESSED_DEPOSIT_AUTH;
use oxide_token_lib::deposit_message_hashing::{compute_deposit_message_hash, compute_deposit_message_nullifier};
use refund_lib::{assert_is_frozen_tip, assert_refund_authorized, RefundAuthorization};

// Mirrored by `computeUnprocessedDepositRefundAuthMessage` in `yarn-project/oxide-lib`.
pub fn compute_unprocessed_deposit_refund_auth_message(
    message_hash: Field,
    executor: EthAddress,
    user_payload_hash: Field,
) -> Field {
    poseidon2_hash_with_separator(
        [message_hash, executor.to_field(), user_payload_hash],
        DOM_SEP__UNPROCESSED_DEPOSIT_AUTH,
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
    message_hash: pub Field,
    message_leaf_index: pub Field,
    // ===== Private inputs =====
    // Can be private as we trust OxidePortal to not create a message for a different L2 token.
    l2_token: AztecAddress,
    // Tip of the chain at the time of `frozen_archive`.
    frozen_tip: BlockHeader,
    frozen_tip_sibling_path: [Field; ARCHIVE_HEIGHT],
    shared_secret_salt: Field,
    l2_recipient: AztecAddress,
    l2_recipient_public_keys: PublicKeys,
    l2_recipient_instance: AccountInstancePreimage,
    l2_recipient_nhk_m: Scalar,
    // The recipient's authorization of the refund auth message.
    auth: RefundAuthorization,
) -> pub Field {
    assert(executor != EthAddress::zero(), "executor must be non-zero");

    // 1. CONSTRAINING MESSAGE WAS NOT PROCESSED

    // 1.1 Constrain `frozen_tip` to be the rightmost leaf of the frozen archive.
    assert_is_frozen_tip(frozen_tip, frozen_tip_sibling_path, frozen_archive_root);

    // 1.2 Prove the rollup has never absorbed the message and hence that the message is unprocessed.
    //
    // We use ">=" and not ">" as next_available_leaf_index corresponds to the next smallest unused leaf index in
    // the tree of the provided block header.
    assert(
        message_leaf_index as u128 >= frozen_tip.state.l1_to_l2_message_tree.next_available_leaf_index as u128,
        "attempting to spend a processed message via the unprocessed deposit refund",
    );

    // 2. VERIFYING L2_RECIPIENT AUTHORIZATION

    // 2.1 Recompute the L1->L2 deposit message exactly as `OxidePortal.sol::deposit` did and assert it matches
    //    the public-input `message_hash`.
    let recomputed_message_hash = compute_deposit_message_hash(
        l1_portal,
        chain_id,
        l2_token,
        rollup_version,
        shared_secret_salt,
        l2_recipient,
        amount,
        message_leaf_index,
    );
    assert(recomputed_message_hash == message_hash, "recomputed message hash does not match public input");

    // 2.2 Verify the L2 recipient authorized this refund.
    let auth_message = poseidon2_hash_with_separator(
        [message_hash, executor.to_field(), user_payload_hash],
        DOM_SEP__UNPROCESSED_DEPOSIT_AUTH,
    );
    assert_refund_authorized(
        l2_recipient,
        l2_recipient_public_keys,
        l2_recipient_instance,
        auth_message,
        auth,
    );

    // 3. RETURN THE SILOED DEPOSIT-MESSAGE NULLIFIER
    //
    // 3.1 We could use the message hash directly as the OxidePortal nullifier, but computing the siloed message
    // nullifier and sharing the nullifier set with the frozen-deposit path acts as a secondary check that the two
    // paths cannot double-spend the same deposit.
    assert_eq(
        hash_public_key(derive_public_key(l2_recipient_nhk_m)),
        l2_recipient_public_keys.npk_m_hash,
        "l2_recipient_nhk_m does not match l2_recipient's npk_m_hash",
    );
    let nhk_app = compute_app_siloed_secret_key(l2_recipient_nhk_m, l2_token, DOM_SEP__NHK_M as Field);
    let inner_nullifier = compute_deposit_message_nullifier(message_hash, nhk_app);
    compute_siloed_nullifier(l2_token, inner_nullifier)
}
