// use aztec::prelude::{AztecAddress, PrivateContext};
// use aztec::protocol::grumpkin_point::GrumpkinPoint;
// use ecdsa_public_key_note::EcdsaPublicKeyNote;

use aztec::{
    keys::getters::get_public_keys,
    oracle::logging::{debug_log, debug_log_format},
    protocol::{
        address::{AztecAddress, PartialAddress},
        traits::{ToField, FromField},
        hash::poseidon2_hash_with_separator,
        contract_class_id::ContractClassId,
        constants::DOM_SEP__FUNCTION_ARGS
    },
};

use constants::MAX_WITNESS_LEN;

global SIGNATURE_LEN: u32 = 64;
global KEY_LEN: u32 = 32;

pub fn extract_pubkeys_32(witness: [Field; 500]) -> ([u8; KEY_LEN], [u8; KEY_LEN]) {
    let mut x: [u8; KEY_LEN] = [0; KEY_LEN];
    let mut y: [u8; KEY_LEN] = [0; KEY_LEN];

    for i in 0..witness.len() {
        if i < 32 {
            x[i] = witness[i] as u8;
            y[i] = witness[i + 32] as u8;
        }
    }

    (x, y)
}

// 0: is_init
// 1: auth address
// 2 - 65: signature (64 bytes)
// 66 - 97: pubkey x (32 bytes)
// 98 - 129: pubkey y (32 bytes)

pub fn parse_witness_to_key(witness: [Field; 500]) -> ([u8; 32], [u8; 32]) {
    let mut x: [u8; 32] = [0; 32];
    let mut y: [u8; 32] = [0; 32];

    for i in 0..32 {
        x[i] = witness[i + 66] as u8;
        y[i] = witness[i + 98] as u8;
    }

    (x, y)
}

// 0: is_init
// 1: auth address
// 2 - 34: pubkey x (32 bytes)
// 35 - 67: pubkey y (32 bytes)
// 68 ~: signature (unknown len bytes)
pub fn parse_witness_to_key_webauthn(witness: [Field; 500]) -> ([u8; 32], [u8; 32]) {
    let mut x: [u8; 32] = [0; 32];
    let mut y: [u8; 32] = [0; 32];

    for i in 0..32 {
        x[i] = witness[i + 2] as u8;
        y[i] = witness[i + 35] as u8;
    }

    (x, y)
}

// pub fn bytes32_to_field(bytes32: [u8; 32]) -> Field {
//     let mut v = 1;
//     let mut ret = 0 as Field;

//     for i in 0..32 {
//         ret = ret + (bytes32[i] as Field) * v;
//         v = v * 256;
//     }

//     ret
// }

// pub fn u8_to_u8_32(arr: [u8]) -> [u8; 32] {
//     let mut as_field: [u8; 32] = [0 as u8; 32];
//     for i in 0..32 {
//         as_field[i] = arr[i];
//     }
//     as_field
// }

pub fn concat_u8_32(arr1: [u8; 32], arr2: [u8; 32]) -> [u8; 64] {
    let mut array: [u8; 64] = [0 as u8; 64];
    for i in 0..32 {
        array[i] = arr1[i];
        array[i + 32] = arr2[i];
    }
    array
}

// pub fn concat_u8_32(arr1: [u8; 32], arr2: [u8; 32]) -> [Field; 64] {
//     let mut array: [Field; 64] = [0; 64];
//     for i in 0..32 {
//         array[i] = arr1[i] as Field;
//         array[i + 32] = arr2[i] as Field;
//     }
//     array
// }


pub fn field_32_to_u8_32(arr: [Field; 32]) -> [u8; 32] {
    let mut as_field: [u8; 32] = [0; 32];
    for i in 0..32 {
        as_field[i] = arr[i] as u8;
    }
    as_field
}


pub fn u8_32_to_field_array(arr: [u8; 32]) -> [Field; 32] {
    let mut as_field: [Field; 32] = [0; 32];
    for i in 0..32 {
        as_field[i] = arr[i] as Field;
    }
    as_field
}

pub fn u8_64_to_field_array(arr: [u8; 64]) -> [Field; 64] {
    let mut as_field: [Field; 64] = [0; 64];
    for i in 0..64 {
        as_field[i] = arr[i] as Field;
    }
    as_field
}

pub fn u8_134_to_field_array(arr: [u8; 256]) -> [Field; 134] {
    let mut as_field: [Field; 134] = [0; 134];
    for i in 0..134 {
        as_field[i] = arr[i] as Field;
    }
    as_field
}

pub fn u8_243_to_field_array(arr: [u8; 256]) -> [Field; 243] {
    let mut as_field: [Field; 243] = [0; 243];
    for i in 0..243 {
        as_field[i] = arr[i] as Field;
    }
    as_field
}

pub fn u8_256_to_field_array(arr: [u8; 256]) -> [Field; 256] {
    let mut as_field: [Field; 256] = [0; 256];
    for i in 0..256 {
        as_field[i] = arr[i] as Field;
    }
    as_field
}

