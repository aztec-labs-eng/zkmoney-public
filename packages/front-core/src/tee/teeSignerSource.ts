import { createPublicClient, fallback, http, type Chain, type Hex } from "viem"
import type { AztecNode } from "@aztec/aztec.js/node"
import type { AztecAddress } from "@aztec/stdlib/aztec-address"
import { ContractService, loadTeeSigner, type TeeSigner } from "@obsidion/sdk"
import { logger } from "src/utils/logger"

/**
 * A resolvable source of a `TeeSigner`, injected into `useAsset` so the hook
 * stays environment-agnostic. The hook calls `load()`, fans the result into
 * `TokenService`/`PaylinkService`, and re-runs `load()` whenever `subscribe`
 * fires. Which concrete source is wired (attested oxide enclave vs. sandbox
 * dev relayer) is decided by the environment-aware app layer.
 */
export interface TeeSignerSource {
  /** Short non-secret label for connect logging. */
  readonly label: string
  /** Resolve a signer. Returns `undefined` for a benign skip (nothing to
   *  connect yet); throws for a real failure (which triggers `refresh`). */
  load(): Promise<TeeSigner | undefined>
  /** Subscribe to "reload now" signals (e.g. an oxide manifest roll).
   *  Returns an unsubscribe fn. Static sources may omit it. */
  subscribe?(onChange: () => void): () => void
  /** Asked once after a failed `load()`; a source backed by a refreshable
   *  manifest can re-fetch so the next `subscribe` tick reconnects. */
  refresh?(): void
}

export interface OxideTeeSignerSourceOptions {
  /** L1 JSON-RPC URL for the chain the TEE binding lives on. */
  l1RpcUrl: string
  /** Viem `Chain` for the L1 (must match `l1RpcUrl`). */
  l1Chain: Chain
  /**
   * Optional transform applied to the manifest's `enclaveUrl` before connecting — lets a caller
   * rewrite a sandbox-local host (e.g. `localhost` to a LAN IP for a physical device) without this
   * environment-agnostic module knowing about device-specific URL rewriting itself.
   */
  transformEnclaveUrl?(url: string): string
  /**
   * Node the pinned enclave's L2 approval is read from. Supplied together with `getTokenAddress`;
   * `undefined` while the app has no node yet (degraded boot) makes `load()` skip, like a missing
   * manifest tuple. Without the pair the connect verifies the L1 binding only.
   */
  getNode?(): AztecNode | undefined
  /** Active OxideToken the approval is read on; `undefined` until the contract service resolves it. */
  getTokenAddress?(): Promise<AztecAddress | undefined>
}

/**
 * Attested signer source for testnet/mainnet. The enclave URL + portal flow
 * from the oxide env-registry tuple (`ContractService.getOxideClient()`); the
 * source reads the current tuple per `load()` so a fresh enclave URL is never
 * mixed with a stale portal. `subscribe` refires on manifest rolls.
 *
 * With `getNode` and `getTokenAddress`, an enclave whose key the token has not approved is refused
 * at connect (`TeeSignerNotApprovedError`) and never reaches `TokenService`; the caller's retry
 * re-pins, so on a mixed fleet the connect settles on an approved enclave without user action.
 *
 * The client is resolved lazily inside each method — never at construction —
 * so the source can be built before `ContractService` has its singleton.
 */
export function createOxideTeeSignerSource(options: OxideTeeSignerSourceOptions): TeeSignerSource {
  const { l1RpcUrl, l1Chain, transformEnclaveUrl, getNode, getTokenAddress } = options
  if (!!getNode !== !!getTokenAddress) {
    throw new Error("[teeSignerSource] getNode and getTokenAddress must be supplied together")
  }

  const getClient = () => {
    try {
      return ContractService.getInstance().getOxideClient()
    } catch {
      // getInstance throws before the provider constructs the singleton.
      return undefined
    }
  }

  return {
    label: `remote:${l1Chain.id}`,
    async load() {
      const tuple = getClient()?.getCurrentTuple()
      if (!tuple) return undefined // degraded boot — no manifest tuple yet
      const { portal, enclaveUrl } = tuple
      // Defend against a malformed portal. The client validates the manifest,
      // but an empty value would otherwise pass straight into
      // OxidePortalContract and fail far from here with an opaque viem message.
      if (!/^0x[0-9a-fA-F]{40}$/.test(portal)) {
        logger.warn("[teeSignerSource] connect skipped: portal address missing or malformed", {
          portal,
        })
        return undefined
      }
      let l2Approval: { node: AztecNode; tokenAddress: AztecAddress } | undefined
      if (getNode && getTokenAddress) {
        const node = getNode()
        const tokenAddress = await getTokenAddress()
        if (!node || !tokenAddress) return undefined // degraded boot — nothing to check the pin against
        l2Approval = { node, tokenAddress }
      }
      // `@aztec/ethereum`'s `ViemClient` requires
      // `FallbackTransport<HttpTransport[]>` — wrap the single http transport
      // in `fallback([...])` to match what `loadTeeSigner` (and
      // `OxidePortalContract` underneath) expects. The http `timeout` bounds the
      // L1 reads (`portal.getTeeBinding`, `portal.isPcr0Approved`) that
      // `FleetSigner.connect()` makes outside its own AbortController.
      //
      // `as unknown as ...` papers over a readonly-vs-mutable tuple mismatch
      // between the viem copy here and the aztec-vendored viem the SDK uses —
      // runtime types are compatible; this is purely a cross-node_modules TS
      // visibility issue. `unknown` over `any` keeps the param shape checkable.
      const viemClient = createPublicClient({
        chain: l1Chain,
        transport: fallback([http(l1RpcUrl, { timeout: 10_000 })]),
      }) as unknown as Parameters<typeof loadTeeSigner>[2]
      const resolvedEnclaveUrl = transformEnclaveUrl ? transformEnclaveUrl(enclaveUrl) : enclaveUrl
      return l2Approval
        ? await loadTeeSigner(resolvedEnclaveUrl, portal as Hex, viemClient, { l2Approval })
        : await loadTeeSigner(resolvedEnclaveUrl, portal as Hex, viemClient)
    },
    subscribe(onChange) {
      const client = getClient()
      if (!client) return () => {}
      return client.subscribe(() => onChange())
    },
    refresh() {
      try {
        void getClient()?.refresh()
      } catch {
        // getInstance can throw in teardown races; degraded state stands.
      }
    },
  }
}
