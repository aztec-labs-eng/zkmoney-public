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
import {
  DEFAULT_FPC_REFUEL_THRESHOLD,
  l1ChainIdForNetwork,
  MAINNET_CLAIM_FPC_FLOAT,
  PASSKEY_RP_NAME,
  ZKJWT_VKEY_HASH,
} from "@obsidion/core/constants"
import type { ContractServiceOptions, OxideEnvProfile } from "@obsidion/core/types"
import { assertProfilePolicy, parseNetwork } from "./profilePolicy"
import type { PredicateScreeningConfig } from "@obsidion/front-core"
import { http } from "viem"
import { foundry, mainnet, sepolia, type Chain } from "viem/chains"

export type WebWalletConfig = {
  network: Network
  nodeUrl: string
  /**
   * Key for a gateway-fronted node, sent as `x-api-key` on every JSON-RPC request. It ships in
   * the public bundle by design, so the gateway key must be origin-restricted or disposable.
   * Empty means the node is open, which is what sandbox is.
   */
  nodeApiKey?: string
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
   * origin) the one sender the bridge page accepts material from. Empty means no campaign, for
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
  /**
   * XMTP network. Every build defaults to `"dev"`; `VITE_XMTP_ENV` overrides.
   */
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

const XMTP_ENVS = ["local", "dev", "production"] as const

