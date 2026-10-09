import { selectWebPasskeyRpId } from "@obsidion/passkey-web"
import { Network, createClassArtifactResolver } from "@obsidion/sdk"
import { campaignOriginFrom } from "./campaignOrigin"
import {
  createArtifactPinResolver,
  resolveWalletProfile,
  type ConfigProfileErrorCode,
  type WalletProfileBoot,
  type ResolveWalletProfileInput,
} from "@obsidion/config-client"
import { setWebClassArtifactResolver } from "./classArtifacts"
import { DEMO_ROLLUP, setActiveRollup } from "../platform/storage/rollupStorage"
import { openWalletStore } from "../platform/storage/walletStorage"
import {
  endpointDigest,
  readEndpointOverrides,
  tryNormalizeEndpoint,
  type EndpointKind,
  type EndpointOverrides,
} from "./endpointOverrides"
import { getDesktopL1Bridge } from "../platform/desktopBridge"
import {
  DEFAULT_FPC_REFUEL_THRESHOLD,
  l1ChainIdForNetwork,
  MAINNET_CLAIM_FPC_FLOAT,
  PASSKEY_RP_NAME,
  ZKJWT_VKEY_HASH,
} from "@obsidion/core/constants"
import type { ContractServiceOptions, OxideEnvProfile } from "@obsidion/core/types"
import { assertHostProfileUrl, assertProfilePolicy, parseNetwork } from "./profilePolicy"
import type { PredicateScreeningConfig } from "@obsidion/front-core"
import { http } from "viem"
import { foundry, mainnet, sepolia, type Chain } from "viem/chains"

export type EndpointSource = "settings" | "default"

/** Who chose an endpoint's URL, and whether it normalizes to the build/profile default's. */
export interface EndpointProvenance {
  source: EndpointSource
  isDefault: boolean
}

export type WebWalletConfig = {
  network: Network
  nodeUrl: string
  /**
   * Key for a gateway-fronted node, sent as `x-api-key` on every JSON-RPC request. The build's key
   * ships in the public bundle by design, so the gateway key must be origin-restricted or
   * disposable. Empty means the node is open, which is what sandbox is. A key goes only to the URL
   * it came with: the build's to the default node, a Settings key to the node saved beside it.
   */
  nodeApiKey?: string
  /**
   * Per endpoint, provenance and default-equality. `source` drives the recovery actions; the
   * node's `isDefault` also decides its PXE store and scan cursors, and whether it takes the build's
   * API key.
   */
  endpoints: Record<EndpointKind, EndpointProvenance>
  /** Digest of the node's normalized endpoint; set only when the node is not the default. */
  nodeEndpointDigest?: string
  /** The profile's `shared.rollupVersion`, read only by the rollup-skew report. */
  profileRollupVersion: string
  /**
   * The oxide env-registry profile EVERY consumer must use — ContractService's
   * address overlay, tag resolution, a1 onboarding and the SIPA rail alike.
   * Resolved once here so no call site re-derives a manifest URL.
   */
  oxideProfile: OxideEnvProfile
  /** L1 chain the accounts and the Registry live on. */
  l1ChainId: number
  /** Viem chain for `l1ChainId` (TEE signer source, injected-wallet clients). */
  l1Chain: Chain
  rpId: string
  rpName: string
  l1RpcUrl: string
  /** ClaimFPC fee-juice balance (wei) under which the wallet attempts a post-tx `refuel`. */
  fpcRefuelThreshold: bigint
  /**
   * The deployment's ClaimFPC, off the profile snapshot. Registration names it as the L2 recipient
   * oxide's NamePortal reports a claimed name to, which is what admits the account to the
   * registration-gated rail. Absent only where no snapshot resolved (demo mode).
   */
  claimFpcAddress?: string
  accountServiceUrl: string
  /**
   * Launch-campaign API base: the admission verify call, the hand-off anchor tier, and (as an
   * origin) the one referrer the sealed hand-off accepts material from. Empty means no campaign, for
   * sandbox and self-hosted setups.
   */
  campaignUrl: string
  /** Always false: wallet entry asks no waitlist. `VITE_ADMISSION_GATE` is accepted and arms nothing. */
  admissionGate: boolean
  /**
   * Skip the account-service attestation gate. Only valid against an
   * `IS_TEST_MODE=true` instance: the browser has no App Attest, so a client
   * without it cannot satisfy a live gate. Defaults ON only for sandbox; any
   * other network must set it explicitly, and mainnet refuses it outright.
   */
  accountServiceTestMode: boolean
  /**
   * TEE enclave base URL (co-signer for oxide-token operations); `/rpc` is
   * appended. Empty means "use the manifest's own enclaveUrl verbatim".
   */
  enclaveUrl: string
  /** Real WASM proving in the browser (overrides the per-network default). */
  proverEnabled: boolean
  /** XMTP network from the selected config profile. */
  xmtpEnv: "local" | "dev" | "production"
  /**
   * Google OAuth web client id for email-locked paylink claims (OIDC id_token popup). Unset means
   * the /link view offers no in-browser email claim and hands off to the app.
   */
  googleClientId?: string
  /**
   * Predicate L1 address screening. Undefined means screening is off (every address passes) —
   * allowed everywhere except mainnet, which refuses to build unscreened. Must be the same
   * policy oxide's relayer enforces, or the client verdict and the relayer's disagree.
   */
  predicate?: PredicateScreeningConfig
}

