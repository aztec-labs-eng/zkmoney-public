use aztec::protocol::{
    address::{AztecAddress, SaltedInitializationHash},
    constants::DOM_SEP__PUBLIC_CALLDATA,
    contract_class_id::ContractClassId,
    hash::{poseidon2_hash_subarray, poseidon2_hash_with_separator},
    public_keys::PublicKeys,
    traits::{Deserialize, FromField, Packable, Serialize, ToField},
};
use std::meta::derive;

/// Longest public calldata a sponsored call may carry: the selector plus 15 argument fields. The
/// bound exists because the circuit has to hold the whole preimage to bind the selector (below);
/// private legs are unaffected, since only their args HASH rides the batch.
pub global MAX_PUBLIC_CALLDATA_FIELDS: u32 = 16;

pub global POLICY_TREE_DEPTH: u32 = 6;
pub global POLICY_TREE_LEAVES: u8 = 64;
pub global DOM_SEP__CLAIM_FPC_POLICY_LEAF: u32 = 1239;
pub global DOM_SEP__CLAIM_FPC_POLICY_NODE: u32 = 1240;

pub global KIND_BY_ADDRESS: u8 = 1;
pub global KIND_BY_CLASS: u8 = 2;
pub global KIND_BY_SELF: u8 = 3;
pub global KIND_BY_ANY: u8 = 4;

/// One sponsorable call shape. `target` is an address (BY_ADDRESS), a contract class id
/// (BY_CLASS -- per-instance addresses like paylink escrows or fresh accounts are unknowable at
/// deploy time, their class is not), or unused and zero (BY_SELF -- the FPC's own `#[only_self]`
/// functions, where the target is the FPC address by definition; and BY_ANY).
///
/// A BY_ANY entry (`target` and `selector` zero) matches ANY dispatched call, this contract's own
/// `#[only_self]` functions included. A policy carrying one sponsors openly: funds cannot be stolen
/// through dispatch (fee juice is non-transferable and user assets stay authwit-gated), so the
/// entry's budget bounds the only exposure, metered waste. What keeps the ENTRYPOINTS off that list
/// is not the policy but `msg_sender must be none` -- a dispatched call carries the FPC as sender,
/// so `subscribe`, `sponsor` and `refuel` refuse it however a policy is written.
///
/// `max_fee` is the call's MARGINAL fee budget -- except for BY_ANY, where it is a PER-BATCH
/// budget counted AT MOST ONCE however many calls match through it. A batch's cap is the
/// entrypoint overhead (`gas.nr`, priced at the config's fee-per-gas) plus the BY_ANY budget
/// (once, if used) plus the sum over the specific entries the batch matched, so multi-call
/// batches pay the overhead once and a batch dispatched openly is bounded flat.
#[derive(Deserialize, Eq, Packable, Serialize)]
pub struct WhitelistEntry {
    pub kind: u8,
    pub target: Field,
    pub selector: Field,
    pub max_fee: u128,
}

/// Rail slots a deployment can carry. A deployment names as many as it needs and leaves the rest
/// empty; the count is fixed because the config is one `PublicImmutable` of fixed layout.
pub global MAX_RAILS: u32 = 4;

/// The `gate_selector` of a rail no one can subscribe on: its notes arrive by `gift_voucher` alone.
/// Nonzero, so the slot counts as configured, and no function's selector, so `subscribe` refuses
/// the rail before calling anything. Mirrored by `CLAIM_FPC_GATE_NONE` in the sdk.
pub global GATE_NONE: Field = 1;

/// One sponsorship rail: the gate that admits a user, the policy that bounds what their batches may
/// carry, and the allowance the subscription starts with. Rails are independent -- a user can hold
/// a subscription on several at once, and each gate answers only for its own.
///
/// `gate_selector` names an `#[only_self]` private function of this contract that returns a
/// `GateReceipt` (gate.nr). Zero marks an empty slot, so no rail can be reached by accident;
/// `GATE_NONE` marks a rail entered by gift alone. `refill_period` of zero never refills: that
/// allowance is all the rail will ever grant (notes.nr).
#[derive(Deserialize, Eq, Packable, Serialize)]
pub struct Rail {
    pub gate_selector: Field,
    pub policy_root: Field,
    pub max_tx: u32,
    pub refill_period: u64,
}

