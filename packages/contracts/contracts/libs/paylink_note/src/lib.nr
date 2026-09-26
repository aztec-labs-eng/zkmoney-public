use oxide_token_contract::OxideToken;
use aztec::{
    context::PrivateContext,
    macros::notes::note,
    note::{lifecycle::destroy_note, note_getter::get_note},
    oracle::logging::debug_log_format,
    protocol::{
        address::{AztecAddress, EthAddress},
        traits::{Deserialize, FromField, Packable, Serialize, ToField},
    },
};
use poseidon::poseidon2::Poseidon2;

/// `Transfer.meta` width. Every paylink transfer takes a caller-supplied meta: the deposit's carries
/// the creator's memo and tag to the escrow's `Transfer` event, where a link holder reads it; the
/// claim and refund legs forward whatever the caller read there, so the payout event carries it too.
pub global TRANSFER_META_LEN: u32 = OxideToken::TRANSFER_META_LEN;

/// Note for a Paylink
/// - hash: the committed data (the email hash); direct paylinks use a fixed DIRECT_HASH
/// - sender_hash: so the initiator can reclaim in the appropriate time range
/// - data: packed amount and claim window
/// - refundable_until: end of the creator refund window, which opens at creation
/// - oidc_key_registry/vkey_hash: optional email-zk binding fields; non-email
///   paylinks set these to zero.
#[derive(Eq, Packable, Serialize, Deserialize)]
#[note]
pub struct PaylinkNote {
    pub hash: Field,
    pub sender_hash: Field,
    pub data: Field,
    pub refundable_until: Field,
    pub oidc_key_registry: AztecAddress,
    pub vkey_hash: Field,
    pub token_address: AztecAddress,
}

// =============================================
// PACKING / UNPACKING
// =============================================

/// Packs a u128 amount and two u64 timestamps into a single Field element.
///
/// Memory layout (32 bytes total):
/// - Bytes 0-15:  amount (u128)
/// - Bytes 16-23: from_claimable (u64)
/// - Bytes 24-31: until_claimable (u64)
pub fn pack_data(amount: u128, from_claimable: u64, until_claimable: u64) -> Field {
    let amount_bytes: [u8; 32] = (amount as Field).to_be_bytes();
    let from_claimable_bytes: [u8; 32] = (from_claimable as Field).to_be_bytes();
    let until_claimable_bytes: [u8; 32] = (until_claimable as Field).to_be_bytes();

    let mut combined: [u8; 32] = [0; 32];

    for i in 0..16 {
        combined[i] = amount_bytes[16 + i];
    }
    for i in 0..8 {
        combined[16 + i] = from_claimable_bytes[24 + i];
    }
    for i in 0..8 {
        combined[24 + i] = until_claimable_bytes[24 + i];
    }

    pack_be_bytes_into_field::<32, 32>(combined)
}

pub fn pack_be_bytes_into_field<let NBytes: u32, let MAX_FIELD_SIZE: u32>(
    x: [u8; NBytes],
) -> Field {
    let mut result: Field = 0;
    for i in 0..MAX_FIELD_SIZE {
        result *= 256;
        result += x[i] as Field;
    }
    result
}

/// Unpacks a Field element back into (amount, from_claimable, until_claimable).
pub fn unpack_data(data_field: Field) -> (u128, u64, u64) {
    let bytes: [u8; 32] = data_field.to_be_bytes();

    let mut amount: u128 = 0;
    for i in 0..16 {
        amount = amount * 256 + (bytes[i] as u128);
    }

    let mut from_claimable: u64 = 0;
    for i in 0..8 {
        from_claimable = from_claimable * 256 + (bytes[16 + i] as u64);
    }

    let mut until_claimable: u64 = 0;
    for i in 0..8 {
        until_claimable = until_claimable * 256 + (bytes[24 + i] as u64);
    }

    (amount, from_claimable, until_claimable)
}

/// Deposit-time window invariants shared by every flavor. The refund window opens at creation and
/// may overlap the claim window but never outlive it; past `until_claimable` the expired refund
/// branch takes over.
pub fn assert_windows(from_claimable: u64, until_claimable: u64, refundable_until: u64) {
    assert(from_claimable < until_claimable, "until_claimable must exceed from_claimable");
    assert(refundable_until <= until_claimable, "refundable_until must not exceed until_claimable");
}

// =============================================
// TIME GATES (no public calls)
// =============================================

/// Enforces `from <= now <= until` from the tx's own anchor block: the anchor already lies at or
/// past `from` and inclusion comes later still; the tx expires at `until`, so an over-late tx is
/// never included. A too-early call fails here in simulation, a too-late one is refused at send.
pub fn enforce_window(from: u64, until: u64, context: &mut PrivateContext) {
    assert(context.get_anchor_block_header().timestamp() >= from, "window not open");
    context.set_expiration_timestamp(until);
}

/// True once the anchor block already lies past `until`; inclusion is later still.
pub fn is_past(until: u64, context: &PrivateContext) -> bool {
    context.get_anchor_block_header().timestamp() > until
}

// =============================================
// TRANSFER HELPER
// =============================================