/** Viem chain for an L1 chain id; unknown ids get a generic local-chain shape. */
export function l1ChainFor(chainId: number): Chain {
  switch (chainId) {
    case mainnet.id:
      return mainnet
    case sepolia.id:
      return sepolia
    case foundry.id:
      return foundry
    default:
      return { ...foundry, id: chainId, name: `Chain ${chainId}` }
  }
}

/**
 * Fail closed: the bypass defaults on only where the account-service itself is
 * a test-mode instance (sandbox). A testnet/mainnet build that never sets the
 * flag gets the real gate; mainnet refuses an explicit bypass.
 */
function resolveAccountServiceTestMode(
  env: Record<string, string | undefined>,
  network: Network,
): boolean {
  const raw = env.VITE_ACCOUNT_SERVICE_TEST_MODE
  const testMode = raw === undefined ? network === Network.SANDBOX : raw === "true"
  if (testMode && network === Network.MAINNET) {
    throw new Error(
      "VITE_ACCOUNT_SERVICE_TEST_MODE=true bypasses the personhood gate — not valid on mainnet",
    )
  }
  return testMode
}

/**
 * The staging/mainnet enclaves are HTTPS hosts serving `Access-Control-Allow-Origin: *`, so the
 * browser dials the manifest's own `enclaveUrl` — the URL the attestation triple binds to the
 * portal and pcr0 — and no proxy sits in between. Sandbox is the exception: the mock TEE is
 * CORS-free, so it rides the same-origin `/svc/enclave` vite proxy. Any other tier whose enclave
 * predates the CORS fix — oxide's dev tier, notably — sets `VITE_ENCLAVE_URL=/svc/enclave`
 * explicitly and points the proxy at that tier's host via `ENCLAVE_TARGET`.
 */
function defaultEnclaveUrl(env: Record<string, string | undefined>, network: Network): string {
  return env.VITE_ENCLAVE_URL ?? (network === Network.SANDBOX ? "/svc/enclave" : "")
}

/**
 * Screening arms on the verification hash; the chain then becomes mandatory too. The API key is
 * optional: the AWS slot's same-origin `/svc/predicate` proxy injects it server-side, while a
 * direct dial (dev `.env.local`, the Vercel slot's pass-through rewrite) bakes it via
 * `VITE_PREDICATE_API_KEY`. A committed `VITE_PREDICATE_CHAIN`/`_BASE_URL` alone is inert, not a
 * misconfiguration. Predicate serves no CORS headers, so the default base is the same-origin
 * `/svc/predicate` proxy (vite dev/preview; the deployed slot's CDN behavior/rewrite — its
 * upstream is what picks the Predicate tier there). `VITE_PREDICATE_BASE_URL` overrides for a
 * direct dial.
 */