/// The rail `rail_id` names. Both asserts are the fail-closed boundary of every entrypoint: a
/// deployment's rails are exactly the non-empty slots its config was configured with.
pub fn rail_at(config: Config, rail_id: u8) -> Rail {
    assert((rail_id as u32) < MAX_RAILS, "rail id out of range");
    let rail = config.rails[rail_id as u32];
    assert(rail.gate_selector != 0, "rail not configured");
    rail
}

/// The FPC's entire configuration, fixed by the one-shot `configure` in one `PublicImmutable`
/// (WithHash-backed: a private read is ONE historical storage proof regardless of size). Changing
/// anything means deploying (and funding) a new FPC -- an unfunded FPC is inert, so deployment is
/// the update mechanism and there is no admin surface.
#[derive(Deserialize, Eq, Packable, Serialize)]
pub struct Config {
    /// The domain owner's full secp256k1 pubkey, each coordinate split into 16-byte halves (a
    /// coordinate exceeds the field modulus). The circuit verifies claim signatures against it
    /// directly; the deploy-time audit is checking keccak(pubkey)[12..] == `Registry.domainOwner`.
    pub domain_owner_pub_key_x_hi: Field,
    pub domain_owner_pub_key_x_lo: Field,
    pub domain_owner_pub_key_y_hi: Field,
    pub domain_owner_pub_key_y_lo: Field,
    /// The Registry's EIP-712 domain separator, split into two 16-byte halves.
    pub registry_domain_separator_hi: Field,
    pub registry_domain_separator_lo: Field,
    /// L1 `OxideAccountFactory` address and its `implementation` (ERC-1167 clone target).
    pub factory_address: Field,
    pub implementation_address: Field,
    /// L1 `NamePortal`: the ONLY sender whose name-ownership message the registration gate
    /// consumes. The content is public and `notify` is permissionless, so any other L1 address
    /// could emit the same bytes -- pinning the sender is what makes the message proof that the
    /// NameRegistry holds the name rather than proof of someone's willingness to pay L1 gas.
    pub name_portal_address: Field,
    /// The price this FPC sponsors at, per gas dimension -- the single fee decision a deploy makes.
    /// The circuit prices its own `CLAIM_FPC_OVERHEAD_GAS` (gas.nr) at these, and every entry's
    /// `max_fee` is gas priced the same way: a call's marginal gas, or the whole-batch gas caps
    /// for BY_ANY. A network base fee above them stops sponsorship until it falls back or a new
    /// FPC is deployed.
    pub max_fee_per_da_gas: u128,
    pub max_fee_per_l2_gas: u128,
    /// The rails this deployment offers, indexed by the `rail_id` its entrypoints take. Each root
    /// is a fixed-depth (64-leaf) Poseidon2 tree whose canonical manifest is public and lives
    /// off-chain; each sponsored call supplies its committed entry and six-sibling inclusion path.
    pub rails: [Rail; MAX_RAILS],
    /// Preimage of the secret hash oxide's skim pool attaches to every FeeJuicePortal deposit for
    /// this FPC. PUBLIC BY DESIGN (published in oxide's manifest): it gates nothing -- the message
    /// content hash already pins recipient and amount -- it only lets anyone run `refuel`.
    pub claim_secret: Field,
}

/// Address-derivation witness for a BY_CLASS whitelist match: proves the call's target address is
/// an instance of the whitelisted class.
#[derive(Deserialize, Eq, Serialize)]
pub struct ClassWitness {
    pub class_id: Field,
    pub salted_initialization_hash: Field,
    pub public_keys: PublicKeys,
}

