// @obsidion/core/types — leaf type declarations for the obsidion workspace.
//
// Invariant: this module must not transitively import contract artifacts,
// any @obsidion workspace package, or @aztec/* runtime entry points.
// All @aztec/* references are type-only.

import type { AztecAddress } from "@aztec/stdlib/aztec-address"
import type { ContractArtifact } from "@aztec/stdlib/abi"
import type { Fr } from "@aztec/aztec.js/fields"
import type { TxReceipt } from "@aztec/stdlib/tx"
import type { FieldLike } from "@aztec/aztec.js/abi"
import type { TxSendResultImmediate } from "@aztec/aztec.js/contracts"
import type { DEFAULT_CONTRACTS_NAME, SWAP_ON_WITHDRAW_OUTPUTS } from "../constants/index.js"
// ── Network ──────────────────────────────────────────────────────────

// Re-export the runtime Network enum so its TYPE is reachable from the
// types subpath. The single declaration lives in ../constants/index.ts.
export { Network } from "../constants/index.js"
import type { Network } from "../constants/index.js"

/** Alias for call sites that import `NetworkType` instead of `Network`. */
export type NetworkType = Network

export type NetworkMap<T> = Record<Network, Record<string, T>>

// ── Swap-on-withdraw ─────────────────────────────────────────────────

/** What a swap-on-withdraw delivers on L1 in place of the withdrawn DAI. */
export type SwapOnWithdrawOutput = (typeof SWAP_ON_WITHDRAW_OUTPUTS)[number]

// ── Contracts ────────────────────────────────────────────────────────

export type ContractName = (typeof DEFAULT_CONTRACTS_NAME)[number]

// Re-export the FPCPaymentType type identity from constants for the same
// reason — its runtime form lives there, but the type identity is reachable
// from the types subpath.
export { FPCPaymentType } from "../constants/index.js"

// ── Contract service ─────────────────────────────────────────────────

// FetchFunction type for pluggable fetch method
export type FetchFunction = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface ContractServiceOptions {
  fetchFunction?: FetchFunction
  /**
   * Where contract addresses come from.
   * `"profile"` → the `config` snapshot below, which is fixed at construction, so the
   * address mutators throw. `"local-ledger"` → storage alone, written by the caller (the deploy
   * tooling's mode: the run records its own deployments).
   */
  source: "profile" | "local-ledger"
  config?: ContractServiceConfig
  /**
   * Oxide env-registry profile override. An explicit profile forces it; `null`
   * disables the oxide overlay entirely; omitted → the `config` snapshot's own
   * `oxide` pointer in profile mode, else no overlay.
   */
  oxideEnvProfile?: OxideEnvProfile | null
  /**
   * Generation seam for hardcoded artifacts: return the canonical generation's
   * compiled artifact JSON for a contract, or null to use this branch's
   * compilation.
   */
  resolveGenerationArtifact?: (contract: ContractName) => unknown | null
  resolveClassArtifact?: (classId: string) => Promise<ContractArtifact>
  onL1AddressesLoaded?: (addresses: { token: string; portal: string }) => void
}

// ── Oxide env-registry ───────────────────────────────────────────────

/**
 * Pointer to oxide's hosted deployment-env manifest. This is the ONLY part of the oxide
 * environment that builds bake in — the values behind it roll at runtime. `portal` is a pinned
 * deployment, never "latest".
 */
export interface OxideEnvProfile {
  /** HTTPS URL of oxide's `<env>.v4.json` manifest. */
  manifestUrl: string
  /** The pinned deployment's `portal`: one entry in the manifest's `deployments[]`. */
  portal: string
  /**
   * Full 40-char git SHA of the deployment this profile is pinned to. When set,
   * the boot-time apply path logs a drift WARN if the live `tuple.gitSha` is
   * non-empty and differs (observability only, non-blocking — see
   * OxideEnvRegistryClient). Compared full-to-full, so it must be the complete
   * sha the manifest carries, not an abbreviation. Optional: set on the shipped
   * staging profile and the dev override, omittable for any profile that opts
   * out of drift observability.
   */
  expectedGitSha?: string
}

