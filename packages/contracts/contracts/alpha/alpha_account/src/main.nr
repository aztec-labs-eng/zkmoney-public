use aztec::macros::aztec;
mod authwit;
mod webauthn;

#[aztec]
pub contract ObsidionAccountAlpha {
    use aztec::{
        authwit::auth::IS_VALID_SELECTOR,
        context::PrivateContext,
        macros::{
            functions::{allow_phase_change, external, view},
            storage::storage,
        },
        messages::delivery::MessageDelivery,
        oracle::get_contract_instance::get_contract_instance,
        protocol::traits::Hash,
        state_vars::{Map, SinglePrivateImmutable},
    };

    use alpha_lib::utils::{
        compute_combined_payloads_and_intents_hash, compute_intents_hash,
        compute_intents_hash_from_inner_hash, compute_intents_only_signature_hash,
        compute_signed_message_hash, INTENT_HASHES_LEN, push_tx_nonce_nullifier, set_as_fee_payer,
    };

    use alpha_lib::keys::compute_key_commitment;
    use alpha_lib::notes::BoolNote;
    use alpha_lib::payloads::AppPayload;

    use crate::authwit::load_alpha_webauthn_witness;
    use crate::webauthn::verify_webauthn_p256;

    global empty_hashes: [Field; INTENT_HASHES_LEN] = [0; INTENT_HASHES_LEN];

    #[storage]
    struct Storage<Context> {
        intents_hashes: Map<Field, SinglePrivateImmutable<BoolNote, Context>, Context>,
    }

    ////////////////////////////////////////////////////////////////
    /////////////////////// Entrypoint methods /////////////////////
    ////////////////////////////////////////////////////////////////

    #[external("private")]
    #[allow_phase_change]
    fn entrypoint(app_payload: AppPayload, fee_method: u8) {
        assert(validate(self.context, app_payload.hash()), "entrypoint validation failed");
        execute_calls(
            self.storage,
            self.context,
            app_payload,
            fee_method,
            false,
            empty_hashes,
        );
    }

    #[external("private")]
    #[allow_phase_change]
    fn entrypoint_with_intent(
        app_payload: AppPayload,
        fee_method: u8,
        intent_hashes: [Field; INTENT_HASHES_LEN],
    ) {
        let inner_hash = compute_combined_payloads_and_intents_hash(app_payload, intent_hashes);
        assert(validate(self.context, inner_hash), "entrypoint_with_intent validation failed");
        execute_calls(
            self.storage,
            self.context,
            app_payload,
            fee_method,
            true,
            intent_hashes,
        );
    }

    ////////////////////////////////////////////////////////////////
    ///////////////// Entrypoint Helper methods ////////////////////
    ////////////////////////////////////////////////////////////////

    #[contract_library_method]
    fn execute_calls(
        storage: Storage<&mut PrivateContext>,
        context: &mut PrivateContext,
        app_payload: AppPayload,
        fee_method: u8,
        with_authwit: bool,
        intent_hashes: [Field; INTENT_HASHES_LEN],
    ) {
        push_tx_nonce_nullifier(context, app_payload.tx_nonce);
        set_as_fee_payer(context, fee_method);

        if with_authwit {
            let intents_hash = compute_intents_hash(intent_hashes);
            let bool_note = BoolNote { boolean: true };
            storage.intents_hashes.at(intents_hash).initialize(bool_note).deliver(
                MessageDelivery::onchain_unconstrained(),
            );
        }

        app_payload.execute_calls(context);
    }

    ////////////////////////////////////////////////////////////////
    ////////////////////// Validation methods //////////////////////
    ////////////////////////////////////////////////////////////////

    /// The passkey is committed into the address: the instance's `immutables_hash` is the
    /// commitment of the one key that may sign, so the witness key is checked against it before
    /// the signature is verified. The challenge is the authwit outer hash: `inner_hash` bound to
    /// this account, chain id and rollup version.
    #[contract_library_method]
    fn validate(context: &mut PrivateContext, inner_hash: Field) -> bool {
        let outer_hash = compute_signed_message_hash(context, inner_hash);
        let witness = unsafe { load_alpha_webauthn_witness(outer_hash) };

        let instance = get_contract_instance(context.this_address());
        assert(
            compute_key_commitment(witness.pub_key_x, witness.pub_key_y) == instance.immutables_hash,
            "key does not match the account's committed key",
        );

        verify_webauthn_p256(
            witness.pub_key_x,
            witness.pub_key_y,
            outer_hash,
            witness.authenticator_data,
            witness.client_data_json,
            witness.client_data_json_len,
            witness.signature,
        )
    }

    ////////////////////////////////////////////////////////////////
    ////////////////////// External methods ////////////////////////
    ////////////////////////////////////////////////////////////////

    /// Intent authorization is by membership in `storage.intents_hashes` only.
    ///
    /// The note at `intents_hash(inner_hash)` is populated by
    /// `entrypoint_with_intent.execute_calls` from the `intent_hashes` argument,
    /// which is itself bound by the user's combined-payload signature verified in
    /// `validate`. Per-intent witness bytes are NOT read on this path --
    /// the SDK-side `ObsidionAccount.createAuthWit`
    /// (`packages/sdk/src/obsidion/alpha/account/ObsidionAccount.ts`) deliberately
    /// returns a witness-less `AuthWitness` for intent shapes; no signing call
    /// happens for per-call authwits.
    ///
    /// INVARIANT for future Noir contributors: any callee that consumes the
    /// alpha account's intent authorization MUST go through
    /// `assert_inner_hash_valid_authwit` (in aztec-nr) so the protocol's
    /// replay-protection nullifier (`poseidon2(account_address, inner_hash)`)
    /// is emitted on the consumer side. Skipping that path would make
    /// `storage.intents_hashes` reusable across transactions and is a
    /// behavior-breaking change vs. this SDK's witness-less authwit design.
    #[external("private")]
    #[view]
    fn verify_private_authwit(inner_hash: Field) -> Field {
        let intents_hash = compute_intents_hash_from_inner_hash(self.context, inner_hash);
        self.storage.intents_hashes.at(intents_hash).get_note();
        IS_VALID_SELECTOR
    }

    /// Authorizes an intent batch without executing any calls, writing the same
    /// `intents_hashes` note as `entrypoint_with_intent`. Deliberately NOT gated on
    /// msg_sender: the expected caller is a sponsoring FPC, and authorization comes
    /// from the user's WebAuthn signature over the intents-only hash, bound to this
    /// account, chain id and version like every other signature the account checks.
    #[external("private")]
    fn authorize_intents(intent_hashes: [Field; INTENT_HASHES_LEN]) {
        let inner_hash = compute_intents_only_signature_hash(intent_hashes);
        assert(validate(self.context, inner_hash), "authorize_intents validation failed");

        let intents_hash = compute_intents_hash(intent_hashes);
        let bool_note = BoolNote { boolean: true };
        self.storage.intents_hashes.at(intents_hash).initialize(bool_note).deliver(
            MessageDelivery::onchain_unconstrained(),
        );
    }
}
