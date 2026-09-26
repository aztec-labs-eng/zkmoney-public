use sha256::sha256_var;
use base64::BASE64_URL_ENCODER;
use crate::authwit::{AUTHENTICATOR_DATA_LEN, MAX_CLIENT_DATA_JSON_LEN, CHALLENGE_LEN};

pub fn verify_webauthn_p256(
    pub_key_x: [u8; 32],
    pub_key_y: [u8; 32],
    outer_hash: Field,
    authenticator_data: [u8; AUTHENTICATOR_DATA_LEN],
    client_data_json: [u8; MAX_CLIENT_DATA_JSON_LEN],
    client_data_json_len: u32,
    signature: [u8; 64],
) -> bool {
    let outer_hash_bytes: [u8; 32] = outer_hash.to_be_bytes();

    let challenge_base64: [u8; CHALLENGE_LEN] = BASE64_URL_ENCODER::encode(outer_hash_bytes);

    for i in 0..CHALLENGE_LEN {
        assert(challenge_base64[i] == client_data_json[36 + i]);
    }

    let client_data_json_hash: [u8; 32] = sha256_var(
        client_data_json,
        client_data_json_len as u64,
    );

    let mut signed_data: [u8; AUTHENTICATOR_DATA_LEN + 32] = [0; AUTHENTICATOR_DATA_LEN + 32];
    for i in 0..AUTHENTICATOR_DATA_LEN {
        signed_data[i] = authenticator_data[i];
    }
    for i in 0..32 {
        signed_data[AUTHENTICATOR_DATA_LEN + i] = client_data_json_hash[i];
    }

    let hashed_data = sha256_var(signed_data, (AUTHENTICATOR_DATA_LEN + 32) as u64);

    std::ecdsa_secp256r1::verify_signature(
        pub_key_x,
        pub_key_y,
        signature,
        hashed_data,
    )
}
