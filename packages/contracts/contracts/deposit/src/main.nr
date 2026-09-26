use aztec::macros::aztec;

// VERSION=0.81.0 aztec-nargo compile
// rm codegenCache.json && VERSION=0.81.0 aztec codegen ./ -o ../../src/artifacts

#[aztec]
pub contract Deposit {
    use aztec::{
        context::PrivateContext,
        macros::{functions::external, storage::storage},
        messages::delivery::MessageDelivery,
        note::{note_getter::get_note},
        oracle::logging::debug_log_format,
        protocol::address::AztecAddress,
        // state_vars::{
        //     DelayedPublicMutable, PrivateImmutable, PrivateMutable,
        // },
    };

    use oxide_token_contract::OxideToken;

    // #[storage]
    // struct Storage<Context> {
    //     shared_mutable: DelayedPublicMutable<Field, 1, Context>,
    //     private_immutable: PrivateImmutable<FieldNote, Context>,
    //     private_mutable: PrivateMutable<FieldNote, Context>,
    // }

    #[external("private")]
    fn deposit_private(from: AztecAddress, amount: u128, nonce: Field, asset: AztecAddress) {
        OxideToken::at(asset)
            .transfer(
                from,
                self.context.this_address(),
                amount,
                [0; OxideToken::TRANSFER_META_LEN],
                nonce,
            )
            .call(self.context);
    }

    // #[external("private")]
    // fn get_shared_mutable() -> Field {
    //     self.storage.shared_mutable.get_current_value()
    // }

    // #[external("private")]
    // fn get_private_immutable() -> Field {
    //     self.storage.private_immutable.get_note().value()
    // }

    // #[private]
    // fn get_private_mutable() -> Field {
    //     let note_emission = storage.private_mutable.get_note();
    //     note_emission.emit(&mut context, AztecAddress::zero(), MessageDelivery.CONSTRAINED_ONCHAIN);
    //     let note = note_emission.note;

    //     note.value()
    // }

    // #[external("private")]
    // fn get_private_mutable_no_emit() -> Field {
    //     let storage_slot = self.storage.private_mutable.get_storage_slot();
    //     let mut (authenticator_note, note_hash_for_read_request): (RetrievedNote<FieldNote>, Field)
    //          = get_note(self.context, storage_slot);

    //     note_hash_for_read_request
    // }

    // #[private]
    // fn get_everything() -> [Field; 4] {
    //     // let shared_mutable = storage.shared_mutable.get_current_value();

    //     let private_immutable = storage.private_immutable.get_note().value();

    //     let note_emission = storage.private_mutable.get_note();
    //     note_emission.emit(&mut context, AztecAddress::zero(), MessageDelivery.CONSTRAINED_ONCHAIN);
    //     let private_mutable = note_emission.note.value();

    //     let mut result = [0; 4];
    //     // result[0] = shared_mutable;
    //     result[0] = 0;
    //     result[1] = private_immutable;
    //     result[2] = private_mutable;
    //     result[3] = dep::poseidon::poseidon2::Poseidon2::hash([result[0], result[1], result[2]], 3); // 78 lol

    //     result
    // }

    // everything: 59925
    // shared_mutable: 4919 (59925 - 55006)
    // private_immutable: 1418 (59925 - 58507)
    // private_mutable: 48350 (59925 - 11575)

}