// ── Config snapshot ──────────────────────────────────────────────────

export interface ContractServiceConfigEntry {
  address?: string
  classId: string
  meta?: Record<string, unknown>
}

/**
 * The config a ContractService runs on, as data. Hand-written here rather than derived from the
 * profile schema because core carries no zod and never imports the config package: the arrow
 * points the other way, and `@obsidion/config-client` maps a fetched profile onto this shape.
 */
export interface ContractServiceConfig {
  /** Must agree with the network the service was constructed for; a mismatch is rejected. */
  network: Network
  /** The profile version these contracts came from. A paylink stamps it into its link. */
  configVersion: string
  /** Keyed by ContractName, so profile keys are translated on the way in, never passed through raw. */
  contracts: Partial<Record<ContractName, ContractServiceConfigEntry>>
  oxide: OxideEnvProfile | null
}

/**
 * The resolved deployment tuple. The attestation-coupled `enclaveUrl` ↔ `portal` ↔ `pcr0`
 * triple is ATOMIC and always comes from one manifest entry (the enclave's identity is verified
 * against the on-chain portal binding), so consumers must never mix it across entries.
 */
export interface OxideEnvTuple {
  /** The deployment's `label` (its SSM scope and fleet name). */
  version: string
  gitSha: string
  /**
   * The entry's `updatedAt`. Parsed to epoch ms at validation time; drives the monotonic-apply
   * guard (an older tuple is never applied over a newer one).
   */
  timestamp: string
  /**
   * The entry's `deployedAt` — when this deployment came into existence. Republishing advances
   * `timestamp` and leaves this alone, so an L1 scan for the deployment starts here.
   */
  deployedAt: string
  /** The number of the L1 block the deployment's own transactions start at, as a decimal string. */
  deployedAtBlock?: string
  /** L1 TEE portal address (20-byte hex). */
  portal: string
  /** L1 chain id as a decimal string. */
  chainId?: string
  /** L1 ERC-20 token address (20-byte hex). */
  token: string
  /** L2 oxide-token address (32-byte hex). */
  l2Token: string
  /** Public TEE proxy /rpc endpoint for this version's enclave. */
  enclaveUrl: string
  pcr0: string
  rollupVersion: string
  certManager?: string
  nitroValidator?: string
  /** Account-abstraction + ENS handles. `registry` is the entry's `nameRegistry`. */
  registry?: string
  /** L1 AccountMetadataRegistry — the replaceable per-user metadata and resolver-operator store the
   *  NameRegistry points at. */
  accountMetadataRegistry?: string
  accountFactory?: string
  paymaster?: string
  entryPoint?: string
  ensDomain?: string
  /** SIPA stealth-deposit surface; the implementations, `depositSubsidy` and `l2Broadcaster` roll per deployment. */
  sipaFactory?: string
  sipaRecoveryProtocol?: "legacy-eoa" | "account"
  /** The latest CCIP resolution module (`NameRegistry.resolver`) — the `resolve` target. */
  sipaResolver?: string
  /** The blessed RegistrationController — the payment-policy contract holding the registration
   *  schedule immutables and verifying SignedTerms; absent on pre-split pins, where the schedule
   *  lives on the registry itself. */
  registrationController?: string
  /** The NamePortal — sends the L1->L2 message attesting that an account holds a name. ClaimFPC's
   *  registration rail pins it as the only sender it accepts; absent on pins that predate it, where
   *  no such message is ever emitted. */
  namePortal?: string
  resolverProofVerifier?: string
  resolverGatewayUrl?: string
  /**
   * The generation's blessed SIPA implementations, one per intent family. Deployment-coupled
   * (`current` only), and the word every SIPA address commits to: each bakes in this generation's
   * portal and its own `depositFee()`, which is why a registration sweep prices higher than a plain
   * deposit's. `SIPAFactory` keeps only one forward pointer per rollup version, and every
   * generation deployed against that version overwrites it, so a retired generation's SIPAs are
   * derivable from these alone. Absent on generations that predate version-scoped implementations —
   * their SIPAs used a different address preimage and are not derivable here at all.
   */
  depositSIPAImplementation?: string
  registrationSIPAImplementation?: string
  depositSubsidy?: string
  /** Pays a relayer that finalizes a withdrawal or refund through the plain withdrawal executor. */
  withdrawalSubsidy?: string
  proverSubsidy?: string
  /** L1 executor every wallet withdrawal settles into; it pays the relayer tip and forwards the rest to the
   *  recipient named in the user payload. */
  plainWithdrawalExecutor?: string
  /** L2 Broadcaster the wallet broadcasts L1 operations through. */
  l2Broadcaster?: string
  frozenNotesRefundVerifier?: string
  frozenDepositRefundVerifier?: string
  unprocessedDepositRefundVerifier?: string
  frozenNotesRefundVkSha256?: string
  frozenDepositRefundVkSha256?: string
  /** L1 SwapEscrowFactory for swap-on-withdraw. Deployment-coupled (`current` only); a swap
   *  withdrawal fails loudly at submit where the manifest hasn't published one yet. */
  swapEscrowFactory?: string
  /** L1 OperationExecutor oxide's relayers run broadcast L1 operations through. The swap-on-withdraw
   *  tip is priced by simulating the relayer's exact `execute` call against it. */
  operationExecutor?: string
  /** The ClaimFPC counterfactual oxide's FPCFunder deposits to, and the deploy salt it was derived
   *  with. Oxide derives both from the seeded ClaimFPC inputs at its L1 deploy; our deploy rederives
   *  the address from the salt and refuses to land anywhere else. */
  fpcFunder?: string
  fpcBeneficiary?: string
  fpcBeneficiarySalt?: string
}

