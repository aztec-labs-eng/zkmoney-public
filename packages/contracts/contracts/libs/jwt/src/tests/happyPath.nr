use aztec::protocol::address::AztecAddress;
use crate::{verifyJwt::{VerifiedJwtClaims, verify_jwt}};
use aztec::protocol::traits::FromField;
use crate::tests::utils::setup_jwt_input;
use crate::verifyJwt::JWTInput;



#[test]
fn test_verify_jwt_with_jwt_input() {
    let sender = AztecAddress::from_field(0x08cad1e03676948f661bc00df74eadac619fc961aa8bf9ee7ca9e9b64291485c);
    let jwt_input = setup_jwt_input();

    let claims : VerifiedJwtClaims = verify_jwt(jwt_input, sender);
    let jwk_id : Field = claims.jwk_id;
    let pre_email_hash : Field = claims.pre_email_hash;
    let aud_hash : Field = claims.aud_hash;
    let iss_hash : Field = claims.iss_hash;

    // These assertions would be done in the smart contract
    assert(jwk_id == 0x09da8db7854d9e52609f9bc5406ec19e54c68adbe15f553e7b2af1d606d27453);
    assert(aud_hash == 0x26144bb490f0c09b602239f94cd334aa9b8c8d525f45914637bb8c092d3178cc);
    assert(pre_email_hash == 0x2aa92d09f5b00c647ba5c0c49e9c275c310067d9ba3c31ec0f01ddcf1d5c3e74);
    assert(iss_hash == 0x14235fd1a6b73c4bdbc8bc5283cc03e2961bd924945f79daf90f307b2f345637)
}


// change the sender
#[test(should_fail)]
fn change_the_sender() {
    let sender = AztecAddress::from_field(0x18cad1e03676948f661bc00df74eadac619fc961aa8bf9ee7ca9e9b64291485c);
    let jwt_input = setup_jwt_input();
    let claims : VerifiedJwtClaims = verify_jwt(jwt_input, sender);
}

// change the nonce_preimages
#[test(should_fail)]
fn change_the_nonce_preimage() {
    let sender = AztecAddress::from_field(0x08cad1e03676948f661bc00df74eadac619fc961aa8bf9ee7ca9e9b64291485c);
    let nonce_preimage = 14476477470897909914953353222147217146511303107948618543424541588625598612898;

    let jwt_input_pre = setup_jwt_input();

    let jwt_input = JWTInput {
        header_and_payload: jwt_input_pre.header_and_payload,
        base64_decode_offset: jwt_input_pre.base64_decode_offset,
        signature_limbs: jwt_input_pre.signature_limbs,
        public_key_e: jwt_input_pre.public_key_e,
        public_key_limbs: jwt_input_pre.public_key_limbs,
        public_key_redc_limbs: jwt_input_pre.public_key_redc_limbs,
        nonce_preimage: nonce_preimage,
    };
    let claims : VerifiedJwtClaims = verify_jwt(jwt_input, sender);
}

// change the public_key_e
#[test(should_fail)]
fn change_the_public_key_e() {
    let sender = AztecAddress::from_field(0x08cad1e03676948f661bc00df74eadac619fc961aa8bf9ee7ca9e9b64291485c);
    let public_key_e = 1;
    let jwt_input_pre = setup_jwt_input();
    let jwt_input = JWTInput {
        header_and_payload: jwt_input_pre.header_and_payload,
        base64_decode_offset: jwt_input_pre.base64_decode_offset,
        signature_limbs: jwt_input_pre.signature_limbs,
        public_key_e: public_key_e,
        public_key_limbs: jwt_input_pre.public_key_limbs,
        public_key_redc_limbs: jwt_input_pre.public_key_redc_limbs,
        nonce_preimage: jwt_input_pre.nonce_preimage,
    };
    let claims : VerifiedJwtClaims = verify_jwt(jwt_input, sender);

    // this will fail later in all implementations as they should check the jwd_id against the allowlist
    assert(claims.jwk_id == 0x09da8db7854d9e52609f9bc5406ec19e54c68adbe15f553e7b2af1d606d27453);
}
