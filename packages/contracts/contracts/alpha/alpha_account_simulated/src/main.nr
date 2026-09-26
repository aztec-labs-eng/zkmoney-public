use aztec::macros::aztec;

// Stub account contract for `ObsidionAccountAlpha`, used as a
// `currentContractClassId` override during kernelless simulation.
//
// The wallet replaces the user's account class with this one in PXE
// `SimulationOverrides` so PXE dispatches the entrypoint selector against
// this artifact instead of the real WebAuthn-verifying contract. With
// `skipKernels: true` (the PXE default when overrides are supplied) the
// simulation skips kernel proving and signature work. Real proving still
// uses the production `ObsidionAccountAlpha` class.
//
// Gas-parity invariant: this stub MUST emit the same private side effects
// (nullifiers, note hashes, encrypted-log messages, read requests, and
// public call counts) as the production contract, modulo the actual
// signature verification circuit. Otherwise `gasUsed.totalGas`
// reported by simulation under-estimates what proving actually consumes,
// and the proven tx fails with "Circuit execution failed: The gas used
// exceeds the gas limits".
//
// What each function keeps and drops, per production:
//
//   entrypoint{,_with_intent}:
//     - `validate(...)` DROPPED: the instance read and the key commitment
//       check emit nothing, and the signature circuit emits nothing.
//     - `execute_calls(...)` KEPT, including the tx-nonce nullifier and the
//       `intents_hashes` write.
//
//   verify_private_authwit:
//     - intent-hash recompute KEPT, storage read DROPPED (see the function).
//
//   authorize_intents:
//     - `validate(...)` DROPPED, `intents_hashes` write KEPT.
//
// The storage layout MUST match production exactly so slot computation
// agrees (slots are positional in struct order).
#[aztec]
pub contract ObsidionAccountAlphaSimulated {
    use aztec::{
        authwit::auth::IS_VALID_SELECTOR,
        context::PrivateContext,
        macros::{functions::{allow_phase_change, external, view}, storage::storage},
        messages::delivery::MessageDelivery,
        state_vars::{Map, SinglePrivateImmutable},
    };

    use alpha_lib::utils::{
        compute_intents_hash, compute_intents_hash_from_inner_hash, INTENT_HASHES_LEN,
        push_tx_nonce_nullifier, set_as_fee_payer,
    };

    use alpha_lib::notes::BoolNote;
    use alpha_lib::payloads::AppPayload;

    global empty_hashes: [Field; INTENT_HASHES_LEN] = [0; INTENT_HASHES_LEN];

    // Storage layout matches production `ObsidionAccountAlpha` exactly so
    // slot computation agrees -- slots are positional in struct order.
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

    // Mirror of production's `execute_calls`. Keep the real storage write so
    // gas / side-effect counts (1 note hash + 1 onchain log per intent batch)
    // match the production circuit exactly.
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
    ////////////////////// External methods ////////////////////////
    ////////////////////////////////////////////////////////////////

    // Production also does `intents_hashes.at(intents_hash).get_note()` after
    // computing the intents_hash, which surfaces "Failed to get a note" in
    // simulation. The capsule load + hash recompute have no side effects so
    // they are kept to exercise the same code path; the read result is
    // discarded.
    //
    // Gas-parity caveat: production emits 1 read request via `get_note()`;
    // this stub emits 0. Sim under-estimates by exactly 1 read request per
    // `verify_private_authwit` invocation. If proving fails because of this,
    // add a dummy read request back here.
    #[external("private")]
    #[view]
    fn verify_private_authwit(inner_hash: Field) -> Field {
        let _ = compute_intents_hash_from_inner_hash(self.context, inner_hash);
        IS_VALID_SELECTOR
    }

    #[external("private")]
    fn authorize_intents(intent_hashes: [Field; INTENT_HASHES_LEN]) {
        let intents_hash = compute_intents_hash(intent_hashes);
        let bool_note = BoolNote { boolean: true };
        self.storage.intents_hashes.at(intents_hash).initialize(bool_note).deliver(
            MessageDelivery::onchain_unconstrained(),
        );
    }
}
