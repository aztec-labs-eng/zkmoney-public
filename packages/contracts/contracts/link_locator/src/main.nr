use aztec::macros::aztec;

/// Publishes a shared link's payload under a tag only the link's holder can compute. Log tags are
/// siloed by the emitting contract's address, so a link holder can find a log only from a contract
/// whose address it already knows: this one is never deployed, and every client derives its address
/// from the artifact.
#[aztec]
pub contract LinkLocator {
    use aztec::{macros::functions::external, protocol::constants::PRIVATE_LOG_CIPHERTEXT_LEN};

    /// `payload` is encrypted by the caller and always fills the log, so every locator log is the
    /// same length. Anyone holding a link can announce under its tag, so nothing here reserves it:
    /// the payload is signed by the link's key, and a reader drops any other.
    #[external("private")]
    fn announce(tag: Field, payload: [Field; PRIVATE_LOG_CIPHERTEXT_LEN]) {
        self.context.emit_private_log_unsafe(tag, BoundedVec::from_array(payload));
    }
}
