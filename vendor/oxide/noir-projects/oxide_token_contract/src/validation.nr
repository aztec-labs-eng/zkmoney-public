use super::{
    asserted_note::AssertedNote,
    da::{
        extract_metadata_da_component, extract_tee_notes_da_component, extract_tee_required_nullifiers_da_component,
        extract_tee_withdrawal_message_hashes_da_component, TEEMetadata,
    },
    k1_verify::Signature,
};
use aztec::{
    context::UtilityContext,
    note::note_interface::NoteHash,
    protocol::{
        address::AztecAddress,
        blob_data::TxEffect,
        constants::{MAX_L2_TO_L1_MSGS_PER_TX, MAX_NOTE_HASHES_PER_TX, MAX_NULLIFIERS_PER_TX},
        hash::{compute_note_hash_nonce, compute_siloed_note_hash, compute_unique_note_hash, poseidon2_hash},
        traits::{Deserialize, Serialize},
    },
    state_vars::{Map, PublicMutable, StateVariable},
};

use oxide_lib::constants::{APPROVED_SIGNERS_STORAGE_SLOT, TEE_SIG_DOMAIN_NOTE};

#[derive(Deserialize, Eq, Serialize)]
struct TeeSignedData {
    domain: u8,
    anchor_block_hash: Field,
    token_address: AztecAddress,
    signed_commitment: Field,
    required_nullifiers: BoundedVec<Field, MAX_NULLIFIERS_PER_TX>,
    tee_notes: BoundedVec<Field, MAX_NOTE_HASHES_PER_TX>,
    withdrawal_message_hashes: BoundedVec<Field, MAX_L2_TO_L1_MSGS_PER_TX>,
}

struct DAComponents {
    tee_notes: BoundedVec<Field, MAX_NOTE_HASHES_PER_TX>,
    required_nullifiers: BoundedVec<Field, MAX_NULLIFIERS_PER_TX>,
    withdrawal_message_hashes: BoundedVec<Field, MAX_L2_TO_L1_MSGS_PER_TX>,
    metadata: TEEMetadata,
}

impl DAComponents {
    unconstrained fn from_effect(effect: TxEffect, contract_address: AztecAddress) -> Option<DAComponents> {
        let tee_notes = extract_tee_notes_da_component(effect, contract_address);
        let metadata = extract_metadata_da_component(effect, contract_address);
        let required_nullifiers = extract_tee_required_nullifiers_da_component(effect, contract_address);
        let withdrawal_message_hashes = extract_tee_withdrawal_message_hashes_da_component(effect, contract_address);

        if tee_notes.is_none()
            | metadata.is_none()
            | required_nullifiers.is_none()
            | withdrawal_message_hashes.is_none() {
            Option::none()
        } else {
            Option::some(
                DAComponents {
                    tee_notes: tee_notes.unwrap_unchecked(),
                    metadata: metadata.unwrap_unchecked(),
                    required_nullifiers: required_nullifiers.unwrap_unchecked(),
                    withdrawal_message_hashes: withdrawal_message_hashes.unwrap_unchecked(),
                },
            )
        }
    }
}