impl ClassWitness {
    pub fn derive_address(self) -> AztecAddress {
        AztecAddress::compute_from_class_id(
            ContractClassId::from_field(self.class_id),
            SaltedInitializationHash::from_field(self.salted_initialization_hash),
            self.public_keys,
        )
    }
}

/// Merkle inclusion proof for one call against the immutable policy root.
/// `sibling_path` is bottom-up; `leaf_index` is constrained to 0..63 before its low bits choose left/right.
#[derive(Deserialize, Eq, Serialize)]
pub struct PolicyMerkleProof {
    pub entry: WhitelistEntry,
    pub leaf_index: u8,
    pub sibling_path: [Field; POLICY_TREE_DEPTH],
}

fn policy_leaf(entry: WhitelistEntry) -> Field {
    poseidon2_hash_with_separator(
        [entry.kind as Field, entry.target, entry.selector, entry.max_fee as Field],
        DOM_SEP__CLAIM_FPC_POLICY_LEAF,
    )
}

fn policy_node(left: Field, right: Field) -> Field {
    poseidon2_hash_with_separator([left, right], DOM_SEP__CLAIM_FPC_POLICY_NODE)
}

pub fn policy_merkle_root(proof: PolicyMerkleProof) -> Field {
    assert(proof.leaf_index < POLICY_TREE_LEAVES, "policy leaf index out of range");
    let mut index = proof.leaf_index;
    let mut current = policy_leaf(proof.entry);
    for level in 0..POLICY_TREE_DEPTH {
        let sibling = proof.sibling_path[level];
        let is_right = (index & 1) == 1;
        let left = if is_right { sibling } else { current };
        let right = if is_right { current } else { sibling };
        current = policy_node(left, right);
        index = index >> 1;
    }
    current
}

/// The function a call actually runs, as a selector the policy can bind.
///
/// A PRIVATE call runs `function_selector` -- the protocol dispatches on it. A PUBLIC call does not:
/// it is enqueued with a CALLDATA HASH, and the target's `public_dispatch` reads the function from
/// the calldata's FIRST FIELD, so `function_selector` is decorative there. A caller could name a
/// committed selector and have something else execute.
///
/// So for a public call the selector is taken from the calldata itself, and the calldata is bound to
/// the hash being dispatched: `hash_calldata_array` is
/// `poseidon2_hash_with_separator(calldata, DOM_SEP__PUBLIC_CALLDATA)`, which for a `len`-field
/// preimage equals `poseidon2_hash_subarray` over `[separator, ...calldata]` at `len + 1` (pinned by
/// `subarray_hash_reproduces_the_protocol_calldata_hash` below). The preimage is a witness the
/// caller supplies; substituting a different one changes the hash, and the hash is what executes.
pub fn bound_selector(
    call_selector: Field,
    is_public: bool,
    calldata: [Field; MAX_PUBLIC_CALLDATA_FIELDS],
    calldata_len: u32,
    calldata_hash: Field,
) -> Field {
    if is_public {
        assert(calldata_len > 0, "public calldata must carry its selector");
        assert(calldata_len <= MAX_PUBLIC_CALLDATA_FIELDS, "public calldata too long to sponsor");
        let mut with_separator: [Field; MAX_PUBLIC_CALLDATA_FIELDS + 1] =
            [0; MAX_PUBLIC_CALLDATA_FIELDS + 1];
        with_separator[0] = DOM_SEP__PUBLIC_CALLDATA as Field;
        for i in 0..MAX_PUBLIC_CALLDATA_FIELDS {
            with_separator[i + 1] = calldata[i];
        }
        assert(
            poseidon2_hash_subarray(with_separator, calldata_len + 1) == calldata_hash,
            "public calldata does not hash to the dispatched call",
        );
        calldata[0]
    } else {
        call_selector
    }
}