function resolvePredicateConfig(
  env: Record<string, string | undefined>,
  network: Network,
): PredicateScreeningConfig | undefined {
  // Kill switch for tiers whose vars keep the policy configured (staging). Mainnet never
  // runs unscreened, so an explicit disable there is a misconfiguration, not a choice.
  if (env.VITE_PREDICATE_DISABLED === "true") {
    if (network === Network.MAINNET) {
      throw new Error(
        "VITE_PREDICATE_DISABLED=true turns off L1 address screening — not valid on mainnet",
      )
    }
    return undefined
  }
  const apiKey = env.VITE_PREDICATE_API_KEY
  const verificationHash = env.VITE_PREDICATE_VERIFICATION_HASH
  const chain = env.VITE_PREDICATE_CHAIN
  if (!verificationHash) {
    if (network === Network.MAINNET) {
      throw new Error(
        "Mainnet requires L1 address screening — set VITE_PREDICATE_VERIFICATION_HASH and " +
          "VITE_PREDICATE_CHAIN (plus VITE_PREDICATE_API_KEY when no key-injecting proxy fronts the API)",
      )
    }
    if (apiKey) {
      throw new Error(
        "Partial Predicate config — VITE_PREDICATE_API_KEY is set without " +
          "VITE_PREDICATE_VERIFICATION_HASH",
      )
    }
    return undefined
  }
  if (!chain) {
    throw new Error(
      "Partial Predicate config — VITE_PREDICATE_VERIFICATION_HASH requires VITE_PREDICATE_CHAIN",
    )
  }
  return {
    apiKey: apiKey || undefined,
    verificationHash,
    chain,
    baseUrl: env.VITE_PREDICATE_BASE_URL || "/svc/predicate",
  }
}

/**
 * The desktop launcher's configuration setting, which it writes into index.html as
 * `window.__ZKMONEY_ENDPOINTS__` ahead of the module scripts. Only these keys are read, and only in
 * a desktop build running under the launcher (`hostConfiguration`).
 */
export type RuntimeEndpoints = {
  /**
   * Where to fetch the config profile, in place of `VITE_CONFIG_PROFILE_URL`. The document decides
   * every contract address the wallet uses and carries no signature, so this is the one injected
   * key that can cost a user their funds; the host that injects it owns that warning. The checks
   * that still run — shape, identity, network, schema, expiry, the mainnet policy — are format
   * checks any author can satisfy, so they bound mistakes, not malice.
   */
  configProfileUrl?: string
  /** Boot from the profile baked into this build, whatever the live document says. */
  bootFromBakedProfile?: boolean
}

function runtimeEndpoints(): RuntimeEndpoints {
  const raw = (globalThis as { __ZKMONEY_ENDPOINTS__?: unknown }).__ZKMONEY_ENDPOINTS__
  if (!raw || typeof raw !== "object") return {}
  const source = raw as Record<string, unknown>
  const picked: RuntimeEndpoints = {}
  if (typeof source.configProfileUrl === "string" && source.configProfileUrl.length > 0) {
    picked.configProfileUrl = source.configProfileUrl
  }
  if (source.bootFromBakedProfile === true) picked.bootFromBakedProfile = true
  return picked
}

/**
 * What the host may change: nothing on the hosted bundle, whose build lacks the desktop flag, nor
 * on any page the launcher does not serve. The switch starts the wallet without fetching, so a URL
 * beside it is unused.
 */
function hostConfiguration(
  env: Record<string, string | undefined>,
  runtime: RuntimeEndpoints,
): RuntimeEndpoints {
  if (env.VITE_DESKTOP_BUILD !== "true" || !getDesktopL1Bridge()) return {}
  return runtime.bootFromBakedProfile ? { bootFromBakedProfile: true } : runtime
}

export function resolveNetwork(env: Record<string, string | undefined>): Network {
  return parseNetwork(env.VITE_NETWORK)
}

/**
 * Env-resolved half; the oxide pointer and the endpoint facts only exist once the profile has
 * supplied the defaults, so `mergeProfileConfig` completes it.
 */
export type BaseWebWalletConfig = Omit<
  WebWalletConfig,
  "oxideProfile" | "endpoints" | "nodeEndpointDigest" | "profileRollupVersion" | "xmtpEnv"
>

/** The campaign URL as baked, once its origin has passed the hand-off's rule (see campaignOrigin.ts). */
function resolveCampaignUrl(env: { VITE_CAMPAIGN_URL?: string }): string {
  const url = env.VITE_CAMPAIGN_URL ?? ""
  campaignOriginFrom(url)
  return url
}

