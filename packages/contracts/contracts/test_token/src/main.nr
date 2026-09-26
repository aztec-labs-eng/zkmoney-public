use aztec::macros::aztec;

/// Test-only token: exposes OxideToken's external surface (`transfer`, `balance_of`, `name`/`symbol`/`decimals`,
/// `Transfer` event) over plain UintNote balances -- no TEE attestation -- plus a minter-gated `mint_to_private` for
/// funding. Sandbox suites that test entrypoint / FPC / paylink logic use it as the asset without the TEE-portal
/// harness. The public surface is deliberately tiny so class publication stays under the sandbox per-tx DA gas cap.
#[aztec]
pub contract TestToken {
    use aztec::{
        macros::{
            events::event,
            functions::{authorize_once, external, initializer, internal, only_self, view},
            storage::storage,
        },
        messages::{delivery::MessageDelivery, logs::event::MAX_EVENT_SERIALIZED_LEN},
        protocol::address::AztecAddress,
        state_vars::{Owned, PublicImmutable},
    };
    use balance_set::BalanceSet;
    use compressed_string::FieldCompressedString;

    // gas-optimized max notes for initial transfer call
    global INITIAL_TRANSFER_CALL_MAX_NOTES: u32 = 2;
    // max notes per recursive call once the initial max is exceeded
    global RECURSIVE_TRANSFER_CALL_MAX_NOTES: u32 = 8;

    // Mirrors OxideToken::TRANSFER_META_LEN. Derived from the same aztec-nr constant so the two
    // tokens cannot drift apart on an SDK bump.
    pub global TRANSFER_META_LEN: u32 = MAX_EVENT_SERIALIZED_LEN - 3;

    // Same shape as OxideToken::Transfer -- event selectors derive from type name + field types, so consumers
    // decoding with the oxide token's ABI see these events.
    #[event]
    struct Transfer {
        pub from: AztecAddress,
        pub to: AztecAddress,
        pub amount: u128,
        /// Unparsed passthrough blob; sized to the private-event capacity, so it costs no extra DA.
        pub meta: [Field; TRANSFER_META_LEN],
    }

    #[storage]
    struct Storage<Context> {
        name: PublicImmutable<FieldCompressedString, Context>,
        symbol: PublicImmutable<FieldCompressedString, Context>,
        decimals: PublicImmutable<u8, Context>,
        private_balances: Owned<BalanceSet<Context>, Context>,
        minter: PublicImmutable<AztecAddress, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(name: str<31>, symbol: str<31>, decimals: u8, minter: AztecAddress) {
        self.storage.name.initialize(FieldCompressedString::from_string(name));
        self.storage.symbol.initialize(FieldCompressedString::from_string(symbol));
        self.storage.decimals.initialize(decimals);
        self.storage.minter.initialize(minter);
    }

    // Selector-compatible with OxideToken::transfer -- paylink_note / deposit call this on whatever asset address
    // they are given.
    #[authorize_once("from", "authwit_nonce")]
    #[external("private")]
    fn transfer(
        from: AztecAddress,
        to: AztecAddress,
        amount: u128,
        meta: [Field; TRANSFER_META_LEN],
        authwit_nonce: Field,
    ) {
        self.internal._decrease_private_balance(from, amount, INITIAL_TRANSFER_CALL_MAX_NOTES);
        self.internal._increase_private_balance(to, amount);

        self.emit(Transfer { from, to, amount, meta }).deliver_to(
            to,
            MessageDelivery::onchain_unconstrained(),
        );
    }

    #[external("private")]
    fn mint_to_private(to: AztecAddress, amount: u128) {
        _validate_minter(self.msg_sender(), self.storage.minter.read());

        self.internal._increase_private_balance(to, amount);
    }

    /// Side-effect-free private call. A private tx is metered on its side effects, so a sponsored
    /// batch carrying only this one costs exactly the FPC entrypoint's own overhead -- which is how
    /// the sdk pins ClaimFPC's `CLAIM_FPC_OVERHEAD_GAS` against simulation.
    #[external("private")]
    fn noop() {}

    #[external("private")]
    #[only_self]
    fn recurse_subtract_balance_internal(account: AztecAddress, amount: u128) -> u128 {
        self.internal._subtract_balance(account, amount, RECURSIVE_TRANSFER_CALL_MAX_NOTES)
    }

    #[external("utility")]
    unconstrained fn balance_of(owner: AztecAddress) -> u128 {
        self.storage.private_balances.at(owner).balance_of()
    }

    #[external("public")]
    #[view]
    fn name() -> FieldCompressedString {
        self.storage.name.read()
    }

    #[external("public")]
    #[view]
    fn symbol() -> FieldCompressedString {
        self.storage.symbol.read()
    }

    #[external("public")]
    #[view]
    fn decimals() -> u8 {
        self.storage.decimals.read()
    }

    #[contract_library_method]
    fn _validate_minter(sender: AztecAddress, minter: AztecAddress) {
        assert(minter.eq(sender), "caller is not minter");
    }

    // Subtracts `amount` from `account`'s notes and re-emits the change as a fresh note.
    #[internal("private")]
    fn _decrease_private_balance(account: AztecAddress, amount: u128, max_notes: u32) {
        let change = self.internal._subtract_balance(account, amount, max_notes);
        self.storage.private_balances.at(account).add(change).deliver(
            MessageDelivery::onchain_constrained(),
        );
    }

    #[internal("private")]
    fn _increase_private_balance(to: AztecAddress, amount: u128) {
        self.storage.private_balances.at(to).add(amount).deliver(
            MessageDelivery::onchain_constrained(),
        );
    }

    // Nullifies notes up to `amount`, recursing when more than `max_notes` notes are needed. Returns the change.
    #[internal("private")]
    fn _subtract_balance(account: AztecAddress, amount: u128, max_notes: u32) -> u128 {
        let subtracted = self.storage.private_balances.at(account).try_sub(amount, max_notes);
        if subtracted >= amount {
            subtracted - amount
        } else {
            assert(subtracted > 0, "Balance too low");
            let remaining = amount - subtracted;
            self.call_self.recurse_subtract_balance_internal(account, remaining)
        }
    }
}
