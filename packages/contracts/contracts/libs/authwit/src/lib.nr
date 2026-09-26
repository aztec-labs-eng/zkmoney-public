use aztec::{
    protocol::{address::AztecAddress, traits::FromField},
    oracle::auth_witness::get_auth_witness,
};
use constants::{MAX_WITNESS_LEN, MODULE_ADDRESS_INDEX, PUBKEY_INDEX_INDEX};

/// Simplified ObsidionAuthWitness after nuke-lazy refactor.
///
/// Old layout had pubkeys[1-64] and class_id[65] for lazy validation.
/// New layout:
///   [0]: module_address
///   [1]: pubkey_index
///   [2+]: signature and auth-specific data
pub struct ObsidionAuthWitness {
    pub module_address: AztecAddress,
    pub pubkey_index: Field,
}

impl ObsidionAuthWitness {
    pub fn deserialize(witness: [Field; MAX_WITNESS_LEN]) -> Self {
        Self {
            module_address: AztecAddress::from_field(witness[MODULE_ADDRESS_INDEX]),
            pubkey_index: witness[PUBKEY_INDEX_INDEX],
        }
    }
}

pub unconstrained fn get_obsidion_auth_witness(message_hash: Field) -> ObsidionAuthWitness {
    let witness: [Field; MAX_WITNESS_LEN] = get_auth_witness(message_hash);
    ObsidionAuthWitness::deserialize(witness)
}
