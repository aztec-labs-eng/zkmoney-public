use super::{
    asserted_note::{AssertedNote, note_creation_tx_hash_slot},
    effects::emit_insertion_effect,
    validation::validate_note,
};
use aztec::{
    context::{PrivateContext, UtilityContext},
    ephemeral::EphemeralArray,
    messages::{
        delivery::{do_private_message_delivery, MessageDelivery},
        discovery::{
            ComputeNoteHash, ComputeNoteNullifier, CustomMessageHandler, do_sync_state,
            private_notes::process_private_note_msg,
        },
        encoding::MAX_MESSAGE_CONTENT_LEN,
        logs::note::{encode_private_note_message_with_msg_type_id, MAX_NOTE_PACKED_LEN},
        msg_type::custom_msg_type_id,
        processing::{
            NoteValidationRequest, offchain::OffchainInboxSync, ResolvedTx,
            validate_and_store_enqueued_notes_and_events,
        },
    },
    note::{note_interface::{NoteHash, NoteType}, NoteMessage},
    oracle::{capsules, get_membership_witness::are_block_hashes_in_archive, message_processing::get_tx_effects},
    protocol::{address::AztecAddress, hash::sha256_to_field, traits::{Deserialize, Hash, Packable, Serialize}},
    utils::array::subarray,
};

global ASSERTED_NOTE_MSG_TYPE_ID: u64 = custom_msg_type_id(0);

/// Serialization mirror of aztec-nr's private `NoteValidationRequest` fields used by note discovery.
#[derive(Deserialize)]
struct DiscoveredNote {
    contract_address: AztecAddress,
    owner: AztecAddress,
    storage_slot: Field,
    randomness: Field,
    note_nonce: Field,
    max_note_packed_len: Field,
    packed_note: BoundedVec<Field, MAX_NOTE_PACKED_LEN>,
    note_hash: Field,
    nullifier: Field,
    tx_hash: Field,
}

pub fn deliver_note(context: &mut PrivateContext, message: NoteMessage<AssertedNote>) {
    let new_note = message.get_new_note();

    do_private_message_delivery(
        context,
        || encode_private_note_message_with_msg_type_id(
            ASSERTED_NOTE_MSG_TYPE_ID,
            new_note.note,
            new_note.owner,
            new_note.storage_slot,
            new_note.randomness,
        ),
        Option::some(new_note.note_hash_counter),
        new_note.owner,
        MessageDelivery::onchain_unconstrained(),
    );

    // Safety: Offchain effects are by definition unconstrained.
    unsafe {
        emit_insertion_effect(
            new_note.note.amount,
            new_note.owner,
            new_note.note.randomness,
            new_note.storage_slot,
        )
    };
}

unconstrained fn compute_asserted_note_hash(
    packed_note: BoundedVec<Field, MAX_NOTE_PACKED_LEN>,
    owner: AztecAddress,
    storage_slot: Field,
    note_type_id: Field,
    _contract_address: AztecAddress,
    randomness: Field,
) -> Option<Field> {
    if (note_type_id == AssertedNote::get_id()) & (packed_note.len() == <AssertedNote as Packable>::N) {
        let note = AssertedNote::unpack(subarray(packed_note.storage(), 0));
        Option::some(note.compute_note_hash(owner, storage_slot, randomness))
    } else {
        Option::none()
    }
}

unconstrained fn compute_asserted_note_nullifier(
    unique_note_hash: Field,
    packed_note: BoundedVec<Field, MAX_NOTE_PACKED_LEN>,
    owner: AztecAddress,
    _storage_slot: Field,
    note_type_id: Field,
    _contract_address: AztecAddress,
    _randomness: Field,
) -> Option<Field> {
    if (note_type_id == AssertedNote::get_id()) & (packed_note.len() == <AssertedNote as Packable>::N) {
        let note = AssertedNote::unpack(subarray(packed_note.storage(), 0));
        note.compute_nullifier_unconstrained(owner, unique_note_hash)
    } else {
        Option::none()
    }
}

global NOTE_VALIDATION_REQUESTS_ARRAY_BASE_SLOT: Field = sha256_to_field(
    "AZTEC_NR::NOTE_VALIDATION_REQUESTS_ARRAY_BASE_SLOT".as_bytes(),
);

/// Candidates parked by `note_handler` for the batched validation pass in `sync_state_batched`.
global PENDING_NOTE_VALIDATIONS_SLOT: Field = sha256_to_field("OXIDE_TOKEN::PENDING_NOTE_VALIDATIONS".as_bytes());

/// A candidate that passed every delivery-time check except anchor-ancestry, which is settled for
/// all candidates in one batched oracle call.
#[derive(Deserialize, Serialize)]
struct ValidatedNote {
    request: NoteValidationRequest,
    tx_hash: Field,
    unique_note_hash: Field,
    anchor_block_hash: Field,
}

