//! Shared logic of the Oxide refund circuits.

mod authorization;
mod frozen_tip;

pub use authorization::{assert_refund_authorized, RefundAuthorization};
pub use frozen_tip::assert_is_frozen_tip;
