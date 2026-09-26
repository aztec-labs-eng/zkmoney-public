// Stealth crypto lives in sdk (sipaStealth.ts) so contract-adjacent services can share it;
// re-exported here for the existing front-core consumers.
export {
  MAX_NONCE,
  type SipaK1Point,
  deriveSharedSecret,
  computeStealthRecipientHash,
  deriveRecoveryAddress,
  deriveRecoveryPrivateKey,
} from "@obsidion/sdk"
