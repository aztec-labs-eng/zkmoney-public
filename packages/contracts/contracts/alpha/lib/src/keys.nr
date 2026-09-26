use aztec::protocol::hash::poseidon2_hash_with_separator;

pub global DOM_SEP__ALPHA_KEY_ID: Field = 0x414c5048415f4b4559; // "ALPHA_KEY" in hex

pub fn pack_bytes_to_field(bytes: [u8; 32], offset: u32) -> Field {
    let mut acc: Field = 0;
    for i in 0..16 {
        acc = acc * 256 + bytes[offset + i] as Field;
    }
    acc
}

/// The account's `immutables_hash`: the commitment of the one signing key an account is bound to.
/// Oxide's refund circuits recompute it from the same 64-byte x‖y key.
pub fn compute_key_commitment(pub_key_x: [u8; 32], pub_key_y: [u8; 32]) -> Field {
    poseidon2_hash_with_separator(
        [
            pack_bytes_to_field(pub_key_x, 0),
            pack_bytes_to_field(pub_key_x, 16),
            pack_bytes_to_field(pub_key_y, 0),
            pack_bytes_to_field(pub_key_y, 16),
        ],
        DOM_SEP__ALPHA_KEY_ID,
    )
}

// Shared with the SDK parity test (`alphaKeyCommitment.sandbox.test.ts`): x[i] = i + 1, y[i] = 0xff - i.
global KEY_COMMITMENT_VECTOR: Field =
    0x2ec7aa3dafb41e9b61288d8d83d3e22f82b044ac7ad4ad606f1bf7a110e3dc49;

#[test]
fn test_key_commitment_vector() {
    let mut x: [u8; 32] = [0; 32];
    let mut y: [u8; 32] = [0; 32];
    for i in 0..32 {
        x[i] = i as u8 + 1;
        y[i] = 0xff - i as u8;
    }
    assert(compute_key_commitment(x, y) == KEY_COMMITMENT_VECTOR, "key commitment vector drifted");
}

#[test]
fn test_key_commitment_differs_by_key() {
    let mut x: [u8; 32] = [0; 32];
    let y: [u8; 32] = [0; 32];
    let a = compute_key_commitment(x, y);
    x[31] = 1;
    let b = compute_key_commitment(x, y);
    assert(a != b, "distinct keys must commit to distinct values");
}
