//! Past-user eligibility: the signer of the campaign message owns an address committed under
//! `merkle_root` in `category`. The proof is bound to one L1 `owner`. The nullifier depends only on
//! the signature, so nullifiers burned before `owner` existed stay valid.
use keccak256::keccak256;
use poseidon::poseidon2::Poseidon2;
use std::ecdsa_secp256k1::verify_signature;

global TREE_DEPTH: u32 = 19;

/// keccak256("zkmoney.eligibility.nullifier.v1") mod p.
global DOMAIN_SEPARATOR: Field =
    15933627273728771157097423285708830975907896828959796420780278569037500211443;

/// EIP-191 digest of `ELIGIBILITY_SIGN_MESSAGE`.
global EXPECTED_MESSAGE_HASH: [u8; 32] = [
    253, 167, 164, 191, 152, 41, 134, 48, 250, 46, 228, 130, 9, 207, 184, 172, 61, 96, 202, 56, 73,
    154, 124, 225, 233, 91, 78, 52, 84, 81, 114, 54,
];

fn main(
    merkle_root: pub Field,
    category: pub Field,
    owner: pub Field,
    address: Field,
    signature: [u8; 64],
    pub_key_x: [u8; 32],
    pub_key_y: [u8; 32],
    message_hash: [u8; 32],
    merkle_path: [Field; TREE_DEPTH],
    merkle_index_bits: [bool; TREE_DEPTH],
) -> pub Field {
    // Without this pin, any signature by the key, such as one on a public transaction, would pass.
    assert(message_hash == EXPECTED_MESSAGE_HASH, "signature is not over the campaign message");
    assert(
        verify_signature(pub_key_x, pub_key_y, signature, message_hash),
        "invalid secp256k1 signature",
    );
    assert(
        address == address_from_pubkey(pub_key_x, pub_key_y),
        "address does not match public key",
    );
    let leaf = hash_2(category, address);
    let root = compute_merkle_root(leaf, merkle_index_bits, merkle_path);
    assert(root == merkle_root, "address not eligible for category");

    let _ = owner;
    compute_nullifier(signature)
}

fn address_from_pubkey(pub_key_x: [u8; 32], pub_key_y: [u8; 32]) -> Field {
    let mut pubkey: [u8; 64] = [0; 64];
    for i in 0..32 {
        pubkey[i] = pub_key_x[i];
        pubkey[32 + i] = pub_key_y[i];
    }
    let hash = keccak256(pubkey, 64);
    let mut acc: Field = 0;
    for i in 12..32 {
        acc = acc * 256 + hash[i] as Field;
    }
    acc
}

fn hash_2(left: Field, right: Field) -> Field {
    Poseidon2::hash([left, right], 2)
}

fn compute_merkle_root(
    leaf: Field,
    indices: [bool; TREE_DEPTH],
    path: [Field; TREE_DEPTH],
) -> Field {
    let mut current = leaf;
    for i in 0..TREE_DEPTH {
        let sibling = path[i];
        let left = if indices[i] { sibling } else { current };
        let right = if indices[i] { current } else { sibling };
        current = hash_2(left, right);
    }
    current
}

// A custom signer can pick ECDSA nonces and mint several nullifiers; RFC 6979 wallets cannot.
fn compute_nullifier(signature: [u8; 64]) -> Field {
    let mut chunks: [Field; 4] = [0; 4];
    for c in 0..4 {
        let mut chunk: Field = 0;
        for i in 0..16 {
            chunk = chunk * 256 + signature[c * 16 + i] as Field;
        }
        chunks[c] = chunk;
    }
    Poseidon2::hash(
        [DOMAIN_SEPARATOR, chunks[0], chunks[1], chunks[2], chunks[3]],
        5,
    )
}

// T_SIGNATURE signs EXPECTED_MESSAGE_HASH and W_SIGNATURE signs W_MSG_HASH, both with private key
// 0x1111...1111, whose address is T_ADDRESS.
global T_PUBKEY_X: [u8; 32] = [
    79, 53, 91, 220, 183, 204, 10, 247, 40, 239, 60, 206, 185, 97, 93, 144, 104, 75, 181, 178, 202,
    95, 133, 154, 176, 240, 183, 4, 7, 88, 113, 170,
];
global T_PUBKEY_Y: [u8; 32] = [
    56, 91, 107, 27, 142, 173, 128, 156, 166, 116, 84, 217, 104, 63, 207, 43, 160, 52, 86, 214, 254,
    44, 74, 190, 43, 7, 240, 251, 219, 178, 241, 193,
];
global T_SIGNATURE: [u8; 64] = [
    205, 181, 73, 249, 194, 225, 217, 224, 41, 105, 193, 194, 24, 26, 63, 186, 62, 153, 24, 186, 83,
    179, 68, 6, 69, 98, 186, 9, 167, 181, 112, 38, 28, 164, 32, 237, 214, 158, 180, 145, 81, 8, 192,
    146, 214, 55, 254, 250, 7, 208, 222, 108, 166, 180, 78, 87, 52, 164, 12, 232, 224, 161, 42, 215,
];
global W_SIGNATURE: [u8; 64] = [
    91, 132, 120, 219, 122, 202, 92, 230, 28, 176, 90, 150, 174, 26, 130, 246, 61, 60, 246, 142,
    116, 1, 45, 254, 116, 248, 55, 154, 238, 111, 46, 30, 15, 166, 178, 27, 168, 198, 208, 62, 72,
    119, 204, 177, 31, 58, 191, 219, 190, 3, 61, 149, 148, 235, 140, 43, 64, 85, 128, 126, 225, 150,
    75, 29,
];
global W_MSG_HASH: [u8; 32] = [171; 32];
global T_ADDRESS: Field = 147896056361741740851429730701358742406088556330;
global T_OWNER: Field = 0x17c5185167401ed00cf5f5b2fc97d9bbfdb7d025;

