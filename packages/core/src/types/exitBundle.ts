// Exit-runner protocol — the versioned request/result envelope between the v5
// host and a frozen-generation exit runner. Two Aztec protocol versions can't
// share one node_modules, so each generation's runner is a version-pinned
// out-of-process step and these types cross the boundary as JSON, pinned by one
// golden-vector fixture (packages/front-core/test/fixtures/exit-bundle-golden.json).
// A non-additive wire change must update the fixture and bump the wire version
// declared in @obsidion/front-core's exitBundleCodec.
//
// Trust boundary: the host treats every runner→host message as untrusted input
// (fail-closed parse in @obsidion/front-core exitBundleCodec). The runner never
// submits L1 transactions — ExitBundleResult carries only calldata material
// (proof, nullifiers, TEE signature, amount); recipient and portal always come
// from host-held state.

// ── Host → runner ────────────────────────────────────────────────────

/**
 * Everything one frozen-generation exit needs. Key material is harness/test
 * account material in the PoC. `teeSecretKey` reconstructs the harness
 * LocalTeeSigner; the production co-signature path is deferred.
 */
export interface ExitBundleRequest {
  protocolVersion: number
  type: "exit-request"
  /** Account secret key (Fr hex, 0x-prefixed). */
  secretKey: string
  /** ECDSA k256 signing key (hex, no 0x — matches the migration handoff). */
  signingKey: string
  /** Expected v4 account address — the runner asserts derivation matches. */
  accountAddress: string
  /** Harness LocalTeeSigner secret (Buffer32 hex). */
  teeSecretKey: string
  /** Demoted-generation node RPC URL. */
  nodeUrl: string
  /** L1 RPC URL — read-only calls (freeze archive, withdrawn-note filter). */
  l1RpcUrl: string
  l1ChainId: number
  /** The frozen generation's on-chain rollup version. */
  rollupVersion: string
  /** L1 TEE portal address (0x…, 20 bytes). */
  portalAddress: string
  /** The generation's L2 token address (0x…, 32 bytes). */
  l2TokenAddress: string
  /** L1 recipient of the exited ERC20 (0x…, 20 bytes). */
  l1Recipient: string
  /** Processor tip, decimal string (0 on the v4 escape-door path). */
  processorTip: string
}

/** Host acknowledgement after NotesEnumerated — the runner proceeds to prove. */
export interface ExitBundleProceed {
  protocolVersion: number
  type: "proceed"
}

export type ExitBundleHostMessage = ExitBundleRequest | ExitBundleProceed

// ── Runner → host ────────────────────────────────────────────────────

export type ExitBundleStage = "booting" | "syncing" | "enumerating" | "proving" | "done"

export interface ExitBundleStatus {
  protocolVersion: number
  type: "status"
  stage: ExitBundleStage
  detail?: string
}

export interface ExitBundleNotesEnumerated {
  protocolVersion: number
  type: "notes-enumerated"
  noteCount: number
  /** Total exitable amount, decimal string. */
  totalAmount: string
}

/**
 * Calldata material for the portal's frozen-notes withdrawal. The host submits
 * with its own viem client against the frozen generation's portal ABI.
 */
export interface ExitBundleResult {
  protocolVersion: number
  type: "exit-result"
  /** Exited amount, decimal string. */
  amount: string
  /** UltraHonk proof bytes, 0x hex. */
  proof: string
  /** Spent-note nullifiers, 0x 32-byte hex each. */
  nullifiers: string[]
  /** TEE ECDSA co-signature over the portal's public-input digest, 0x hex. */
  teeSignature: string
  /** Proving wall time (witness + proof), ms. */
  provingMs: number
}

export interface ExitBundleError {
  protocolVersion: number
  type: "error"
  stage?: ExitBundleStage
  message: string
}

export type ExitBundleMessage =
  | ExitBundleStatus
  | ExitBundleNotesEnumerated
  | ExitBundleResult
  | ExitBundleError

// ── Generation manifest ──────────────────────────────────────────────

export type GenerationStatus = "frozen" | "canonical"

/**
 * One rollup generation this app build supports, keyed by the on-chain rollup
 * version. `frozen` entries name the demoted chain surface and the exit-bundle
 * asset; the `canonical` entry is the live generation (no bundle). The L1
 * registry (`getCanonicalRollup()`) stays the runtime source of truth — a
 * follow-up adds the cross-check.
 */
/**
 * Per-generation backend service URLs. Present on frozen entries whose stack must reach a
 * SEPARATE service instance from the canonical one (both generations run live at once, on distinct
 * ports). Canonical entries omit this and use the app's base URLs. Each generation's
 * stack passes these into its ContractService/clients, overriding the hardcoded `SERVICE_PORTS`.
 */
export interface GenerationServices {
  addressRegistry?: string
  accountService?: string
  resolver?: string
}

export interface GenerationManifestEntry {
  /** On-chain rollup version number (the portal's ROLLUP_VERSION). */
  version: number
  status: GenerationStatus
  /** Demoted node RPC URL (frozen entries). */
  nodeUrl?: string
  /** L1 TEE portal address (frozen entries). */
  portalAddress?: string
  /** L1 ERC20 underlying the portal (frozen entries). */
  erc20Address?: string
  /**
   * Exit-flow SubsidyManager bound to this band's portal (frozen entries) — a required
   * `Pool.processWithdrawals` argument that pays the executor, since the exit itself tips zero.
   * Distinct from the deposit-flow `subsidyManager` on the oxide manifest tuple; the two are
   * different contracts and swapping them quotes zero payout, so the operation never executes.
   */
  exitSubsidyManager?: string
  /** Exit-bundle asset name (frozen entries), e.g. "exit-v4". */
  bundleAsset?: string
  /**
   * Full 40-char deploy sha of this band's oxide cut. Two WARN-only consumers compare it against
   * the live manifest's `versions.<stack>.current.gitSha`: the boot-time env-profile drift WARN
   * (the shipped testnet profile sources its sha from the canonical entry) and the v4 exit's
   * manifest fetch. Never fatal — an exit must not brick on a redeploy.
   */
  expectedGitSha?: string
  /** Per-generation backend service URLs (frozen entries); routed to by the active generation. */
  services?: GenerationServices
  /**
   * Which TS sdk lineage constructs this generation's wallet/PXE: "v4" = the frozen
   * snapshot (4.3.0 `node_*` RPC), "v5" = the current @obsidion/sdk
   * (5.0.1 `aztec_*` RPC). Boot picks the create path from the canonical entry's value.
   */
  stack?: "v4" | "v5"
  /**
   * This generation's contract-service registry version (the `registry[version]`
   * slot its deployed contracts live under). Sourced from the generation, not the
   * live-core `CONTRACT_SERVICE_VERSION` constant — a v4-canonical device must
   * read the v4 slot ("0.0.2"), not the current stack's ("0.0.3"). The v4 exit
   * runtime reads it off the frozen generation's entry.
   */
  contractServiceVersion?: string
}
