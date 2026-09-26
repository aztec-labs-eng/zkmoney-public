use aztec::oracle::auth_witness::get_auth_witness;

global MAX_WITNESS_LEN: u32 = 500;

global PUBKEY_X_INDEX: u32 = 0;
global PUBKEY_Y_INDEX: u32 = 32;
global SIGNATURE_INDEX: u32 = 64;
global SIGNATURE_LEN: u32 = 64;

global AUTHENTICATOR_DATA_INDEX: u32 = 128;
pub global AUTHENTICATOR_DATA_LEN: u32 = 37;
global CLIENT_DATA_JSON_LEN_INDEX: u32 = 165;
global CLIENT_DATA_JSON_INDEX: u32 = 166;
// Chromium pseudo-randomly appends a ~109-byte anti-templating key to clientDataJSON, which can
// push it past 256 bytes on long origins. 319 is the largest value that keeps sha256_var at the
// same block count (N / 64 = 4) and fits the witness (166 + 319 <= MAX_WITNESS_LEN).
pub global MAX_CLIENT_DATA_JSON_LEN: u32 = 319;
pub global CHALLENGE_LEN: u32 = 43;

pub struct AlphaWebauthnWitness {
    pub pub_key_x: [u8; 32],
    pub pub_key_y: [u8; 32],
    pub signature: [u8; SIGNATURE_LEN],
    pub authenticator_data: [u8; AUTHENTICATOR_DATA_LEN],
    pub client_data_json_len: u32,
    pub client_data_json: [u8; MAX_CLIENT_DATA_JSON_LEN],
}

impl AlphaWebauthnWitness {
    pub fn deserialize(witness: [Field; MAX_WITNESS_LEN]) -> Self {
        let mut pub_key_x: [u8; 32] = [0; 32];
        let mut pub_key_y: [u8; 32] = [0; 32];
        for i in 0..32 {
            pub_key_x[i] = witness[PUBKEY_X_INDEX + i] as u8;
            pub_key_y[i] = witness[PUBKEY_Y_INDEX + i] as u8;
        }

        let mut signature: [u8; SIGNATURE_LEN] = [0; SIGNATURE_LEN];
        for i in 0..SIGNATURE_LEN {
            signature[i] = witness[SIGNATURE_INDEX + i] as u8;
        }

        let mut authenticator_data: [u8; AUTHENTICATOR_DATA_LEN] = [0; AUTHENTICATOR_DATA_LEN];
        for i in 0..AUTHENTICATOR_DATA_LEN {
            authenticator_data[i] = witness[AUTHENTICATOR_DATA_INDEX + i] as u8;
        }

        let client_data_json_len = witness[CLIENT_DATA_JSON_LEN_INDEX] as u32;

        let mut client_data_json: [u8; MAX_CLIENT_DATA_JSON_LEN] = [0; MAX_CLIENT_DATA_JSON_LEN];
        for i in 0..MAX_CLIENT_DATA_JSON_LEN {
            let value = witness[CLIENT_DATA_JSON_INDEX + i] as u8;
            if i < client_data_json_len {
                client_data_json[i] = value;
            }
        }

        Self {
            pub_key_x,
            pub_key_y,
            signature,
            authenticator_data,
            client_data_json_len,
            client_data_json,
        }
    }
}

pub unconstrained fn load_alpha_webauthn_witness(message_hash: Field) -> AlphaWebauthnWitness {
    let witness: [Field; MAX_WITNESS_LEN] = get_auth_witness(message_hash);
    AlphaWebauthnWitness::deserialize(witness)
}