/// Verify one call against the leaf `policy_root` commits; returns that leaf's max_fee and whether
/// the match went through a BY_ANY entry (whose max_fee the caller must count at most once per
/// batch). `policy_root` is the rail's, so a batch is bounded by the policy of the rail it rides
/// and a leaf of some other rail proves nothing here.
///
/// Membership binds all four fields (kind, target/class, selector, max_fee) to the root. BY_CLASS
/// entries additionally require the call's target to derive from the entry's class id via
/// `class_witness`. BY_SELF entries match calls back into the FPC itself (`this_address`) and
/// require a zero target. What a BY_SELF entry authorizes is the FPC's own code, and the function
/// it names carries `#[only_self]`, so no caller outside a dispatched batch can reach it either.
/// BY_ANY entries match any target at all, and require a zero target and selector.
///
/// `selector` is the call's BOUND selector (`bound_selector`), so a public call is matched by the
/// function its calldata actually runs -- committed entries bind public and private calls alike.
pub fn assert_call_whitelisted(
    target_address: AztecAddress,
    selector: Field,
    class_witness: ClassWitness,
    policy_witness: PolicyMerkleProof,
    this_address: AztecAddress,
    policy_root: Field,
) -> (u128, bool) {
    assert(policy_merkle_root(policy_witness) == policy_root, "invalid policy merkle proof");

    let entry = policy_witness.entry;
    let derived_from_class = class_witness.derive_address();
    if entry.kind == KIND_BY_CLASS {
        assert(
            derived_from_class == target_address,
            "class witness does not derive the call target",
        );
    }
    let matched_by_address = (entry.kind == KIND_BY_ADDRESS)
        & (entry.target == target_address.to_field())
        & (entry.selector == selector);
    let matched_by_class = (entry.kind == KIND_BY_CLASS)
        & (entry.target == class_witness.class_id)
        & (entry.selector == selector);
    let matched_by_self = (entry.kind == KIND_BY_SELF)
        & (entry.target == 0)
        & (target_address == this_address)
        & (entry.selector == selector);
    let matched_by_any =
        (entry.kind == KIND_BY_ANY) & (entry.target == 0) & (entry.selector == 0);
    let matched = matched_by_address | matched_by_class | matched_by_self | matched_by_any;
    assert(matched, "call not whitelisted");
    (entry.max_fee, matched_by_any)
}

/// Fold one matched entry into a batch's fee cap. A specific entry's `max_fee` is that call's own
/// budget and adds every time it matches; a BY_ANY entry's is the whole batch's, so it adds at most
/// once however many calls come through it. `any_counted` carries that across the dispatch loop.
pub fn add_entry_budget(
    total: u128,
    entry_max_fee: u128,
    matched_by_any: bool,
    any_counted: bool,
) -> (u128, bool) {
    if matched_by_any {
        if any_counted {
            (total, true)
        } else {
            (total + entry_max_fee, true)
        }
    } else {
        (total + entry_max_fee, any_counted)
    }
}

// -- tests -------------------------------------------------------------------

global TEST_SELF: AztecAddress = AztecAddress::from_field(0xfec);

#[test]
fn whitelist_matches_a_private_call() {
    let target = AztecAddress::from_field(0x1234);
    let entry =
        WhitelistEntry { kind: KIND_BY_ADDRESS, target: 0x1234, selector: 0xabcd, max_fee: 7 };
    let policy_witness = test_policy_merkle_proof(entry);
    let (fee, is_by_any) = assert_call_whitelisted(
        target,
        0xabcd,
        test_witness(),
        policy_witness,
        TEST_SELF,
        policy_merkle_root(policy_witness),
    );
    assert(fee == 7);
    assert(!is_by_any);
}

#[test]
fn whitelist_matches_a_self_call() {
    let entry = WhitelistEntry { kind: KIND_BY_SELF, target: 0, selector: 0xabcd, max_fee: 9 };
    let policy_witness = test_policy_merkle_proof(entry);
    let (fee, is_by_any) = assert_call_whitelisted(
        TEST_SELF,
        0xabcd,
        test_witness(),
        policy_witness,
        TEST_SELF,
        policy_merkle_root(policy_witness),
    );
    assert(fee == 9);
    assert(!is_by_any);
}

