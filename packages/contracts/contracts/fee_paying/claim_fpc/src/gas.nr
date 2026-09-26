use aztec::protocol::traits::{Deserialize, Serialize};
use std::meta::derive;

/// Gas an entrypoint or a gate costs before any sponsored call. The values themselves are the
/// `#[abi(tag)]` globals in main.nr -- such a global has to live in the contract module.
#[derive(Deserialize, Eq, Serialize)]
pub struct OverheadGas {
    pub da_gas: u32,
    pub l2_gas: u32,
}

/// The overhead at the config's sponsored fee-per-gas: what every batch is charged once, on top of
/// the marginal max_fees of the calls it carries.
pub fn overhead_max_fee(
    overhead: OverheadGas,
    max_fee_per_da_gas: u128,
    max_fee_per_l2_gas: u128,
) -> u128 {
    (overhead.da_gas as u128) * max_fee_per_da_gas + (overhead.l2_gas as u128) * max_fee_per_l2_gas
}