function resolveXmtpEnv(
  env: Record<string, string | undefined>,
  network: Network,
): WebWalletConfig["xmtpEnv"] {
  const raw = env.VITE_XMTP_ENV ?? (network === Network.MAINNET ? "production" : "dev")
  if (!(XMTP_ENVS as readonly string[]).includes(raw)) {
    throw new Error(`Unknown VITE_XMTP_ENV "${raw}" (expected ${XMTP_ENVS.join("|")})`)
  }
  return raw as WebWalletConfig["xmtpEnv"]
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
 *
 * A packaged desktop build takes the injected value first, which is how its retarget setting
 * reaches a bundle that dials the enclave directly.
 */
function resolveEnclaveUrl(
  env: Record<string, string | undefined>,
  network: Network,
  runtime: RuntimeEndpoints,
): string {
  return (
    runtime.enclaveUrl ??
    env.VITE_ENCLAVE_URL ??
    (network === Network.SANDBOX ? "/svc/enclave" : "")
  )
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
 * Runtime endpoint overrides injected by a host page: the desktop launcher writes
 * `window.__ZKMONEY_ENDPOINTS__` into index.html ahead of the module scripts, so a
 * packaged desktop bundle can be repointed without a rebuild. Nothing injects the
 * global on the hosted deployment, so every value falls through to the baked env.
 * Only the keys named here are honored — an injected object cannot touch the RP ID
 * or any other config.
 */
export type RuntimeEndpoints = Partial<Pick<WebWalletConfig, "nodeUrl" | "l1RpcUrl" | "enclaveUrl">>

const RUNTIME_ENDPOINT_KEYS = ["nodeUrl", "l1RpcUrl", "enclaveUrl"] as const

function runtimeEndpoints(): RuntimeEndpoints {
  const raw = (globalThis as { __ZKMONEY_ENDPOINTS__?: unknown }).__ZKMONEY_ENDPOINTS__
  if (!raw || typeof raw !== "object") return {}
  const source = raw as Record<string, unknown>
  const picked: RuntimeEndpoints = {}
  for (const key of RUNTIME_ENDPOINT_KEYS) {
    const value = source[key]
    if (typeof value === "string" && value.length > 0) picked[key] = value
  }
  return picked
}

export function resolveNetwork(env: Record<string, string | undefined>): Network {
  return parseNetwork(env.VITE_NETWORK)
}

/** Env-resolved half; the oxide pointer only ever comes from the profile version, so `mergeProfileConfig` completes it. */
export type BaseWebWalletConfig = Omit<WebWalletConfig, "oxideProfile">

/** The campaign URL as baked, once its origin has passed the bridge's rule (see campaignOrigin.ts). */
function resolveCampaignUrl(env: { VITE_CAMPAIGN_URL?: string }): string {
  const url = env.VITE_CAMPAIGN_URL ?? ""
  campaignOriginFrom(url)
  return url
}

export function loadConfig(
  env: Record<string, string | undefined> = import.meta.env,
  runtime: RuntimeEndpoints = runtimeEndpoints(),
): BaseWebWalletConfig {
  const network = resolveNetwork(env)
  const l1ChainId = l1ChainIdForNetwork(network)
  return {
    network,
    nodeUrl: runtime.nodeUrl ?? env.VITE_NODE_URL ?? "http://localhost:8080",
    nodeApiKey: env.VITE_NODE_API_KEY || undefined,
    l1ChainId,
    l1Chain: l1ChainFor(l1ChainId),
    rpId: selectWebPasskeyRpId(env),
    rpName: env.VITE_PASSKEY_RP_NAME ?? PASSKEY_RP_NAME,
    l1RpcUrl: runtime.l1RpcUrl ?? env.VITE_L1_RPC_URL ?? "http://localhost:8545",
    // Whole fee-juice units (1 FJ = 1e18 wei).
    fpcRefuelThreshold: env.VITE_FPC_REFUEL_THRESHOLD
      ? BigInt(env.VITE_FPC_REFUEL_THRESHOLD) * 10n ** 18n
      : network === Network.MAINNET
      ? MAINNET_CLAIM_FPC_FLOAT
      : DEFAULT_FPC_REFUEL_THRESHOLD,
    // Same-origin dev-server proxy (vite.config.ts) — browsers refuse the raw
    // 5060 port (SIP, restricted).
    accountServiceUrl: env.VITE_ACCOUNT_SERVICE_URL ?? "/svc/account",
    campaignUrl: resolveCampaignUrl(env),
    admissionGate: false,
    accountServiceTestMode: resolveAccountServiceTestMode(env, network),
    enclaveUrl: resolveEnclaveUrl(env, network, runtime),
    proverEnabled: env.VITE_PROVER_ENABLED !== "false",
    xmtpEnv: resolveXmtpEnv(env, network),
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
  /** Host-injected endpoint overrides; defaults to reading the desktop launcher's global. */
  runtime?: RuntimeEndpoints
  /** The profile baked into this build; the app tree passes the virtual module's export. */
  bakedProfile?: unknown
}

export interface WebBootConfig {
  config: WebWalletConfig
  /** Handed to ObsidionCoreProvider verbatim. */
  contractServiceOptions: ContractServiceOptions
  /** The version's zkJWT vkey hash differs from the bundled one. Reported at boot, never gating. */
  zkJwtVkeySkew: boolean
  /** The config service was unreachable and the build's baked profile booted the wallet. */
  bootedFromBakedProfile: boolean
  /** Set on a snapshot boot: what the wallet is running on, and the live failure it stood in for. */
  bakedProfile?: {
    publishedAt: string
    current: string
    liveFailure: { code: ConfigProfileErrorCode; message: string }
  }
}

/**
 * Profile values fill the fields whose `VITE_*` override is unset; localhost defaults sit below
 * both. The analytics endpoint is deliberately absent — read at module scope, a profile value
 * could never reach what the bundle actually posts to.
 */
function mergeProfileConfig(
  env: Record<string, string | undefined>,
  base: BaseWebWalletConfig,
  boot: WalletProfileBoot,
  runtime: RuntimeEndpoints,
): WebWalletConfig {
  // The version's pointer, alone: nothing outside the document supplies or overrides it.
  const oxideProfile = assertProfilePolicy(boot, base.network)
  return {
    ...base,
    // A host-injected endpoint outranks both: the desktop launcher writes the user's saved
    // override into the page, and a profile value replacing it would make that setting inert.
    // `||`, not `??`: the deploy script writes every allow-listed key into .env.production even
    // when the operator left it unset, so an omitted var arrives as "" rather than undefined.
    nodeUrl: runtime.nodeUrl || env.VITE_NODE_URL || boot.nodeUrl,
    l1RpcUrl: runtime.l1RpcUrl || env.VITE_L1_RPC_URL || boot.version.l1RpcUrl,
    // A loopback origin keeps `loadConfig`'s value — sandbox's browser-restricted port needs the
    // same-origin proxy, which a document (absolute URLs only) cannot express.
    accountServiceUrl: env.VITE_ACCOUNT_SERVICE_URL || accountServiceFrom(boot, base),
    xmtpEnv: env.VITE_XMTP_ENV ? base.xmtpEnv : boot.profile.shared.xmtpEnv,
    oxideProfile,
    claimFpcAddress: boot.snapshot.contracts.claimFpc?.address,
  }
}

const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/

function accountServiceFrom(boot: WalletProfileBoot, base: BaseWebWalletConfig): string {
  const served = boot.version.accountServiceUrl
  // `|| "/svc/account"` because a deployed bundle's unset var arrives as "" and `loadConfig`
  // coalesces only on undefined — the proxy path is the default this is falling back to.
  return LOOPBACK.test(served) ? base.accountServiceUrl || "/svc/account" : served
}

/**
 * The app's one boot path: `VITE_CONFIG_PROFILE_URL` names the profile; a build without it does
 * not boot. Seeds `getConfig()` before returning — consumers read it synchronously.
 */
export async function resolveBootConfig(
  input: ResolveBootConfigInput = {},
): Promise<WebBootConfig> {
  const env = input.env ?? import.meta.env

  const profileUrl = env.VITE_CONFIG_PROFILE_URL
  if (!profileUrl) {
    throw new Error(
      "VITE_CONFIG_PROFILE_URL is not set — the wallet boots from a config profile and has no " +
        "other address source.",
    )
  }

  // resolveWalletProfile needs the network before any config is built.
  const network = resolveNetwork(env)

  const request: LiveProfileRequest = {
    profileUrl,
    expectedProfileId: env.VITE_CONFIG_EXPECTED_PROFILE_ID,
    network,
    expectedZkJwtVkeyHash: ZKJWT_VKEY_HASH,
  }
  const boot: WalletProfileBoot = await resolveWalletProfile({
    ...request,
    bakedProfile: input.bakedProfile,
    fetchImpl: input.fetchImpl,
    now: input.now,
  })

  if (boot.zkJwtVkeySkew) {
    console.error(
      `[bootConfig] zkJWT vkey skew: profile "${boot.profile.profileId}" serves ` +
        `${boot.version.vkeys?.zkJwtVkeyHash}, this build bundles ${ZKJWT_VKEY_HASH}`,
    )
  }
  const bakedProfile =
    boot.bootedFromBakedProfile && boot.liveFailure
      ? {
          publishedAt: boot.profile.publishedAt,
          current: boot.versionId,
          liveFailure: boot.liveFailure,
        }
      : undefined
  if (bakedProfile) {
    console.warn(
      `[bootConfig] config service unreachable (${bakedProfile.liveFailure.message}); booting on ` +
        `the baked profile "${boot.profile.profileId}" version ${bakedProfile.current}, published ` +
        bakedProfile.publishedAt,
    )
  }

  const runtime = input.runtime ?? runtimeEndpoints()
  const base = loadConfig(env, runtime)
  const merged = mergeProfileConfig(env, base, boot, runtime)
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
  return seed(request, {
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
  })
}

function seed(request: LiveProfileRequest, boot: WebBootConfig): WebBootConfig {
  cached = boot.config
  liveProfileRequest = request
  return boot
}

export async function fetchLiveProfilePortal(fetchImpl?: typeof fetch): Promise<string> {
  if (!liveProfileRequest) {
    throw new Error(
      "fetchLiveProfilePortal() before resolveBootConfig() — no profile request exists until the " +
        "wallet has booted from one.",
    )
  }
  const live = await resolveWalletProfile({ ...liveProfileRequest, fetchImpl })
  return assertProfilePolicy(live, liveProfileRequest.network).portal
}

/**
 * The L1 transport every browser-side public client shares — one seam for endpoint policy.
 * Same-tick requests coalesce into one JSON-RPC batch, so parallel reads cost one round trip.
 */
export function l1Transport(config: WebWalletConfig) {
  return http(config.l1RpcUrl, { timeout: 15_000, batch: true })
}