#[test]
fn by_any_entry_matches_any_foreign_private_call() {
    let entry = WhitelistEntry { kind: KIND_BY_ANY, target: 0, selector: 0, max_fee: 11 };
    let policy_witness = test_policy_merkle_proof(entry);
    let (fee, is_by_any) = assert_call_whitelisted(
        AztecAddress::from_field(0x1234),
        0xabcd,
        test_witness(),
        policy_witness,
        TEST_SELF,
        policy_merkle_root(policy_witness),
    );
    assert(fee == 11);
    assert(is_by_any);
}

#[test]
fn by_any_entry_matches_a_call_into_the_fpc() {
    // BY_ANY is unqualified: it opens the FPC's own `#[only_self]` functions too, so a policy that
    // carries one needs no separate BY_SELF leaf for them. The entrypoints stay out of reach
    // regardless, on `msg_sender must be none` rather than on the policy.
    let entry = WhitelistEntry { kind: KIND_BY_ANY, target: 0, selector: 0, max_fee: 11 };
    let policy_witness = test_policy_merkle_proof(entry);
    let (fee, is_by_any) = assert_call_whitelisted(
        TEST_SELF,
        0xabcd,
        test_witness(),
        policy_witness,
        TEST_SELF,
        policy_merkle_root(policy_witness),
    );
    assert(fee == 11);
    assert(is_by_any);
}

#[test(should_fail_with = "call not whitelisted")]
fn by_any_entry_with_a_nonzero_target_fails_closed() {
    let entry = WhitelistEntry { kind: KIND_BY_ANY, target: 0x1234, selector: 0, max_fee: 11 };
    let policy_witness = test_policy_merkle_proof(entry);
    let _ = assert_call_whitelisted(
        AztecAddress::from_field(0x1234),
        0xabcd,
        test_witness(),
        policy_witness,
        TEST_SELF,
        policy_merkle_root(policy_witness),
    );
}

#[test(should_fail_with = "call not whitelisted")]
fn by_any_entry_with_a_nonzero_selector_fails_closed() {
    // Zero selector is what keeps a BY_ANY leaf from doubling as a wildcard-target entry.
    let entry = WhitelistEntry { kind: KIND_BY_ANY, target: 0, selector: 0xabcd, max_fee: 11 };
    let policy_witness = test_policy_merkle_proof(entry);
    let _ = assert_call_whitelisted(
        AztecAddress::from_field(0x1234),
        0xabcd,
        test_witness(),
        policy_witness,
        TEST_SELF,
        policy_merkle_root(policy_witness),
    );
}

#[test(should_fail_with = "call not whitelisted")]
fn self_entry_does_not_match_a_foreign_target() {
    // The selector alone must not open a foreign contract: BY_SELF binds the target to the FPC.
    let entry = WhitelistEntry { kind: KIND_BY_SELF, target: 0, selector: 0xabcd, max_fee: 9 };
    let other = AztecAddress::from_field(0x1234);
    let policy_witness = test_policy_merkle_proof(entry);
    let _ = assert_call_whitelisted(
        other,
        0xabcd,
        test_witness(),
        policy_witness,
        TEST_SELF,
        policy_merkle_root(policy_witness),
    );
}

#[test(should_fail_with = "call not whitelisted")]
fn self_entry_with_a_nonzero_target_fails_closed() {
    let entry = WhitelistEntry { kind: KIND_BY_SELF, target: 0x1234, selector: 0xabcd, max_fee: 9 };
    let policy_witness = test_policy_merkle_proof(entry);
    let _ = assert_call_whitelisted(
        TEST_SELF,
        0xabcd,
        test_witness(),
        policy_witness,
        TEST_SELF,
        policy_merkle_root(policy_witness),
    );
}

