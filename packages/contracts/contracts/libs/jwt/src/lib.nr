pub mod verifyJwt;
pub mod jwt_lib;
// pub mod tests;

use bignum::{params::BigNumParams};
use rsa::{rsa::verify_sha256_pkcs1v15, types::RBN2048};

global PUBLIC_KEY_LIMBS_LEN: u32 = 36;
global EMAIL_LEN: u32 = 64;
global E_LEN: u32 = 1;
pub global LIMBS_LEN: u32 = 18;
global RSA_BITS: u32 = 2048;


// ISS byte arrays, zero-padded to JWT_ISS_MAX_LEN (32)
pub global JWT_ISS_MAX_LEN: u32 = 32;

pub global GOOGLE_ISS_BYTES: [u8; JWT_ISS_MAX_LEN] = [
    104, 116, 116, 112, 115, 58, 47, 47, 97, 99, 99, 111, 117, 110, 116, 115, 46, 103, 111, 111,
    103, 108, 101, 46, 99, 111, 109, 0, 0, 0, 0, 0,
]; // "https://accounts.google.com"

pub global APPLE_ISS_BYTES: [u8; JWT_ISS_MAX_LEN] = [
    104, 116, 116, 112, 115, 58, 47, 47, 97, 112, 112, 108, 101, 105, 100, 46, 97, 112, 112, 108,
    101, 46, 99, 111, 109, 0, 0, 0, 0, 0, 0, 0,
]; // "https://appleid.apple.com"

/// Verify the RSA-SHA256 signature over `header_and_payload`.
pub fn assert_verify_jwt<let HeaderAndPayloadMaxLen: u32>(
    header_and_payload: BoundedVec<u8, HeaderAndPayloadMaxLen>,
    pubkey_limbs: [u128; LIMBS_LEN],
    pubkey_redc_limbs: [u128; LIMBS_LEN],
    signature: [u128; LIMBS_LEN],
) {
    let hash = dep::sha256::sha256_var(
        header_and_payload.storage(),
        header_and_payload.len() as u64,
    );
    let params: BigNumParams<LIMBS_LEN, RSA_BITS> = BigNumParams::new(false, pubkey_limbs, pubkey_redc_limbs);
    let signature: RBN2048 = RBN2048::from_array(params, signature);
    let result = verify_sha256_pkcs1v15(hash, signature, 65537);
    assert(result, "jwt verification failed: signature");
}


pub fn bytes_to_fields<let N: u32>(bytes: [u8; N]) -> [Field; N] {
    let mut fields = [0 as Field; N];
    for i in 0..N {
        fields[i] = bytes[i] as Field;
    }
    fields
}

/// Hash a bounded byte array using Poseidon2 with 31-byte little-endian field packing.
///
/// Bytes at indexes greater than or equal to `data_len` are ignored while packing each chunk.
/// The hash arity is the fixed max chunk count for `N`, so callers with the same max length share
/// one domain while still binding only the actual bounded-vector bytes.
pub fn poseidon2_hash_packed<let N: u32>(data: [u8; N], data_len: u32) -> Field {
    let FIELDS_NEEDED: u32 = (N + 30) / 31;
    let mut fields: [Field; (N + 30) / 31] = [0; (N + 30) / 31];
    for i in 0..FIELDS_NEEDED {
        let mut field_val: Field = 0;
        for j in 0..31 {
            let byte_idx = i * 31 + j;
            if byte_idx < data_len {
                field_val = field_val + (data[byte_idx] as Field) * pow_256(j);
            }
        }
        fields[i] = field_val;
    }
    dep::poseidon::poseidon2::Poseidon2::hash(fields, FIELDS_NEEDED)
}

fn pow_256(exp: u32) -> Field {
    let mut result: Field = 1;
    for _ in 0..exp {
        result = result * 256;
    }
    result
}

// This will work the same for Google and Apple,
// Both use the same pub key format
//     RSA 256, e: 65537 (AQAB)
pub fn derive_JWK(
    public_key_limbs: [u128; LIMBS_LEN],
    public_key_redc_limbs: [u128; LIMBS_LEN],
    public_key_e: u128,
) -> Field {
    let public_key_limbs = public_key_limbs.concat(public_key_redc_limbs);
    let public_key_limbs_and_e = public_key_limbs.concat([public_key_e]);

    // convert u128 array to field array
    let mut public_key_limbs_and_e_field: [Field; PUBLIC_KEY_LIMBS_LEN + E_LEN] =
        [0; PUBLIC_KEY_LIMBS_LEN + E_LEN];
    for i in 0..public_key_limbs_and_e.len() {
        public_key_limbs_and_e_field[i] = public_key_limbs_and_e[i] as Field;
    }

    let hash = dep::poseidon::poseidon2::Poseidon2::hash(
        public_key_limbs_and_e_field,
        (PUBLIC_KEY_LIMBS_LEN + E_LEN),
    );

    hash
}

pub fn emailHashFromBytes(email_bytes: [u8; EMAIL_LEN], email_len: u32) -> Field {
    poseidon2_hash_packed(email_bytes, email_len)
}