fn validate_signature(
    signature: Signature,
    domain: u8,
    contract_address: AztecAddress,
    signed_commitment: Field,
    da_components: DAComponents,
) -> bool {
    let signed_data = TeeSignedData {
        domain,
        anchor_block_hash: da_components.metadata.anchor_block_hash,
        token_address: contract_address,
        signed_commitment,
        required_nullifiers: da_components.required_nullifiers,
        tee_notes: da_components.tee_notes,
        withdrawal_message_hashes: da_components.withdrawal_message_hashes,
    };

    aztec::protocol::logging::debug_log("Validating signature");

    aztec::protocol::logging::debug_log_format(
        "Public key x: {0}, {1}",
        [da_components.metadata.pub_key_x_hi, da_components.metadata.pub_key_x_lo],
    );
    aztec::protocol::logging::debug_log_format(
        "Public key y: {0}, {1}",
        [da_components.metadata.pub_key_y_hi, da_components.metadata.pub_key_y_lo],
    );
    aztec::protocol::logging::debug_log_format("Signature: {}", signature.serialize());
    aztec::protocol::logging::debug_log_format("Signed data: {}", signed_data.serialize());

    // Poseidon2-hash the serialized TeeSignedData and verify the ECDSA-secp256k1 signature over
    // the resulting field with the registered public key.
    let msg_hash = poseidon2_hash(signed_data.serialize());
    crate::k1_verify::safe_verify_signature(
        [da_components.metadata.pub_key_x_hi as u128, da_components.metadata.pub_key_x_lo as u128],
        [da_components.metadata.pub_key_y_hi as u128, da_components.metadata.pub_key_y_lo as u128],
        signature,
        msg_hash,
    )
}

fn fetch_unique_note_hash(siloed_note_hash: Field, effect: TxEffect) -> Option<Field> {
    let first_nullifier_in_tx = effect.nullifiers[0];
    let mut matching_count = 0;
    let mut unique_note_hash = 0;

    for i in 0..MAX_NOTE_HASHES_PER_TX {
        let nonce_for_i = compute_note_hash_nonce(first_nullifier_in_tx, i);
        let unique_note_hash_for_i = compute_unique_note_hash(nonce_for_i, siloed_note_hash);
        if effect.note_hashes[i] == unique_note_hash_for_i {
            matching_count += 1;
            unique_note_hash = unique_note_hash_for_i;
        }
    }
    // The siloed note hash must be used exactly once in the transaction.
    if matching_count == 1 {
        Option::some(unique_note_hash)
    } else {
        Option::none()
    }
}

fn validate_siloed_vs_unique_note_hash(siloed_note_hash: Field, effect: TxEffect) -> bool {
    let first_nullifier_in_tx = effect.nullifiers[0];
    let mut matching_count = 0;
    for i in 0..MAX_NOTE_HASHES_PER_TX {
        let nonce_for_i = compute_note_hash_nonce(first_nullifier_in_tx, i);
        let unique_note_hash_for_i = compute_unique_note_hash(nonce_for_i, siloed_note_hash);
        if effect.note_hashes[i] == unique_note_hash_for_i {
            matching_count += 1;
        }
    }
    // The siloed note hash must be used exactly once in the transaction.
    matching_count == 1
}

fn validate_required_nullifiers(
    required_nullifiers: BoundedVec<Field, MAX_NULLIFIERS_PER_TX>,
    effect: TxEffect,
) -> bool {
    let mut valid = true;
    for i in 0..required_nullifiers.len() {
        let required_nullifier = required_nullifiers.get_unchecked(i);
        valid = valid & (count_appearances_in_array(effect.nullifiers, required_nullifier) >= 1);
    }
    valid
}

fn validate_siloed_note_hash_in_tee_notes<let N: u32>(
    siloed_note_hash: Field,
    tee_notes: BoundedVec<Field, N>,
) -> bool {
    count_appearances_in_bounded_vec(tee_notes, siloed_note_hash) == 1
}

// Mirrors validateWithdrawalMessageHashesInL2ToL1Msgs in yarn-project/tee-enclave/src/signer.ts.
// We do the whole TEE dance because we can't fully trust the outbox - it inherits trust from
// circuits that may be buggy. So independently verify that every withdrawal the TEE attested in the
// creation preimage actually shows up as an L2->L1 message in the creation tx's effects.
// At least once, not exactly once: the check exists to catch an attested message the tx never emitted. A repeated
// message settles as a single withdrawal, so it says nothing about the notes, and the enclave accepts it.
fn validate_withdrawal_message_hashes_in_l2_to_l1_msgs<let N: u32>(
    withdrawal_message_hashes: BoundedVec<Field, N>,
    effect: TxEffect,
) -> bool {
    let mut valid = true;
    for i in 0..withdrawal_message_hashes.len() {
        let withdrawal_message_hash = withdrawal_message_hashes.get_unchecked(i);
        valid = valid & (count_appearances_in_array(effect.l2_to_l1_msgs, withdrawal_message_hash) >= 1);
    }
    valid
}