pub unconstrained fn note_handler(
    contract_address: AztecAddress,
    msg_type_id: u64,
    msg_metadata: u64,
    msg_content: BoundedVec<Field, MAX_MESSAGE_CONTENT_LEN>,
    resolved_tx: ResolvedTx,
    _recipient: AztecAddress,
) {
    // Ignore unknown custom message kinds: a forged log must be skipped, not abort recipient sync.
    if msg_type_id == ASSERTED_NOTE_MSG_TYPE_ID {
        let discovered_notes: EphemeralArray<NoteValidationRequest> =
            EphemeralArray::at(NOTE_VALIDATION_REQUESTS_ARRAY_BASE_SLOT);
        let len_before = discovered_notes.len();

        process_private_note_msg(
            contract_address,
            resolved_tx.tx_hash,
            resolved_tx.unique_note_hashes_in_tx,
            resolved_tx.first_nullifier_in_tx,
            compute_asserted_note_hash,
            compute_asserted_note_nullifier,
            msg_metadata,
            msg_content,
        );

        let notes_discovered = discovered_notes.len() - len_before;
        aztec::protocol::logging::debug_log_format(
            "Found {0} notes after processing",
            [notes_discovered as Field],
        );
        if notes_discovered > 1 {
            // Delete all, we don't allow one log discovering multiple notes.
            for _ in 0..notes_discovered {
                let _deleted = discovered_notes.pop();
            }
        } else if notes_discovered == 1 {
            // Park the request; `sync_state_batched` validates all parked candidates at once.
            let note_validation_request = discovered_notes.pop();
            let pending: EphemeralArray<NoteValidationRequest> = EphemeralArray::at(PENDING_NOTE_VALIDATIONS_SLOT);
            pending.push(note_validation_request);
        }
    } else {
        aztec::protocol::logging::warn_log_format(
            "Ignoring message with unknown type id {0}",
            [msg_type_id as Field],
        );
    }
}

/// `sync_state` body: discovery parks candidates; batched tx-effect and anchor-ancestry checks validate them.
pub unconstrained fn sync_state_batched(
    contract_address: AztecAddress,
    _compute_note_hash: ComputeNoteHash,
    _compute_note_nullifier: ComputeNoteNullifier,
    process_custom_message: Option<CustomMessageHandler>,
    offchain_inbox_sync: Option<OffchainInboxSync>,
    scope: AztecAddress,
) {
    let pending: EphemeralArray<NoteValidationRequest> = EphemeralArray::empty_at(PENDING_NOTE_VALIDATIONS_SLOT);

    // We must make sure that all `AssertedNote`s we find have been validated by `note_handler`, which is the only route
    // that runs `validate_note`. Any note of this type found in any other message type (e.g. a regular
    // `PRIVATE_NOTE_MSG_TYPE_ID`) would result in _only_ checking note hash existence in the tree, which is
    // insufficient. We therefore pass `compute_note_hash` and `compute_note_nullifier` functions that reject all notes.
    //
    // `note_handler` uses its own hardcoded hash functions, so this doesn't affect it.
    do_sync_state(
        contract_address,
        |_packed_note, _owner, _storage_slot, _note_type_id, _contract_address, _randomness| Option::none(),
        |_unique_note_hash, _packed_note, _owner, _storage_slot, _note_type_id, _contract_address, _randomness| {
            Option::none()
        },
        process_custom_message,
        offchain_inbox_sync,
        scope,
    );
    let pending_count = pending.len();
    if pending_count != 0 {
        // Batched so the node round-trips stay constant per sync instead of per note.
        let effects = get_tx_effects(pending.map(|request: NoteValidationRequest| {
            DiscoveredNote::deserialize(request.serialize()).tx_hash
        }));

        let passers: EphemeralArray<ValidatedNote> = EphemeralArray::empty();
        for i in 0..pending_count {
            let request = pending.get(i);
            let discovered = DiscoveredNote::deserialize(request.serialize());
            let note = AssertedNote::unpack(subarray(discovered.packed_note.storage(), 0));
            let maybe_validated = validate_note(
                note,
                contract_address,
                discovered.storage_slot,
                discovered.owner,
                effects.get(i),
            );
            if maybe_validated.is_some() {
                let (unique_note_hash, anchor_block_hash) = maybe_validated.unwrap_unchecked();
                passers.push(
                    ValidatedNote { request, tx_hash: discovered.tx_hash, unique_note_hash, anchor_block_hash },
                );
            }
        }

        let passer_count = passers.len();
        if passer_count != 0 {
            let head_header = UtilityContext::new().block_header();
            let head_hash = head_header.hash();
            let in_archive = are_block_hashes_in_archive(
                head_header,
                passers.map(|passer: ValidatedNote| passer.anchor_block_hash),
            );
            let queue: EphemeralArray<NoteValidationRequest> =
                EphemeralArray::at(NOTE_VALIDATION_REQUESTS_ARRAY_BASE_SLOT);
            for i in 0..passer_count {
                let passer = passers.get(i);
                // The head's own hash is never in its archive; accept it by equality.
                if (passer.anchor_block_hash == head_hash) | in_archive.get(i) {
                    aztec::protocol::logging::debug_log("Validated note");
                    queue.push(passer.request);
                    capsules::store(
                        contract_address,
                        note_creation_tx_hash_slot(passer.unique_note_hash),
                        passer.tx_hash,
                        AztecAddress::zero(),
                    );
                } else {
                    aztec::protocol::logging::debug_log("Dropping note whose anchor block hash is not in the chain");
                }
            }
            validate_and_store_enqueued_notes_and_events(scope);
        }
    }
}
