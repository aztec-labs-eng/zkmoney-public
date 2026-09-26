use super::{effects::emit_withdrawal_effect, k1_verify::Signature, strict_mode::is_strict_mode};
use aztec::{
    context::PrivateContext,
    oracle::capsules,
    protocol::{
        address::{AztecAddress, EthAddress},
        hash::{poseidon2_hash, sha256_to_field},
        traits::{Serialize, ToField},
    },
};

use oxide_lib::constants::WITHDRAWAL_PUBLISHING_TAG;

pub fn publish_withdrawal(
    context: &mut PrivateContext,
    content_hash: Field,
    executor: EthAddress,
    user_payload_hash: Field,
    amount: u128,
    prover_tip: u128,
    randomness: Field,
) {
    // Safety: Signature is not enforced by the protocol.
    let signature = unsafe { load_withdrawal_signature(context.this_address(), content_hash) };

    // Safety: Offchain effects are by definition unconstrained.
    unsafe { emit_withdrawal_effect(executor, user_payload_hash, amount, prover_tip, randomness) };

    // Safety: These values are unverified. Read "TEMPORARY" at the bottom of this file.
    let plain_executor_user_payload = unsafe { load_plain_executor_user_payload(context.this_address(), content_hash) };

    // Send an unencrypted private log, so a relayer or a user can recover the exact preimage the L1 portal will need.
    let mut serialized = BoundedVec::new();
    serialized.push(executor.to_field());
    serialized.push(user_payload_hash);
    serialized.push(amount.to_field());
    serialized.push(prover_tip.to_field());
    serialized.push(randomness);
    serialized.extend_from_array(plain_executor_user_payload);
    serialized.extend_from_array(signature.serialize());

    context.emit_private_log_unsafe(WITHDRAWAL_PUBLISHING_TAG, serialized);
}

global OXIDE_TOKEN_WITHDRAWAL_SIGNATURE_CAPSULE_SLOT: Field =
    sha256_to_field("OXIDE_TOKEN::WITHDRAWAL_SIGNATURE".as_bytes());

unconstrained fn load_withdrawal_signature(contract_address: AztecAddress, content_hash: Field) -> Signature {
    let signature_capsule_slot = poseidon2_hash(
        [OXIDE_TOKEN_WITHDRAWAL_SIGNATURE_CAPSULE_SLOT, content_hash],
    );

    let signature: Option<Signature> = capsules::load::<Signature>(
        contract_address,
        signature_capsule_slot,
        AztecAddress::zero(),
    );

    let strict_mode = is_strict_mode(contract_address);

    // Fail if signature not found in strict mode
    if strict_mode {
        signature.unwrap()
    } else {
        signature.unwrap_or(std::mem::zeroed())
    }
}

// ---------------------------------------------------------------------------------------------
// TEMPORARY: plain-executor user payload recovery data availability.
//
// https://linear.app/aztec-labs/issue/OX-1700/solve-user-payload-data-availability
//
//

global OXIDE_TOKEN_PLAIN_EXECUTOR_USER_PAYLOAD_CAPSULE_SLOT: Field =
    sha256_to_field("OXIDE_TOKEN::PLAIN_EXECUTOR_USER_PAYLOAD".as_bytes());

unconstrained fn load_plain_executor_user_payload(contract_address: AztecAddress, content_hash: Field) -> [Field; 2] {
    let plain_executor_user_payload_capsule_slot = poseidon2_hash([
        OXIDE_TOKEN_PLAIN_EXECUTOR_USER_PAYLOAD_CAPSULE_SLOT,
        content_hash,
    ]);

    let plain_executor_user_payload: Option<[Field; 2]> = capsules::load::<[Field; 2]>(
        contract_address,
        plain_executor_user_payload_capsule_slot,
        AztecAddress::zero(),
    );

    plain_executor_user_payload.unwrap_or([0, 0])
}

// ---------------------------------------------------------------------------------------------
