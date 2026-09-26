use aztec::macros::aztec;

#[aztec]
pub contract PaylinkDirect {
    use aztec::{
        macros::{functions::{authorize_once, external}, storage::storage},
        messages::delivery::MessageDelivery,
        protocol::{address::{AztecAddress, EthAddress}, traits::ToField},
        state_vars::{SinglePrivateImmutable, StateVariable},
    };

    use aztec::macros::functions::initialization_utils::{
        assert_is_initialized_private, assert_is_initialized_utility,
        mark_as_initialized_from_private_initializer,
    };

    use paylink_note::{
        assert_windows, execute_claim, execute_claim_to_l1, execute_refund,
        get_note_and_unpack_data, pack_data, PaylinkNote, transfer, TRANSFER_META_LEN,
    };
    use poseidon::poseidon2::Poseidon2;

    /// Fixed commitment hash -- anyone who holds the link can claim.
    global DIRECT_HASH: Field = 0;

    #[storage]
    struct Storage<Context> {
        paylink_direct_note: SinglePrivateImmutable<PaylinkNote, Context>,
    }

    // =============================================
    // DEPOSIT
    // =============================================

    /// `sender` is the funding account; refund rights bind to it. Authorization is the token's
    /// standard gate on the pull below: a self-created link (account entrypoint, msg_sender ==
    /// sender) needs nothing; a sponsored creation (msg_sender is the FPC) consumes the sender's
    /// authwit.
    ///
    #[external("private")]
    fn deposit(
        amount: u128,
        from_claimable: u64,
        until_claimable: u64,
        refundable_until: u64,
        token_address: AztecAddress,
        sender: AztecAddress,
        meta: [Field; TRANSFER_META_LEN],
    ) {
        assert(!sender.is_zero(), "sender required");
        assert_windows(from_claimable, until_claimable, refundable_until);
        let sender_hash = Poseidon2::hash([sender.to_field()], 1);
        let data = pack_data(amount, from_claimable, until_claimable);

        let paylink_direct_note = PaylinkNote {
            hash: DIRECT_HASH,
            sender_hash,
            data,
            refundable_until: refundable_until as Field,
            oidc_key_registry: AztecAddress::zero(),
            vkey_hash: 0,
            token_address,
        };

        // Constrained on-chain delivery tagged by the paylink contract itself, so anyone
        // holding the link can discover the note without registering the depositor as a sender.
        self.storage.paylink_direct_note.initialize(paylink_direct_note).deliver(
            MessageDelivery::onchain_constrained().with_sender(self.address),
        );

        // `meta` lands in both parties' Transfer copies: the creator's memo and tag for the link
        // holder, and the link itself for the creator's own resync.
        transfer(sender, self.address, amount, token_address, meta, self.context);

        mark_as_initialized_from_private_initializer(self.context, false);
    }

    // =============================================
    // CLAIM
    // =============================================

    /// `recipient` is the payout target, and the claim is authorized BY the recipient via
    /// `#[authorize_once]`: a self-claim (account entrypoint, msg_sender == recipient) needs
    /// nothing; any other callstack (an FPC sponsoring the claim, a wrapper contract) consumes
    /// the recipient's authwit over this exact call. `authwit_nonce` makes each authorization
    /// single-use, so a claim authwit cannot be replayed for a later call on the same account.
    /// This is what lets a sponsored claim pay the claimant instead of msg_sender (the FPC)
    /// while a foreign callstack still cannot redirect the payout to an unconsenting address.
    #[authorize_once("recipient", "authwit_nonce")]
    #[external("private")]
    fn claim(recipient: AztecAddress, authwit_nonce: Field, meta: [Field; TRANSFER_META_LEN]) {
        assert_is_initialized_private(self.context);
        assert(!recipient.is_zero(), "recipient required");
        let (note, amount, from_claimable_val, until_claimable_val) = get_note_and_unpack_data(
            self.context,
            DIRECT_HASH,
            self.storage.paylink_direct_note.get_storage_slot(),
        );

        execute_claim(
            recipient,
            self.address,
            from_claimable_val,
            until_claimable_val,
            note.token_address,
            amount,
            meta,
            self.context,
        );
    }

    /// Bearer claim to L1: the link is the credential and the payout is not an L2 identity, so
    /// there is nothing to authorize. The burn goes to `executor`, which runs the user payload that
    /// `user_payload_hash` commits to. Consumes the same nullifier as `claim` and the refund.
    /// Publishes the payout in the withdrawal log, so an L1 claim is visible to anyone holding the
    /// link.
    #[external("private")]
    fn claim_to_l1(executor: EthAddress, user_payload_hash: Field, prover_tip: u128) {
        assert_is_initialized_private(self.context);
        assert(!executor.is_zero(), "executor required");
        let (note, amount, from_claimable_val, until_claimable_val) = get_note_and_unpack_data(
            self.context,
            DIRECT_HASH,
            self.storage.paylink_direct_note.get_storage_slot(),
        );

        execute_claim_to_l1(
            executor,
            user_payload_hash,
            prover_tip,
            self.address,
            from_claimable_val,
            until_claimable_val,
            note.token_address,
            amount,
            self.context,
        );
    }

    // =============================================
    // REFUND
    // =============================================

    /// `sender` must be the original funder (`execute_refund` checks it against the note's
    /// sender_hash) and authorizes the refund via `#[authorize_once]`: a self-refund
    /// (msg_sender == sender) passes authwit_nonce = 0; a sponsoring FPC's callstack consumes
    /// the sender's authwit. Valid until `refundable_until`, and again once the claim window has
    /// expired; the branch is decided from the anchor block, not by the caller.
    #[authorize_once("sender", "authwit_nonce")]
    #[external("private")]
    fn refund(sender: AztecAddress, authwit_nonce: Field, meta: [Field; TRANSFER_META_LEN]) {
        assert_is_initialized_private(self.context);
        assert(!sender.is_zero(), "sender required");
        execute_refund(
            sender,
            self.address,
            self.storage.paylink_direct_note.get_storage_slot(),
            meta,
            self.context,
        );
    }

    // utility function to get the note
    #[external("utility")]
    unconstrained fn sync_note() -> pub PaylinkNote {
        assert_is_initialized_utility(self.context);
        let note = self.storage.paylink_direct_note.view_note();
        note
    }

}
