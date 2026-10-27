//! Shared logic of the Oxide refund circuits.

mod frozen_tip;
mod migration_signature;
pub mod test_fixtures;

pub use frozen_tip::assert_is_frozen_tip;
pub use migration_signature::{assert_valid_migration_signature, MigrationSignature};
