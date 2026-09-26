use aztec::{
    authwit::{auth::compute_authwit_message_hash, account::AccountFeePaymentMethodOptions},
    context::PrivateContext,
    protocol::{
        constants::{DOM_SEP__SIGNATURE_PAYLOAD, DOM_SEP__TX_NULLIFIER},
        hash::poseidon2_hash_with_separator,
        address::AztecAddress,
        traits::{FromField, Hash},
    },
};

use aztec::oracle::capsules;
use crate::payloads::AppPayload;

global CAPSULE_SLOT: Field = 1234;

global APP_PAYLOAD_HASH_INDEX: u32 = 0;
global COMBINED_PAYLOADS_AND_INTENTS_HASH_INPUT_LEN: u32 = 5;
pub global INTENT_HASHES_LEN: u32 = 4;

global DOM_SEP__INTENTS_HASH: Field = 1235;

pub fn set_as_fee_payer(context: &mut PrivateContext, fee_payment_method: u8) {

    if fee_payment_method == AccountFeePaymentMethodOptions.PREEXISTING_FEE_JUICE {
        context.set_as_fee_payer();
        context.end_setup();
    }

    if fee_payment_method == AccountFeePaymentMethodOptions.FEE_JUICE_WITH_CLAIM {
        context.set_as_fee_payer();
    }
}

/// Spends the payload's nonce, so a signed payload executes at most once: a second tx reusing it
/// emits the same nullifier and is rejected.
pub fn push_tx_nonce_nullifier(context: &mut PrivateContext, tx_nonce: Field) {
    context.push_nullifier_unsafe(poseidon2_hash_with_separator([tx_nonce], DOM_SEP__TX_NULLIFIER));
}

/// The outer hash the account's signature covers: the inner signature payload bound to this
/// account, chain id and rollup version, as upstream accounts sign it.
pub fn compute_signed_message_hash(context: &mut PrivateContext, inner_hash: Field) -> Field {
    compute_authwit_message_hash(
        context.this_address(),
        context.chain_id(),
        context.version(),
        inner_hash,
    )
}

pub fn compute_combined_payloads_and_intents_hash(
    app_payload: AppPayload,
    intent_hashes: [Field; INTENT_HASHES_LEN],
) -> Field {
    let mut hashes: [Field; COMBINED_PAYLOADS_AND_INTENTS_HASH_INPUT_LEN] = [0; COMBINED_PAYLOADS_AND_INTENTS_HASH_INPUT_LEN];
    hashes[APP_PAYLOAD_HASH_INDEX] = app_payload.hash();
    for i in APP_PAYLOAD_HASH_INDEX..INTENT_HASHES_LEN {
        hashes[1 + i] = intent_hashes[i];
    }
    poseidon2_hash_with_separator(hashes, DOM_SEP__SIGNATURE_PAYLOAD)
}

/// Signature payload for intents-only authorization (no app payload). Cannot collide with the
/// 5-element combined form above: poseidon2 domain-separates by input length.
pub fn compute_intents_only_signature_hash(intent_hashes: [Field; INTENT_HASHES_LEN]) -> Field {
    poseidon2_hash_with_separator(intent_hashes, DOM_SEP__SIGNATURE_PAYLOAD)
}

pub fn compute_intents_hash(intent_hashes: [Field; INTENT_HASHES_LEN]) -> Field {
    let result = poseidon2_hash_with_separator(intent_hashes, DOM_SEP__INTENTS_HASH);
    result
}

pub fn compute_intents_hash_from_inner_hash(context: &mut PrivateContext, inner_hash: Field) -> Field {
    let intent_hash = compute_authwit_message_hash(
        context.maybe_msg_sender().unwrap(),
        context.chain_id(),
        context.version(),
        inner_hash,
    );

    let capsule: [Field; COMBINED_PAYLOADS_AND_INTENTS_HASH_INPUT_LEN] = unsafe {
        // Capsules from TS-side `new Capsule(addr, slot, data)` default to scope=ZERO
        // (see @aztec/stdlib Capsule ctor -- `scope` is the optional 4th arg).
        capsules::load(context.this_address(), CAPSULE_SLOT, AztecAddress::zero()).unwrap()
    };
    let capsuled_intent_hashes: [Field; INTENT_HASHES_LEN] = [capsule[1], capsule[2], capsule[3], capsule[4]];

    let mut intent_hash_exists = false;
    for i in 0..INTENT_HASHES_LEN {
        if capsuled_intent_hashes[i] == intent_hash {
            intent_hash_exists = true;
        }
    }
    assert(intent_hash_exists, "requested intent_hash not found in capsule");

    compute_intents_hash(capsuled_intent_hashes)
}

// =============================================
// TESTS
// =============================================

/// `compute_authwit_message_hash(0x1234, 31337, 1, 0xabc)`. The SDK pins the same value over
/// `computeOuterAuthWitHash`, so the two sides agree on argument order and separator.
global SIGNED_MESSAGE_VECTOR: Field = 0x2ca23d1f9e552b59f588bd5d060d0208869f813ca982298eadbc462930218933;

#[test]
fn test_signed_message_vector() {
    let account = AztecAddress::from_field(0x1234);
    let computed = compute_authwit_message_hash(account, 31337, 1, 0xabc);
    assert(computed == SIGNED_MESSAGE_VECTOR, "signed message vector drifted");
}

#[test]
fn test_signed_message_binds_account_chain_and_version() {
    let account = AztecAddress::from_field(0x1234);
    let base = compute_authwit_message_hash(account, 31337, 1, 0xabc);
    let other_account = compute_authwit_message_hash(AztecAddress::from_field(0x1235), 31337, 1, 0xabc);
    let other_chain = compute_authwit_message_hash(account, 31338, 1, 0xabc);
    let other_version = compute_authwit_message_hash(account, 31337, 2, 0xabc);
    assert(other_account != base, "account must change the signed message");
    assert(other_chain != base, "chain id must change the signed message");
    assert(other_version != base, "version must change the signed message");
}