/**
 * What a ContractService needs from storage in every mode: a per-process memo for artifact
 * promises. Artifacts are multi-MB JSON behind dynamic imports, and PXE keys them by class id
 * and instances by address, so it cannot answer name→artifact — the memo earns its place.
 *
 * Profile mode needs nothing beyond this, which is why both wallet implementations are memo-only.
 */
export interface IContractServiceStorage {
  getArtifactCache(): Map<ContractName, Promise<ContractArtifact>>
  setArtifactCache(contract: ContractName, artifactPromise: Promise<ContractArtifact>): void
}

/**
 * The extra surface `source: "local-ledger"` needs: the caller writes its own deployments and
 * reads them back. Deploy tooling and the sdk/backend test harnesses run on this; no shipped
 * wallet does.
 */
export interface ILocalLedgerStorage extends IContractServiceStorage {
  getContractAddressMap(): Promise<Map<ContractName, AztecAddress>>
  getContractAddress(name: ContractName): Promise<AztecAddress | null>
  setContractAddress(name: ContractName, address: AztecAddress): Promise<void>
}

// ── Auth ─────────────────────────────────────────────────────────────

// Re-export the runtime AUTH_TYPE enum from constants for type identity.
export { AUTH_TYPE } from "../constants/index.js"

/**
 * Which WebAuthn PRF output slot a credential's MSK is derived from.
 *
 * Passkey providers contextualize the PRF salt differently:
 * iCloud Keychain (and Apple's security-key path) produce the
 * browser-reproducible value in `eval.first`; Google Password Manager
 * produces it in `eval.second`. The slot is decided once at credential
 * creation (from the attestation AAGUID) and persisted, because an
 * assertion carries no AAGUID. Shared here so every consumer agrees on
 * the same union.
 */
export type PrfSlot = "first" | "second"

/**
 * Which device answers a laptop sign-in or unlock. The user picks one on every laptop ceremony:
 * `this-device` admits the browser's own synced passkey, `phone` scans a QR to the phone, and
 * `security-key` uses a roaming hardware key. Shared here so the recovery requests, the SDK's
 * `createPasskey` options and the web screens agree on one union without a layering break.
 */
export type SignInRoute = "this-device" | "phone" | "security-key"

// ── Cross-cutting transaction/UI enum types ──────────────────────────

export {
  TokenActionEnum,
  PaylinkActionEnum,
  TransactionStatusEnum,
  QueueStatus,
  TransactionProgress,
  OtherActionEnum,
  Visibility,
} from "../constants/index.js"

