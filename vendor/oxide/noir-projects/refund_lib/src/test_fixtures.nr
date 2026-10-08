//! Fixtures for the tests of the refund circuits.

use crate::RefundAuthorization;
use aztec::protocol::{
    abis::{block_header::BlockHeader, state_reference::StateReference},
    address::AztecAddress,
    constants::ARCHIVE_HEIGHT,
    contract_class_id::ContractClassId,
    merkle_tree::test_utils::SingleSubtreeMerkleTree,
    traits::{Empty, FromField, Hash},
};
use oxide_lib::account_address::{AccountInstancePreimage, PasskeyPublicKey};
use oxide_lib::constants::WEBAUTHN_MAX_CLIENT_DATA_JSON_LEN;
use oxide_lib::webauthn::WebAuthnAuth;
use std::embedded_curve_ops::{EmbeddedCurvePoint, EmbeddedCurveScalar};

/// A frozen tip, with the root and the sibling path that prove it is the latest block of its frozen archive.
pub struct FrozenTip {
    pub header: BlockHeader,
    pub archive_root: Field,
    pub archive_path: [Field; ARCHIVE_HEIGHT],
}

/// The block number of the frozen tip. Earlier blocks come before it, so its sibling path has left siblings.
global TIP_BLOCK_NUMBER: u32 = 7;

type ArchiveTree = SingleSubtreeMerkleTree<16, 4, ARCHIVE_HEIGHT>;

/// Block 7 of a frozen archive, with `state` as its state. It is the latest block, so the same sibling path proves
/// both archive checks of `assert_is_frozen_tip`.
pub fn frozen_tip_with(state: StateReference) -> FrozenTip {
    block_seven_with(state, 0)
}

/// Block 7 of a frozen archive that holds `later_block` at index 8, with `state` as its state. It is in the archive
/// but it is not the latest block.
pub fn older_block_with(state: StateReference, later_block: Field) -> FrozenTip {
    block_seven_with(state, later_block)
}

fn block_seven_with(state: StateReference, later_block: Field) -> FrozenTip {
    let mut blocks = [0; 16];
    for i in 0..TIP_BLOCK_NUMBER {
        blocks[i] = 0xb10c00 + i as Field;
    }
    let last_archive: ArchiveTree = SingleSubtreeMerkleTree::new(blocks);

    let mut header = BlockHeader::empty();
    header.global_variables.block_number = TIP_BLOCK_NUMBER;
    header.last_archive.root = last_archive.get_root();
    header.last_archive.next_available_leaf_index = TIP_BLOCK_NUMBER as Field;
    header.state = state;

    blocks[TIP_BLOCK_NUMBER] = header.hash();
    blocks[TIP_BLOCK_NUMBER + 1] = later_block;
    let archive: ArchiveTree = SingleSubtreeMerkleTree::new(blocks);
    FrozenTip {
        header,
        archive_root: archive.get_root(),
        archive_path: archive.get_sibling_path(TIP_BLOCK_NUMBER as Field),
    }
}

/// A zero authorization, for a test whose target check runs before the circuit reads the authorization.
pub fn unread_authorization() -> RefundAuthorization {
    RefundAuthorization {
        use_passkey: true,
        passkey: PasskeyPublicKey { x: [0; 32], y: [0; 32] },
        webauthn: WebAuthnAuth {
            authenticator_data: [0; 37],
            client_data_json: [0; WEBAUTHN_MAX_CLIENT_DATA_JSON_LEN],
            client_data_json_len: 0,
            signature: [0; 64],
        },
        fbpk_m: EmbeddedCurvePoint { x: 0, y: 0 },
        fallback_signature: (EmbeddedCurveScalar::new(0, 0), EmbeddedCurveScalar::new(0, 0)),
    }
}

/// A zero account instance, for a test whose target check runs before the circuit reads the recipient's address.
pub fn unread_instance() -> AccountInstancePreimage {
    AccountInstancePreimage {
        contract_class_id: ContractClassId::from_field(0),
        salt: 0,
        initialization_hash: 0,
        deployer: AztecAddress::from_field(0),
    }
}