/// Calls OxideToken::transfer. `meta` lands unparsed in the recipient's `Transfer` event.
pub fn transfer(
    from: AztecAddress,
    to: AztecAddress,
    amount: u128,
    token_address: AztecAddress,
    meta: [Field; TRANSFER_META_LEN],
    context: &mut PrivateContext,
) {
    debug_log_format(
        "[PAYLINK_TRANSFER] from={0} to={1}",
        [from.to_field(), to.to_field()],
    );
    debug_log_format(
        "[PAYLINK_TRANSFER] amount={0} token={1}",
        [amount as Field, token_address.to_field()],
    );
    debug_log_format("[PAYLINK_TRANSFER] nonce=0 (hardcoded)", []);
    OxideToken::at(token_address).transfer(from, to, amount, meta, 0).call(context);
    debug_log_format("[PAYLINK_TRANSFER] transfer call complete", []);
}

// =============================================
// CLAIM (shared across paylink flavors)
// =============================================

/// Shared claim logic. Reads note, enforces claim window, checks commitment hash, transfers tokens.
pub fn execute_claim(
    sender: AztecAddress,
    contract_address: AztecAddress,
    from_claimable_val: u64,
    until_claimable_val: u64,
    token_address: AztecAddress,
    amount_val: u128,
    meta: [Field; TRANSFER_META_LEN],
    context: &mut PrivateContext,
) {
    enforce_window(from_claimable_val, until_claimable_val, context);

    transfer(
        contract_address,
        sender,
        amount_val,
        token_address,
        meta,
        context,
    );
}

/// Shared L1 claim: enforces the claim window, then burns the escrow's note through the token's
/// `withdraw` to `executor`, which runs the user payload that `user_payload_hash` commits to. The
/// escrow is `from`, so no authwit is needed. The prover tip comes out of the L1 payout at the
/// portal; the token rejects `prover_tip > amount`.
pub fn execute_claim_to_l1(
    executor: EthAddress,
    user_payload_hash: Field,
    prover_tip: u128,
    contract_address: AztecAddress,
    from_claimable_val: u64,
    until_claimable_val: u64,
    token_address: AztecAddress,
    amount_val: u128,
    context: &mut PrivateContext,
) {
    enforce_window(from_claimable_val, until_claimable_val, context);
    // Neither the token nor the enclave bounds the executor field; an over-wide value would burn
    // to an address L1 can never reconstruct.
    executor.validate();

    OxideToken::at(token_address)
        .withdraw(
            contract_address,
            executor,
            user_payload_hash,
            amount_val,
            prover_tip,
            [0; OxideToken::WITHDRAW_META_LEN],
            0,
        )
        .call(context);
}

pub fn get_note_and_unpack_data(
    context: &mut PrivateContext,
    commitment_hash: Field,
    storage_slot: Field,
) -> (PaylinkNote, u128, u64, u64) {
    let note = _get_note(context, storage_slot);
    assert(note.hash == commitment_hash, "Incorrect commitment to claim");
    let (amount_val, from_claimable_val, until_claimable_val) = unpack_data(note.data);
    (note, amount_val, from_claimable_val, until_claimable_val)
}
// =============================================
// REFUND (shared across paylink flavors)
// =============================================

/// Shared refund logic. Reads note, checks the sender binding, transfers tokens, then gates on
/// time from the anchor block: past `until_claimable` nothing more is needed; otherwise the tx
/// must land by `refundable_until` (the refund window opens at creation).
pub fn execute_refund(
    sender: AztecAddress,
    contract_address: AztecAddress,
    storage_slot: Field,
    meta: [Field; TRANSFER_META_LEN],
    context: &mut PrivateContext,
) {
    let sender_hash = Poseidon2::hash([sender.to_field()], 1);
    let note = _get_note(context, storage_slot);
    let (amount_val, _, until_claimable_val) = unpack_data(note.data);

    assert(sender_hash == note.sender_hash, "not the sender of the note");

    transfer(
        contract_address,
        sender,
        amount_val,
        note.token_address,
        meta,
        context,
    );

    if !is_past(until_claimable_val, context) {
        context.set_expiration_timestamp(note.refundable_until as u64);
    }
}

// =============================================
// NOTE GETTER
// =============================================

/// Reads the paylink note and pushes a nullifier to prevent replay.
/// A second call with the same storage_slot will fail due to duplicate nullifier.
pub fn _get_note(context: &mut PrivateContext, storage_slot: Field) -> PaylinkNote {
    let note = get_note(context, Option::none(), storage_slot).note;

    let nullifier = Poseidon2::hash([context.this_address().to_field(), storage_slot], 2);
    context.push_nullifier_unsafe(nullifier);

    note
}

// =============================================
// TESTS
// =============================================

#[test]
fn test_pack_unpack_timestamp_like_values() {
    let amount: u128 = 1000000000000000000;
    let from_claimable: u64 = 1704067200;
    let until_claimable: u64 = 1735689600;

    let packed = pack_data(amount, from_claimable, until_claimable);
    let (unpacked_amount, unpacked_from, unpacked_until) = unpack_data(packed);

    assert_eq(unpacked_amount, amount);
    assert_eq(unpacked_from, from_claimable);
    assert_eq(unpacked_until, until_claimable);
}

#[test(should_fail_with = "until_claimable must exceed from_claimable")]
fn test_assert_windows_rejects_empty_claim_window() {
    assert_windows(100, 100, 100);
}

#[test(should_fail_with = "refundable_until must not exceed until_claimable")]
fn test_assert_windows_rejects_refund_window_past_expiry() {
    assert_windows(0, 100, 101);
}

#[test]
fn test_assert_windows_accepts_overlapping_windows() {
    assert_windows(10, 100, 100);
}
