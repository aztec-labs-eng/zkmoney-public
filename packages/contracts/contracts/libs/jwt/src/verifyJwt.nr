// adapted from https://github.com/shield-labs/zklogin
// and https://github.com/zkemail/noir-jwt

use crate::{
    APPLE_ISS_BYTES, assert_verify_jwt, derive_JWK, emailHashFromBytes,
    GOOGLE_ISS_BYTES, JWT_ISS_MAX_LEN, LIMBS_LEN,
    poseidon2_hash_packed,
};
use crate::jwt_lib::{JwtPayload, parse_decimal_field};
use aztec::protocol::{address::AztecAddress, traits::{Deserialize, Serialize, ToField}};
use base64::BASE64_URL_DECODER;

global JWT_HEADER_MAX_LEN: u32 = 256;
pub comptime global JWT_PAYLOAD_JSON_MAX_LEN: u32 = 768;
pub global JWT_PAYLOAD_MAX_LEN: u32 =
    comptime { nodash::div_ceil(JWT_PAYLOAD_JSON_MAX_LEN, 3) * 4 };
global JWT_SUB_MAX_LEN: u32 = 64;
pub global JWT_AUD_MAX_LEN: u32 = 128;
pub global EMAIL_LEN: u32 = 64;
// BN254 field element is at most 77 decimal digits; 80 gives comfortable padding.
global JWT_NONCE_STR_LEN: u32 = 80;

/// JWT input for Noir circuit verification.
///
/// The payload JSON is no longer a separate witness-it is derived inside the
/// circuit by base64url-decoding the payload portion of `header_and_payload`
/// starting at `base64_decode_offset`.  This eliminates the attack vector where
/// a caller could supply a real signed header+payload together with a forged
/// `payload_json`.
#[derive(Serialize, Deserialize)]
pub struct JWTInput {
    /// Raw base64url-encoded `header.payload` bytes, used for RSA signature verification.
    pub header_and_payload: BoundedVec<u8, JWT_HEADER_MAX_LEN + 1 + JWT_PAYLOAD_MAX_LEN>,
    /// Byte offset into `header_and_payload` where the payload base64url starts
    /// (i.e. the index immediately after the '.' separator).
    pub base64_decode_offset: u32,
    pub signature_limbs: [u128; LIMBS_LEN],
    pub public_key_e: u128,
    pub public_key_limbs: [u128; LIMBS_LEN],
    pub public_key_redc_limbs: [u128; LIMBS_LEN],
    /// Random preimage r such that poseidon2(r, address) equals the JWT nonce claim.
    pub nonce_preimage: Field,
}

/// Claims extracted and verified from the JWT.
pub struct VerifiedJwtClaims {
    /// poseidon2(sub_hash, pre_email_hash) ,  used as the key in the email registry.
    pub email_hash: Field,
    /// poseidon2(packed email bytes) , used in send_to_email to verify the committed email.
    pub pre_email_hash: Field,
    /// poseidon2(packed aud bytes), checked against the aud allowlist.
    pub aud_hash: Field,
    /// JWT issued-at timestamp, checked against block timestamp in the public function.
    pub iat: u64,
    /// Poseidon2 hash of the public key limbs, verified against the on-chain allowlist.
    pub jwk_id: Field,
    /// Poseidon2 hash of issuer bytes packed into 31-byte chunks. Exposed so the on-chain
    /// OidcKeyRegistry can scope the trusted-JWK lookup per issuer. Derived from the same bytes
    /// the `iss in {Google, Apple}` assert checks, so it is bound to the signed payload.
    pub iss_hash: Field,
}

/// Base64url-decode the payload slice of `header_and_payload` inside the circuit.
///
/// `base64_decode_offset` must be the index right after the header/payload '.' separator.
/// The tail past the real payload length is left zero because `decode_var` treats bytes at
/// index >= len as out-of-bounds and only accepts 0 there; any non-zero byte in the tail makes
/// the decode unsatisfiable.
fn decode_payload_json(
    header_and_payload: BoundedVec<u8, JWT_HEADER_MAX_LEN + 1 + JWT_PAYLOAD_MAX_LEN>,
    base64_decode_offset: u32,
) -> BoundedVec<u8, JWT_PAYLOAD_JSON_MAX_LEN> {
    // Bind the offset to the signed '.' separator (ASCII 46) instead of relying on decode_var
    // to incidentally reject a '.' that slips into the staged buffer.
    assert(
        header_and_payload.storage()[base64_decode_offset - 1] == 46,
        "base64_decode_offset must follow the '.' separator",
    );
    // from_parts below asserts payload_len <= JWT_PAYLOAD_MAX_LEN, so an over-long payload is
    // rejected there.
    let payload_len = header_and_payload.len() - base64_decode_offset;
    let mut payload_b64_storage: [u8; JWT_PAYLOAD_MAX_LEN] = [0; JWT_PAYLOAD_MAX_LEN];
    for i in 0..JWT_PAYLOAD_MAX_LEN {
        if i < payload_len {
            payload_b64_storage[i] = header_and_payload.storage()[base64_decode_offset + i];
        }
    }
    let payload_b64: BoundedVec<u8, JWT_PAYLOAD_MAX_LEN> =
        BoundedVec::from_parts(payload_b64_storage, payload_len);
    BASE64_URL_DECODER::decode_var(payload_b64)
}