pub fn u8_43_to_field_array(arr: [u8; 43]) -> [Field; 43] {
    let mut as_field: [Field; 43] = [0; 43];
    for i in 0..43 {
        as_field[i] = arr[i] as Field;
    }
    as_field
}

// #[test]
// fn test_extract_signature_64() {
//     // mode 0
//     // let array: [Field;500] = [1,188,59,25,252,230,248,175,61,93,32,249,179,194,212,81,8,192,29,232,61,222,48,108,16,237,129,110,32,36,67,192,72,180,167,180,27,45,37,28,193,203,143,45,71,116,178,137,235,43,29,10,207,35,40,49,85,2,108,209,172,189,143,53,163,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];
//     // let signature = extract_signature_64(array, 0);

//     // mode 1
//     let array: [Field;500] = [1,200,188,59,25,252,230,248,175,61,93,32,249,179,194,212,81,8,192,29,232,61,222,48,108,16,237,129,110,32,36,67,192,72,180,167,180,27,45,37,28,193,203,143,45,71,116,178,137,235,43,29,10,207,35,40,49,85,2,108,209,172,189,143,53,163,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];
//     let signature = extract_signature_64(array, 1);

//     assert(signature[0] == 188, "index 0 should be 188");
//     assert(signature[63] == 163, "index 63 should be 163");

//     // for i in 0..64 {
//     //     dep::std::println(signature[i]);
//     // }

// }

// #[test]
// fn test_extract_pubkeys_32() {
//     // mode 0
//     // let array: [Field;500] = [1,188,59,25,252,230,248,175,61,93,32,249,179,194,212,81,8,192,29,232,61,222,48,108,16,237,129,110,32,36,67,192,72,180,167,180,27,45,37,28,193,203,143,45,71,116,178,137,235,43,29,10,207,35,40,49,85,2,108,209,172,189,143,53,163,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];
//     // let (pub_key_x, pub_key_y) = extract_pubkeys_32(array, 0);

//     // mode 1
//     let array: [Field;500] = [1,200,188,59,25,252,230,248,175,61,93,32,249,179,194,212,81,8,192,29,232,61,222,48,108,16,237,129,110,32,36,67,192,72,180,167,180,27,45,37,28,193,203,143,45,71,116,178,137,235,43,29,10,207,35,40,49,85,2,108,209,172,189,143,53,163,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];
//     let (pub_key_x, pub_key_y) = extract_pubkeys_32(array, 1);

//     dep::std::println(pub_key_x[0]);
//     dep::std::println(pub_key_x[31]);
//     dep::std::println(pub_key_y[0]);
//     dep::std::println(pub_key_y[31]);

//     assert(pub_key_x[0] == 188, "first index for x 0 should be 188");
//     assert(pub_key_x[31] == 72, "last index for x 63 should be 72");
//     assert(pub_key_y[0] == 180, "first indext for y should be 180");
//     assert(pub_key_y[31] == 163, "last index 63 for y should be 163");

//     // for i in 0..64 {
//     //     dep::std::println(signature[i]);
//     // }

// }


pub fn parse_field_64_pubkey_to_u8_32(pubkeys: [Field; 64]) -> ([u8; KEY_LEN], [u8; KEY_LEN]) {
    let mut x: [u8; 32] = [0; 32];
    let mut y: [u8; 32] = [0; 32];

    for i in 0..32 {
        x[i] = pubkeys[i] as u8;
        y[i] = pubkeys[i + 32] as u8;
    }

    (x, y)
}

pub fn compute_ecdsa_salt(authmod_address: AztecAddress, pubkeys: [Field; 64]) -> Field {
    let mut serialized_args = [0; 65];
    serialized_args[0] = authmod_address.to_field();
    for i in 0..64 {
        serialized_args[i + 1] = pubkeys[i];
    }
    // debug_log_format("args {}", serialized_args);

    // salt in ASCII is 11597108116 in decimal
    poseidon2_hash_with_separator(serialized_args, 83657684)
}

pub fn verify_computed_address_from_witness(account: AztecAddress, salt: Field, class_id: ContractClassId) -> bool {
    debug_log_format("salt {}", [salt]);

    let initialization_hash = 0;
    let deployer = AztecAddress::zero();

    let partial_address = PartialAddress::compute(class_id, salt, initialization_hash, deployer);
    debug_log_format("partial_address {}", [partial_address.to_field()]);

    // is this doable even if acc not publicly deployed?
    let account_pubkeys = aztec::keys::getters::get_public_keys(account);
    debug_log_format("pubkey_hash {}", [account_pubkeys.hash().to_field()]);

    /// From aztec.js:
    // Given public keys and a partial address, we can compute our address in the following steps.
    // 1. preaddress = poseidon2([publicKeysHash, partialAddress], GeneratorIndex.CONTRACT_ADDRESS_V1);
    // 2. addressPoint = (preaddress * G) + ivpk_m
    // 3. address = addressPoint.x
    let computed_address = AztecAddress::compute(account_pubkeys, partial_address);

    debug_log_format("computed_address {}", [computed_address.to_field()]);
    debug_log_format("account {}", [account.to_field()]);

    computed_address.eq(account)
}

