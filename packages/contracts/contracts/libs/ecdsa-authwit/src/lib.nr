use aztec::{
    protocol::{address::AztecAddress, traits::FromField},
    oracle::auth_witness::get_auth_witness,
};
use constants::{MAX_WITNESS_LEN, MODULE_ADDRESS_INDEX, PUBKEY_INDEX_INDEX};
use obsidion_authwit::ObsidionAuthWitness;

/// Simplified witness layout after nuke-lazy refactor.
/// Signature now starts at index 2 (was 67).
pub global SIGNATURE_INDEX: u32 = 2;
pub global SIGNATURE_LEN: u32 = 64;

/// EcdsaAuthWitness with simplified layout.
///
/// New layout:
///   [0]: authmod_address
///   [1]: pubkey_index
///   [2-65]: signature (64 bytes)
pub struct EcdsaAuthWitness {
    pub authmod_address: AztecAddress,
    pub pubkey_index: Field,
    pub signature: [u8; SIGNATURE_LEN],
}

impl EcdsaAuthWitness {
    pub fn deserialize(witness: [Field; MAX_WITNESS_LEN]) -> Self {
        let obsidion_authwit = ObsidionAuthWitness::deserialize(witness);

        // signature: indices 2-65 (64 bytes)
        let mut signature: [u8; SIGNATURE_LEN] = [0; SIGNATURE_LEN];
        for i in 0..SIGNATURE_LEN {
            signature[i] = witness[i + SIGNATURE_INDEX] as u8;
        }

        Self {
            authmod_address: obsidion_authwit.module_address,
            pubkey_index: obsidion_authwit.pubkey_index,
            signature,
        }
    }
}

pub unconstrained fn get_ecdsa_auth_witness(message_hash: Field) -> EcdsaAuthWitness {
    let witness: [Field; MAX_WITNESS_LEN] = get_auth_witness(message_hash);
    EcdsaAuthWitness::deserialize(witness)
}
