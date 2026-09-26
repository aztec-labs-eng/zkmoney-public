use crate::gas::OverheadGas;
use aztec::protocol::{address::AztecAddress, traits::{Deserialize, Serialize}};
use std::meta::derive;

/// Keys the rail's one-subscription-per-holder nullifier.
pub global DOM_SEP__CLAIM_SUBSCRIPTION: u32 = 1236;

/// What a gate hands back to `subscribe`.
///
/// `user` is the L2 address the gate's witnesses admit -- `subscribe` compares it with the address
/// it was asked to subscribe, which is what stops a gate proof for one user from minting another's
/// subscription. Every gate proves control of `user` from its own witnesses, so the receipt is the
/// whole admission and `subscribe` defers nothing.
///
/// `identity` is what the rail's one-subscription-per-holder nullifier is keyed on, and it is the
/// gate's choice: both gates report the L1 OxideAccount, so a holder's allowance is one per rail
/// however many L2 addresses they point it at. `gas` is the gate's own metered cost, so
/// `subscribe`'s fee cap prices the gate that actually ran rather than the most expensive gate the
/// contract could run.
#[derive(Deserialize, Eq, Serialize)]
pub struct GateReceipt {
    pub user: AztecAddress,
    pub identity: Field,
    pub gas: OverheadGas,
}
