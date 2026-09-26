// The L1->L2 message oxide's NamePortal emits for a registered user. Consuming one is half of what
// admits a user to a registration-gated rail: the portal reads the NameRegistry's `nameOf`, so
// the message exists only for an L1 account that actually holds a name, and its content names that
// account and the name it holds.

use aztec::protocol::hash::sha256_to_field;
use keccak256::keccak256;

global NAME_OWNERSHIP_SIGNATURE: str<40> = "name_ownership_verified(address,bytes32)";

/// Content of the message attesting that `owner` holds `name_hash`: `abi.encodeWithSignature` over
/// the handler signature -- a 4-byte keccak selector then 32-byte big-endian arguments -- sha256
/// compressed to a field, which is what `NamePortal.notify` sends. The TS mirror is
/// `packages/sdk/src/services/registrationMessage.ts`, and the pinned vector below is what fails
/// when the two drift.
///
/// The content names an L1 address, never an L2 one, so it admits nobody by itself: the gate
/// derives the owner from a bootstrap key and takes that key's signature over the L2 address
/// (main.nr `_gate_registration`).
pub fn name_ownership_content_hash(owner: [u8; 20], name_hash: [u8; 32]) -> Field {
    let selector: [u8; 4] = comptime {
        let h: [u8; 32] = keccak256(NAME_OWNERSHIP_SIGNATURE.as_bytes(), 40);
        [h[0], h[1], h[2], h[3]]
    };
    let mut preimage: [u8; 68] = [0; 68];
    for i in 0..4 {
        preimage[i] = selector[i];
    }
    // address right-aligned in its 32-byte word
    for i in 0..20 {
        preimage[16 + i] = owner[i];
    }
    for i in 0..32 {
        preimage[36 + i] = name_hash[i];
    }
    sha256_to_field(preimage)
}

// -- tests -------------------------------------------------------------------

/// Same fixture as packages/sdk/test/services/registrationMessage.test.ts.
global PINNED_OWNER: [u8; 20] = [
    0x0e, 0xad, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xbe, 0xe0,
];
global PINNED_NAME_HASH: [u8; 32] = [
    0x0d, 0xa1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0x1e, 0x55,
];

#[test]
fn content_hash_matches_the_typescript_mirror() {
    assert_eq(
        name_ownership_content_hash(PINNED_OWNER, PINNED_NAME_HASH),
        0x0076965bb2b826b57030fd020a5c87ab48ca8086410dbb797d788534438ae5c6,
    );
}

#[test]
fn the_content_binds_both_the_owner_and_the_name() {
    let pinned = name_ownership_content_hash(PINNED_OWNER, PINNED_NAME_HASH);
    assert(name_ownership_content_hash([0x11; 20], PINNED_NAME_HASH) != pinned);
    assert(name_ownership_content_hash(PINNED_OWNER, [0x22; 32]) != pinned);
}
