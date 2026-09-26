use aztec::macros::aztec;

#[aztec]
pub contract PaylinkEmail {
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

    // Recursive proof constants (matching obsidion_fpc / paylink_zkp_name).
    // VKEY_SIZE stays 115 after the circuit change (measured: VK length unchanged).
    global VKEY_SIZE: u32 = 115;
    global PROOF_SIZE: u32 = 458;
    global HONK_IDENTIFIER: u32 = 6;

    use std::verify_proof_with_type;

    use oidc_key_registry::OidcKeyRegistry;
    use paylink_note::{
        assert_windows, execute_claim, execute_claim_to_l1, execute_refund,
        get_note_and_unpack_data, pack_data, PaylinkNote, transfer, TRANSFER_META_LEN,
    };
    use poseidon::poseidon2::Poseidon2;

    #[storage]
    struct Storage<Context> {
        // MUST stay the first storage field so the note keeps storage slot 1
        // (PaylinkService.PAYLINK_NOTE_STORAGE_SLOT = 1n, used by isPaylinkClaimed).
        paylink_email_note: SinglePrivateImmutable<PaylinkNote, Context>,
    }

    // =============================================
    // DEPOSIT
    // =============================================

    /// `sender` is the funding account; refund rights bind to it. Authorization is the token's
    /// standard gate on the pull below: a self-created link (account entrypoint, msg_sender ==
    /// sender) needs nothing; a sponsored creation (msg_sender is the FPC) consumes the sender's
    /// authwit.
    #[external("private")]
    fn deposit(
        amount: u128,
        oidc_key_registry: AztecAddress,
        vkey_hash: Field,
        emailhash: Field,
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

        let paylink_email_note = PaylinkNote {
            hash: emailhash,
            sender_hash,
            data,
            refundable_until: refundable_until as Field,
            oidc_key_registry,
            vkey_hash,
            token_address,
        };

        // Constrained on-chain delivery tagged by the paylink contract itself, so anyone
        // holding the link can discover the note without registering the depositor as a sender.
        self.storage.paylink_email_note.initialize(paylink_email_note).deliver(
            MessageDelivery::onchain_constrained().with_sender(self.address),
        );

        // `meta` lands in both parties' Transfer copies: the creator's memo and tag for the link
        // holder, and the link itself for the creator's own resync.
        transfer(sender, self.address, amount, token_address, meta, self.context);

        mark_as_initialized_from_private_initializer(self.context, false);
    }

    // =============================================
    // CLAIM (zkJWT proof verification)
    // =============================================

    /// Claim using a pre-generated UltraHonk proof of the zkJWT circuit.
    ///
    /// Public outputs from the proof (7 fields, h_iss appended at index 6):
    ///   [caller, email_hash, pre_email_hash, aud_hash, iat_as_field, jwk_id, h_iss]
    ///
    /// The vkey hash and registry address are read from the per-paylink binding set at deposit, so
    /// a claimer cannot substitute a different circuit or a malicious registry.
    ///
    /// `recipient` is the payout target AND the proof binding: the zkJWT proof's `caller` public
    /// input is verified as `recipient`, so a proof cannot be replayed for a different address.
    /// The claim is authorized BY the recipient via `#[authorize_once]` (the paylink_direct
    /// treatment): a self-claim (account entrypoint, msg_sender == recipient) needs no authwit and
    /// passes `authwit_nonce = 0`; any other callstack (a sponsoring FPC) consumes the recipient's
    /// authwit over this exact call, so a foreign callstack cannot redirect the payout.
    #[authorize_once("recipient", "authwit_nonce")]
    #[external("private")]
    fn claim(
        zkjwt_vkey: [Field; VKEY_SIZE],
        zkjwt_proof: [Field; PROOF_SIZE],
        email_hash: Field,
        pre_email_hash: Field,
        aud_hash: Field,
        iat: Field,
        jwk_id: Field,
        h_iss: Field,
        recipient: AztecAddress,
        authwit_nonce: Field,
        meta: [Field; TRANSFER_META_LEN],
    ) {
        assert_is_initialized_private(self.context);
        assert(!recipient.is_zero(), "recipient required");

        let (note, amount, from_claimable_val, until_claimable_val) = get_note_and_unpack_data(
            self.context,
            pre_email_hash,
            self.storage.paylink_email_note.get_storage_slot(),
        );

        // Recursively verify the zkJWT proof against the vkey this paylink was bound to at deposit.
        verify_proof_with_type(
            zkjwt_vkey,
            zkjwt_proof,
            [recipient.to_field(), email_hash, pre_email_hash, aud_hash, iat, jwk_id, h_iss],
            note.vkey_hash,
            HONK_IDENTIFIER,
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

        // Verify (issuer, aud, jwk) against the bound OidcKeyRegistry at its current generation, and
        // reject a stale login token. iat is bound by the proof verified above; the freshness gate
        // rides on this already-enqueued view so claim() adds no extra public call.
        OidcKeyRegistry::at(note.oidc_key_registry)
            .assert_valid(h_iss, aud_hash, jwk_id, iat as u64)
            .enqueue_view_incognito(self.context);
    }

    /// Email-locked claim to L1. The burn goes to `executor`, which runs the user payload that
    /// `user_payload_hash` commits to. The proof's `caller` public input is verified as the hash of
    /// both, so the login nonce commits to the executor and the payout, and a proof cannot be
    /// replayed through a different executor or to a different address. Possession of a valid
    /// proof is the authorization; there is no L2 identity to gate. Consumes the same nullifier as
    /// `claim` and the refund, and publishes the payout in the withdrawal log.
    #[external("private")]
    fn claim_to_l1(
        zkjwt_vkey: [Field; VKEY_SIZE],
        zkjwt_proof: [Field; PROOF_SIZE],
        email_hash: Field,
        pre_email_hash: Field,
        aud_hash: Field,
        iat: Field,
        jwk_id: Field,
        h_iss: Field,
        executor: EthAddress,
        user_payload_hash: Field,
        prover_tip: u128,
    ) {
        assert_is_initialized_private(self.context);
        assert(!executor.is_zero(), "executor required");

        let (note, amount, from_claimable_val, until_claimable_val) = get_note_and_unpack_data(
            self.context,
            pre_email_hash,
            self.storage.paylink_email_note.get_storage_slot(),
        );

        verify_proof_with_type(
            zkjwt_vkey,
            zkjwt_proof,
            [
                Poseidon2::hash([executor.to_field(), user_payload_hash], 2),
                email_hash,
                pre_email_hash,
                aud_hash,
                iat,
                jwk_id,
                h_iss,
            ],
            note.vkey_hash,
            HONK_IDENTIFIER,
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

        OidcKeyRegistry::at(note.oidc_key_registry)
            .assert_valid(h_iss, aud_hash, jwk_id, iat as u64)
            .enqueue_view_incognito(self.context);
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
            self.storage.paylink_email_note.get_storage_slot(),
            meta,
            self.context,
        );
    }

    // utility function to get the note
    #[external("utility")]
    unconstrained fn sync_note() -> pub PaylinkNote {
        assert_is_initialized_utility(self.context);
        let note = self.storage.paylink_email_note.view_note();
        note
    }
}
