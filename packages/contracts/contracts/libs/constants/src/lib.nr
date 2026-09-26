pub global MAX_WITNESS_LEN: u32 = 500;
pub global INSTALL_KEYS_LEN: u32 = 500;
pub global PUBKEY_MAX_INDEX: Field = 1000;

// ============================================================================
// Simplified witness layout (after nuke-lazy refactor)
// ============================================================================
// Old layout had pubkeys[1-64] and class_id[65] for lazy validation.
// New layout removes these - pubkeys are passed as entrypoint params for setup,
// and read from storage for normal validation.
//
// New layout:
//   [0]: authmod_address
//   [1]: pubkey_index
//   [2+]: signature and auth-specific data
// ============================================================================
pub global MODULE_ADDRESS_INDEX: u32 = 0;
pub global PUBKEY_INDEX_INDEX: u32 = 1;

pub struct ModuleID {
    pub AUTH: u8,
    pub RECOVERY: u8,
    pub DELEGATE: u8,
}

pub global MODULE_ID: ModuleID = ModuleID {
    AUTH: 0,
    RECOVERY: 1,
    DELEGATE: 2,
};
