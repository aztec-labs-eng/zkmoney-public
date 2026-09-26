import type { FetchFunction, OxideEnvProfile, OxideEnvTuple } from "@obsidion/core/types"

// The canonical manifest validator + extractor live in the leaf package
// (@obsidion/core/oxide), which carries zero @aztec/* weight, so strict
// full-tuple consumers can share one copy. Re-exported here for consumers that
// import them from this module.
import {
  type ExtractOxideEnvTupleOptions,
  OxideManifestValidationError,
  extractPinnedOxideEnvTuple,
} from "@obsidion/core/oxide"

export { OxideManifestValidationError, extractPinnedOxideEnvTuple }

// OxideEnvRegistryClient — runtime consumer of oxide's hosted v4 manifest. Resolves one atomic
// tuple per fetch: the entry in `deployments[]` whose `portal` the profile pins. The
// attestation-coupled enclaveUrl ↔ portal ↔ pcr0 triple (FleetSigner.connect verifies the
// enclave against the on-chain portal binding) must never be mixed across snapshots, so the
// tuple is frozen and replaced whole. Other entries on the pinned rollup are migration sources,
// never attestation sources — their enclaves may be dead.
//
// Layering note: a pure HTTP client would normally live in front-core per
// CLAUDE.md's decision tree. It lives here because ContractService (contracts
// layer) consumes the tuple for its read-time address overlay, and front-core
// sits ABOVE contracts. Do not treat this as precedent for other HTTP clients.
//
// Runtime constraints (this file runs in browsers, Node, and Bun):
//   - global fetch only (injectable for tests, mirroring ContractService)
//   - manual AbortController timeout
//   - NO process.env reads at module scope

const DEFAULT_FETCH_TIMEOUT_MS = 15_000

// Boot-retry backoff — runs only while no tuple has been applied; once one has,
// refreshes are consumer-driven.
const RETRY_INITIAL_DELAY_MS = 2_000
const RETRY_MAX_DELAY_MS = 60_000
const RETRY_JITTER_RATIO = 0.2

export type OxideResolutionSource = "live" | null
export type OxideFailureMode = "fetch-failed" | "manifest-incompatible" | null

export interface OxideResolutionState {
  /** Where the currently applied tuple came from; null when no tuple. */
  source: OxideResolutionSource
  /** Most recent refresh failure classification; null after a success. */
  failureMode: OxideFailureMode
  /** Epoch ms of the last successful fetch. */
  fetchedAt: number | null
}

function tuplesEqual(a: OxideEnvTuple, b: OxideEnvTuple): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof OxideEnvTuple>
  for (const key of keys) {
    if (a[key] !== b[key]) return false
  }
  return true
}

export interface OxideEnvRegistryClientDeps {
  profile: OxideEnvProfile
  /** Injectable fetch (tests); defaults to global fetch. */
  fetchFunction?: FetchFunction
  /** Fetch timeout override (ms). */
  timeoutMs?: number
  /**
   * The pinned-entry policy the caller derived (`pinnedEntryPolicy`), forwarded unchanged to
   * every extraction: on mainnet the strict prod schema + the fatal same-sha gate, so a
   * wrong/partial manifest fails closed instead of degrading to empty registry rows with real
   * funds; undefined keeps the lenient tuple + the non-blocking gitSha-drift WARN.
   */
  extractOptions?: ExtractOxideEnvTupleOptions
}

export class OxideEnvRegistryClient {
  private readonly profile: OxideEnvProfile
  private readonly fetchImpl: FetchFunction
  private readonly timeoutMs: number
  private readonly extractOptions: ExtractOxideEnvTupleOptions | undefined

  private appliedTuple: OxideEnvTuple | null = null
  private appliedTimestampMs: number | null = null
  private source: OxideResolutionSource = null
  private failureMode: OxideFailureMode = null
  private fetchedAt: number | null = null
  /** Last gitSha a deployment-identity drift WARN was emitted for — dedups the
   *  warning so a steady-state poll loop does not spam it (see warnOnGitShaDrift). */
  private lastWarnedGitSha: string | null = null

  private subscribers = new Set<(tuple: OxideEnvTuple) => void>()
  private inFlight: Promise<void> | null = null
  private initPromise: Promise<void> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private activeAbort: AbortController | null = null
  private retryAttempt = 0
  private disposed = false