export function loadConfig(
  env: Record<string, string | undefined> = import.meta.env,
): BaseWebWalletConfig {
  const network = resolveNetwork(env)
  const l1ChainId = l1ChainIdForNetwork(network)
  return {
    network,
    nodeUrl: env.VITE_NODE_URL ?? "http://localhost:8080",
    nodeApiKey: env.VITE_NODE_API_KEY || undefined,
    l1ChainId,
    l1Chain: l1ChainFor(l1ChainId),
    rpId: selectWebPasskeyRpId(env),
    rpName: env.VITE_PASSKEY_RP_NAME ?? PASSKEY_RP_NAME,
    l1RpcUrl: env.VITE_L1_RPC_URL ?? "http://localhost:8545",
    // Whole fee-juice units (1 FJ = 1e18 wei).
    fpcRefuelThreshold: env.VITE_FPC_REFUEL_THRESHOLD
      ? BigInt(env.VITE_FPC_REFUEL_THRESHOLD) * 10n ** 18n
      : network === Network.MAINNET
      ? MAINNET_CLAIM_FPC_FLOAT
      : DEFAULT_FPC_REFUEL_THRESHOLD,
    // Same-origin dev-server proxy (vite.config.ts) — browsers refuse the raw
    // 5060 port (SIP, restricted).
    accountServiceUrl: "/svc/account",
    campaignUrl: resolveCampaignUrl(env),
    admissionGate: false,
    accountServiceTestMode: resolveAccountServiceTestMode(env, network),
    enclaveUrl: defaultEnclaveUrl(env, network),
    proverEnabled: env.VITE_PROVER_ENABLED !== "false",
    googleClientId: env.VITE_GOOGLE_CLIENT_ID || undefined,
    predicate: resolvePredicateConfig(env, network),
  }
}

let cached: WebWalletConfig | undefined

type LiveProfileRequest = Pick<
  ResolveWalletProfileInput,
  "profileUrl" | "expectedProfileId" | "expectedZkJwtVkeyHash"
> & { network: Network }

let liveProfileRequest: LiveProfileRequest | undefined
let liveProfileFetchImpl: typeof fetch | undefined

/**
 * The process-wide config, seeded by `resolveBootConfig` once the profile has supplied the oxide
 * pointer. Reading it earlier is a boot-order bug and throws — no complete config exists yet.
 */
export function getConfig(): WebWalletConfig {
  if (!cached) {
    throw new Error(
      "getConfig() before resolveBootConfig() — the wallet boots from a config profile, and no " +
        "config exists until it has resolved.",
    )
  }
  return cached
}

/** Test injections; every default reads the build's own `import.meta.env`. */
export interface ResolveBootConfigInput {
  env?: Record<string, string | undefined>
  fetchImpl?: typeof fetch
  now?: () => Date
  /** The host's configuration setting; defaults to reading the desktop launcher's global. */
  runtime?: RuntimeEndpoints
  /** Settings-stored endpoint overrides; defaults to reading this browser's localStorage. */
  readEndpointOverrides?: () => EndpointOverrides
  /** The profile baked into this build; the app tree passes the virtual module's export. */
  bakedProfile?: unknown
  /** Demo mode: its own partition and an in-memory wallet database; nothing persistent is touched. */
  demoStorage?: boolean
}

export interface WebBootConfig {
  config: WebWalletConfig
  /** Handed to ObsidionCoreProvider verbatim. */
  contractServiceOptions: ContractServiceOptions
  /** The version's zkJWT vkey hash differs from the bundled one. Reported at boot, never gating. */
  zkJwtVkeySkew: boolean
  /** The build's baked profile booted the wallet: the service was unreachable, or the host asked. */
  bootedFromBakedProfile: boolean
  /**
   * The host pointed the wallet at this profile URL and a document from it booted the wallet. Set
   * only when that document is what the wallet is actually running on — a fallback to the baked
   * copy reports `bakedProfile` instead.
   */
  customProfileUrl?: string
  /** Set on a snapshot boot: what the wallet is running on and why. */
  bakedProfile?: {
    publishedAt: string
    current: string
    /** The host (the desktop launcher's setting) chose the snapshot; nothing was fetched. */
    forced: boolean
    /** The snapshot has passed its `expiresAt` — only a forced boot gets this far. */
    expired: boolean
    /** The live failure the snapshot stood in for; absent on a forced boot. */
    liveFailure?: { code: ConfigProfileErrorCode; message: string }
  }
}

/**
 * Saved and build overrides take precedence for node and L1 RPC. The account service comes from
 * the profile. The analytics endpoint is read at module scope, outside this config.
 */
