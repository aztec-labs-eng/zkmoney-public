// The rollup generations an app build supports; the runtime GENERATIONS manifest lives in constants.

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
