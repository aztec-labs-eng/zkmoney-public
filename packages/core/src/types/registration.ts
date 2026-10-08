// Registration-by-deposit shared types (registration-fee.md §SIPA / §Registry).
//
// Leaf types only — no runtime, no @aztec/* or workspace imports. Mirrors oxide's
// `AccountMetadataRegistry.UserRecord` struct and its `RegistrationIntent` codec field-for-field,
// so the client encoder that produces `recordData` and the contract that `abi.decode`s it agree
// byte-for-byte.

/** secp256k1 public-key point — the on-chain `K1Point { uint256 x; uint256 y; }`. */
export interface K1PointArg {
  x: bigint
  y: bigint
}

/**
 * The per-user record the AccountMetadataRegistry stores, in the EXACT field order the contract
 * `abi.decode(recordData, (address, bytes32, AccountMetadataRegistry.UserRecord))` expects. The
 * name itself lives in the NameRegistry, so no nameHash and no resolver here.
 *
 * - `l2Address` — the L2 account recorded as `UserRecord.l2Address` (`bytes32`).
 * - `rollupVersion` — binds the record to a rollup (`uint256`).
 * - `publicKey` — the user's registry stealth key (`K1Point`).
 * - `resolverOperator` — the gateway operator EOA serving this user; keys the `ResolverOperator` record.
 */
export interface UserRecord {
  l2Address: `0x${string}`
  rollupVersion: bigint
  publicKey: K1PointArg
  resolverOperator: `0x${string}`
}

/**
 * The full registration intent a registration SIPA commits to: the registration record plus the
 * payment the SIPA base performs. The fee and the funder are committed in the SIPA address, so a
 * controller swapped in after the deposit can refuse the sweep but cannot re-price or redirect it.
 *
 * - `owner` — the predicted OxideAccount; `FACTORY.predictAccountAddress(bootstrapKey)` must equal it.
 * - `nameHash` — the wire nameHash the NameRegistry keys the claim on (`bytes32`).
 * - `record` — the metadata the controller writes to the AccountMetadataRegistry once the name is
 *   claimed.
 * - `fee` — the fee the sweep pays, in the fee token. Must equal the controller's schedule fee (or
 *   the signed terms' fee).
 * - `beneficiary` — the allowlisted funder the fee goes to. Irrelevant when `fee` is zero.
 * - `recipientCommitment` — the owner's L2 recipient the SIPA base bridges the post-fee remainder to.
 * - `namePortalRecipient` — the L2 address the NamePortal reports the claimed name to. Zero notifies
 *   nobody, which is what a deployment with no registration-gated rail commits to.
 */
export interface RegistrationIntent {
  owner: `0x${string}`
  nameHash: `0x${string}`
  record: UserRecord
  fee: bigint
  beneficiary: `0x${string}`
  recipientCommitment: `0x${string}`
  namePortalRecipient: `0x${string}`
}

/** How a registration is priced: paid at the standard schedule, or a tag the campaign granted. */
export type RegistrationKind = "standard" | "earned_tag"

/**
 * Two flags stand for a kind elsewhere: `reduced` on the claim server's signed terms, and
 * `feeWaived` on what a wallet stores. Each means `earned_tag` when true and `standard` otherwise.
 * `registrationKind()` is the one boundary that turns either flag into a kind.
 */

/** The minimum deposit and the fee the chain enforces for one kind. */
export interface RegistrationSchedule {
  min: bigint
  fee: bigint
}

/** Everything that prices one kind of registration: the enforced schedule and the deposit asked for. */
export interface RegistrationPricing extends RegistrationSchedule {
  kind: RegistrationKind
  ask: bigint
}

// ── Claim server wire shapes (account-service `/domain/*`) ───────────
// Uint256s are decimal strings: JSON has no bigint.

/**
 * The operator-signed `SignedTerms` struct `RegistrationController.register()` verifies. It DEFINES
 * the name's fee and minimum deposit; clients pass it through, never re-derive it.
 */
export interface SignedTermsResponse {
  fee: string
  minDeposit: string
  nonce: string
  deadline: string
  signature: `0x${string}`
  /** The reduced schedule: the tag price is waived and `fee` is at least the relayer's sweep fee. */
  reduced: boolean
  /** A golden ticket bought the reduced schedule (no opening minimum); otherwise an earned tag. */
  ticket: boolean
}

/** The claim server's hold on a name: anyone may reserve it past `deadline` (unix seconds). */
export interface NameHold {
  deadline: string
}

/** `POST /domain/sign`: the NameClaim the Registry verifies, the name's hold, and its terms. */
export interface NameClaimResponse {
  signature: `0x${string}`
  nonce: string
  /** The NameClaim's validity, unix seconds. A re-sign refreshes it; it never extends the hold. */
  deadline: string
  /** Anchored at the holder's first reserve, so a re-sign inside a live hold reports the same end. */
  hold: NameHold
  /** Absent where no controller is configured: the contract's immutable schedule applies. */
  terms?: SignedTermsResponse
}

/** `POST /domain/reservation`: the names a bootstrap key has claimed, and its live signed holds. */
export interface NameReservationResponse {
  nameHashes: `0x${string}`[]
  issued: { nameHash: `0x${string}`; hold: NameHold }[]
}
