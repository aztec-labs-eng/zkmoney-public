use aztec::oracle::auth_witness::get_auth_witness;

global MAX_WITNESS_LEN: u32 = 500;

global PUBKEY_X_INDEX: u32 = 0;
global PUBKEY_Y_INDEX: u32 = 32;
global SIGNATURE_INDEX: u32 = 64;
pub global SIGNATURE_LEN: u32 = 64;

pub struct AlphaEcdsaWitness {
    pub pub_key_x: [u8; 32],
    pub pub_key_y: [u8; 32],
    pub signature: [u8; SIGNATURE_LEN],
}

impl AlphaEcdsaWitness {
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

        Self { pub_key_x, pub_key_y, signature }
    }
}

pub unconstrained fn load_alpha_ecdsa_witness(message_hash: Field) -> AlphaEcdsaWitness {
    let witness: [Field; MAX_WITNESS_LEN] = get_auth_witness(message_hash);
    AlphaEcdsaWitness::deserialize(witness)
}