function mergeProfileConfig(
  env: Record<string, string | undefined>,
  base: BaseWebWalletConfig,
  boot: WalletProfileBoot,
  readOverrides: () => EndpointOverrides,
): WebWalletConfig {
  // The version's pointer, alone: nothing outside the document supplies or overrides it.
  const oxideProfile = assertProfilePolicy(boot, base.network)
  // One read, so the three endpoints come from one record even while another tab saves.
  const stored = readOverrides()
  // `||`, not `??`: the deploy script writes every allow-listed key into .env.production even
  // when the operator left it unset, so an omitted var arrives as "" rather than undefined.
  const node = resolveEndpoint(stored.node, env.VITE_NODE_URL || boot.nodeUrl)
  const l1Rpc = resolveEndpoint(stored.l1Rpc, env.VITE_L1_RPC_URL || boot.version.l1RpcUrl)
  const enclave = resolveEndpoint(stored.enclave, defaultEnclaveUrl(env, base.network))
  return {
    ...base,
    nodeUrl: node.url,
    nodeApiKey:
      (node.provenance.source === "settings" ? stored.nodeApiKey : undefined) ??
      (node.provenance.isDefault ? env.VITE_NODE_API_KEY || undefined : undefined),
    l1RpcUrl: l1Rpc.url,
    enclaveUrl: enclave.url,
    endpoints: { node: node.provenance, l1Rpc: l1Rpc.provenance, enclave: enclave.provenance },
    // A stored URL the normalizer refuses still gets a stable digest; the dial fails later.
    nodeEndpointDigest: node.provenance.isDefault
      ? undefined
      : endpointDigest(tryNormalizeEndpoint(node.url) ?? node.url),
    profileRollupVersion: boot.profile.shared.rollupVersion,
    // A loopback origin keeps `loadConfig`'s value — sandbox's browser-restricted port needs the
    // same-origin proxy, which a document (absolute URLs only) cannot express.
    accountServiceUrl: accountServiceFrom(boot),
    xmtpEnv: boot.profile.shared.xmtpEnv,
    oxideProfile,
    claimFpcAddress: boot.snapshot.contracts.claimFpc?.address,
  }
}

/**
 * One endpoint's URL and provenance: the stored override, else the build/profile default.
 * `isDefault` compares normalized forms, so a retyped default still counts as the default and a
 * same-origin URL with another path does not. A default that is not an absolute URL (the enclave's
 * `""` or `/svc/enclave`) makes any override custom.
 */
function resolveEndpoint(
  stored: string | undefined,
  fallback: string,
): { url: string; provenance: EndpointProvenance } {
  const [url, source]: [string, EndpointSource] = stored
    ? [stored, "settings"]
    : [fallback, "default"]
  const defaultNormalized = tryNormalizeEndpoint(fallback)
  const isDefault =
    source === "default" ||
    (defaultNormalized !== undefined && tryNormalizeEndpoint(url) === defaultNormalized)
  return { url, provenance: { source, isDefault } }
}

/** Browser-restricted SIP ports reach the profile's local service through the app proxy. */
function accountServiceFrom(boot: WalletProfileBoot): string {
  const served = boot.version.accountServiceUrl
  const url = new URL(served)
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1"
  return local && (url.port === "5060" || url.port === "5061") ? "/svc/account" : served
}

/**
 * The app's one boot path: `VITE_CONFIG_PROFILE_URL` names the profile, or a host override replaces
 * it; a build with neither does not boot. Seeds `getConfig()` before returning — consumers read it
 * synchronously.
 */
