use aztec::protocol::address::AztecAddress;
use crate::{verifyJwt::{VerifiedJwtClaims, verify_jwt}};
use crate::tests::utils::{setup_jwt_input, setup_jwt_with_custom_offset};
use aztec::protocol::traits::FromField;

/// Base64 offset manipulation tests
/// These tests verify that the verify_jwt function properly validates the base64_decode_offset
/// parameter, which is client-supplied and therefore untrusted.
///
/// Attack vector: A malicious client could provide a valid signed JWT but manipulate the
/// base64_decode_offset to decode the wrong portion of the JWT, potentially:
/// 1. Decoding the header as the payload
/// 2. Decoding signature bytes as JSON
/// 3. Causing integer underflow (offset > length)
/// 4. Triggering modulo wraparound to read unintended data

// Valid sender address for all tests
global VALID_SENDER: Field = 0x08cad1e03676948f661bc00df74eadac619fc961aa8bf9ee7ca9e9b64291485c;

/// Test: offset = 0 (decode entire header+payload as payload)
/// Expected: Should fail during base64 decoding or JSON parsing
/// Fails decoded != INVALID_DECODE_VALUE
#[test(should_fail)]
fn offset_zero_decodes_header_as_payload() {
    let sender = AztecAddress::from_field(VALID_SENDER);
    let jwt_input = setup_jwt_with_custom_offset(0);
    let _claims: VerifiedJwtClaims = verify_jwt(jwt_input, sender);
}

/// Test: offset = header_and_payload.len() (exactly at boundary)
/// Expected: Should fail because payload length becomes 0 (line 89: len - offset = 0)
#[test(should_fail_with = "utils::search could not find needle in haystack")]
fn offset_at_exact_length_boundary() {
    let sender = AztecAddress::from_field(VALID_SENDER);
    let valid_jwt = setup_jwt_input();
    let length = valid_jwt.header_and_payload.len();
    let jwt_input = setup_jwt_with_custom_offset(length);
    let _claims: VerifiedJwtClaims = verify_jwt(jwt_input, sender);
    assert(false, "utils::search could not find needle in haystack");
}

/// Test: offset = length + 1 (one past the end)
/// Expected: Should fail due to integer underflow in u32 subtraction
/// Line 89 in verifyJwt.nr: jwt.header_and_payload.len() - jwt.base64_decode_offset
/// Assertion failed: attempt to subtract with overflow
#[test(should_fail)]
fn offset_one_past_end_underflow() {
    let sender = AztecAddress::from_field(VALID_SENDER);
    let valid_jwt = setup_jwt_input();
    let length = valid_jwt.header_and_payload.len();
    let jwt_input = setup_jwt_with_custom_offset(length + 1);
    let _claims: VerifiedJwtClaims = verify_jwt(jwt_input, sender);
}

/// Test: offset = length + 100 (far past the end)
/// Expected: Should fail due to underflow creating huge BoundedVec length
/// Assertion failed: attempt to subtract with overflow
#[test(should_fail)]
fn offset_far_past_end_underflow() {
    let sender = AztecAddress::from_field(VALID_SENDER);
    let valid_jwt = setup_jwt_input();
    let length = valid_jwt.header_and_payload.len();
    let jwt_input = setup_jwt_with_custom_offset(length + 100);
    let _claims: VerifiedJwtClaims = verify_jwt(jwt_input, sender);
}

/// Test: offset = 2^32 - 1 (max u32 value)
/// Expected: Should fail due to extreme wraparound in modulo operation
/// Line 85 in verifyJwt.nr: [(i + jwt.base64_decode_offset) % jwt.header_and_payload.len()]
/// Assertion failed: attempt to add with overflow
#[test(should_fail)]
fn offset_max_u32_extreme_wraparound() {
    let sender = AztecAddress::from_field(VALID_SENDER);
    let jwt_input = setup_jwt_with_custom_offset(4294967295); // 2^32 - 1
    let _claims: VerifiedJwtClaims = verify_jwt(jwt_input, sender);
}

/// Test: offset = correct - 10 (start 10 bytes before the actual payload)
/// Expected: Should fail because decoded data will be garbage (part header, part payload)
/// Assertion failed: DecodeError: invalid symbol 46, offset 9.
#[test(should_fail)]
fn offset_before_correct_position() {
    let sender = AztecAddress::from_field(VALID_SENDER);
    let valid_jwt = setup_jwt_input();
    let correct_offset = valid_jwt.base64_decode_offset;
    let jwt_input = setup_jwt_with_custom_offset(correct_offset - 10);
    let _claims: VerifiedJwtClaims = verify_jwt(jwt_input, sender);
}

/// Test: offset = correct + 10 (start 10 bytes after the dot separator)
/// Expected: Should fail because we skip the first 10 bytes of the payload
#[test(should_fail_with = "utils::search could not find needle in haystack")]
fn offset_after_correct_position() {
    let sender = AztecAddress::from_field(VALID_SENDER);
    let valid_jwt = setup_jwt_input();
    let correct_offset = valid_jwt.base64_decode_offset;
    let jwt_input = setup_jwt_with_custom_offset(correct_offset + 10);
    let _claims: VerifiedJwtClaims = verify_jwt(jwt_input, sender);
    assert(false, "utils::search could not find needle in haystack");
}

/// Test: offset = 1 (start from second byte, miss first character)
/// Expected: Should fail because header parsing will be off by one
// Assertion failed: DecodeError: invalid symbol 46, offset 9.
#[test(should_fail)]
fn offset_one_miss_first_byte() {
    let sender = AztecAddress::from_field(VALID_SENDER);
    let jwt_input = setup_jwt_with_custom_offset(1);
    let _claims: VerifiedJwtClaims = verify_jwt(jwt_input, sender);
}

/// Test: offset pointing to middle of header (approximate)
/// Expected: Should fail because we're decoding header data as payload
// Assertion failed: DecodeError: invalid symbol 46, offset 35.
#[test(should_fail)]
fn offset_in_middle_of_header() {
    let sender = AztecAddress::from_field(VALID_SENDER);
    // Assuming header is roughly first 70 bytes, use offset 35
    let jwt_input = setup_jwt_with_custom_offset(35);
    let _claims: VerifiedJwtClaims = verify_jwt(jwt_input, sender);
}

/// Test: Large offset that would cause wraparound
/// Expected: Should fail due to modulo wraparound reading wrong data
// Assertion failed: attempt to subtract with overflow
#[test(should_fail)]
fn offset_large_value_wraparound() {
    let sender = AztecAddress::from_field(VALID_SENDER);
    let valid_jwt = setup_jwt_input();
    let length = valid_jwt.header_and_payload.len();
    // Use an offset that's multiple times the length to test wraparound
    let jwt_input = setup_jwt_with_custom_offset(length * 3);
    let _claims: VerifiedJwtClaims = verify_jwt(jwt_input, sender);
}