unconstrained fn validate_signer_registration(metadata: TEEMetadata) -> bool {
    let util_ctx = UtilityContext::new();
    let approved_signers: Map<Field, PublicMutable<bool, UtilityContext>, UtilityContext> =
        Map::new(util_ctx, APPROVED_SIGNERS_STORAGE_SLOT);
    let signer_key = poseidon2_hash([
        metadata.pub_key_x_hi,
        metadata.pub_key_x_lo,
        metadata.pub_key_y_hi,
        metadata.pub_key_y_lo,
    ]);
    approved_signers.at(signer_key).read()
}

// Returns the unique note hash and the TEE-signed anchor block hash if valid. The anchor's chain presence is NOT
// checked here; the caller batches that check (see delivery.nr).
pub unconstrained fn validate_note(
    note: AssertedNote,
    contract_address: AztecAddress,
    storage_slot: Field,
    owner: AztecAddress,
    maybe_effect: Option<TxEffect>,
) -> Option<(Field, Field)> {
    let inner_note_hash = note.compute_note_hash(owner, storage_slot, note.randomness);
    let siloed_note_hash = compute_siloed_note_hash(contract_address, inner_note_hash);

    if maybe_effect.is_none() {
        Option::none()
    } else {
        let effect = maybe_effect.unwrap();
        aztec::protocol::logging::debug_log_format(
            "Fetched tx effect for {0}: revert_code={1}, fee={2}, first_nullifier={3}, randomness={4}",
            [
                effect.tx_hash,
                effect.revert_code as Field,
                effect.transaction_fee,
                effect.nullifiers[0],
                note.randomness,
            ],
        );

        let da_components = DAComponents::from_effect(effect, contract_address);

        // ugly indentation because we don't have early returns ):
        if da_components.is_none() {
            Option::none()
        } else {
            let da_components = da_components.unwrap_unchecked();

            // Validate everything but the signature
            let valid_conditions = validate_siloed_vs_unique_note_hash(siloed_note_hash, effect)
                & validate_required_nullifiers(da_components.required_nullifiers, effect)
                & validate_siloed_note_hash_in_tee_notes(siloed_note_hash, da_components.tee_notes)
                & validate_withdrawal_message_hashes_in_l2_to_l1_msgs(da_components.withdrawal_message_hashes, effect)
                & validate_signer_registration(da_components.metadata);

            if valid_conditions {
                // Now validate the signature. We do this last because the signature verification can panic if the public key is
                // not on the curve. However we have validated before that the public key has been registered, so validated on l1
                // to be on the curve.
                if validate_signature(
                    note.signature,
                    TEE_SIG_DOMAIN_NOTE,
                    contract_address,
                    siloed_note_hash,
                    da_components,
                ) {
                    fetch_unique_note_hash(siloed_note_hash, effect).map(|unique_note_hash| {
                        (unique_note_hash, da_components.metadata.anchor_block_hash)
                    })
                } else {
                    Option::none()
                }
            } else {
                Option::none()
            }
        }
    }
}

fn count_appearances_in_array<T: Eq, let N: u32>(array: [T; N], value: T) -> u32 {
    let mut count = 0;
    for i in 0..N {
        if array[i] == value {
            count += 1;
        }
    }
    count
}

fn count_appearances_in_bounded_vec<T: Eq, let N: u32>(vec: BoundedVec<T, N>, value: T) -> u32 {
    let mut count = 0;
    for i in 0..vec.len() {
        if vec.get_unchecked(i) == value {
            count += 1;
        }
    }
    count
}