  constructor(deps: OxideEnvRegistryClientDeps) {
    this.profile = deps.profile
    this.fetchImpl = deps.fetchFunction || globalThis.fetch?.bind(globalThis) || fetch
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
    this.extractOptions = deps.extractOptions
  }

  getProfile(): OxideEnvProfile {
    return this.profile
  }

  /** The currently applied tuple — same frozen reference until the next apply. */
  getCurrentTuple(): OxideEnvTuple | null {
    return this.appliedTuple
  }

  /** Diagnostics only — never wraps the tuple (stable tuple identity matters). */
  getResolutionState(): OxideResolutionState {
    return { source: this.source, failureMode: this.failureMode, fetchedAt: this.fetchedAt }
  }

  /**
   * Listener fires only when a tuple is APPLIED with changed field values —
   * never for failed fetches, identical re-fetches, or discarded stale tuples.
   * Consumers seed initial state from getCurrentTuple(); because a tuple can
   * be applied before any subscriber exists, logic that reacts to one must
   * also run on the seeded value, not only inside the listener.
   */
  subscribe(listener: (tuple: OxideEnvTuple) => void): () => void {
    this.subscribers.add(listener)
    return () => {
      this.subscribers.delete(listener)
    }
  }

  /**
   * Boot entry point (idempotent): attempt one live refresh; if that fails
   * with no tuple applied, self-schedule capped-backoff retries until the
   * first success. Construction never fetches; this is the
   * only implicit-retry surface the client owns (consumer-driven triggers —
   * enclave failure, app foreground, relayer interval — call refresh()).
   */
  async initialize(): Promise<void> {
    if (this.initPromise) return this.initPromise
    this.initPromise = (async () => {
      await this.refresh()
      if (!this.appliedTuple && !this.disposed) {
        this.scheduleRetry()
      }
    })()
    return this.initPromise
  }

  /**
   * Fetch + validate + monotonically apply the manifest. Single-flight:
   * concurrent calls share one in-flight fetch. Never throws — failures are
   * classified on getResolutionState(); a failure leaves whatever tuple was
   * already applied in place, or none, and callers fall back to the snapshot.
   */
  async refresh(): Promise<void> {
    if (this.disposed) return
    if (this.inFlight) return this.inFlight

    this.inFlight = (async () => {
      const controller = new AbortController()
      // Held on the instance so dispose() can cancel an in-flight fetch (R14)
      // — a reset/unmount must not leave a request running for up to the
      // full timeout.
      this.activeAbort = controller
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      try {
        const response = await this.fetchImpl(this.profile.manifestUrl, {
          signal: controller.signal,
        })
        if (!response.ok) {
          throw new Error(`oxide env registry: HTTP ${response.status}`)
        }
        const manifest: unknown = await response.json()
        const { tuple, timestampMs } = extractPinnedOxideEnvTuple(
          manifest,
          this.profile,
          this.extractOptions,
        )
        if (this.disposed) return
        this.failureMode = null
        this.applyLive(tuple, timestampMs)
      } catch (error) {
        if (this.disposed) return
        if (error instanceof OxideManifestValidationError) {
          this.failureMode = "manifest-incompatible"
          console.error(
            `[OxideEnvRegistryClient] manifest at ${this.profile.manifestUrl} is incompatible ` +
              `(pinned ${this.pinLabel()}) — app update may be required: ${error.message}`,
          )
        } else {
          // A transient fetch failure must not mask a manifest already proven
          // incompatible: on mainnet the boot brick fires only on "manifest-incompatible"
          // with no applied tuple, so downgrading that to "fetch-failed" here would
          // let a build with a proven-bad pinned manifest boot quietly and retry
          // instead of failing loud. Keep the actionable classification. Scoped to
          // the prod gate so testnet/sandbox failure classification is unchanged.
          const keepIncompatible =
            this.extractOptions?.requireProdSchema === true &&
            this.failureMode === "manifest-incompatible" &&
            !this.appliedTuple
          if (!keepIncompatible) {
            this.failureMode = "fetch-failed"
          }
          console.warn(
            `[OxideEnvRegistryClient] manifest fetch failed (${(error as Error)?.message}); ` +
              `serving ${this.appliedTuple ? `${this.source} tuple` : "no tuple"}`,
          )
        }
      } finally {
        clearTimeout(timer)
        this.activeAbort = null
        this.inFlight = null
      }
    })()
    return this.inFlight
  }

