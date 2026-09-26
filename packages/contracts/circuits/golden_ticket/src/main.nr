//! Golden ticket: a paylink holder proves to the account-service that a paylink note of at least
//! `threshold` in `token` sits under `root`, siloed to an escrow of a paylink class, without revealing
//! the link. The proof is bound to one L1 `owner` and yields a per-escrow nullifier in its own domain.
use aztec::note::utils::compute_note_hash;
use aztec::protocol::{
    address::{AztecAddress, PartialAddress},
    constants::NOTE_HASH_TREE_HEIGHT,
    contract_class_id::ContractClassId,
    hash::{compute_siloed_note_hash, compute_unique_note_hash, poseidon2_hash_with_separator},
    merkle_tree::{check_membership, MembershipWitness},
    public_keys::PublicKeys,
    traits::{FromField, Packable, ToField},
};
use paylink_note::{PaylinkNote, unpack_data};

/// Both escrows keep the note in their first storage slot.
pub global PAYLINK_NOTE_STORAGE_SLOT: Field = 1;
/// "GOLD": keeps the ticket nullifier apart from the note's own nullifier.
pub global DOM_SEP__GOLDEN_TICKET: u32 = 0x474f4c44;

fn main(
    root: pub Field,
    threshold: pub u128,
    token: pub AztecAddress,
    class_ids: pub [Field; 2],
    owner: pub Field,
    note: PaylinkNote,
    randomness: Field,
    note_nonce: Field,
    witness: MembershipWitness<NOTE_HASH_TREE_HEIGHT>,
    public_keys: PublicKeys,
    class_id: Field,
) -> pub Field {
    assert(
        (class_id == class_ids[0]) | (class_id == class_ids[1]),
        "escrow class is not a paylink",
    );
    // Paylink escrows deploy with zero salt, init hash, deployer and immutables.
    let partial = PartialAddress::compute(
        ContractClassId::from_field(class_id),
        0,
        0,
        AztecAddress::zero(),
        0,
    );
    let escrow = AztecAddress::compute(public_keys, partial);

    let note_hash = compute_note_hash(
        PAYLINK_NOTE_STORAGE_SLOT,
        note.pack().concat([escrow.to_field(), randomness]),
    );
    let unique = compute_unique_note_hash(note_nonce, compute_siloed_note_hash(escrow, note_hash));
    assert(check_membership(unique, witness, root), "paylink note is not under the root");

    assert(note.token_address == token, "paylink token mismatch");
    let (amount, _, _) = unpack_data(note.data);
    assert(amount >= threshold, "paylink amount below threshold");

    // `owner` binds the proof to one registrant; the nullifier stays per-escrow.
    let _ = owner;
    poseidon2_hash_with_separator([unique], DOM_SEP__GOLDEN_TICKET)
}