#[test(should_fail_with = "call not whitelisted")]
fn a_self_call_needs_its_own_entry() {
    // A BY_ADDRESS entry for some other contract must not let a call into the FPC through.
    let entry =
        WhitelistEntry { kind: KIND_BY_ADDRESS, target: 0x1234, selector: 0xabcd, max_fee: 7 };
    let policy_witness = test_policy_merkle_proof(entry);
    let _ = assert_call_whitelisted(
        TEST_SELF,
        0xabcd,
        test_witness(),
        policy_witness,
        TEST_SELF,
        policy_merkle_root(policy_witness),
    );
}

#[test(should_fail_with = "invalid policy merkle proof")]
fn policy_merkle_proof_cannot_change_a_committed_fee() {
    let target = AztecAddress::from_field(0x1234);
    let entry =
        WhitelistEntry { kind: KIND_BY_ADDRESS, target: 0x1234, selector: 0xabcd, max_fee: 7 };
    let committed = test_policy_merkle_proof(entry);
    let changed = test_policy_merkle_proof(
        WhitelistEntry { kind: KIND_BY_ADDRESS, target: 0x1234, selector: 0xabcd, max_fee: 8 },
    );
    let _ = assert_call_whitelisted(
        target,
        0xabcd,
        test_witness(),
        changed,
        TEST_SELF,
        policy_merkle_root(committed),
    );
}

#[test(should_fail_with = "policy leaf index out of range")]
fn policy_merkle_proof_rejects_an_index_outside_the_fixed_tree() {
    let entry =
        WhitelistEntry { kind: KIND_BY_ADDRESS, target: 0x1234, selector: 0xabcd, max_fee: 7 };
    let mut policy_witness = test_policy_merkle_proof(entry);
    policy_witness.leaf_index = POLICY_TREE_LEAVES;
    let _ = policy_merkle_root(policy_witness);
}

#[test]
fn policy_root_matches_typescript_builder() {
    // packages/sdk/test/feePaymentMethod/claimFpcPolicy.test.ts: the second leaf in its three-entry
    // policy, padded with 61 canonical empty leaves. This catches separator, field-order,
    // padding, index-bit, and sibling-order drift across the ABI boundary.
    let witness = PolicyMerkleProof {
        entry: WhitelistEntry { kind: KIND_BY_CLASS, target: 0x102, selector: 0x202, max_fee: 12 },
        leaf_index: 1,
        sibling_path: [
            0x257857454af9dde5f54aa0307948d0d1d6f41c92cee16c7a8599979d5b0abe8c,
            0x2de03ff10a62c8347db7e10667b34a35aebd608f98ebf46ba191bb15c4b0aaea,
            0x01a8d53d1fa97e760f19ea8385a777d2660b3615412ce4c381cfd562a89b7889,
            0x04f2429580a6148ef625520387e38373d6e7e09380f5ca9ce73288ab98e05b45,
            0x17645d95165a7995e5ad1c0771d685fa8f2575e20c6fcfc7729628b44e0e2682,
            0x1e6930d6c22422844f4a3988a2f8744e5179efdc4e13e5acb82cf4c5a16d2c41,
        ],
    };
    assert(
        policy_merkle_root(witness)
            == 0x137155a814cbe1b4698468c4f8df80a01e5788e2f7ffa6f0fec1d7b8978f1fdd,
    );
}

#[test]
fn subarray_hash_reproduces_the_protocol_calldata_hash() {
    // `bound_selector`'s equality check only binds the calldata if this holds: the padded
    // separator-prefixed subarray hash IS `hash_calldata_array` for the same preimage.
    let calldata: [Field; 3] = [0xabcd, 11, 22];
    let dispatched = poseidon2_hash_with_separator(calldata, DOM_SEP__PUBLIC_CALLDATA);
    let mut padded: [Field; MAX_PUBLIC_CALLDATA_FIELDS] = [0; MAX_PUBLIC_CALLDATA_FIELDS];
    for i in 0..3 {
        padded[i] = calldata[i];
    }
    assert(bound_selector(0xdead, true, padded, 3, dispatched) == 0xabcd);
}