  /** Cancel timers, subscriptions, AND any in-flight fetch (R14); a late
   *  completion that slips through will not apply/notify. Idempotent. */
  dispose(): void {
    this.disposed = true
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.activeAbort?.abort()
    this.activeAbort = null
    this.subscribers.clear()
  }

  private pinLabel(): string {
    return `portal ${this.profile.portal}`
  }

  private applyLive(tuple: OxideEnvTuple, timestampMs: number): void {
    // Monotonic apply (R13): a tuple older than the applied one is stale-edge
    // noise (CloudFront edges can briefly disagree post-roll) — never applied,
    // so neither wallet roll classification nor the relayer exit policy flaps.
    if (this.appliedTimestampMs !== null && timestampMs < this.appliedTimestampMs) {
      console.warn(
        `[OxideEnvRegistryClient] discarding stale-edge tuple (ts ${tuple.timestamp} < applied ` +
          `${this.appliedTuple?.timestamp}) — gitSha ${tuple.gitSha}`,
      )
      return
    }
    const changed = !this.appliedTuple || !tuplesEqual(this.appliedTuple, tuple)
    const previous = this.appliedTuple
    this.appliedTuple = changed ? tuple : previous
    this.appliedTimestampMs = timestampMs
    this.source = "live"
    this.fetchedAt = Date.now()
    this.cancelRetry()
    // Drift-check on EVERY apply, not only when `changed`: a re-fetch that
    // returns the tuple already applied (changed === false) must still warn.
    // warnOnGitShaDrift dedups so a steady-state poll loop stays quiet.
    if (this.appliedTuple) this.warnOnGitShaDrift(this.appliedTuple)
    if (changed && this.appliedTuple) {
      console.log(
        `[OxideEnvRegistryClient] applied tuple for ${this.pinLabel()}: ` +
          `gitSha=${this.appliedTuple.gitSha} rollupVersion=${this.appliedTuple.rollupVersion} ` +
          `portal=${this.appliedTuple.portal} enclaveUrl=${this.appliedTuple.enclaveUrl}`,
      )
      this.notify(this.appliedTuple)
    }
  }

  /**
   * Deployment-identity drift (origin D6, part i): when the profile pins an
   * expectedGitSha, an APPLIED tuple on a DIFFERENT non-empty gitSha means the
   * running cut has rolled away from the vendored/pinned artifacts. Loud but
   * NON-BLOCKING — the tuple still applies; this only tells the operator to
   * re-pin (vendor/oxide + the profile's expectedGitSha) before trusting a
   * smoke. Called on EVERY apply so a rolled cut stays visible even when a
   * re-fetch returns the tuple already applied, and deduped on the warned
   * gitSha so a steady-state poll loop does not spam. Skipped when the manifest
   * omits gitSha (the parser defaults it to "") so an absent value is a no-op,
   * not a false mismatch; staging carries no expectedGitSha and is silent.
   */
  private warnOnGitShaDrift(tuple: OxideEnvTuple): void {
    const expectedGitSha = this.profile.expectedGitSha
    if (!expectedGitSha || !tuple.gitSha || tuple.gitSha === expectedGitSha) return
    if (tuple.gitSha === this.lastWarnedGitSha) return
    this.lastWarnedGitSha = tuple.gitSha
    console.warn(
      `[OxideEnvRegistryClient] applied gitSha=${tuple.gitSha} != pinned ` +
        `expectedGitSha=${expectedGitSha} — the deployment rolled away from the vendored pin; ` +
        `re-pin vendor/oxide + the profile's expectedGitSha before trusting a smoke (non-blocking).`,
    )
  }

  private notify(tuple: OxideEnvTuple): void {
    for (const listener of this.subscribers) {
      try {
        listener(tuple)
      } catch (error) {
        console.error("[OxideEnvRegistryClient] subscriber threw:", error)
      }
    }
  }

  private scheduleRetry(): void {
    if (this.disposed || this.retryTimer) return
    const base = Math.min(RETRY_INITIAL_DELAY_MS * 2 ** this.retryAttempt, RETRY_MAX_DELAY_MS)
    const jitter = base * RETRY_JITTER_RATIO * (Math.random() * 2 - 1)
    const delay = Math.max(0, Math.round(base + jitter))
    this.retryAttempt += 1
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.refresh().then(() => {
        if (!this.appliedTuple && !this.disposed) this.scheduleRetry()
      })
    }, delay)
  }

  private cancelRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.retryAttempt = 0
  }
}
