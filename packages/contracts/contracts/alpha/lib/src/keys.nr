use aztec::protocol::hash::{poseidon2_hash_with_separator, sha256_to_field};

/// An account commits to a set of up to eight passkeys: their hashes fill the slots in ascending order, zero-padded,
/// and the set hash is the account's `immutables_hash`. Recipe and separators are oxide's
/// (`oxide_lib::account_address`, `oxide_lib::constants`), so the refund circuits recompute the same values.
pub global MAX_ACCOUNT_PASSKEYS: u32 = 8;

/// `sha256_to_field("ALPHA_KEY")`, pinned equal to oxide's `DOM_SEP__PASSKEY_IMMUTABLES`.
pub global DOM_SEP__PASSKEY_IMMUTABLES: Field =
    0xd8495d95c87d89027e5766fbedd796b4e6da2d3a6f13b99b55bc182177530c;
/// `sha256_to_field("ALPHA_KEYS")`, pinned equal to oxide's `DOM_SEP__PASSKEY_SET_IMMUTABLES`.
pub global DOM_SEP__PASSKEY_SET_IMMUTABLES: Field =
    0x2b4d0c08148783033eb8ecf21f84cd7a0855df337cae09709fb65b46efdbdf;

pub fn pack_bytes_to_field(bytes: [u8; 32], offset: u32) -> Field {
    let mut acc: Field = 0;
    for i in 0..16 {
        acc = acc * 256 + bytes[offset + i] as Field;
    }
    acc
}

/// The hash of one passkey, which fills one slot of the set.
pub fn compute_passkey_hash(pub_key_x: [u8; 32], pub_key_y: [u8; 32]) -> Field {
    poseidon2_hash_with_separator(
        [
            pack_bytes_to_field(pub_key_x, 0),
            pack_bytes_to_field(pub_key_x, 16),
            pack_bytes_to_field(pub_key_y, 0),
            pack_bytes_to_field(pub_key_y, 16),
        ],
        DOM_SEP__PASSKEY_IMMUTABLES,
    )
}

/// The account's `immutables_hash`: the commitment of its passkey set.
pub fn compute_passkey_set_immutables_hash(slots: [Field; MAX_ACCOUNT_PASSKEYS]) -> Field {
    poseidon2_hash_with_separator(slots, DOM_SEP__PASSKEY_SET_IMMUTABLES)
}

/// Whether `passkey_hash` fills a slot. Zero never matches, so padding admits no key.
pub fn passkey_set_contains(slots: [Field; MAX_ACCOUNT_PASSKEYS], passkey_hash: Field) -> bool {
    let mut found = false;
    for i in 0..MAX_ACCOUNT_PASSKEYS {
        found = found | (slots[i] == passkey_hash);
    }
    found & (passkey_hash != 0)
}

// Vectors shared with the sdk parity test (`alphaPasskeySet.test.ts`), produced by oxide's TS at the pinned build.
// Key 1: x[i] = i + 1, y[i] = 0xff - i. Key 2: x[i] = 0xff - i, y[i] = i + 1. Hash 2 sorts before hash 1.
global PASSKEY_HASH_VECTOR_1: Field =
    0x1fe0fbf8537e7fe1fc8c28921a3b5c8c75452fa4550a27d1234ecd835e492e0f;
global PASSKEY_HASH_VECTOR_2: Field =
    0x0d10652febab90ae0b2cafef1709a23bf1e729fb6b6c31f1e4885bd8c39972a8;
global SET_HASH_VECTOR_ONE_KEY: Field =
    0x2b26bbaa93a12de1cf583828e2668c7f889da325cf98385e66390859a1c14d6b;
global SET_HASH_VECTOR_TWO_KEYS: Field =
    0x081fab49249ef1fd613dd6f790faf2e2e3b4b75387fec57b24b0ca47514582e4;

fn vector_key_1() -> ([u8; 32], [u8; 32]) {
    let mut x: [u8; 32] = [0; 32];
    let mut y: [u8; 32] = [0; 32];
    for i in 0..32 {
        x[i] = i as u8 + 1;
        y[i] = 0xff - i as u8;
    }
    (x, y)
}

fn vector_key_2() -> ([u8; 32], [u8; 32]) {
    let (x, y) = vector_key_1();
    (y, x)
}

fn one_key_slots() -> [Field; MAX_ACCOUNT_PASSKEYS] {
    let mut slots: [Field; MAX_ACCOUNT_PASSKEYS] = [0; MAX_ACCOUNT_PASSKEYS];
    slots[0] = PASSKEY_HASH_VECTOR_1;
    slots
}

fn two_key_slots() -> [Field; MAX_ACCOUNT_PASSKEYS] {
    let mut slots: [Field; MAX_ACCOUNT_PASSKEYS] = [0; MAX_ACCOUNT_PASSKEYS];
    slots[0] = PASSKEY_HASH_VECTOR_2;
    slots[1] = PASSKEY_HASH_VECTOR_1;
    slots
}

#[test]
fn test_separators_are_oxides() {
    assert(
        DOM_SEP__PASSKEY_IMMUTABLES == sha256_to_field("ALPHA_KEY".as_bytes()),
        "passkey separator drifted",
    );
    assert(
        DOM_SEP__PASSKEY_SET_IMMUTABLES == sha256_to_field("ALPHA_KEYS".as_bytes()),
        "passkey set separator drifted",
    );
}

#[test]
fn test_passkey_hash_vectors() {
    let (x1, y1) = vector_key_1();
    let (x2, y2) = vector_key_2();
    assert(compute_passkey_hash(x1, y1) == PASSKEY_HASH_VECTOR_1, "passkey hash vector 1 drifted");
    assert(compute_passkey_hash(x2, y2) == PASSKEY_HASH_VECTOR_2, "passkey hash vector 2 drifted");
}

#[test]
fn test_set_hash_vectors() {
    assert(
        compute_passkey_set_immutables_hash(one_key_slots()) == SET_HASH_VECTOR_ONE_KEY,
        "one-key set hash vector drifted",
    );
    assert(
        compute_passkey_set_immutables_hash(two_key_slots()) == SET_HASH_VECTOR_TWO_KEYS,
        "two-key set hash vector drifted",
    );
}

#[test]
fn test_slot_order_is_committed() {
    let mut swapped = two_key_slots();
    swapped[0] = PASSKEY_HASH_VECTOR_1;
    swapped[1] = PASSKEY_HASH_VECTOR_2;
    assert(
        compute_passkey_set_immutables_hash(swapped) != SET_HASH_VECTOR_TWO_KEYS,
        "the same keys in another slot order must commit differently",
    );
}

#[test]
fn test_passkey_set_contains() {
    let slots = two_key_slots();
    assert(passkey_set_contains(slots, PASSKEY_HASH_VECTOR_1), "member in slot 1 not found");
    assert(passkey_set_contains(slots, PASSKEY_HASH_VECTOR_2), "member in slot 0 not found");
    assert(!passkey_set_contains(slots, PASSKEY_HASH_VECTOR_1 + 1), "foreign hash admitted");
    assert(!passkey_set_contains(slots, 0), "zero padding admitted");
}

#[test]
fn test_passkey_hash_differs_by_key() {
    let mut x: [u8; 32] = [0; 32];
    let y: [u8; 32] = [0; 32];
    let a = compute_passkey_hash(x, y);
    x[31] = 1;
    let b = compute_passkey_hash(x, y);
    assert(a != b, "distinct keys must hash to distinct values");
}