#[test]
fn a_private_call_is_bound_by_its_function_selector() {
    let empty: [Field; MAX_PUBLIC_CALLDATA_FIELDS] = [0; MAX_PUBLIC_CALLDATA_FIELDS];
    assert(bound_selector(0xabcd, false, empty, 0, 0) == 0xabcd);
}

#[test(should_fail_with = "public calldata does not hash to the dispatched call")]
fn a_public_call_cannot_claim_a_selector_its_calldata_does_not_run() {
    // THE attack: name a committed selector in `function_selector`, then dispatch calldata whose
    // first field runs something else. The calldata the FPC binds is the one that executes, so the
    // substituted preimage no longer hashes to it.
    let executed: [Field; 3] = [0xbeef, 11, 22];
    let dispatched = poseidon2_hash_with_separator(executed, DOM_SEP__PUBLIC_CALLDATA);
    let mut lied_about: [Field; MAX_PUBLIC_CALLDATA_FIELDS] = [0; MAX_PUBLIC_CALLDATA_FIELDS];
    lied_about[0] = 0xabcd; // the whitelisted selector
    lied_about[1] = 11;
    lied_about[2] = 22;
    let _ = bound_selector(0xabcd, true, lied_about, 3, dispatched);
}

#[test(should_fail_with = "public calldata does not hash to the dispatched call")]
fn a_public_call_cannot_shorten_its_calldata_to_fit_a_hash() {
    let executed: [Field; 3] = [0xabcd, 11, 22];
    let dispatched = poseidon2_hash_with_separator(executed, DOM_SEP__PUBLIC_CALLDATA);
    let mut padded: [Field; MAX_PUBLIC_CALLDATA_FIELDS] = [0; MAX_PUBLIC_CALLDATA_FIELDS];
    for i in 0..3 {
        padded[i] = executed[i];
    }
    // Same fields, wrong length: the sponge's length-derived IV moves the hash.
    let _ = bound_selector(0xabcd, true, padded, 2, dispatched);
}

#[test(should_fail_with = "public calldata must carry its selector")]
fn empty_public_calldata_fails_closed() {
    let empty: [Field; MAX_PUBLIC_CALLDATA_FIELDS] = [0; MAX_PUBLIC_CALLDATA_FIELDS];
    let _ = bound_selector(0xabcd, true, empty, 0, 0);
}

#[test]
fn a_committed_entry_matches_a_public_call_through_its_calldata() {
    // A per-call policy sponsors public functions: the entry commits (target, selector) and the
    // selector matched is the one the calldata runs.
    let calldata: [Field; 2] = [0xabcd, 7];
    let dispatched = poseidon2_hash_with_separator(calldata, DOM_SEP__PUBLIC_CALLDATA);
    let mut padded: [Field; MAX_PUBLIC_CALLDATA_FIELDS] = [0; MAX_PUBLIC_CALLDATA_FIELDS];
    padded[0] = calldata[0];
    padded[1] = calldata[1];
    let entry =
        WhitelistEntry { kind: KIND_BY_ADDRESS, target: 0x1234, selector: 0xabcd, max_fee: 7 };
    let policy_witness = test_policy_merkle_proof(entry);
    let (fee, is_by_any) = assert_call_whitelisted(
        AztecAddress::from_field(0x1234),
        bound_selector(0xabcd, true, padded, 2, dispatched),
        test_witness(),
        policy_witness,
        TEST_SELF,
        policy_merkle_root(policy_witness),
    );
    assert(fee == 7);
    assert(!is_by_any);
}

fn test_witness() -> ClassWitness {
    ClassWitness { class_id: 0, salted_initialization_hash: 0, public_keys: PublicKeys::default() }
}

fn test_policy_merkle_proof(entry: WhitelistEntry) -> PolicyMerkleProof {
    PolicyMerkleProof { entry, leaf_index: 0, sibling_path: [0; POLICY_TREE_DEPTH] }
}

