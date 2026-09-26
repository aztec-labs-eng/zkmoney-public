mod config;
mod eligibility;
mod gas;
mod gate;
mod notes;
mod registration;

use aztec::macros::aztec;

/// Campaign fee-paying contract with parallel sponsorship rails.
///
/// The FPC is the transaction entrypoint (`from: NO_FROM`) and controls the whole callstack --
/// only whitelisted calls are dispatchable, which is the griefing defense.
///
/// A RAIL is one sponsorship offer: a gate that admits users, a policy that bounds what their
/// batches may carry, and a per-window allowance (config.nr). A deployment configures several, and
/// they are independent -- a strict rail can admit a user on a hard-to-forge witness and sponsor a
/// single call, while an open rail sponsors the product's flows on a different witness, with
/// neither able to spend the other's allowance or dispatch through the other's policy.
///
/// There are two entrypoints -- `subscribe` (a rail's first tx) and `sponsor` (every later one) --
/// and both take the `rail_id` they ride. `subscribe` calls the rail's configured gate on itself
/// and gets back a `GateReceipt` (gate.nr); the contract itself knows no gate by name, so a new
/// rail is a new gate function plus a config value. Everything a batch pays for is a whitelisted
/// call in it. Capability therefore composes through rails and policies rather than through new
/// entrypoints, and each batched call is its own circuit, so a batch pays only for what it carries.
///
/// A third way onto a rail is a GIFT: a subscriber's batch may carry `gift_voucher`, which hands one
/// use of their allowance to another address as a single-use note on a rail that never refills. The
/// holder spends it through `sponsor` like any subscriber -- a paylink escrow, say, whose holder has
/// no account of their own.
///
/// ALL configuration is fixed at `configure` time (one PublicImmutable read per entrypoint). No
/// admin, no setters: the FPC self-limits by its fee-juice funding, and constants change by
/// deploying a new FPC.
///
/// Config lives OUTSIDE the constructor so the address is deterministic (fixed salt + universal
/// deploy + password hash as the only initializer arg) and computable before the oxide L1 side
/// exists -- oxide's skim pool needs this address, and our config needs oxide's addresses, so one
/// of the two had to become post-deploy. `configure` is a one-shot enable gated by a password:
/// the constructor commits its hash, a private proof of the preimage authorizes the single
/// `PublicImmutable` config write, and until it lands every entrypoint fails its config read.
///
/// Funding: oxide's portal skims deposits/withdrawals into an L1 pool; racers consume it for a
/// bounty and deposit the skim through the canonical FeeJuicePortal to this address, with a
/// public claim secret (oxide's manifest). `refuel` is the permissionless L2 leg: anyone may
/// consume such a message, and the claimed juice pays for its own claim.
#[aztec]
pub contract ClaimFPC {
    use crate::config::{
        add_entry_budget, assert_call_whitelisted, bound_selector, ClassWitness, Config, GATE_NONE,
        MAX_PUBLIC_CALLDATA_FIELDS, PolicyMerkleProof, Rail, rail_at,
    };
    use crate::eligibility::{
        binding_digest, derive_oxide_account, eth_address_from_pubkey, eth_address_to_field,
        field_to_eth_address, fields_to_bytes32, name_claim_digest,
    };
    use crate::gas::{overhead_max_fee, OverheadGas};
    use crate::gate::{DOM_SEP__CLAIM_SUBSCRIPTION, GateReceipt};
    use crate::notes::{refresh_subscription_note, SubscriptionNote};
    use crate::registration::name_ownership_content_hash;

    use aztec::{
        authwit::entrypoint::FunctionCall,
        macros::{
            functions::{allow_phase_change, external, initializer, internal, only_self},
            storage::storage,
        },
        messages::delivery::MessageDelivery,
        note::{
            note_getter_options::NoteGetterOptions, note_interface::NoteProperties,
            note_viewer_options::NoteViewerOptions,
        },
        protocol::{
            abis::function_selector::FunctionSelector,
            address::{AztecAddress, EthAddress},
            constants::FEE_JUICE_ADDRESS,
            hash::{poseidon2_hash, poseidon2_hash_with_separator},
            traits::{FromField, Serialize, ToField},
        },
        state_vars::{Owned, PrivateSet, PublicImmutable},
        utils::comparison::Comparator,
    };
    use compressed_string::FieldCompressedString;
    use fee_juice_interface::FeeJuice;
    use fpc_lib::bounded_anchor_timestamp;

    global MAX_SPONSORED_CALLS: u32 = 5;

    /// What either entrypoint costs before any sponsored call -- protocol per-tx gas plus the fixed
    /// side effects both emit: the tx-request nullifier and the entrypoint's own (claim push here,
    /// note pop in `sponsor`), the SubscriptionNote's hash and delivery log, and the fee payer's
    /// public data write. A property of this contract's code, so the circuit charges it from here and
    /// a deploy supplies only the price: no FPC can be configured with a wrong idea of its own
    /// overhead. The `#[abi(fpc_gas)]` export carries the numbers into the compiled artifact, where
    /// the deploy config reads them to derive per-call marginals by subtraction
    /// (packages/contracts/src/claimFpcGas.ts).
    ///
    /// Literals because `#[abi]` exports a global's expression as written. They are pinned by the
    /// sdk's `test/fpc/claimFpc/nameClaimRail.sandbox.test.ts`, which sponsors a batch of one side-effect-free call
    /// (metered at zero, so the tx IS the overhead) and asserts the emitted side effects and the
    /// simulated gas, plus the TS metering derivation and measured-table cross-checks in
    /// `claimFpcConfig.ts`.
    #[abi(fpc_gas)]
    global CLAIM_FPC_OVERHEAD_GAS: OverheadGas = OverheadGas { da_gas: 800, l2_gas: 483700 };

    /// What the NameClaim gate's self-call costs on top of the entrypoint overhead. Zero: gas is
    /// metered on side effects, and this gate emits none -- it verifies two signatures and a CREATE2
    /// derivation, all in-circuit. A gate that consumes a message or writes state reports its own
    /// nonzero cost the same way, and `subscribe` prices whichever gate ran from the receipt.
    #[abi(fpc_gate_gas)]
    global NAME_CLAIM_GATE_GAS: OverheadGas = OverheadGas { da_gas: 0, l2_gas: 0 };

    /// What a registration-gated subscribe costs on top of the entrypoint overhead: the consumed
    /// message's nullifier, at L2_GAS_PER_NULLIFIER and one field of DA at DA_GAS_PER_FIELD. The two
    /// signature checks the gate also runs emit nothing. Pinned against the kernel's metering
    /// constants and the measured table by the sdk's `claimFpcGasInventory.test.ts`.
    #[abi(fpc_gate_gas)]
    global REGISTRATION_GATE_GAS: OverheadGas = OverheadGas { da_gas: 32, l2_gas: 16000 };

    /// What one `refuel` tx costs: its own circuit, the FeeJuice claim circuit (message-consumption
    /// nullifier + enqueued `_increase_public_balance`), and the public balance write. A fixed
    /// shape, so the literals are the measured whole-tx gas, pinned exactly by the sdk's
    /// `claimFpcRefuel.sandbox.test.ts` (simulated gas == this global == the measured gas table entry).
    /// The cap this prices is also the most a griefer can burn per funding message into sequencer
    /// fees, so it must stay well under the pool's minimum skim deposit.
    #[abi(fpc_refuel_gas)]
    global REFUEL_OVERHEAD_GAS: OverheadGas = OverheadGas { da_gas: 224, l2_gas: 659123 };

    #[storage]
    struct Storage<Context> {
        password_hash: PublicImmutable<Field, Context>,
        config: PublicImmutable<Config, Context>,
        subscriptions: Owned<PrivateSet<SubscriptionNote, Context>, Context>,
    }

    /// The only initializer arg, so the address commits to (class, salt, password hash) and nothing
    /// else. The hash is public; the preimage is the operator secret that authorizes `configure`.
    #[external("public")]
    #[initializer]
    fn constructor(password_hash: Field) {
        self.storage.password_hash.initialize(password_hash);
    }

    /// One-shot enable. Private so the password preimage never appears in calldata: a public check
    /// would let a mempool observer front-run the reveal with a hostile config and brick this
    /// (deterministic, one-config-ever) address. The enqueued self-call is the only writer of
    /// `config`, and `PublicImmutable`'s initialization nullifier makes a second configure revert.
    #[external("private")]
    fn configure(password: str<31>, config: Config) {
        let committed = self.storage.password_hash.read();
        assert(password_hash_of(password) == committed, "invalid configure password");
        self.enqueue(ClaimFPC::at(self.address)._configure(config));
    }

    #[external("public")]
    #[only_self]
    fn _configure(config: Config) {
        self.storage.config.initialize(config);
    }

    /// Onboarding onto one rail: runs the rail's gate, mints the user's SubscriptionNote for that
    /// rail, pays the fee, and dispatches the first sponsored batch.
    ///
    /// The gate runs as a self-call on the selector the rail names, and `gate_args_hash` is that
    /// call's argument hash -- the caller supplies the preimage through the tx's hashed args, so
    /// each gate takes whatever witnesses it needs without `subscribe` naming any of them. A gate
    /// only attests; every state change is here, so a gate cannot mint anything by itself.
    ///
    /// The FPC knows nothing about accounts: onboarding rides the batch as a whitelisted call to
    /// the account class's no-payload intent authorization (`authorize_intents`), built
    /// client-side -- a fresh user needs no funds and no prior tx.
    #[external("private")]
    #[allow_phase_change]
    fn subscribe(
        rail_id: u8,
        calls: [FunctionCall; MAX_SPONSORED_CALLS],
        class_witnesses: [ClassWitness; MAX_SPONSORED_CALLS],
        policy_witnesses: [PolicyMerkleProof; MAX_SPONSORED_CALLS],
        public_calldata: [[Field; MAX_PUBLIC_CALLDATA_FIELDS]; MAX_SPONSORED_CALLS],
        public_calldata_lens: [u32; MAX_SPONSORED_CALLS],
        user: AztecAddress,
        gate_args_hash: Field,
    ) {
        let (config, rail, batch_max_fee) = self.internal._entrypoint_preamble(
            rail_id,
            calls,
            class_witnesses,
            policy_witnesses,
            public_calldata,
            public_calldata_lens,
        );
        // A rail entered by gift alone names no gate; its notes come from `gift_voucher`.
        assert(rail.gate_selector != GATE_NONE, "rail admits no subscriptions");

        let receipt: GateReceipt = self
            .context
            .call_private_function_with_args_hash(
                self.context.this_address(),
                FunctionSelector::from_field(rail.gate_selector),
                gate_args_hash,
                false,
            )
            .get_preimage();
        // The gate attests about an L2 address of its own choosing; this is what stops a gate proof
        // for one address from minting a subscription for another.
        assert(receipt.user == user, "gate admits a different user");

        // One subscription per (gate identity, rail), per rollup version. The identity is the
        // gate's -- for a claim it is the L1 account, never the L2 address (a leaked bootstrap key
        // must not mint unlimited subscriptions across fresh L2 addresses) and never the digest
        // (claim retries differ only in deadline). Scoping it by rail is what lets one holder ride
        // every rail they are eligible for while spending each rail's allowance only once.
        self.context.push_nullifier_unsafe(poseidon2_hash_with_separator(
            [receipt.identity, rail_id as Field],
            DOM_SEP__CLAIM_SUBSCRIPTION,
        ));

        // This tx is the first use of the rail's first window. The window starts at a BOUNDED
        // anchor: an unbounded one could sit a whole refill period in the past and let the first
        // refill fire at once, doubling the window. Inserted before end_setup so the note is
        // non-revertible together with the nullifier above: if a future whitelisted call enqueues
        // public work that reverts, the nullifier must not outlive the note -- that would burn the
        // one-per-identity subscription with nothing to show for it, permanently.
        let anchor_ts = bounded_anchor_timestamp(self.context);
        self
            .storage
            .subscriptions
            .at(user)
            .insert(
                SubscriptionNote { rail: rail_id, uses: rail.max_tx - 1, refilled_at: anchor_ts },
            )
            .deliver(MessageDelivery::onchain_unconstrained());

        self.internal._assert_fee_within_max(
            batch_max_fee
                + overhead_max_fee(
                    receipt.gas,
                    config.max_fee_per_da_gas,
                    config.max_fee_per_l2_gas,
                ),
        );
        self.context.set_as_fee_payer();
        self.context.end_setup();

        self.internal._dispatch_calls(calls);
    }

    /// The NameClaim gate: the bound OxideAccount plus the domain owner's L1 claim over it. The
    /// whole witness set is reconstructible from the master secret plus public L1 data, across
    /// rollup migrations. The identity it reports is that account.
    #[external("private")]
    #[only_self]
    fn _gate_name_claim(
        user: AztecAddress,
        name_hash: [u8; 32],
        nonce: [u8; 32],
        deadline: [u8; 32],
        claim_sig: [u8; 64],
        bootstrap_pub_key_x: [u8; 32],
        bootstrap_pub_key_y: [u8; 32],
        binding_sig: [u8; 64],
    ) -> GateReceipt {
        let config = self.storage.config.read();
        let oxide_account = bound_oxide_account(
            config,
            user,
            bootstrap_pub_key_x,
            bootstrap_pub_key_y,
            binding_sig,
        );

        // Domain owner signed NameClaim{name_hash, oxide_account, nonce, deadline} -- verified
        // against the pubkey pinned in config. `deadline` is signed data only, NEVER enforced:
        // after a rollup migration every deadline is long expired and the witness set must still
        // reconstruct (replay is bounded by the nullifier, fresh per rollup version).
        let claim_digest = name_claim_digest(
            fields_to_bytes32(
                config.registry_domain_separator_hi,
                config.registry_domain_separator_lo,
            ),
            name_hash,
            oxide_account,
            nonce,
            deadline,
        );
        assert(
            std::ecdsa_secp256k1::verify_signature(
                fields_to_bytes32(
                    config.domain_owner_pub_key_x_hi,
                    config.domain_owner_pub_key_x_lo,
                ),
                fields_to_bytes32(
                    config.domain_owner_pub_key_y_hi,
                    config.domain_owner_pub_key_y_lo,
                ),
                claim_sig,
                claim_digest,
            ),
            "invalid NameClaim signature",
        );

        GateReceipt { user, identity: eth_address_to_field(oxide_account), gas: NAME_CLAIM_GATE_GAS }
    }

    /// The registration gate: oxide's NamePortal attested on L1 that an OxideAccount holds a name,
    /// and the account's bootstrap key binds THIS L2 address to it. The message names an L1 address
    /// and nothing else, so it admits nobody on its own -- the binding signature is what makes it
    /// this user's, exactly as in the NameClaim gate. The identity it reports is that account.
    ///
    /// `notify` is permissionless and repeatable, so the message is not the limiter: a second one
    /// for the same owner is consumable, and the rail's one-subscription-per-identity nullifier is
    /// what bounds admission. That repeatability is also how the rail re-opens after an FPC roll or
    /// a rollup migration, and how an already-registered account is back-filled.
    ///
    /// Every witness is public (the message secret by design, the leaf index from the Inbox's logs)
    /// except the bootstrap signature, which the master secret re-derives -- so a wallet restored on
    /// a fresh device rebuilds the whole set by scanning. See `registrationMessage.ts`.
    #[external("private")]
    #[only_self]
    fn _gate_registration(
        user: AztecAddress,
        name_hash: [u8; 32],
        bootstrap_pub_key_x: [u8; 32],
        bootstrap_pub_key_y: [u8; 32],
        binding_sig: [u8; 64],
        secret: Field,
        message_leaf_index: Field,
    ) -> GateReceipt {
        let config = self.storage.config.read();
        let oxide_account = bound_oxide_account(
            config,
            user,
            bootstrap_pub_key_x,
            bootstrap_pub_key_y,
            binding_sig,
        );

        // The portal attested that this account holds this name.
        self.context.consume_l1_to_l2_message(
            name_ownership_content_hash(oxide_account, name_hash),
            [secret],
            EthAddress::from_field(config.name_portal_address),
            message_leaf_index,
        );

        GateReceipt {
            user,
            identity: eth_address_to_field(oxide_account),
            gas: REGISTRATION_GATE_GAS,
        }
    }

    /// A follow-up sponsored batch on a rail the user already holds. Identity is the rail's
    /// SubscriptionNote itself (only the owner's PXE can produce it), and the note chain is also
    /// the rate limiter via `_consume_subscription`. A batch carrying only a SIPA notification and
    /// its L1-operation broadcasts is how every SIPA broadcast past the first one runs.
    #[external("private")]
    #[allow_phase_change]
    fn sponsor(
        rail_id: u8,
        calls: [FunctionCall; MAX_SPONSORED_CALLS],
        class_witnesses: [ClassWitness; MAX_SPONSORED_CALLS],
        policy_witnesses: [PolicyMerkleProof; MAX_SPONSORED_CALLS],
        public_calldata: [[Field; MAX_PUBLIC_CALLDATA_FIELDS]; MAX_SPONSORED_CALLS],
        public_calldata_lens: [u32; MAX_SPONSORED_CALLS],
        user: AztecAddress,
    ) {
        let (_config, rail, batch_max_fee) = self.internal._entrypoint_preamble(
            rail_id,
            calls,
            class_witnesses,
            policy_witnesses,
            public_calldata,
            public_calldata_lens,
        );

        // The bound doubles as mempool hygiene: proven-but-unmined batches stay valid only briefly.
        let anchor_ts = bounded_anchor_timestamp(self.context);
        self.internal._consume_subscription(user, rail_id, rail, anchor_ts);

        self.internal._assert_fee_within_max(batch_max_fee);
        self.context.set_as_fee_payer();
        self.context.end_setup();

        self.internal._dispatch_calls(calls);
    }

    /// Hand one use of `from`'s allowance on `from_rail` to `recipient`, as a single-use note on
    /// `to_rail`. Reached only as a whitelisted BY_SELF call inside the gifter's own sponsored
    /// batch, and popping the gifter's note is the authorization: only its owner's PXE can. The
    /// note is delivered under the recipient's own tag, so whoever holds the recipient's keys finds
    /// it without knowing the gifter; the gifting PXE must hold those keys too, in scope.
    ///
    /// `to_rail` must never refill: with a refill the note would grow into that rail's whole
    /// allowance in a stranger's hands. What the note may pay for is `to_rail`'s policy; how many
    /// times, exactly once. Several gifts to one recipient are several notes.
    #[external("private")]
    #[only_self]
    fn gift_voucher(from: AztecAddress, from_rail: u8, recipient: AztecAddress, to_rail: u8) {
        let config = self.storage.config.read();
        let source = rail_at(config, from_rail);
        let target = rail_at(config, to_rail);
        assert(target.refill_period == 0, "gifted rail must not refill");

        let anchor_ts = bounded_anchor_timestamp(self.context);
        self.internal._consume_subscription(from, from_rail, source, anchor_ts);
        self
            .storage
            .subscriptions
            .at(recipient)
            .insert(SubscriptionNote { rail: to_rail, uses: 1, refilled_at: anchor_ts })
            .deliver(MessageDelivery::onchain_unconstrained().with_sender(recipient));
    }

    /// Permissionless top-up: consume one skim-funding L1->L2 message (public secret, oxide's
    /// manifest) and credit this FPC. No eligibility, no subscription -- the message content hash
    /// binds (to = this FPC, amount), so the only possible effect is funding us, and the claimed
    /// juice pays for its own claim (`claim_and_end_setup` credits non-revertibly during setup),
    /// so this works exactly when it matters: with the FPC near empty.
    ///
    /// Top-of-stack like the sponsor entrypoints: wrapped in an account tx, the fee cap would
    /// subsidize the wrapper's other calls. The cap is min(refuel overhead at config prices,
    /// amount) -- never net-negative, and a griefer can burn at most the overhead cap of a
    /// message into sequencer fees. Losing a claim race costs nothing: the duplicate message
    /// nullifier drops the tx before any fee is charged.
    #[external("private")]
    #[allow_phase_change]
    fn refuel(amount: u128, message_leaf_index: Field) {
        assert(
            self.context.maybe_msg_sender() == Option::none(),
            "msg_sender must be none for refuel",
        );
        let config = self.storage.config.read();

        let overhead_cap = overhead_max_fee(
            REFUEL_OVERHEAD_GAS,
            config.max_fee_per_da_gas,
            config.max_fee_per_l2_gas,
        );
        let cap = if overhead_cap <= amount {
            overhead_cap
        } else {
            amount
        };
        self.internal._assert_fee_within_max(cap);

        // Races make stale proven refuels the common case; keep them out of the mempool.
        let _ = bounded_anchor_timestamp(self.context);

        self.context.set_as_fee_payer();
        FeeJuice::at(FEE_JUICE_ADDRESS)
            .claim_and_end_setup(
                self.context.this_address(),
                amount,
                config.claim_secret,
                message_leaf_index,
            )
            .call(self.context);
    }

    /// Pop the user's SubscriptionNote for THIS rail, spend one use (or refill), and re-insert.
    /// The rail select is what keeps the rails' allowances apart: a user holding several notes
    /// spends only the one the batch rides. The elapsed time a refill sees is genuine to within one
    /// TTL: `refilled_at` was stamped from a bounded anchor, and the popped note only exists in
    /// anchors at or after its insertion.
    #[internal("private")]
    fn _consume_subscription(user: AztecAddress, rail_id: u8, rail: Rail, anchor_ts: u64) {
        let options = NoteGetterOptions::new()
            .select(SubscriptionNote::properties().rail, Comparator.EQ, rail_id)
            .set_limit(1);
        let subscriptions = self.storage.subscriptions.at(user).pop_notes(options);
        assert(subscriptions.len() > 0, "No active subscription for this rail");
        let refreshed = refresh_subscription_note(
            subscriptions.get(0),
            anchor_ts,
            rail.max_tx,
            rail.refill_period,
        );
        self.storage.subscriptions.at(user).insert(refreshed).deliver(
            MessageDelivery::onchain_unconstrained(),
        );
    }

    /// Shared entrypoint gate: top-of-stack, every non-empty call matched against the RAIL'S policy
    /// by the selector it actually runs (`bound_selector` -- a public call's comes from its
    /// calldata, whose preimage the caller supplies and the circuit binds to the dispatched hash),
    /// including legs back into this contract. Returns the config (one historical read), the rail
    /// (asserted configured), and the batch fee cap: this contract's own `CLAIM_FPC_OVERHEAD_GAS`
    /// priced at the config's sponsored fee-per-gas (once, whatever the batch shape) plus the SUM of
    /// the matched entries' marginal max_fees -- each call brings its own budget and batches
    /// compose. A BY_ANY entry's max_fee is a per-batch budget instead: counted AT MOST ONCE however
    /// many calls match through it (config.nr).
    #[internal("private")]
    fn _entrypoint_preamble(
        rail_id: u8,
        calls: [FunctionCall; MAX_SPONSORED_CALLS],
        class_witnesses: [ClassWitness; MAX_SPONSORED_CALLS],
        policy_witnesses: [PolicyMerkleProof; MAX_SPONSORED_CALLS],
        public_calldata: [[Field; MAX_PUBLIC_CALLDATA_FIELDS]; MAX_SPONSORED_CALLS],
        public_calldata_lens: [u32; MAX_SPONSORED_CALLS],
    ) -> (Config, Rail, u128) {
        assert(
            self.context.maybe_msg_sender() == Option::none(),
            "msg_sender must be none for sponsored calls",
        );
        let config = self.storage.config.read();
        let rail = rail_at(config, rail_id);
        assert(!calls[0].target_address.is_zero(), "primary call must be set");

        let mut batch_max_fee: u128 = overhead_max_fee(
            CLAIM_FPC_OVERHEAD_GAS,
            config.max_fee_per_da_gas,
            config.max_fee_per_l2_gas,
        );
        let mut any_budget_counted = false;
        for i in 0..MAX_SPONSORED_CALLS {
            let call = calls[i];
            if !call.target_address.is_zero() {
                let (entry_max_fee, matched_by_any) = assert_call_whitelisted(
                    call.target_address,
                    bound_selector(
                        call.function_selector.to_field(),
                        call.is_public,
                        public_calldata[i],
                        public_calldata_lens[i],
                        call.args_hash,
                    ),
                    class_witnesses[i],
                    policy_witnesses[i],
                    self.context.this_address(),
                    rail.policy_root,
                );
                let (total, counted) = add_entry_budget(
                    batch_max_fee,
                    entry_max_fee,
                    matched_by_any,
                    any_budget_counted,
                );
                batch_max_fee = total;
                any_budget_counted = counted;
            }
        }
        (config, rail, batch_max_fee)
    }

    /// Dispatch the matched batch, in order. Nothing is special-cased: the account's
    /// `authorize_intents`, token spends, the token's `notify_sipa_recipient` and the Broadcaster's
    /// L1-operation broadcasts all ride it as policy-matched calls, built client-side.
    ///
    /// Private legs are called with their args hash; public ones are ENQUEUED with their calldata
    /// hash (`FunctionCall.args_hash` IS the calldata hash when `is_public`) -- the same hash the
    /// preamble bound the matched selector to, so what the policy matched is what runs. Either way
    /// the preimage rides the tx's hashed args, so the PXE resolves it.
    #[internal("private")]
    fn _dispatch_calls(calls: [FunctionCall; MAX_SPONSORED_CALLS]) {
        for i in 0..MAX_SPONSORED_CALLS {
            let call = calls[i];
            if !call.target_address.is_zero() {
                // msg_sender stays the FPC so a dispatched call's consumers can verify the authwits
                // the user signed against it.
                assert(!call.hide_msg_sender, "sponsored calls must not hide msg_sender");
                if call.is_public {
                    self.context.call_public_function_with_calldata_hash(
                        call.target_address,
                        call.args_hash,
                        call.is_static,
                        false,
                    );
                } else {
                    let _result = self.context.call_private_function_with_args_hash(
                        call.target_address,
                        call.function_selector,
                        call.args_hash,
                        call.is_static,
                    );
                }
            }
        }
    }

    /// Private fee cap: asserting in private means an over-limit tx cannot even be proven, so the
    /// FPC can never be forced to pay more than the whitelist allows.
    #[internal("private")]
    fn _assert_fee_within_max(max_fee: u128) {
        let gas_settings = self.context.gas_settings();
        let total_gas = gas_settings.gas_limits + gas_settings.teardown_gas_limits;
        let max_possible_fee: u128 = (total_gas.da_gas as u128)
            * gas_settings.max_fees_per_gas.fee_per_da_gas
            + (total_gas.l2_gas as u128) * gas_settings.max_fees_per_gas.fee_per_l2_gas;
        assert(max_possible_fee <= max_fee, "Gas settings exceed whitelist max_fee");
    }

    /// The L1 OxideAccount a bootstrap key controls, bound to `user`: CREATE2-derive the account
    /// from the key, then require that key's signature over the L2 address. Deriving the account
    /// rather than taking it is what stops a caller naming somebody else's L1 identity; the
    /// signature is what stops an observer of the (public) L1 data pointing that identity at an
    /// address of their own. Both gates rest on this, and it is why both grant the same thing:
    /// whoever holds a bootstrap key may subscribe an L2 address of their choosing, and the rail's
    /// nullifier keys on the account, so doing it for a stranger spends the holder's own allowance.
    #[contract_library_method]
    fn bound_oxide_account(
        config: Config,
        user: AztecAddress,
        bootstrap_pub_key_x: [u8; 32],
        bootstrap_pub_key_y: [u8; 32],
        binding_sig: [u8; 64],
    ) -> [u8; 20] {
        let oxide_account = derive_oxide_account(
            field_to_eth_address(config.factory_address),
            field_to_eth_address(config.implementation_address),
            eth_address_from_pubkey(bootstrap_pub_key_x, bootstrap_pub_key_y),
        );
        assert(
            std::ecdsa_secp256k1::verify_signature(
                bootstrap_pub_key_x,
                bootstrap_pub_key_y,
                binding_sig,
                binding_digest(user),
            ),
            "invalid L2 binding signature",
        );
        oxide_account
    }

    #[contract_library_method]
    fn password_hash_of(password: str<31>) -> Field {
        poseidon2_hash(FieldCompressedString::from_string(password).serialize())
    }

    /// Whether `user` holds a subscription note for `rail_id` in THIS instance. Distinct from
    /// `get_subscription_uses`, whose 0 means either "no note" or "note exhausted until the next
    /// refill" -- a caller deciding between `subscribe` and `sponsor` must not conflate those:
    /// subscribing over a live note re-nullifies a spent nullifier and reverts. Subscriptions live
    /// in this contract's storage, so a redeployed ClaimFPC answers false for everyone.
    #[external("utility")]
    unconstrained fn has_subscription(user: AztecAddress, rail_id: u8) -> pub bool {
        let options = NoteViewerOptions::new()
            .select(SubscriptionNote::properties().rail, Comparator.EQ, rail_id)
            .set_limit(1);
        self.storage.subscriptions.at(user).view_notes(options).len() > 0
    }

    /// Remaining sponsored txs for `user` on `rail_id`, summed over every note it holds there (a
    /// gifted rail may hold several); 0 when no subscription exists.
    #[external("utility")]
    unconstrained fn get_subscription_uses(user: AztecAddress, rail_id: u8) -> pub u32 {
        let options = NoteViewerOptions::new().select(
            SubscriptionNote::properties().rail,
            Comparator.EQ,
            rail_id,
        );
        let notes = self.storage.subscriptions.at(user).view_notes(options);
        let mut uses: u32 = 0;
        for i in 0..notes.len() {
            uses += notes.get_unchecked(i).uses;
        }
        uses
    }

    #[external("utility")]
    unconstrained fn get_config() -> pub Config {
        self.storage.config.read()
    }

    /// Deploy-tooling idempotency: deployed-but-unconfigured instances answer false and every
    /// entrypoint fails its config read until `configure` lands.
    #[external("utility")]
    unconstrained fn is_configured() -> pub bool {
        self.storage.config.is_initialized()
    }
}
