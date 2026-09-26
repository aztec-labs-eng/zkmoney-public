use crate::constants::DOM_SEP__PASSKEY_IMMUTABLES;
use aztec::protocol::{
    address::{AztecAddress, PartialAddress},
    contract_class_id::ContractClassId,
    hash::poseidon2_hash_with_separator,
    public_keys::PublicKeys,
};

/// Uncompressed P-256 public key, coordinates as 32 big-endian bytes each. This is the shape
/// `std::ecdsa_secp256r1::verify_signature` consumes.
pub struct PasskeyPublicKey {
    pub x: [u8; 32],
    pub y: [u8; 32],
}

/// The address preimage fields of a contract instance, less the immutables hash that the passkey provides.
pub struct AccountInstancePreimage {
    pub contract_class_id: ContractClassId,
    pub salt: Field,
    pub initialization_hash: Field,
    pub deployer: AztecAddress,
}

fn pack_16_bytes(bytes: [u8; 32], offset: u32) -> Field {
    let mut acc: Field = 0;
    for i in 0..16 {
        acc = acc * 256 + bytes[offset + i] as Field;
    }
    acc
}

/// The `immutables_hash` a passkey account commits in its address preimage.
///
/// Mirrors `compute_key_commitment` in the wallet's alpha account library (see `DOM_SEP__PASSKEY_IMMUTABLES` in
/// `constants.nr`).
pub fn compute_passkey_immutables_hash(passkey: PasskeyPublicKey) -> Field {
    poseidon2_hash_with_separator(
        [
            pack_16_bytes(passkey.x, 0),
            pack_16_bytes(passkey.x, 16),
            pack_16_bytes(passkey.y, 0),
            pack_16_bytes(passkey.y, 16),
        ],
        DOM_SEP__PASSKEY_IMMUTABLES,
    )
}

pub fn compute_account_address(
    public_keys: PublicKeys,
    instance: AccountInstancePreimage,
    immutables_hash: Field,
) -> AztecAddress {
    let partial_address = PartialAddress::compute(
        instance.contract_class_id,
        instance.salt,
        instance.initialization_hash,
        instance.deployer,
        immutables_hash,
    );
    AztecAddress::compute(public_keys, partial_address)
}

mod tests {
    use super::{compute_passkey_immutables_hash, PasskeyPublicKey};

    // Pinned vector shared with `yarn-project/oxide-lib/src/account_address.test.ts`. If this test fails, the Noir
    // and the TS implementations of the passkey immutables hash disagree.
    #[test]
    fn immutables_hash_matches_ts() {
        let mut x: [u8; 32] = [0; 32];
        let mut y: [u8; 32] = [0; 32];
        for i in 0..32 {
            x[i] = (i + 1) as u8;
            y[i] = (0xff - i) as u8;
        }
        let hash = compute_passkey_immutables_hash(PasskeyPublicKey { x, y });
        assert_eq(hash, PINNED_IMMUTABLES_HASH);
    }

    global PINNED_IMMUTABLES_HASH: Field = 0x2ec7aa3dafb41e9b61288d8d83d3e22f82b044ac7ad4ad606f1bf7a110e3dc49;
}