fn empty_rail() -> Rail {
    Rail { gate_selector: 0, policy_root: 0, max_tx: 0, refill_period: 0 }
}

fn test_config(rails: [Rail; MAX_RAILS]) -> Config {
    Config {
        domain_owner_pub_key_x_hi: 0,
        domain_owner_pub_key_x_lo: 0,
        domain_owner_pub_key_y_hi: 0,
        domain_owner_pub_key_y_lo: 0,
        registry_domain_separator_hi: 0,
        registry_domain_separator_lo: 0,
        factory_address: 0,
        implementation_address: 0,
        name_portal_address: 0,
        max_fee_per_da_gas: 0,
        max_fee_per_l2_gas: 0,
        rails,
        claim_secret: 0,
    }
}

fn two_rail_config() -> Config {
    test_config([
        Rail { gate_selector: 0xa1, policy_root: 0xb1, max_tx: 1, refill_period: 0 },
        Rail { gate_selector: 0xa2, policy_root: 0xb2, max_tx: 100, refill_period: 86400 },
        empty_rail(),
        empty_rail(),
    ])
}

#[test]
fn a_configured_rail_is_readable_by_its_id() {
    let strict = rail_at(two_rail_config(), 0);
    assert(strict.gate_selector == 0xa1);
    assert(strict.policy_root == 0xb1);
    assert(strict.max_tx == 1);
    assert(strict.refill_period == 0);
    let open = rail_at(two_rail_config(), 1);
    assert(open.gate_selector == 0xa2);
    assert(open.max_tx == 100);
}

#[test(should_fail_with = "rail id out of range")]
fn a_rail_id_past_the_last_slot_is_refused() {
    let _ = rail_at(two_rail_config(), MAX_RAILS as u8);
}

#[test(should_fail_with = "rail not configured")]
fn an_empty_rail_slot_is_not_a_rail() {
    // Zero gate_selector is the empty marker, so unused slots can never be subscribed to.
    let _ = rail_at(two_rail_config(), 2);
}

#[test(should_fail_with = "invalid policy merkle proof")]
fn a_leaf_of_one_rail_does_not_prove_against_another() {
    // What keeps a strict rail strict: the batch is matched against the root of the rail it rides,
    // so the open rail's BY_ANY leaf buys nothing on the strict one.
    let by_any = WhitelistEntry { kind: KIND_BY_ANY, target: 0, selector: 0, max_fee: 11 };
    let open_witness = test_policy_merkle_proof(by_any);
    let strict_root = policy_merkle_root(
        test_policy_merkle_proof(
            WhitelistEntry { kind: KIND_BY_ADDRESS, target: 0x1234, selector: 0xabcd, max_fee: 7 },
        ),
    );
    let _ = assert_call_whitelisted(
        AztecAddress::from_field(0x1234),
        0xabcd,
        test_witness(),
        open_witness,
        TEST_SELF,
        strict_root,
    );
}

#[test]
fn a_by_any_budget_is_charged_once_per_batch() {
    // Two calls through the same BY_ANY entry cost one budget; a third through a specific entry
    // adds its own on top.
    let (after_first, counted) = add_entry_budget(100, 30, true, false);
    assert(after_first == 130);
    assert(counted);
    let (after_second, still_counted) = add_entry_budget(after_first, 30, true, counted);
    assert(after_second == 130);
    assert(still_counted);
    let (with_specific, _) = add_entry_budget(after_second, 7, false, still_counted);
    assert(with_specific == 137);
}

#[test]
fn specific_entry_budgets_add_per_call() {
    let (one, counted) = add_entry_budget(0, 7, false, false);
    let (two, _) = add_entry_budget(one, 7, false, counted);
    assert(two == 14);
    // A BY_ANY match after specific ones still gets its single budget.
    let (with_any, _) = add_entry_budget(two, 30, true, false);
    assert(with_any == 44);
}
