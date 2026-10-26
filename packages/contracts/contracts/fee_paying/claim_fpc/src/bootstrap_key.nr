// Proof that the prover holds the secp256k1 bootstrap key behind a public key, made with the ECDSA blackbox.
//
// An ECDSA signature made with nonce 1 is r = x(G), s = z + r*k mod n. Verification computes ((z + r*sk) / s) * G and
// compares its x with r, so it passes exactly when k = sk or k = -2z/r - sk. Either way k determines sk, so knowing k
// is knowing the key. The two s values sum to n, so requiring low s leaves exactly one k per key, which is what lets it
// key the subscription nullifier. Anyone who sees k or s can recover sk, so both stay private witnesses.

use aztec::protocol::hash::poseidon2_hash_with_separator;
use bignum::{BigNum, Secp256k1_Fr};

pub global DOM_SEP__BOOTSTRAP_KEY_IDENTITY: u32 = 1241;

/// x(G): the r of a nonce-1 signature.
pub global NONCE_ONE_R: [u8; 32] = [
    0x79, 0xbe, 0x66, 0x7e, 0xf9, 0xdc, 0xbb, 0xac, 0x55, 0xa0, 0x62, 0x95, 0xce, 0x87, 0x0b, 0x07,
    0x02, 0x9b, 0xfc, 0xdb, 0x2d, 0xce, 0x28, 0xd9, 0x59, 0xf2, 0x81, 0x5b, 0x16, 0xf8, 0x17, 0x98,
];

/// The message hash the nonce-1 signature signs: ASCII "ZKMONEY_SUBSCRIPTION_KEY_V1", zero padded.
pub global KEY_PROOF_Z: [u8; 32] = [
    0x5a, 0x4b, 0x4d, 0x4f, 0x4e, 0x45, 0x59, 0x5f, 0x53, 0x55, 0x42, 0x53, 0x43, 0x52, 0x49, 0x50,
    0x54, 0x49, 0x4f, 0x4e, 0x5f, 0x4b, 0x45, 0x59, 0x5f, 0x56, 0x31, 0x00, 0x00, 0x00, 0x00, 0x00,
];

/// (n - 1) / 2 for the secp256k1 group order, the largest low s.
global HALF_N: [u8; 32] = [
    0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0x5d, 0x57, 0x6e, 0x73, 0x57, 0xa4, 0x50, 0x1d, 0xdf, 0xe9, 0x2f, 0x46, 0x68, 0x1b, 0x20, 0xa0,
];

/// Proves the prover holds the key behind `pub_key` and returns the secret identity its witness `k` keys. Low s is asserted here, not left to the
/// blackbox, because uniqueness rests on it.
pub fn bootstrap_key_identity(pub_key_x: [u8; 32], pub_key_y: [u8; 32], k: [u8; 32]) -> Field {
    let k_scalar = Secp256k1_Fr::from_be_bytes(k);
    k_scalar.validate_in_field();
    k_scalar.assert_is_not_zero();

    let s = Secp256k1_Fr::from_be_bytes(KEY_PROOF_Z)
        + Secp256k1_Fr::from_be_bytes(NONCE_ONE_R) * k_scalar;
    let s_bytes = s.to_be_bytes();
    assert(bytes_at_most(s_bytes, HALF_N), "bootstrap key proof needs low s");

    let mut signature: [u8; 64] = [0; 64];
    for i in 0..32 {
        signature[i] = NONCE_ONE_R[i];
        signature[32 + i] = s_bytes[i];
    }
    assert(
        std::ecdsa_secp256k1::verify_signature(pub_key_x, pub_key_y, signature, KEY_PROOF_Z),
        "not the bootstrap key",
    );

    let mut hi: [u8; 16] = [0; 16];
    let mut lo: [u8; 16] = [0; 16];
    for i in 0..16 {
        hi[i] = k[i];
        lo[i] = k[16 + i];
    }
    poseidon2_hash_with_separator(
        [Field::from_be_bytes::<16>(hi), Field::from_be_bytes::<16>(lo)],
        DOM_SEP__BOOTSTRAP_KEY_IDENTITY,
    )
}

/// `a <= b` for big-endian 32-byte integers.
fn bytes_at_most(a: [u8; 32], b: [u8; 32]) -> bool {
    let (a_hi, a_lo) = (limb(a, 0), limb(a, 16));
    let (b_hi, b_lo) = (limb(b, 0), limb(b, 16));
    (a_hi < b_hi) | ((a_hi == b_hi) & (a_lo <= b_lo))
}

fn limb(b: [u8; 32], offset: u32) -> u128 {
    Field::from_be_bytes::<16>(slice16(b, offset)) as u128
}

fn slice16(b: [u8; 32], offset: u32) -> [u8; 16] {
    let mut out: [u8; 16] = [0; 16];
    for i in 0..16 {
        out[i] = b[offset + i];
    }
    out
}

// -- tests -------------------------------------------------------------------
// Keys 1 (pub key G, whose witness is -2z/r - 1) and 2 (whose witness is 2). Same fixtures as
// packages/sdk/test/fpc/bootstrapKeyWitness.test.ts.

