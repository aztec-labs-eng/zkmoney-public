// The L1->L2 message oxide's NamePortal emits for a registered user. Proving one exists is half of what admits a
// user to a registration-gated rail: the portal reads the NameRegistry's `nameOf` and checks the account comes from
// its factory, so the message exists only for a bootstrap key whose account holds a name.

use aztec::{
    context::PrivateContext,
    hash::{compute_l1_to_l2_message_hash, compute_secret_hash},
    oracle::get_l1_to_l2_membership_witness::get_l1_to_l2_membership_witness,
    protocol::{
        address::EthAddress, hash::sha256_to_field, merkle_tree::root::root_from_sibling_path,
    },
};

/// Asserts the portal's message with `content` is in the L1->L2 tree at the anchor block, without consuming it. The
/// message states an L1 fact and moves no value, so a second use is harmless, and its nullifier would let anyone
/// match the tx to the account, since the message secret is a public constant.
pub fn assert_name_portal_message(
    context: &mut PrivateContext,
    portal: EthAddress,
    content: Field,
    leaf_index: Field,
) {
    let message_hash = compute_l1_to_l2_message_hash(
        portal,
        context.chain_id(),
        context.this_address(),
        context.version(),
        content,
        compute_secret_hash([0]),
        leaf_index,
    );
    // Safety: the sibling path is only a hint for the root check below.
    let (_index, sibling_path) =
        unsafe { get_l1_to_l2_membership_witness(message_hash, Option::none()) };
    let root = root_from_sibling_path(message_hash, leaf_index, sibling_path);
    assert_eq(
        root,
        context.get_anchor_block_header().state.l1_to_l2_message_tree.root,
        "NamePortal message not found",
    );
}

/// NamePortal hashes the packed bootstrap address and registered name.
pub fn name_ownership_content_hash(bootstrap: [u8; 20], name_hash: [u8; 32]) -> Field {
    let mut preimage: [u8; 52] = [0; 52];
    for i in 0..20 {
        preimage[i] = bootstrap[i];
    }
    for i in 0..32 {
        preimage[20 + i] = name_hash[i];
    }
    sha256_to_field(preimage)
}

// -- tests -------------------------------------------------------------------

/// Same fixture as packages/sdk/test/services/registrationMessage.test.ts.
global PINNED_OWNER: [u8; 20] =
    [0x0e, 0xad, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xbe, 0xe0];
global PINNED_NAME_HASH: [u8; 32] = [
    0x0d, 0xa1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0x1e, 0x55,
];

#[test]
fn content_hash_matches_the_typescript_mirror() {
    assert_eq(
        name_ownership_content_hash(PINNED_OWNER, PINNED_NAME_HASH),
        0x00430fd1ec5d12a2bc57833acc01e9d48e7127e07fc06e6eaebfd92b5885eb4b,
    );
}

#[test]
fn the_content_binds_both_the_owner_and_the_name() {
    let pinned = name_ownership_content_hash(PINNED_OWNER, PINNED_NAME_HASH);
    assert(name_ownership_content_hash([0x11; 20], PINNED_NAME_HASH) != pinned);
    assert(name_ownership_content_hash(PINNED_OWNER, [0x22; 32]) != pinned);
}
