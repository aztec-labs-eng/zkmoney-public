use aztec::macros::aztec;

#[aztec]
pub contract SponsorFPC {
    use aztec::{
        macros::{
            functions::{allow_phase_change, external, initializer, view},
            storage::storage,
        },
        messages::delivery::MessageDelivery,
        protocol::address::AztecAddress,
        state_vars::{PrivateImmutable, Owned},
    };
    use address_note::AddressNote;

    #[storage]
    struct Storage<Context> {
        admin: Owned<PrivateImmutable<AddressNote, Context>, Context>,
    }

    ///////////////////////////////////////
    ///////  Account Contract Logic  //////
    ///////////////////////////////////////

   // Constructs the contract
    #[external("private")]
    #[initializer]
    fn constructor() {
        let admin = self.msg_sender();
        let note = AddressNote { address: admin };
        self.storage.admin.at(admin).initialize(note).deliver(MessageDelivery::onchain_constrained());
    }


    ///////////////////////////////////////
    ///////  FPC Contract Logic  //////
    ///////////////////////////////////////

    #[external("private")]
    #[allow_phase_change]
    fn fee_entrypoint_private(max_fee: u128, nonce: Field) {
        self.context.set_as_fee_payer();
        self.context.end_setup();
    }

    #[external("private")]
    #[allow_phase_change]
    fn fee_entrypoint_public(max_fee: u128, nonce: Field) {
        self.context.set_as_fee_payer();
        self.context.end_setup();
    }

    #[external("private")]
    #[view]
    fn get_accepted_asset() -> AztecAddress {
        self.context.this_address()
    }
}