// ── Transaction result types ─────────────────────────────────────────

/**
 * Base transaction result type with common fields
 */
export type BaseTransactionResult = {
  txHash: string
  revertReason?: {
    functionErrorStack?: {
      functionSelector?: string
    }[]
  }
}

/**
 * Send-time transaction payload returned after the node accepts a NO_WAIT send.
 * This is not mined/checkpointed yet; it carries the tx hash plus offchain
 * artifacts produced during private execution.
 */
export type SentTransaction = {
  txHash: string
} & Omit<TxSendResultImmediate, "txHash"> &
  Record<string, unknown>

/**
 * Pay-to-Email transaction results
 */
export type PayToEmailSendResult = BaseTransactionResult & {
  email: string | null
}

export type PayToEmailCreateResult = BaseTransactionResult & {
  payToEmailSecret: string
  senderAddress: string
  partialAddress: string
  email: string
}

export type PayToEmailClaimResult = BaseTransactionResult & {
  receipt: TxReceipt
}
export type PayToEmailRefundResult = BaseTransactionResult

export type PayToEmailSendTransactionResult = {
  txPromise: Promise<PayToEmailSendResult>
  txHash: Promise<string>
}

export type PayToEmailCreateTransactionResult = {
  txPromise: Promise<PayToEmailCreateResult>
  txHash: Promise<string>
  payToEmailSecret: string
  senderAddress: string
  partialAddress: string
  email: string
  tokenAddress: string
  initHash: string
  classID: string
  ciphertext: Fr[]
}

export type PayToEmailClaimTransactionResult = {
  txPromise: Promise<PayToEmailClaimResult>
  txHash: Promise<string>
}

export type PayToEmailRefundTransactionResult = {
  txPromise: Promise<PayToEmailRefundResult>
  txHash: Promise<string>
}

export type TokenTransactionResult = {
  txPromise: Promise<BaseTransactionResult>
  txHash: Promise<string>
  sentTx: Promise<SentTransaction>
}

export type AutoShieldTransactionResult = {
  txPromise: Promise<BaseTransactionResult>
  txHash: Promise<string>
}

export type AccountTransactionResult = {
  txPromise: Promise<BaseTransactionResult>
  txHash: Promise<string>
}

// ── Pending tx record ────────────────────────────────────────────────

/**
 * The lifecycle's receipt probe. The wallet writes one right after a successful node submit so the
 * activity row can flip to mined or dropped, and it survives restarts. Evicted at
 * `min(expiresAtMs, submittedAt + MAX_TX_LIFETIME_MS)` plus the read-side clock-skew margin.
 */
export interface PendingTxRecord {
  readonly txHash: string
  /** Kernel `expirationTimestamp` in ms, capped at `MAX_TX_LIFETIME_MS` past submit. */
  readonly expiresAtMs: number
  /** Wall-clock at submission. */
  readonly submittedAt: number
}

// ── Pure-data paylink commitment / claim types ─
// Types whose import chains stay clean (only @aztec/* in type position) live
// here. Types carrying SDK-local runtime references stay in @obsidion/sdk's
// services/paylink/types.ts.

/**
 * Email paylink commitment input - just the email
 */
export interface EmailCommitmentInput {
  email: string
}

/**
 * Union type for commitment inputs
 */
export type CommitmentInput = string | EmailCommitmentInput

export type PayLinkAsset = {
  name: string
  symbol: string
  address: string
  decimals: number
  balance?: number
  publicBalance?: number
  privateBalance?: number
  price?: number
  change?: number
  changeAmount?: number
  logo?: string
}

/**
 * Base claim input type
 */
export interface BaseClaimInput {
  // Processor-specific data will be added by each implementation
  [key: string]: unknown
}

/**
 * Direct paylink claim input — no proof needed.
 */
export interface DirectClaimInput extends BaseClaimInput {}

/**
 * Paylink timestamps (unix seconds) chosen at creation. The claim window is
 * [fromClaimable, untilClaimable]; the creator refund window opens at creation and closes at
 * refundableUntil, which may overlap the claim window but never exceeds untilClaimable.
 */