fn zero_hashes() -> [Field; TREE_DEPTH] {
    let mut z: [Field; TREE_DEPTH] = [0; TREE_DEPTH];
    for i in 1..TREE_DEPTH {
        z[i] = hash_2(z[i - 1], z[i - 1]);
    }
    z
}

fn prove(
    root: Field,
    category: Field,
    path: [Field; TREE_DEPTH],
    bits: [bool; TREE_DEPTH],
    address: Field,
    signature: [u8; 64],
    message_hash: [u8; 32],
) -> Field {
    main(
        root,
        category,
        T_OWNER,
        address,
        signature,
        T_PUBKEY_X,
        T_PUBKEY_Y,
        message_hash,
        path,
        bits,
    )
}

fn prove_in_one_leaf_tree(address: Field, signature: [u8; 64], message_hash: [u8; 32]) -> Field {
    let z = zero_hashes();
    let bits = [false; TREE_DEPTH];
    let root = compute_merkle_root(hash_2(1, T_ADDRESS), bits, z);
    prove(root, 1, z, bits, address, signature, message_hash)
}

#[test]
fn derives_address_from_public_key() {
    assert(address_from_pubkey(T_PUBKEY_X, T_PUBKEY_Y) == T_ADDRESS);
}

#[test]
fn matches_campaign_poseidon2_values() {
    assert(
        hash_2(1, T_ADDRESS)
            == 21798046535171009082358737468130292416124926330415424341605492793260020444411,
    );
    assert(
        hash_2(2, T_ADDRESS)
            == 17632654969657918569751257146044654177105484087260847508586606236217816445982,
    );
    assert(
        compute_nullifier(T_SIGNATURE)
            == 18446540441679897329889196622992952050830878484121347127091100538641101703449,
    );
}

#[test]
fn proves_each_category_with_the_same_nullifier() {
    let z = zero_hashes();
    let leaf0 = hash_2(1, T_ADDRESS);
    let leaf1 = hash_2(2, T_ADDRESS);
    let mut path0 = z;
    path0[0] = leaf1;
    let mut path1 = z;
    path1[0] = leaf0;
    let bits0 = [false; TREE_DEPTH];
    let mut bits1 = [false; TREE_DEPTH];
    bits1[0] = true;
    let root = compute_merkle_root(leaf0, bits0, path0);

    let n = compute_nullifier(T_SIGNATURE);
    assert(
        prove(
            root,
            1,
            path0,
            bits0,
            T_ADDRESS,
            T_SIGNATURE,
            EXPECTED_MESSAGE_HASH,
        )
            == n,
    );
    assert(
        prove(
            root,
            2,
            path1,
            bits1,
            T_ADDRESS,
            T_SIGNATURE,
            EXPECTED_MESSAGE_HASH,
        )
            == n,
    );
}

#[test(should_fail_with = "address not eligible for category")]
fn rejects_a_category_the_address_is_not_in() {
    let z = zero_hashes();
    let bits = [false; TREE_DEPTH];
    let root = compute_merkle_root(hash_2(1, T_ADDRESS), bits, z);
    let _ = prove(
        root,
        2,
        z,
        bits,
        T_ADDRESS,
        T_SIGNATURE,
        EXPECTED_MESSAGE_HASH,
    );
}

#[test(should_fail_with = "signature is not over the campaign message")]
fn rejects_a_signature_over_another_digest() {
    let _ = prove_in_one_leaf_tree(T_ADDRESS, W_SIGNATURE, W_MSG_HASH);
}

#[test(should_fail_with = "invalid secp256k1 signature")]
fn rejects_an_invalid_signature() {
    let mut bad = T_SIGNATURE;
    bad[0] = bad[0] + 1;
    let _ = prove_in_one_leaf_tree(T_ADDRESS, bad, EXPECTED_MESSAGE_HASH);
}

#[test(should_fail_with = "address does not match public key")]
fn rejects_a_mismatched_address() {
    let _ = prove_in_one_leaf_tree(T_ADDRESS + 1, T_SIGNATURE, EXPECTED_MESSAGE_HASH);
}
