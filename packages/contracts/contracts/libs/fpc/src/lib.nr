mod tests;

use aztec::{
    context::PrivateContext,
    protocol::{address::AztecAddress, hash::poseidon2_hash_with_separator, traits::ToField},
};
use std::embedded_curve_ops::{EmbeddedCurvePoint, EmbeddedCurveScalar};

pub global MAX_AUTHORIZATION_TTL_SECONDS: u64 = 3600;

/// (s, e) scalar pair from the [s.lo, s.hi, e.lo, e.hi] limb encoding of the TS
/// `SchnorrSignature.toLimbFields()`.
fn schnorr_sig_from_limbs(limbs: [Field; 4]) -> (EmbeddedCurveScalar, EmbeddedCurveScalar) {
    (
        EmbeddedCurveScalar::new(limbs[0], limbs[1]),
        EmbeddedCurveScalar::new(limbs[2], limbs[3]),
    )
}

/// The anchor timestamp this tx was proven against, with the tx's include-by deadline pulled in
/// to one TTL past it. A prover may anchor up to MAX_TX_LIFETIME behind inclusion, so any chain
/// time an entrypoint stores or compares must come from here: it then trails inclusion by at most
/// one TTL.
pub fn bounded_anchor_timestamp(context: &mut PrivateContext) -> u64 {
    let anchor_ts = context.get_anchor_block_header().timestamp();
    context.set_expiration_timestamp(anchor_ts + MAX_AUTHORIZATION_TTL_SECONDS);
    anchor_ts
}

pub fn assert_fresh_quote(context: &mut PrivateContext, valid_until: u64) {
    let anchor_ts = context.get_anchor_block_header().timestamp();
    assert(anchor_ts < valid_until, "quote expired");

    let quote_ttl = valid_until - anchor_ts;
    assert(quote_ttl <= MAX_AUTHORIZATION_TTL_SECONDS, "quote ttl too large");

    context.set_expiration_timestamp(valid_until);
}

/// Compute the quote hash and verify the operator's Schnorr signature
/// inline. Pushes a nullifier to prevent replay.
///
/// Quote preimage (hashed with poseidon2_hash_with_separator):
///   poseidon2([fpc_address, accepted_asset, fj_fee_amount, aa_payment_amount,
///              valid_until, user_address], domain_sep)
pub fn assert_valid_quote(
    context: &mut PrivateContext,
    operator_pubkey: EmbeddedCurvePoint,
    accepted_asset: AztecAddress,
    fj_fee_amount: u128,
    aa_payment_amount: u128,
    valid_until: u64,
    user_address: AztecAddress,
    quote_sig: [Field; 4],
    domain_sep: u32,
) {
    assert_fresh_quote(context, valid_until);

    let quote_hash = poseidon2_hash_with_separator(
        [
            context.this_address().to_field(),
            accepted_asset.to_field(),
            fj_fee_amount as Field,
            aa_payment_amount as Field,
            valid_until as Field,
            user_address.to_field(),
        ],
        domain_sep,
    );

    schnorr::assert_valid_signature(operator_pubkey, schnorr_sig_from_limbs(quote_sig), quote_hash);

    context.push_nullifier_unsafe(quote_hash);
}