export interface PaylinkWindow {
  fromClaimable: bigint
  untilClaimable: bigint
  refundableUntil: bigint
}

/**
 * Email paylink (ZK-JWT) — nested proof bundle verified in-contract via `verify_jwt`.
 */
export interface ZkProofClaimInput {
  zkProof: {
    vkey: FieldLike[]
    proof: FieldLike[]
    public_inputs: string[]
  }
}

// ── Exit-bundle protocol + generation manifest ──────────────────────
// Cross-generation migration wire types. Pure data; the runtime GENERATIONS
// manifest lives in constants and the wire version in front-core's
// exitBundleCodec.
export type {
  ExitBundleRequest,
  ExitBundleProceed,
  ExitBundleHostMessage,
  ExitBundleStage,
  ExitBundleStatus,
  ExitBundleNotesEnumerated,
  ExitBundleResult,
  ExitBundleError,
  ExitBundleMessage,
  GenerationStatus,
  GenerationManifestEntry,
  GenerationServices,
} from "./exitBundle.js"

// ── Generation stack (migration seam) ────────────────────────────────
// Version-agnostic contract each generation's adapter implements.
export type { GenerationStack, FrozenNotesEnumeration } from "./generationStack.js"

export type {
  RegistrationIntent,
  UserRecord,
  K1PointArg,
  RegistrationKind,
  RegistrationSchedule,
  RegistrationPricing,
} from "./registration.js"

// ── Local config ─────────────────────────────────────────────────────
// Declared next to LOCAL_CONFIG_DEFAULTS in ./constants; re-exported here so
// the type is reachable from the types subpath.
export type { LocalConfig } from "../constants/index.js"

// ── Benchmark DTOs ───────────────────────────────────────────────────
// Time-performance benchmark schema (docs/plans/2026-06-03-001). Pure data.
export type {
  BenchmarkFlow,
  BenchmarkSampleStatus,
  PhaseDurations,
  SimFunctionTiming,
  BenchmarkSample,
} from "./benchmark.js"

// ── Bridge lifecycle phases ──────────────────────────────────────────
// Shared vocabulary for L1↔L2 value movement. Defined here (the DTO leaf) so
// sdk services and front-core stores speak the same phase names; front-core
// re-exports them for its storage records.

/** L2→L1 withdrawal lifecycle. */
export type WithdrawalPhase =
  | "submitting" // User tapped Confirm. Pre-mine: no l2TxHash yet. Keyed by localId.
  | "l2_mined" // Burn `withdraw` tx included on L2. l2TxHash + blockNumber known.
  | "awaiting_proven" // Watching the L2 tx receipt until it is proven (or finalized).
  | "finalizing_l1" // L2 proven; polling the portal's `$isWithdrawalSpent` for L1 release.
  | "swapping" // Swap-on-withdraw only: DAI released to the escrow; waiting for a relayer to run the swap.
  | "recoverable" // Swap-on-withdraw only: the escrow holds DAI its route cannot deliver — recoverERC20 is the exit.
  | "recovered" // Swap-on-withdraw only: recoverERC20 confirmed. Terminal.
  | "done" // L1 payout observed (the release on a direct withdrawal, the swap on a swap). Never demotable.
  | "failed" // Terminal — pre-mine local error, or a reorg-dropped burn.

/** SIPA deposit lifecycle (L1→L2). */
export type SIPADepositPhase =
  | "resolved" // self-initiated flow only: the name was resolved to a SIPA address
  | "funding" // self-initiated flow only: the sender's L1 transfer is broadcast, awaiting receipt
  | "funded" // self-initiated flow only: the sender's L1 transfer landed
  | "broadcast" // the resolver's SIPANote was discovered (primary-flow creation phase)
  | "sweeping" // a relayer is deploying the SIPA + sweeping into the pool
  | "pendingClaim" // Sweep log read; waiting for the L1→L2 message to settle
  | "claimed" // store_deposit succeeded — balance-visible. Terminal.
  | "failed" // Terminal.
  | "recoverable" // sweep cannot proceed (e.g. sub-fee funding) — recoverERC20 is the exit
  | "recovered" // recoverERC20 completed. Terminal.