export async function resolveBootConfig(
  input: ResolveBootConfigInput = {},
): Promise<WebBootConfig> {
  const env = input.env ?? import.meta.env
  const runtime = hostConfiguration(env, input.runtime ?? runtimeEndpoints())

  // resolveWalletProfile needs the network before any config is built.
  const network = resolveNetwork(env)

  if (runtime.configProfileUrl) assertHostProfileUrl(runtime.configProfileUrl, network)
  // The expected profile id is NOT overridable alongside the URL: it is what makes an overridden
  // URL serve this build's profile rather than some other one.
  const profileUrl = runtime.configProfileUrl || env.VITE_CONFIG_PROFILE_URL
  if (!profileUrl) {
    throw new Error(
      "VITE_CONFIG_PROFILE_URL is not set — the wallet boots from a config profile and has no " +
        "other address source.",
    )
  }

  const request: LiveProfileRequest = {
    profileUrl,
    expectedProfileId: env.VITE_CONFIG_EXPECTED_PROFILE_ID,
    network,
    expectedZkJwtVkeyHash: ZKJWT_VKEY_HASH,
  }
  const boot: WalletProfileBoot = await resolveWalletProfile({
    ...request,
    bakedProfile: input.bakedProfile,
    forceBakedProfile: runtime.bootFromBakedProfile,
    fetchImpl: input.fetchImpl,
    now: input.now,
  })

  // The rollup first, before anything reads storage. A wallet's database opens only once its tab is
  // the active tab; demo mode's opens here.
  const rollup = input.demoStorage ? DEMO_ROLLUP : boot.profile.shared.rollupVersion
  setActiveRollup(rollup)
  if (input.demoStorage) await openWalletStore(rollup, { persistent: false })

  if (boot.zkJwtVkeySkew) {
    console.error(
      `[bootConfig] zkJWT vkey skew: profile "${boot.profile.profileId}" serves ` +
        `${boot.version.vkeys?.zkJwtVkeyHash}, this build bundles ${ZKJWT_VKEY_HASH}`,
    )
  }
  const bakedProfile: WebBootConfig["bakedProfile"] = boot.bootedFromBakedProfile
    ? {
        publishedAt: boot.profile.publishedAt,
        current: boot.versionId,
        forced: !boot.liveFailure,
        expired: boot.bakedProfileExpired === true,
        ...(boot.liveFailure ? { liveFailure: boot.liveFailure } : {}),
      }
    : undefined
  if (bakedProfile) {
    const why = bakedProfile.liveFailure
      ? `config service unreachable (${bakedProfile.liveFailure.message})`
      : `the host asked for the shipped configuration${bakedProfile.expired ? " (expired)" : ""}`
    console.warn(
      `[bootConfig] ${why}; booting on the baked profile "${boot.profile.profileId}" version ` +
        `${bakedProfile.current}, published ${bakedProfile.publishedAt}`,
    )
  }

  const customProfileUrl =
    runtime.configProfileUrl && !boot.bootedFromBakedProfile ? runtime.configProfileUrl : undefined
  if (customProfileUrl) {
    console.warn(
      `[bootConfig] running on the configuration at ${customProfileUrl}, set on this device — not ` +
        "zk.money's own",
    )
  }

  const base = loadConfig(env)
  const merged = mergeProfileConfig(
    env,
    base,
    boot,
    input.readEndpointOverrides ?? readEndpointOverrides,
  )
  const resolveClassArtifact = createClassArtifactResolver(
    createArtifactPinResolver({
      profileUrl,
      profileId: boot.profile.profileId,
      versionId: boot.versionId,
      expectedSha256: boot.version.artifactManifestSha256,
      fetchImpl: input.fetchImpl,
    }),
    input.fetchImpl,
  )
  setWebClassArtifactResolver(resolveClassArtifact)
  return seed(request, input.fetchImpl, {
    config: merged,
    contractServiceOptions: {
      source: "profile",
      config: boot.snapshot,
      resolveClassArtifact,
      // The same pointer `getConfig()` now serves, so ContractService and every other oxide
      // consumer read one value.
      oxideEnvProfile: merged.oxideProfile,
    },
    zkJwtVkeySkew: boot.zkJwtVkeySkew,
    bootedFromBakedProfile: boot.bootedFromBakedProfile,
    ...(bakedProfile ? { bakedProfile } : {}),
    ...(customProfileUrl ? { customProfileUrl } : {}),
  })
}

function seed(
  request: LiveProfileRequest,
  fetchImpl: typeof fetch | undefined,
  boot: WebBootConfig,
): WebBootConfig {
  cached = boot.config
  liveProfileRequest = request
  liveProfileFetchImpl = fetchImpl
  return boot
}

export async function fetchLiveProfilePortal(fetchImpl?: typeof fetch): Promise<string> {
  if (!liveProfileRequest) {
    throw new Error(
      "fetchLiveProfilePortal() before resolveBootConfig() — no profile request exists until the " +
        "wallet has booted from one.",
    )
  }
  const live = await resolveWalletProfile({
    ...liveProfileRequest,
    fetchImpl: fetchImpl ?? liveProfileFetchImpl,
  })
  return assertProfilePolicy(live, liveProfileRequest.network).portal
}

/**
 * The L1 transport every browser-side public client shares — one seam for endpoint policy.
 * Same-tick requests coalesce into one JSON-RPC batch, so parallel reads cost one round trip.
 */
export function l1Transport(config: WebWalletConfig) {
  return http(config.l1RpcUrl, { timeout: 15_000, batch: true })
}
