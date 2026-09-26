use aztec::protocol::address::AztecAddress;
use aztec::protocol::traits::FromField;
use jwt::verifyJwt::{JWTInput, verify_jwt};

// `caller` is bound to the JWT internally by the nonce check inside
// verify_jwt, and re-exposed as the first public output so the on-chain
// verifier can assert `msg_sender() == caller`.
//
// Public-output layout (must match the on-chain verify_proof_with_type call):
//   [caller, email_hash, pre_email_hash, aud_hash, iat_as_field, jwk_id, iss_hash]
// `iss_hash` (index 6) is appended so the on-chain OidcKeyRegistry can scope the
// trusted-JWK lookup per issuer. Existing positional reads [0..5] are unchanged.
fn main(jwt: JWTInput, caller: Field) -> pub (Field, Field, Field, Field, Field, Field, Field) {
    let claims = verify_jwt(jwt, AztecAddress::from_field(caller));
    (
        caller, claims.email_hash, claims.pre_email_hash, claims.aud_hash, claims.iat as Field,
        claims.jwk_id, claims.iss_hash,
    )
}