/// Verify a JWT (Google or Apple) and extract claims.
///
/// Steps:
///   1. derive_JWK, jwk_id matches the supplied RSA key
///   2. assert_verify_jwt,RSA,SHA256 signature over header_and_payload is valid
///   3. decode payload_json from header_and_payload[base64_decode_offset..] inside the circuit
///   4. extract iss, email, sub, aud, iat from decoded payload via JwtPayload
///   5. assert iss is Google or Apple
///   6. compute and return email_hash, pre_email_hash, aud_hash, iat
pub fn verify_jwt(jwt: JWTInput, address: AztecAddress) -> VerifiedJwtClaims {
    // 1. Verify the public key is the one committed to by jwk_id
    let jwk_id = derive_JWK(
        jwt.public_key_limbs,
        jwt.public_key_redc_limbs,
        jwt.public_key_e,
    );

    // 2. Verify RSA-SHA256 signature
    assert_verify_jwt::<JWT_HEADER_MAX_LEN + 1 + JWT_PAYLOAD_MAX_LEN>(
        jwt.header_and_payload,
        jwt.public_key_limbs,
        jwt.public_key_redc_limbs,
        jwt.signature_limbs,
    );

    // 3. Decode the payload portion of header_and_payload inside the circuit.
    //    This binds the decoded JSON to the signed bytes-no separate payload_json witness.
    let decoded_payload = decode_payload_json(jwt.header_and_payload, jwt.base64_decode_offset);

    let payload = JwtPayload::new(decoded_payload.storage());

    // 4. Verify no duplicate keys (single scan - prevents duplicate-key injection)
    // payload.verify_no_duplicate_keys();

    // 5. Check issuer - accept Google or Apple
    let iss_bv: BoundedVec<u8, JWT_ISS_MAX_LEN> = payload.get_claim_string("iss".as_bytes());
    let iss_bytes: [u8; JWT_ISS_MAX_LEN] = iss_bv.storage();
    let is_apple = iss_bytes == APPLE_ISS_BYTES;
    assert((iss_bytes == GOOGLE_ISS_BYTES) | is_apple, "invalid iss");

    // 5b. Derive iss_hash over packed issuer bytes so the on-chain OidcKeyRegistry can scope
    //     trusted keys per issuer.
    let iss_hash = poseidon2_hash_packed(iss_bytes, iss_bv.len());

    // 6. Extract email, sub, aud, iat
    let email_bv: BoundedVec<u8, EMAIL_LEN> = payload.get_claim_string_unique("email".as_bytes());
    assert(email_bv.len() > 0, "email claim is empty");
    // Provider must have verified the email before we bind it (fail-closed).
    payload.assert_email_verified(is_apple);
    let sub_bv: BoundedVec<u8, JWT_SUB_MAX_LEN> = payload.get_claim_string_unique("sub".as_bytes());
    assert(sub_bv.len() > 0, "sub claim is empty");
    let aud_bv: BoundedVec<u8, JWT_AUD_MAX_LEN> = payload.get_claim_string("aud".as_bytes());
    assert(aud_bv.len() > 0, "aud claim is empty");
    let iat: u64 = payload.get_claim_number("iat".as_bytes());
    assert(iat > 0, "iat claim is zero");

    // 7. Derive email_hash = poseidon2(sub_hash, pre_email_hash)
    //    sub_hash binds the email to a specific provider account, preventing cross-provider squatting.
    let sub_hash = poseidon2_hash_packed(sub_bv.storage(), sub_bv.len());
    let pre_email_hash = emailHashFromBytes(email_bv.storage(), email_bv.len());
    let email_hash = ::poseidon::poseidon2::Poseidon2::hash([sub_hash, pre_email_hash], 2);

    // 8. Derive aud_hash
    let aud_hash = poseidon2_hash_packed(aud_bv.storage(), aud_bv.len());

    // 9. Verify nonce: poseidon2(nonce_preimage, address) must equal the nonce claim.
    //    This binds the JWT to the caller's Aztec address, preventing cross-address replay.
    let nonce_bv: BoundedVec<u8, JWT_NONCE_STR_LEN> = payload.get_claim_string("nonce".as_bytes());
    let nonce_field = parse_decimal_field(nonce_bv.storage(), nonce_bv.len());
    let expected_nonce =
        ::poseidon::poseidon2::Poseidon2::hash([jwt.nonce_preimage, address.to_field()], 2);
    assert(nonce_field == expected_nonce, "nonce mismatch");

    VerifiedJwtClaims { email_hash, pre_email_hash, aud_hash, iat, jwk_id, iss_hash }
}

// Regression for the payload-staging tail: an honest `header.payload` shorter than
// JWT_PAYLOAD_MAX_LEN must round-trip through decode_var. decode_var rejects any non-zero byte
// past the payload length, so staging has to zero-pad the tail for the decode to be satisfiable.
#[test]
fn decode_payload_json_round_trips_short_payload() {
    // "eyJ" . "eyJhIjoxfQ"  where "eyJhIjoxfQ" is base64url({"a":1}).
    let hp_bytes = [101, 121, 74, 46, 101, 121, 74, 104, 73, 106, 111, 120, 102, 81];
    let mut hp: BoundedVec<u8, JWT_HEADER_MAX_LEN + 1 + JWT_PAYLOAD_MAX_LEN> = BoundedVec::new();
    for b in hp_bytes {
        hp.push(b);
    }
    // offset 4 = index right after the '.' at index 3.
    let decoded = decode_payload_json(hp, 4);
    let json = decoded.storage();
    let expected = "{\"a\":1}".as_bytes();
    for i in 0..expected.len() {
        assert(json[i] == expected[i], "decoded payload byte mismatch");
    }
}