// These tests are mirrored in yarn-project/tee-enclave/src/signer.test.ts: every case here has a same-named test there
// with equivalent behavior. This helps ensure the enclave and the client perform equivalent validation checks.
mod test {
    use super::{
        validate_required_nullifiers, validate_siloed_note_hash_in_tee_notes,
        validate_withdrawal_message_hashes_in_l2_to_l1_msgs,
    };
    use aztec::protocol::{
        blob_data::TxEffect,
        constants::{MAX_L2_TO_L1_MSGS_PER_TX, MAX_NOTE_HASHES_PER_TX, MAX_NULLIFIERS_PER_TX},
        traits::Empty,
    };

    global H1: Field = 0x1111;
    global H2: Field = 0x2222;
    global H3: Field = 0x3333;

    unconstrained fn effect_with_l2_to_l1_msgs<let L: u32>(msgs: [Field; L]) -> TxEffect {
        let mut effect = TxEffect::empty();
        for i in 0..L {
            effect.l2_to_l1_msgs[i] = msgs[i];
        }
        effect
    }

    #[test]
    unconstrained fn accepts_attested_withdrawal_messages_present_in_the_tx() {
        let attested: BoundedVec<Field, MAX_L2_TO_L1_MSGS_PER_TX> = BoundedVec::from_array([H1, H2]);
        assert(validate_withdrawal_message_hashes_in_l2_to_l1_msgs(attested, effect_with_l2_to_l1_msgs([H2, H1])));
    }

    #[test]
    unconstrained fn rejects_an_attested_withdrawal_message_absent_from_the_tx() {
        let attested: BoundedVec<Field, MAX_L2_TO_L1_MSGS_PER_TX> = BoundedVec::from_array([H1, H2]);
        assert(!validate_withdrawal_message_hashes_in_l2_to_l1_msgs(attested, effect_with_l2_to_l1_msgs([H1])));
    }

    #[test]
    unconstrained fn accepts_a_repeated_withdrawal_message() {
        let attested: BoundedVec<Field, MAX_L2_TO_L1_MSGS_PER_TX> = BoundedVec::from_array([H1]);
        assert(validate_withdrawal_message_hashes_in_l2_to_l1_msgs(attested, effect_with_l2_to_l1_msgs([H1, H1])));
    }

    #[test]
    unconstrained fn accepts_an_empty_attested_withdrawal_list() {
        let attested: BoundedVec<Field, MAX_L2_TO_L1_MSGS_PER_TX> = BoundedVec::new();
        assert(validate_withdrawal_message_hashes_in_l2_to_l1_msgs(attested, effect_with_l2_to_l1_msgs([H1, H1])));
    }

    #[test]
    unconstrained fn rejects_a_required_nullifier_absent_from_the_tx() {
        let required: BoundedVec<Field, MAX_NULLIFIERS_PER_TX> = BoundedVec::from_array([H1, H2]);
        let mut effect = TxEffect::empty();
        effect.nullifiers[0] = H1;
        assert(!validate_required_nullifiers(required, effect));
        effect.nullifiers[1] = H2;
        assert(validate_required_nullifiers(required, effect));
    }

    #[test]
    unconstrained fn counts_a_note_only_within_the_emitted_tee_notes() {
        let mut storage = [0; MAX_NOTE_HASHES_PER_TX];
        storage[0] = H1;
        storage[1] = H3;
        storage[2] = H2;
        // H2 sits past the emitted length, so it is padding and not a tee note.
        let tee_notes: BoundedVec<Field, MAX_NOTE_HASHES_PER_TX> = BoundedVec::from_parts(storage, 2);
        assert(validate_siloed_note_hash_in_tee_notes(H1, tee_notes));
        assert(!validate_siloed_note_hash_in_tee_notes(H2, tee_notes));
        assert(!validate_siloed_note_hash_in_tee_notes(0, tee_notes));
    }
}