global KEY_ONE_X: [u8; 32] = NONCE_ONE_R;
global KEY_ONE_Y: [u8; 32] = [
    0x48, 0x3a, 0xda, 0x77, 0x26, 0xa3, 0xc4, 0x65, 0x5d, 0xa4, 0xfb, 0xfc, 0x0e, 0x11, 0x08, 0xa8,
    0xfd, 0x17, 0xb4, 0x48, 0xa6, 0x85, 0x54, 0x19, 0x9c, 0x47, 0xd0, 0x8f, 0xfb, 0x10, 0xd4, 0xb8,
];
global KEY_ONE_LOW: [u8; 32] = [
    0xd9, 0x31, 0xf7, 0xb7, 0x2d, 0x72, 0xec, 0xff, 0xd8, 0x86, 0x50, 0x19, 0x05, 0x29, 0xc1, 0x10,
    0x5a, 0x3e, 0x85, 0xb5, 0xc3, 0x15, 0x23, 0x95, 0xc0, 0x86, 0xee, 0x90, 0xdf, 0x9c, 0x1f, 0x04,
];
global KEY_TWO_X: [u8; 32] = [
    0xc6, 0x04, 0x7f, 0x94, 0x41, 0xed, 0x7d, 0x6d, 0x30, 0x45, 0x40, 0x6e, 0x95, 0xc0, 0x7c, 0xd8,
    0x5c, 0x77, 0x8e, 0x4b, 0x8c, 0xef, 0x3c, 0xa7, 0xab, 0xac, 0x09, 0xb9, 0x5c, 0x70, 0x9e, 0xe5,
];
global KEY_TWO_Y: [u8; 32] = [
    0x1a, 0xe1, 0x68, 0xfe, 0xa6, 0x3d, 0xc3, 0x39, 0xa3, 0xc5, 0x84, 0x19, 0x46, 0x6c, 0xea, 0xee,
    0xf7, 0xf6, 0x32, 0x65, 0x32, 0x66, 0xd0, 0xe1, 0x23, 0x64, 0x31, 0xa9, 0x50, 0xcf, 0xe5, 0x2a,
];
global KEY_TWO_Y_NEG: [u8; 32] = [
    0xe5, 0x1e, 0x97, 0x01, 0x59, 0xc2, 0x3c, 0xc6, 0x5c, 0x3a, 0x7b, 0xe6, 0xb9, 0x93, 0x15, 0x11,
    0x08, 0x09, 0xcd, 0x9a, 0xcd, 0x99, 0x2f, 0x1e, 0xdc, 0x9b, 0xce, 0x55, 0xaf, 0x30, 0x17, 0x05,
];
global KEY_TWO_LOW: [u8; 32] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0x02,
];
global KEY_TWO_HIGH: [u8; 32] = [
    0xd9, 0x31, 0xf7, 0xb7, 0x2d, 0x72, 0xec, 0xff, 0xd8, 0x86, 0x50, 0x19, 0x05, 0x29, 0xc1, 0x10,
    0x5a, 0x3e, 0x85, 0xb5, 0xc3, 0x15, 0x23, 0x95, 0xc0, 0x86, 0xee, 0x90, 0xdf, 0x9c, 0x1f, 0x03,
];
global KEY_TWO_PLUS_N: [u8; 32] = [
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe,
    0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x43,
];

#[test]
fn the_low_s_witness_proves_either_kind_of_key() {
    let one = bootstrap_key_identity(KEY_ONE_X, KEY_ONE_Y, KEY_ONE_LOW);
    let two = bootstrap_key_identity(KEY_TWO_X, KEY_TWO_Y, KEY_TWO_LOW);
    assert(one != two);
}

#[test(should_fail_with = "bootstrap key proof needs low s")]
fn the_key_itself_fails_when_its_s_is_high() {
    let _ = bootstrap_key_identity(
        KEY_ONE_X,
        KEY_ONE_Y,
        [
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            0, 0, 0x01,
        ],
    );
}

#[test(should_fail_with = "bootstrap key proof needs low s")]
fn the_other_witness_fails_when_its_s_is_high() {
    let _ = bootstrap_key_identity(KEY_TWO_X, KEY_TWO_Y, KEY_TWO_HIGH);
}

#[test(should_fail_with = "not the bootstrap key")]
fn a_low_s_witness_for_another_key_fails() {
    let _ = bootstrap_key_identity(KEY_TWO_X, KEY_TWO_Y, KEY_ONE_LOW);
}

#[test(should_fail_with = "not the bootstrap key")]
fn the_negated_public_key_fails() {
    let _ = bootstrap_key_identity(KEY_TWO_X, KEY_TWO_Y_NEG, KEY_TWO_LOW);
}

#[test(should_fail)]
fn a_witness_above_the_group_order_fails() {
    let _ = bootstrap_key_identity(KEY_TWO_X, KEY_TWO_Y, KEY_TWO_PLUS_N);
}

#[test(should_fail)]
fn a_zero_witness_fails() {
    let _ = bootstrap_key_identity(KEY_TWO_X, KEY_TWO_Y, [0; 32]);
}
