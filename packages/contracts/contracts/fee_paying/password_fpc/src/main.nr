use aztec::macros::aztec;

#[aztec]
pub contract PasswordFPC {
    use aztec::{
        macros::{
            functions::{allow_phase_change, external, initializer, only_self, view},
            storage::storage,
        },
        protocol::{
            abis::gas_settings::GasSettings,
            address::AztecAddress,
            constants::FEE_JUICE_ADDRESS,
            hash::poseidon2_hash,
            traits::Serialize,
        },
        state_vars::PublicImmutable,
    };
    use compressed_string::FieldCompressedString;
    use fee_juice_interface::FeeJuice;
    use fpc_lib::MAX_AUTHORIZATION_TTL_SECONDS;

    /// Ceiling on a `refuel`'s DECLARED fee, so it sits well above real cost rather than near it.
    /// 20x under `max_fee`: it bounds what someone who learns a claim secret can burn.
    global REFUEL_MAX_FEE: u128 = 50000000000000000000; // 50 FJ

    #[storage]
    struct Storage<Context> {
        // The password HASH is public because a constructor cannot deliver a private note: the
        // recipient's keys are not registered yet. Safe only because the password is a
        // high-entropy secret (`assertFpcPassword`), so the pre-image cannot be brute-forced.
        admin: PublicImmutable<AztecAddress, Context>,
        password: PublicImmutable<Field, Context>,
        max_fee: PublicImmutable<u128, Context>,
    }

    /// `password` gates who may pay fees; `max_fee` is the per-tx ceiling.
    #[external("private")]
    #[initializer]
    fn constructor(password: str<31>, max_fee: u128) {
        let admin = self.msg_sender();
        let password_hash = get_password_hash(password);
        // PublicImmutable must be written from public context, so enqueue an init call.
        self.enqueue(PasswordFPC::at(self.address)._set_storage(admin, password_hash, max_fee));
    }

    /// Becomes the fee payer of the transaction deploying it, so juice bridged to this
    /// deterministic address and claimed earlier in the same payload funds the reserve that
    /// transaction spends from — an FPC on a chain with no pre-funded account.
    ///
    /// Takes the password HASH: the caller derives the address from these arguments, and the
    /// deploying entrypoint is not the admin, so `admin` is explicit rather than `msg_sender()`.
    #[external("private")]
    #[initializer]
    #[allow_phase_change]
    fn constructor_and_pay(admin: AztecAddress, password_hash: Field, max_fee: u128) {
        assert_fee_within_max(self.context.gas_settings(), max_fee);
        self.context.set_as_fee_payer();
        self.context.end_setup();

        // Enqueued after `end_setup`: the app phase admits any public call, unlike setup.
        self.enqueue(PasswordFPC::at(self.address)._set_storage(admin, password_hash, max_fee));
    }

    /// Claim an L1->L2 fee-juice message addressed to this FPC, paying for the claim out of the
    /// juice it claims — the one thing that works at a balance of zero.
    #[external("private")]
    #[allow_phase_change]
    fn refuel(amount: u128, claim_secret: Field, message_leaf_index: Field) {
        assert(
            self.context.maybe_msg_sender() == Option::none(),
            "msg_sender must be none for refuel",
        );

        let cap = if REFUEL_MAX_FEE <= amount { REFUEL_MAX_FEE } else { amount };
        assert_fee_within_max(self.context.gas_settings(), cap);

        // Races make stale proven refuels the common case; keep them out of the mempool.
        let anchor_ts = self.context.get_anchor_block_header().timestamp();
        self.context.set_expiration_timestamp(anchor_ts + MAX_AUTHORIZATION_TTL_SECONDS);

        self.context.set_as_fee_payer();
        FeeJuice::at(FEE_JUICE_ADDRESS)
            .claim_and_end_setup(
                self.context.this_address(),
                amount,
                claim_secret,
                message_leaf_index,
            )
            .call(self.context);
    }

    #[external("public")]
    #[only_self]
    fn _set_storage(admin: AztecAddress, password_hash: Field, max_fee: u128) {
        self.storage.admin.initialize(admin);
        self.storage.password.initialize(password_hash);
        self.storage.max_fee.initialize(max_fee);
    }

    #[external("private")]
    #[allow_phase_change]
    fn fee_entrypoint_private(max_fee: u128, nonce: Field, password: str<31>) {
        let password_hash = get_password_hash(password);
        assert(password_hash == self.storage.password.read(), "invalid password");
        assert_fee_within_max(self.context.gas_settings(), self.storage.max_fee.read());
        self.context.set_as_fee_payer();
        self.context.end_setup();
    }

    #[external("private")]
    #[view]
    fn get_accepted_asset() -> AztecAddress {
        self.context.this_address()
    }

    /// Checked in private, not public teardown: a transaction over the allowance cannot be proven,
    /// so a sequencer can never include one with the FPC on the hook for more than `max_fee`.
    #[contract_library_method]
    fn assert_fee_within_max(gas_settings: GasSettings, max_fee: u128) {
        let total_gas = gas_settings.gas_limits + gas_settings.teardown_gas_limits;
        let max_possible_fee: u128 = (total_gas.da_gas as u128)
            * gas_settings.max_fees_per_gas.fee_per_da_gas
            + (total_gas.l2_gas as u128) * gas_settings.max_fees_per_gas.fee_per_l2_gas;
        assert(max_possible_fee <= max_fee, "Gas settings exceed subscription max_fee");
    }

    #[contract_library_method]
    fn get_password_hash(password: str<31>) -> Field {
        let field_compressed_str = FieldCompressedString::from_string(password);
        poseidon2_hash(field_compressed_str.serialize())
    }
}
