import { getWebBroadcasterArtifact, getWebOxideToken } from "../../config/classArtifacts"
/**
 * The SIPA deposit rail for the browser — the realistic L1→L2 funding path
 * (oxide's Segregated Incoming Payment Addresses), composing the front-core
 * wiring (`setupSipaDiscovery` / `syncSipaDeposits`) over a browser PXE.
 * Discovery and sync ride front-core, while this file owns the address-derivation cache, the
 * sponsored broadcast batch, and the L1 transfer. Every address it derives is owed to the broadcast
 * ledger, which proves its broadcast until it lands. The
 * wallet, the `ContractService` and the `TokenService` are INJECTED per call
 * from the shared front-core contexts — the gateway never builds its own.
 *
 * Receiving: the recipient derives its own deposit address rather than asking the resolver for one.
 * `SipaSelfResolver` hashes it from a key only this wallet holds — no gateway, no CCIP read, no
 * CORS. The relayer still has to learn the address exists, which is what the SIPA broadcast does
 * with no user signature: the token sends this wallet a `SIPA` event and the `Broadcaster`
 * publishes the sweep's L1 operation. The calls are whitelisted members of a ClaimFPC batch like
 * every other
 * sponsored call — the FPC only pays, and eligibility is the entrypoint's subscription — so a
 * first-ever Receive folds the deferred subscription into that same tx. From there the rail is
 * unchanged — a sender does a plain ERC-20 transfer, the relayer sweeps into the portal, this
 * wallet discovers the event, reads the L1 `Sweep` for the claim inputs, and lazy-claims via
 * `TokenService.claimSweptDeposit` (the free `store_deposit` utility sim) — after which the shared
 * asset layer's balance reflects the credit.
 */
import { NO_FROM } from "@aztec/aztec.js/account"
import { Fr } from "@aztec/aztec.js/fields"
import { BlockNumber } from "@aztec/foundation/branded-types"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import {
  getAddress,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  parseAbi,
  parseUnits,
  type Address,
  type Hex,
  type PublicClient,
} from "viem"
import { deriveMasterNullifierHidingSecretKey } from "@aztec/stdlib/keys"
import { DEFAULT_DECIMALS, quotedDepositFee } from "@obsidion/core/constants"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  assertSubsidySweepsSipa,
  buildClaimSponsorPayload,
  buildClaimSubscribePayload,
  buildDepositIntent,
  buildSipaSweepBroadcasts,
  OxideSipaIntent,
  predictAccountAddressLocally,
  deriveSelfSipaSecret,
  chainEpochDay,
  DEFAULT_CONTRACTS,
  claimFpcSponsoredFee,
  type ClaimSponsorContext,
  ContractService,
  fetchSipaEvents,
  readSipaBroadcastTxHashes,
  readSipaHoldingsAtHead,
  type ObsidionAccount,
  type ObsidionWallet,
  selfSipaNonce,
  type SelfResolvedSipa,
  type SipaIntent,
  BroadcasterContract,
  SipaSelfResolver,
  type TokenService,
  TX_AMOUNT_CAP,
} from "@obsidion/sdk"
import {
  deploymentScanRange,
  depositSipaImplementation,
  implementationDepositFee,
  readResolverOperatorRecords,
  deriveSelfSipaKey,
  deriveStealthKey,
  deriveBootstrapKey,
  selfSipaResolverKeys,
  sipaDeployArgCandidates,
  type SipaRecoverCandidate,
  BroadcastAbandoned,
  BroadcastDeferred,
  setupSipaDiscovery,
  syncSipaDeposits,
  SIPADepositStore,
  upsertDepositL1WalletContact,
  WalletSyncCoordinator,
  bootPriority,
  type BroadcastExecutor,
  type BroadcastKind,
  type SIPADepositRecord,
  type SipaDepositSyncResult,
  isUnfundedSipaDeposit,
  readResolverDeployments,
  ResolverPaymentWatcher,
  type ResolverDeployment,
  type ResolverDeploymentSource,
} from "@obsidion/front-core"
import { getConfig, l1ChainFor } from "../../config/env"
import { isDesktopL1SubmitActive, submitViaDesktopBridge } from "../../platform/desktopBridge"
import { getOxideTuple, l1PublicClient, requireTupleField } from "../../config/oxideTuple"
import { getAuthService } from "../../platform/auth/useAuthenticator"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { walletStorage } from "../../platform/storage/walletStorage"
import { loadWalletIdentity } from "../identity/walletIdentity"
import { fpcFundingCut } from "../fees/fpcFundingCut"
import { maybeRefuelFpc } from "../fees/fpcRefuel"
import { claimSponsorContext, noteSubscribed } from "../onboarding/claimSponsorship"
import { RegistrationPendingError } from "../onboarding/registrationRail"
import { registrationScheduleForSipa } from "../onboarding/webRegistration"
import { RAIL_REGISTERED } from "../onboarding/rails"
import {
  WAITING_FOR_REGISTRATION,
  WAITING_FOR_UNLOCK,
  WAIT_MS,
  getBroadcastLedger,
} from "../broadcasts/broadcasts"
import { getActiveStorageId } from "../../platform/storage/activeStorage"
import { AddressesPublishingError, addressesPublishing } from "./addressesPublishing"
import { getL1Clients } from "./l1Wallet"
import { InsufficientL1BalanceError, readL1DepositTokenBalance } from "./l1DepositTokenBalance"
import { sipaFundingTokens } from "./loadDepositFacts"
import { readSipaDeployed } from "./sipaSweep"
import { predictSipaCandidate } from "./sipaPredict"
import { readPortalFrozen } from "../withdraw/portalFrozen"

/** How long one read of the resolver deployments serves the watcher. */
const RESOLVER_DEPLOYMENTS_TTL_MS = 15 * 60_000

/** TestERC20 mint is minter-gated (sandbox faucet convenience; a real sender already holds funds). */
const TEST_ERC20_MINT_ABI = parseAbi(["function mint(address to, uint256 amount)"])

/** Progress stages for a wallet-driven deposit. */
export type DepositStage =
  | "resolving"
  | "broadcasting"
  | "connecting"
  | "minting"
  | "sending"
  | "awaiting-browser"
  | "confirming"
  | "done"

/** Progress copy for each stage. Screens with their own wording override the keys they differ on. */
export const DEPOSIT_STAGE_LABEL: Record<DepositStage, string> = {
  "resolving": "Deriving your deposit address",
  "broadcasting": "Publishing it to the network",
  "connecting": "Connecting your wallet",
  "minting": "Minting test tokens",
  "sending": "Sending from your wallet",
  "awaiting-browser": "Approve the transfer in your browser",
  "confirming": "Waiting for Ethereum confirmation",
  "done": "Done",
}

export interface DepositAddress {
  /** The L1 SIPA address a sender funds. */
  address: Address
  /** The wallet's name, e.g. "alice.sandbox.oxide" — display only; nothing derives from it. */
  name: string
  /**
   * Owes this address's broadcast to the ledger and settles once it landed. Absent when the address
   * is known published. Funds sent before it settles are not lost — they sit at the counterfactual
   * address until the relayer is told about it — but they are not swept either. Throws
   * `RegistrationPendingError` while no rail can pay for the broadcast, and the attempt's error once
   * one fails; the ledger keeps the broadcast owed either way.
   */
  publish?: () => Promise<void>
  /** Owes the broadcast to the ledger, durably, without waiting for it: what funding needs first. */
  owe?: () => Promise<void>
  /** How `depositAddress` got it: a landed pool entry, a pool fill still proving, or a derivation. */
  source?: "pool" | "filling" | "derived"
}

/**
 * A derived address plus what it takes to publish it later. `(day, nonce)` regenerate the
 * resolution exactly, so nothing secret is persisted.
 */
interface CachedSipa {
  address: Address
  day: number
  nonce: number
  published: boolean
  /** The broadcast reached the node under this hash; the chain decides whether it landed. */
  broadcastTxHash?: string
}

// Every field is checked `nonce` is what regenerates the
// message secret, and a missing one makes the publish step derive a DIFFERENT address than the
// one already handed to the user.
function isCachedSipa(v: unknown): v is CachedSipa {
  const e = v as CachedSipa
  return (
    typeof e?.address === "string" &&
    Number.isInteger(e.day) &&
    Number.isInteger(e.nonce) &&
    typeof e.published === "boolean"
  )
}

/**
 * Exported for the cache tests: every branch below routes funds, and a mistake is only visible
 * once a sender has already paid an address nobody sweeps.
 */
export function readCachedSipa(key: string): CachedSipa | null {
  try {
    const raw = walletStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return isCachedSipa(parsed) ? parsed : null
  } catch {
    return null
  }
}

function isPublished(cacheKey: string, entry: CachedSipa): boolean {
  const current = readCachedSipa(cacheKey)
  return !!current?.published && current.day === entry.day && current.nonce === entry.nonce
}

/**
 * Only stamp the entry this publish actually broadcast. A slower publish finishing after a newer
 * derivation replaced it would otherwise mark the NEW address published without ever having told
 * the relayer about it. Resolves once the stamp is saved: an address whose stamp is lost would be
 * handed out again as unpublished, and two senders would share it.
 */
async function markPublished(cacheKey: string, entry: CachedSipa): Promise<void> {
  const current = readCachedSipa(cacheKey)
  if (current?.day === entry.day && current?.nonce === entry.nonce) {
    await saveCachedSipa(cacheKey, { ...entry, published: true, broadcastTxHash: undefined })
  }
}

export function writeCachedSipa(key: string, entry: CachedSipa): void {
  walletStorage.setItem(key, JSON.stringify(entry))
}

/** A slot about to be handed out: saved first, so a later sync can still find and broadcast it. */
export function saveCachedSipa(key: string, entry: CachedSipa): Promise<void> {
  return walletStorage.commitItem(key, JSON.stringify(entry))
}

/**
 * How many broadcast addresses the pool keeps ready. Each fill burns one sponsored-broadcast slot
 * of the daily quota.
 */
export const SIPA_POOL_TARGET = 1

const DAY_MS = 24 * 60 * 60_000

/**
 * Oldest a pooled address may be. The relayer drops a broadcast operation still waiting for funds
 * after its max pending age, so an older address would take funds nobody sweeps.
 */
export const SIPA_POOL_MAX_AGE_MS = 14 * DAY_MS

const poolStorageKey = (cacheKey: string) => `${cacheKey}.pool`

/**
 * The pool of never-handed-out addresses, scoped by the same cache key as the single slot — a
 * deployment roll or account change orphans the whole batch at once. POOL MEMBERSHIP MEANS
 * BROADCAST: an entry is appended only after its broadcast tx mined, and the read drops anything
 * else, so every pooled address is sweepable the moment it is shown. Malformed and expired entries
 * are dropped rather than failing the read, and leave storage on the next write: losing a pooled
 * entry costs a proof, not funds.
 */
export function readSipaPool(cacheKey: string, now: number = Date.now()): CachedSipa[] {
  try {
    const raw = walletStorage.getItem(poolStorageKey(cacheKey))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const oldestDay = (now - SIPA_POOL_MAX_AGE_MS) / DAY_MS
    return parsed.filter((e) => isCachedSipa(e) && e.published && e.day > oldestDay)
  } catch {
    return []
  }
}

function writeSipaPool(cacheKey: string, entries: CachedSipa[]): void {
  walletStorage.setItem(poolStorageKey(cacheKey), JSON.stringify(entries))
}

/**
 * Pop the oldest entry into the slot, as one transaction: the pool loses it as the slot gains it,
 * so it is never handed out twice and never lost between the two. Resolves once saved: an address
 * whose move failed must not be shown.
 */
export async function takeFromSipaPool(
  cacheKey: string,
  maxAgeMs: number = SIPA_POOL_MAX_AGE_MS,
  now: number = Date.now(),
): Promise<CachedSipa | null> {
  const pool = readSipaPool(cacheKey, now)
  const pick = pool.find((e) => e.day > (now - maxAgeMs) / DAY_MS)
  if (!pick) return null
  const rest = pool.filter((e) => e !== pick)
  await walletStorage.commitTransaction([
    [poolStorageKey(cacheKey), JSON.stringify(rest)],
    [cacheKey, JSON.stringify(pick)],
  ])
  return pick
}

/**
 * Callers append only entries whose broadcast has landed (`published: true`). An address already
 * pooled stays once: a landing the ledger failed to record is reported again.
 */
export function appendToSipaPool(cacheKey: string, entry: CachedSipa): void {
  const pool = readSipaPool(cacheKey)
  if (pool.some((e) => e.address.toLowerCase() === entry.address.toLowerCase())) return
  writeSipaPool(cacheKey, [...pool, entry])
}

/**
 * Every slot under `prefix` (one per tag) whose address was handed out but never broadcast. The
 * broadcast is the account's, not the tag's, so a slot left behind by a name lost after the
 * hand-out still belongs here. Pool keys carry a `.pool` suffix and are not slots.
 */
export function readUnpublishedSlots(prefix: string): Array<{ key: string; entry: CachedSipa }> {
  const slots: Array<{ key: string; entry: CachedSipa }> = []
  for (const key of walletStorage.keys()) {
    if (!key.startsWith(prefix) || key.slice(prefix.length).includes(".")) continue
    const entry = readCachedSipa(key)
    if (entry && !entry.published) slots.push({ key, entry })
  }
  return slots
}

/**
 * The next self-resolution nonce for this account today. Slots are handed out in order; the local
 * counter covers what this device derived, `floor` is what the chain already shows broadcast today
 * (another device, or this one before its storage was cleared), and the higher of the two wins. One
 * key per scope, reset when the day rolls. Scope is the account, not the view: every view derives
 * from the same keys, so they share one nonce space.
 */
export async function nextSelfSipaNonce(scope: string, day: number, floor = 0): Promise<number> {
  const key = `${scope}.slot`
  let slot = floor
  try {
    const stored = JSON.parse(walletStorage.getItem(key) ?? "null")
    if (stored?.day === day && Number.isInteger(stored.next)) slot = Math.max(slot, stored.next)
  } catch {
    // corrupt entry: the chain-derived floor still applies
  }
  // Saved before the nonce is used, so a reload never hands the same slot out again.
  await walletStorage.commitItem(key, JSON.stringify({ day, next: slot + 1 }))
  return selfSipaNonce(slot)
}

export function selfSipaScope(network: string, account: string): string {
  return `webwallet.sipa.${network}.${account}`
}

/** How many of today's slots are already broadcast: slot k is used when its salt is among `salts`. */
export function slotFloor(salts: ReadonlySet<string>, selfSipaKey: Fr, day: number): number {
  let used = 0
  while (salts.has(deriveSelfSipaSecret(selfSipaKey, day, selfSipaNonce(used)).toString())) used++
  return used
}

/** What a broadcast publishes for one address. */
export interface SipaPublishInputs {
  address: Address
  user: AztecAddress
  messageSecret: Fr
  intent: SipaIntent
  sipaArgs: SipaRecoverCandidate["args"]
}

/** Publish inputs read back from a record, with the CREATE2 origin they came from. */
export interface RecordedPublishInputs extends SipaPublishInputs {
  candidate: SipaRecoverCandidate
}

/**
 * The publish inputs an address's record holds, written when the address was derived. An address
 * derived under an earlier key no longer re-derives from `(day, nonce)`, but the user may already
 * have shared it, so it publishes from its record. Null when the record lacks its identity or its
 * intent does not hash to what the address commits to.
 */
export function publishInputsFromRecord(
  record: SIPADepositRecord | null | undefined,
): RecordedPublishInputs | null {
  if (!record?.origin || !record.messageSecret || !record.recipientHash) return null
  if (!record.recipientL2Address) return null
  const [candidate] = sipaDeployArgCandidates(record, [])
  if (!candidate) return null
  const intent = buildDepositIntent({
    implementation: candidate.args.implementation,
    recipientCommitment: record.recipientHash as Hex,
  })
  if (intent.intentHash.toLowerCase() !== candidate.args.intentHash.toLowerCase()) return null
  return {
    address: getAddress(record.sipaAddress),
    user: AztecAddress.fromStringUnsafe(record.recipientL2Address),
    messageSecret: Fr.fromHexString(record.messageSecret),
    intent,
    sipaArgs: candidate.args,
    candidate,
  }
}

/**
 * Why a send cannot be swept, or undefined when it can. Below the quoted fee nothing is left to
 * credit and the sweep itself hard-reverts, stranding the funds; above the cap the portal refuses
 * what it would take in. `amount` and `fee` must be in the same token's
 * units, which `decimals` and `symbol` name.
 */
export function depositWindowError(
  amount: bigint,
  fee: bigint,
  decimals: number,
  symbol: string,
): string | undefined {
  if (amount <= fee)
    return `Amount must exceed the deposit fee (${formatUnits(fee, decimals)} ${symbol})`
  const capDisplay = formatUnits(TX_AMOUNT_CAP, DEFAULT_DECIMALS)
  if (amount - fee > parseUnits(capDisplay, decimals)) {
    return "This amount is over the network's maximum per deposit"
  }
  return undefined
}

export interface SipaDepositGateway {
  /**
   * A single-use deposit address for THIS wallet, never one shown before: a pooled entry whose
   * broadcast landed, else a pool fill still proving, else a fresh derivation, which needs an
   * unlocked session and owes the ledger a proof once published. Callers resolve once per view.
   * `publishingLimit` refuses a fresh derivation with `AddressesPublishingError`.
   */
  depositAddress(
    wallet: ObsidionWallet,
    contractService: ContractService,
    tag: string,
    opts?: { onStage?: (stage: DepositStage) => void; publishingLimit?: number },
  ): Promise<DepositAddress>
  /**
   * A pooled address published within `maxAgeMs`, handed out as `depositAddress` hands out a pooled
   * one, else null. Never derives, so never asks for the passkey; the pool refills behind it.
   */
  readyAddress(
    wallet: ObsidionWallet,
    contractService: ContractService,
    tag: string,
    maxAgeMs: number,
  ): Promise<{ address: Address; day: number } | null>
  /**
   * Full self-initiated deposit: transfer `amountDisplay` of the token from the connected L1 wallet
   * to `target` (optionally minting first on the sandbox faucet token), once that address's
   * broadcast is owed to the ledger, so the relayer sweeps it when it lands. `from` pins the sending account to the
   * app's selection. The deposit lands in the L2 balance automatically via the sync loop.
   */
  deposit(params: {
    target: DepositAddress
    amountDisplay: string
    from?: Hex
    /** Connected wallet's display name, stamped on the record for the detail sheet. */
    walletName?: string
    /** Symbol of the token the user sent (the record otherwise carries the bridged token's). */
    tokenSymbol?: string
    /** ERC-20 to transfer instead of the manifest token (mainnet USDC/USDT, swapped by the sweep). */
    token?: { address: Address; decimals: number }
    mint?: boolean
    /** False: a payer funding someone else's address. Nothing is recorded on this device. */
    record?: boolean
    onStage?: (stage: DepositStage) => void
    /** Fires with the L1 hash once the wallet has broadcast the transfer, before confirmation. */
    onSubmitted?: (txHash: Hex) => void
    /** Desktop bridge only: receives the helper page's URL for display. */
    onBrowserSubmit?: (submitUrl: string) => void
    /**
     * The caller's last check, with the fee read for this send (display units of the manifest token). It runs right
     * before the wallet prompt, and on the desktop before the hand-off and again each time the helper page is about to
     * send. A throw stops the transfer.
     */
    preflight: (fresh: { feeDisplay: string }) => Promise<void>
    /**
     * Desktop only: runs when the helper is about to be approved to send, after the recheck passed in time, with the
     * desktop submission id. It must resolve once it has durably recorded that a send may follow, or reject so the send
     * is refused.
     */
    beforeApprove?: (submission: string) => Promise<void>
  }): Promise<{ txHash: Hex; address: Address; name: string }>
  /** Starts the L1 reads a sync pass opens with, which need no PXE. */
  warm(): Promise<void>
  /** Run discovery (once) + a claim sync pass. Returns null while locked. */
  sync(
    wallet: ObsidionWallet,
    tokenService: TokenService,
    opts?: { onProgress?: (done: number, total: number) => void },
  ): Promise<SipaDepositSyncResult | null>
  /** An observe-only pass: L1 reads and record writes, no PXE work. Returns null while locked. */
  observe(wallet: ObsidionWallet, recipient: string): Promise<SipaDepositSyncResult | null>
  /**
   * Polls the addresses the resolver can hand out for this wallet's account and records a funded one
   * at once. `onFunded` runs after a tick recorded one.
   */
  resolverPayments(onFunded: () => void): Pick<ResolverPaymentWatcher, "tick">
  /** Token display metadata (read once off L1). */
  tokenMeta(): Promise<{ address: Address; symbol: string; decimals: number }>
  /** The quoted deposit fee in display units of the manifest token (e.g. "0.5"). */
  depositFee(): Promise<string>
  /** The current local deposit records (feed). */
  records(): SIPADepositRecord[]
  subscribe(listener: (records: SIPADepositRecord[]) => void): () => void
  /** The nonce for this wallet's next self-resolution on `day`; see `nextSelfSipaNonce`. */
  nextSelfNonce(wallet: ObsidionWallet, day: number): Promise<number>
  /**
   * Publish a SIPA the caller already self-resolved (intra-rollup migrate). Same ClaimFPC-sponsored
   * broadcast as Receive; re-derives from `(day, nonce)` and refuses if the address moved.
   * `operationId` tags its proving events with the caller's operation.
   */
  broadcastResolvedSipa(
    wallet: ObsidionWallet,
    contractService: ContractService,
    sipa: SelfResolvedSipa,
    operationId?: string,
  ): Promise<void>
  /** What the broadcast ledger runs for this wallet's deposit addresses. */
  slotExecutor(wallet: ObsidionWallet): BroadcastExecutor
  /** Txs from `fromBlock` on that broadcast one of `user`'s deposit addresses. */
  broadcastTxHashes(
    wallet: ObsidionWallet,
    user: AztecAddress,
    fromBlock: number,
  ): Promise<Set<string>>
}

let singleton: RealSipaDepositGateway | undefined

/** Test-only: the next `getSipaDepositGateway` builds a fresh gateway. */
export function resetSipaDepositGatewayForTests(): void {
  singleton = undefined
}

/**
 * The process-wide gateway: one instance so discovery, the PXE contract
 * registrations and the token metadata are resolved once per session. Creation
 * kicks the store's hydration so `records()` serves the last-known state
 * (subscribers get the post-load list-changed emit) instead of waiting for a
 * sync pass.
 */
export function getSipaDepositGateway(): SipaDepositGateway {
  if (!singleton) {
    singleton = new RealSipaDepositGateway()
    void singleton.hydrate()
  }
  return singleton
}

class RealSipaDepositGateway implements SipaDepositGateway {
  private readonly config = getConfig()
  private readonly store = SIPADepositStore.get(webStorage)
  private readonly publicClient = l1PublicClient(this.config)

  // Caches bound to the wallet instance — a re-booted PXE gets fresh ones.
  private wallet?: ObsidionWallet
  private discoveryDone = false
  private account?: ObsidionAccount
  private broadcasters = new Map<string, BroadcasterContract>()
  // Wallet-independent caches (pure L1 reads).
  private meta?: { address: Address; symbol: string; decimals: number }
  /** Funding hashes whose record event discovery has not created yet. Drained by `sync`. */
  private readonly pendingFundingTx = new Map<string, FundingStamp>()

  private bind(wallet: ObsidionWallet): void {
    if (this.wallet === wallet) return
    this.wallet = wallet
    this.discoveryDone = false
    this.account = undefined
    this.broadcasters.clear()
  }

  /**
   * The unlocked account + MSK (re-derived from the session keys), or null
   * while locked. The account is cached — `createObsidionAccount` re-registers
   * it in the PXE each call, so the 12s sync loop would otherwise spam
   * `registerUserAccount`.
   */
  private async unlockedKeys(
    wallet: ObsidionWallet,
  ): Promise<{ account: ObsidionAccount; msk: Fr } | null> {
    const auth = getAuthService()
    const msk = await auth.getSecretKey()
    const authProvider = await auth.getAuthProvider()
    if (!msk || !authProvider) return null
    this.account ??= await wallet.createObsidionAccount(msk, authProvider)
    return { account: this.account, msk }
  }

  async tokenMeta(): Promise<{ address: Address; symbol: string; decimals: number }> {
    if (this.meta) return this.meta
    const tuple = await getOxideTuple(this.config)
    const token = requireTupleField(tuple, "token") as Address
    const [decimals, symbol] = await Promise.all([
      this.publicClient.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
      this.publicClient.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
    ])
    this.meta = { address: token, symbol, decimals }
    return this.meta
  }

  /** This portal's deposit implementation — the one every address this gateway hands out clones,
   *  and whose `depositFee()` their sweep pays. */
  private async depositImplementation(tuple: OxideEnvTuple): Promise<Address> {
    return depositSipaImplementation(
      this.publicClient,
      requireTupleField(tuple, "sipaFactory") as Address,
      requireTupleField(tuple, "portal") as Address,
    )
  }

  async depositFee(): Promise<string> {
    const [meta, tuple] = await Promise.all([this.tokenMeta(), getOxideTuple(this.config)])
    return formatUnits(await this.quotedFee(tuple), meta.decimals)
  }

  /** Both halves of what a deposit costs: the sweep fee and the portal's cut. */
  private async quotedFee(tuple: OxideEnvTuple): Promise<bigint> {
    const [fee, cut] = await Promise.all([
      this.depositImplementation(tuple).then((implementation) =>
        implementationDepositFee(this.publicClient, implementation),
      ),
      fpcFundingCut(this.publicClient, requireTupleField(tuple, "portal") as Address),
    ])
    return quotedDepositFee(fee, cut)
  }

  /**
   * Register the broadcaster contract + resolver and sponsor senders in this PXE. Required before
   * BROADCASTING, not just before syncing: the tagging pass needs the address preimages to derive
   * tags, and without them the event this wallet just sent itself is one it cannot discover
   * ("Skipping sender-derived tag retrieval … unknown address preimage").
   */
  private async ensureDiscovery(wallet: ObsidionWallet, tuple: OxideEnvTuple): Promise<void> {
    if (this.discoveryDone) return
    const { address: sponsorFpc } = await ContractService.getInstance().getContractRecord(
      DEFAULT_CONTRACTS.claimFpc,
    )
    await setupSipaDiscovery({
      artifactFor: (address) => getWebBroadcasterArtifact(wallet, address),
      pxe: wallet.pxe as never,
      node: wallet.node as never,
      publicClient: this.publicClient,
      tuple,
      network: this.config.network,
      sponsorFpc,
    })
    this.discoveryDone = true
  }

  /**
   * Scoped to the deployment AND the account: the portal rolls with every redeploy, and the same
   * @tag can be re-claimed by a different account. A hit from either would hand out an address this
   * wallet cannot sweep. Deliberately outside `WEB_STORAGE_PREFIX` — a published address cost a
   * proof and survives a front-core state reset, so `WebStorageAdapter.clear()` must not take it.
   */
  private addressCacheKey(tuple: OxideEnvTuple, tag: string): string {
    return `${this.addressCachePrefix(tuple)}${tag}`
  }

  /** What every tag's slot for this account on this deployment starts with. */
  private addressCachePrefix(tuple: OxideEnvTuple): string {
    const account = loadWalletIdentity()?.address ?? "unknown"
    const portal = requireTupleField(tuple, "portal")
    return `webwallet.sipa.address.${this.config.network}.${portal}.${account}.`
  }

  async nextSelfNonce(wallet: ObsidionWallet, day: number): Promise<number> {
    const keys = await this.unlockedKeys(wallet)
    if (!keys) throw new Error("no account for this session — enter with your passkey first")
    return this.nextNonce(wallet, await getOxideTuple(this.config), keys, day)
  }

  /**
   * The local counter alone would let a fresh device re-derive a slot another device already
   * broadcast today, so the floor is read off the chain, from the salts this wallet's own `SIPA`
   * events carry. Pure derivation per slot, no L1 read. A broadcast still in flight elsewhere is
   * invisible here — a duplicate broadcast of the same address, never lost funds.
   */
  private async nextNonce(
    wallet: ObsidionWallet,
    tuple: OxideEnvTuple,
    keys: { account: ObsidionAccount; msk: Fr },
    day: number,
  ): Promise<number> {
    await this.ensureDiscovery(wallet, tuple)
    const user = keys.account.getAddress()
    const events = await fetchSipaEvents(
      wallet,
      AztecAddress.fromStringUnsafe(requireTupleField(tuple, "l2Token")),
      user,
    )
    const salts = new Set(events.map((event) => event.sharedSecretSalt.toString()))
    const used = slotFloor(salts, deriveSelfSipaKey(keys.msk), day)
    console.debug(`[sipaGateway] slot floor ${used} from ${events.length} events`)
    return nextSelfSipaNonce(selfSipaScope(this.config.network, user.toString()), day, used)
  }

  // Cached: `.at()` re-registers the contract in the PXE, so rebuilding it every call spams
  // "Added contract Broadcaster".
  private async broadcasterFor(
    wallet: ObsidionWallet,
    tuple: OxideEnvTuple,
  ): Promise<BroadcasterContract> {
    const address = requireTupleField(tuple, "l2Broadcaster")
    const key = address.toLowerCase()
    let broadcaster = this.broadcasters.get(key)
    if (!broadcaster) {
      broadcaster = BroadcasterContract.at(
        AztecAddress.fromStringUnsafe(address),
        await getWebBroadcasterArtifact(wallet, address),
        wallet as never,
      )
      this.broadcasters.set(key, broadcaster)
    }
    return broadcaster
  }

  async depositAddress(
    wallet: ObsidionWallet,
    contractService: ContractService,
    tag: string,
    opts?: {
      onStage?: (stage: DepositStage) => void
      /** Shown, unfunded addresses still publishing above which no fresh one is derived. */
      publishingLimit?: number
    },
  ): Promise<DepositAddress> {
    this.bind(wallet)
    const tuple = await getOxideTuple(this.config)
    const name = tuple.ensDomain ? `${tag}.${tuple.ensDomain}` : tag

    // Each view gets an address nobody was shown, so senders paying this wallet cannot be linked to
    // each other by a shared deposit address. The ledger finishes publishing the ones already shown.
    const cacheKey = this.addressCacheKey(tuple, tag)
    const publish = (entry: CachedSipa) => () => this.publish(cacheKey, entry, opts?.onStage)
    const owe = (entry: CachedSipa) => () => this.owe(cacheKey, entry)
    const handedOut = <T>(address: T): T => {
      void this.refillPool(wallet, contractService, tuple, cacheKey)
      return address
    }

    // Pool entries were broadcast in the background and never shown to anyone, so popping one is
    // as unlinkable as a fresh derivation and instantly sweepable — no proof. It becomes the
    // slot entry so the handed-out-once bookkeeping is shared with the derive path.
    const pooled = await takeFromSipaPool(cacheKey)
    if (pooled) {
      await this.wakeDeposit(pooled.address)
      await getBroadcastLedger().markShown(pooled.address)
      return handedOut({ address: pooled.address, name, source: "pool" })
    }

    // A pool fill still being proven is as unshown as a landed one: it becomes this view's address,
    // and the proof already running is the one the view waits on.
    const filling = this.fillingPoolEntry(cacheKey)
    if (filling) {
      try {
        await saveCachedSipa(cacheKey, filling)
        await getBroadcastLedger().markShown(filling.address)
      } catch (err) {
        // Nobody was shown it: the next view, or the pool, takes it.
        this.claimedFills.delete(filling.address.toLowerCase())
        throw err
      }
      await this.wakeDeposit(filling.address)
      return handedOut({
        address: filling.address,
        name,
        publish: publish(filling),
        owe: owe(filling),
        source: "filling",
      })
    }

    if (
      opts?.publishingLimit !== undefined &&
      addressesPublishing(getBroadcastLedger().list(), getActiveStorageId()) >= opts.publishingLimit
    )
      throw new AddressesPublishingError()

    // The slot is about to hold the new address; the one it held stays owed to the ledger.
    const previous = readCachedSipa(cacheKey)
    if (previous && !previous.published && !getBroadcastLedger().get(previous.address))
      await this.oweSlot(cacheKey, previous, "deposit", Date.now())

    const keys = await this.unlockedKeys(wallet)
    if (!keys) throw new Error("no account for this session — enter with your passkey first")

    opts?.onStage?.("resolving")
    const day = await chainEpochDay(wallet)
    const { address, nonce } = await this.deriveSipa(
      wallet,
      tuple,
      keys,
      day,
      await this.nextNonce(wallet, tuple, keys, day),
    )
    const entry: CachedSipa = { address, day, nonce, published: false }
    await saveCachedSipa(cacheKey, entry)
    // The address is fully determined by the derivation — the proof and broadcast only tell the
    // relayer it exists — so hand it back now and publish behind it. Funds sent before that
    // lands sit at the counterfactual address (not lost) but are not swept until the relayer is
    // told. Callers that show or fund the address publish it first.
    return { address, name, publish: publish(entry), owe: owe(entry), source: "derived" }
  }

  async readyAddress(
    wallet: ObsidionWallet,
    contractService: ContractService,
    tag: string,
    maxAgeMs: number,
  ): Promise<{ address: Address; day: number } | null> {
    this.bind(wallet)
    const tuple = await getOxideTuple(this.config)
    const cacheKey = this.addressCacheKey(tuple, tag)
    const pooled = await takeFromSipaPool(cacheKey, maxAgeMs)
    void this.refillPool(wallet, contractService, tuple, cacheKey, maxAgeMs)
    if (!pooled) return null
    await this.wakeDeposit(pooled.address)
    await getBroadcastLedger().markShown(pooled.address)
    return { address: pooled.address, day: pooled.day }
  }

  /**
   * Stamp the feed time as now on hand-out. The record was created when the background broadcast
   * was discovered, so `startTime` is the fill moment, and the activity row would sort as if it
   * were old and the sync would poll at its idle cadence. Only the hidden unfunded shape is touched,
   * whatever its phase; a record with any evidence of funds is the rail's.
   */
  private async wakeDeposit(address: Address): Promise<void> {
    try {
      await this.store.load()
      const record = this.store.get(address)
      if (!record || !isUnfundedSipaDeposit(record)) return
      await this.store.upsert(record.sipaAddress, {
        phase: record.phase,
        reorgEpoch: record.reorgEpoch,
        startTime: Date.now(),
      })
    } catch (err) {
      console.warn("[sipaGateway] could not rearm the deposit record", err)
    }
  }

  private refilling = false
  private refillBlockedUntil = 0
  private seeded = false

  /**
   * The ledger replaced the slots' own retries. A slot an earlier version handed out unpublished,
   * or sent without marking, is owed to the ledger once, so its broadcast still lands.
   */
  private async seedLedger(tuple: OxideEnvTuple): Promise<void> {
    if (this.seeded) return
    for (const { key, entry } of readUnpublishedSlots(this.addressCachePrefix(tuple))) {
      await this.oweSlot(key, entry, "deposit", Date.now())
    }
    this.seeded = true
  }

  /** Pool fills a view took before the ledger records them shown. */
  private readonly claimedFills = new Set<string>()

  /**
   * Takes the cache key's pool fill still being proven, as the slot entry a view would hold. The
   * claim is synchronous, so two views never take the same fill.
   */
  private fillingPoolEntry(cacheKey: string): CachedSipa | null {
    const job = getBroadcastLedger()
      .list()
      .find(
        (j) =>
          j.kind === "pool" &&
          j.state !== "landed" &&
          j.source.type === "slot" &&
          j.source.cacheKey === cacheKey &&
          !this.claimedFills.has(j.address),
      )
    if (!job || job.source.type !== "slot") return null
    this.claimedFills.add(job.address)
    return {
      address: getAddress(job.address),
      day: job.source.day,
      nonce: job.source.nonce,
      published: false,
    }
  }

  /**
   * Keep SIPA_POOL_TARGET broadcast addresses ready so a Receive or paylink hands one out without
   * proving. The refill only derives and owes: the ledger proves it, after anything the user is
   * waiting on, and the landed broadcast joins the pool. Pool membership still means broadcast.
   */
  private async refillPool(
    wallet: ObsidionWallet,
    contractService: ContractService,
    tuple: OxideEnvTuple,
    cacheKey: string,
    /** Pooled entries older than this do not count toward the target. */
    maxAgeMs: number = SIPA_POOL_MAX_AGE_MS,
  ): Promise<void> {
    void contractService
    if (this.refilling || Date.now() < this.refillBlockedUntil) return
    this.refilling = true
    try {
      const keys = await this.unlockedKeys(wallet)
      if (!keys) return
      await this.seedLedger(tuple)
      const ledger = getBroadcastLedger()
      await ledger.load()
      const filling = ledger
        .list()
        .filter(
          (j) =>
            j.kind === "pool" &&
            j.state !== "landed" &&
            j.source.type === "slot" &&
            j.source.cacheKey === cacheKey,
        ).length
      const now = Date.now()
      const ready = readSipaPool(cacheKey, now).filter((e) => e.day > (now - maxAgeMs) / DAY_MS)
      if (ready.length + filling >= SIPA_POOL_TARGET) return
      const day = await chainEpochDay(wallet)
      const { address, nonce } = await this.deriveSipa(
        wallet,
        tuple,
        keys,
        day,
        await this.nextNonce(wallet, tuple, keys, day),
      )
      await this.oweSlot(cacheKey, { address, day, nonce, published: false }, "pool")
    } catch (err) {
      // ponytail: flat 5-min cooldown; the sync loop retries after it. No backoff ladder.
      console.warn("[sipaGateway] SIPA pool refill failed", err)
      this.refillBlockedUntil = Date.now() + 5 * 60_000
    } finally {
      this.refilling = false
    }
  }

  /** A sender who paid an address whose broadcast is still owed moves it to the front. */
  private async markOwedFunded(): Promise<void> {
    const ledger = getBroadcastLedger()
    await ledger.load()
    for (const job of ledger.list()) {
      if (job.state === "landed" || job.fundedAt !== undefined || job.source.type !== "slot")
        continue
      const record = this.store.get(getAddress(job.address))
      if (record && Number(record.amount) > 0) await ledger.markFunded(job.address).catch(() => {})
    }
  }

  /** Owe a derived address's broadcast to the ledger. Owing one already owed keeps its progress. */
  private async oweSlot(
    cacheKey: string,
    entry: CachedSipa,
    kind: BroadcastKind,
    shownAt?: number,
  ): Promise<void> {
    await getBroadcastLedger().enqueue({
      address: entry.address,
      kind,
      scope: getActiveStorageId(),
      source: { type: "slot", cacheKey, day: entry.day, nonce: entry.nonce },
      ...(shownAt !== undefined ? { shownAt } : {}),
      ...(entry.broadcastTxHash ? { txHash: entry.broadcastTxHash } : {}),
    })
  }

  /**
   * Everything the address depends on: the salt hashed from this wallet's self-SIPA key, and
   * the Registry's CREATE2 prediction over the resulting recipient hash. Deterministic in
   * `(day, nonce)`, so the publish step re-derives rather than threading state through.
   */
  private async deriveSipa(
    wallet: ObsidionWallet,
    tuple: OxideEnvTuple,
    keys: { account: ObsidionAccount; msk: Fr },
    day: number,
    nonce: number,
  ) {
    await this.ensureDiscovery(wallet, tuple)
    const selfResolver = new SipaSelfResolver(selfSipaResolverKeys(keys.msk))
    const user = keys.account.getAddress()
    const {
      sipaAddress: address,
      sipaArgs,
      intent,
      resolution,
    } = await selfResolver.resolveAddress({
      protocol: tuple.sipaRecoveryProtocol ?? "legacy-eoa",
      user,
      recoveryAccount: predictAccountAddressLocally(
        requireTupleField(tuple, "accountFactory") as Address,
        deriveBootstrapKey(keys.msk).address,
      ),
      day,
      nonce,
      publicClient: this.publicClient,
      sipaFactory: requireTupleField(tuple, "sipaFactory") as Address,
      portal: requireTupleField(tuple, "portal") as Address,
      rollupVersion: BigInt(requireTupleField(tuple, "rollupVersion")),
    })
    await this.store.load()
    const existing = this.store.get(address)
    const meta = await this.tokenMeta()
    await this.store.upsert(
      address,
      {
        phase: existing?.phase ?? "resolved",
        origin:
          "recoveryAddress" in sipaArgs
            ? {
                protocol: "legacy-eoa",
                sipaFactory: requireTupleField(tuple, "sipaFactory") as Address,
                ...sipaArgs,
                rollupVersion: sipaArgs.rollupVersion.toString(),
              }
            : {
                protocol: "account",
                sipaFactory: requireTupleField(tuple, "sipaFactory") as Address,
                ...sipaArgs,
                rollupVersion: sipaArgs.rollupVersion.toString(),
                recoveryAccount: resolution.recoveryAccount.toString() as Address,
                accountFactory: requireTupleField(tuple, "accountFactory") as Address,
              },
      },
      {
        recipientL2Address: user.toString(),
        messageSecret: resolution.messageSecret.toString(),
        recipientHash: resolution.recipientHash.toString(),
        recoveryAddress: "",
        l1ChainId: this.config.l1ChainId,
        tokenAddress: meta.address,
        amount: "0",
        tokenSymbol: meta.symbol,
        startTime: Date.now(),
      },
    )
    return {
      address,
      nonce: resolution.nonce,
      resolution,
      selfResolver,
      user,
      intent,
      implementation: sipaArgs.implementation,
      sipaArgs,
    }
  }

  /** Why the ledger last deferred an address: no rail can pay for it until the name lands. */
  private readonly registrationPending = new Map<string, RegistrationPendingError>()

  /**
   * Owe the address's broadcast, as one the user holds, and settle once it landed. The proof is
   * the ledger's: it runs one at a time, after anything owed before it, and survives a reload.
   */
  private async publish(
    cacheKey: string,
    entry: CachedSipa,
    onStage?: (stage: DepositStage) => void,
  ): Promise<void> {
    if (isPublished(cacheKey, entry)) return
    await this.owe(cacheKey, entry)
    onStage?.("broadcasting")
    await this.waitForBroadcast(entry.address)
  }

  /** Owe the address's broadcast as one the user holds. */
  private async owe(cacheKey: string, entry: CachedSipa): Promise<void> {
    if (isPublished(cacheKey, entry)) return
    await this.oweSlot(cacheKey, entry, "deposit", Date.now())
  }

  /**
   * Settles once the address's broadcast landed. Rejects with the registration's wait while no
   * rail can pay for it, and with the attempt's error once one fails.
   */
  private waitForBroadcast(address: Address): Promise<void> {
    const ledger = getBroadcastLedger()
    const key = address.toLowerCase()
    return new Promise((resolve, reject) => {
      let failures: number | undefined
      const check = () => {
        const job = ledger.get(key)
        const pending = this.registrationPending.get(key)
        failures ??= job?.failures ?? 0
        const settle = (fn: () => void) => {
          off()
          fn()
        }
        if (!job) return settle(() => reject(new Error("This address is no longer published")))
        if (job.state === "landed") return settle(resolve)
        if (job.state !== "queued") return
        if (pending) return settle(() => reject(pending))
        if (job.failures > failures)
          return settle(() => reject(new Error(job.lastError ?? "The address was not published")))
      }
      const off = ledger.onListChanged(check)
      void ledger.load().then(check)
    })
  }

  /**
   * Whether the address's broadcast mined: this wallet holds the `SIPA` event its salt names, from
   * `sinceBlock` on when the address is being published again.
   */
  private async broadcastLanded(
    wallet: ObsidionWallet,
    address: string,
    sinceBlock?: number,
  ): Promise<boolean> {
    await this.store.load()
    const salt = this.store.get(getAddress(address))?.messageSecret
    const keys = await this.unlockedKeys(wallet)
    if (!salt || !keys) return false
    const tuple = await getOxideTuple(this.config)
    await this.ensureDiscovery(wallet, tuple)
    const events = await fetchSipaEvents(
      wallet,
      AztecAddress.fromStringUnsafe(requireTupleField(tuple, "l2Token")),
      keys.account.getAddress(),
      sinceBlock === undefined ? undefined : { fromBlock: BlockNumber(sinceBlock) },
    )
    const wanted = salt.toLowerCase()
    return events.some((event) => event.sharedSecretSalt.toString().toLowerCase() === wanted)
  }

  /** What the broadcast ledger runs for a derived deposit address. */
  slotExecutor(wallet: ObsidionWallet): BroadcastExecutor {
    return {
      landed: (job) => this.broadcastLanded(wallet, job.address, job.republishSince),
      send: async (job, attempt) => {
        if (job.source.type !== "slot") throw new BroadcastAbandoned("Not a deposit address")
        this.bind(wallet)
        const keys = await this.unlockedKeys(wallet)
        if (!keys) throw new BroadcastDeferred(Date.now() + WAIT_MS, WAITING_FOR_UNLOCK)
        const tuple = await getOxideTuple(this.config)
        const contractService = ContractService.getInstance()
        let sponsor: ClaimSponsorContext
        try {
          sponsor = await claimSponsorContext(
            { wallet, account: keys.account, contractService },
            RAIL_REGISTERED,
          )
        } catch (err) {
          if (!(err instanceof RegistrationPendingError)) throw err
          this.registrationPending.set(job.address, err)
          throw new BroadcastDeferred(Date.now() + WAIT_MS, WAITING_FOR_REGISTRATION)
        }
        this.registrationPending.delete(job.address)
        const entry: CachedSipa = {
          address: getAddress(job.address),
          day: job.source.day,
          nonce: job.source.nonce,
          published: false,
        }
        return this.broadcastSipa(wallet, contractService, tuple, keys, entry, {
          sponsor,
          operationId: attempt.operationId,
          onTxHash: attempt.onTxHash,
        })
      },
      onLanded: async (job) => {
        if (job.source.type !== "slot") return
        this.registrationPending.delete(job.address)
        const { cacheKey, day, nonce } = job.source
        const entry: CachedSipa = { address: getAddress(job.address), day, nonce, published: true }
        await markPublished(cacheKey, entry)
        // Nobody saw it: it waits in the pool for the next view. Read again after the await, which a
        // view can take it during.
        const current = getBroadcastLedger().get(job.address) ?? job
        if (
          current.kind === "pool" &&
          current.shownAt === undefined &&
          !this.claimedFills.has(job.address)
        )
          appendToSipaPool(cacheKey, entry)
      },
    }
  }

  /**
   * What an address that no longer re-derives still publishes: its record, provided the record's
   * args deploy exactly that address under this deployment's factory. An address of another factory
   * is not this deployment's to publish; its record stays for recovery.
   */
  private async recordedPublishInputs(
    address: Address,
    tuple: OxideEnvTuple,
  ): Promise<SipaPublishInputs | null> {
    const recorded = publishInputsFromRecord(this.store.get(address))
    if (!recorded) return null
    const factory = requireTupleField(tuple, "sipaFactory") as Address
    if (recorded.candidate.sipaFactory.toLowerCase() !== factory.toLowerCase()) return null
    const predicted = await predictSipaCandidate(this.publicClient, recorded.candidate)
    return predicted.toLowerCase() === address.toLowerCase() ? recorded : null
  }

  /**
   * Sponsor the L2 broadcast that tells the relayer the address exists, folding the deferred
   * first-tx subscription in when one is pending. Re-derives from the cached `(day, nonce)` rather
   * than being handed the first derivation's result: the second derivation is INDEPENDENT, which
   * is what makes the equality check below a real check rather than a tautology. An address that
   * no longer re-derives publishes from its record instead; nothing else is published under it.
   */
  private async broadcastSipa(
    wallet: ObsidionWallet,
    contractService: ContractService,
    tuple: OxideEnvTuple,
    keys: { account: ObsidionAccount; msk: Fr },
    entry: CachedSipa,
    opts: {
      onStage?: (stage: DepositStage) => void
      sponsor?: ClaimSponsorContext
      operationId?: string
      onTxHash?: (txHash: string) => Promise<void>
    } = {},
  ): Promise<string> {
    const { onStage, sponsor: prebuiltSponsor, operationId, onTxHash } = opts
    const derived = await this.deriveSipa(wallet, tuple, keys, entry.day, entry.nonce)
    // The user already holds `entry.address` and may have shared it. Broadcasting anything else
    // strands whatever they were sent.
    const inputs: SipaPublishInputs | null =
      derived.address.toLowerCase() === entry.address.toLowerCase()
        ? { ...derived, messageSecret: derived.resolution.messageSecret }
        : await this.recordedPublishInputs(entry.address, tuple)
    if (!inputs) throw new BroadcastAbandoned("The address no longer derives")
    const { address, user, messageSecret, intent, sipaArgs } = inputs
    const deployed = await readSipaDeployed(this.publicClient, address)
    if (!deployed && !("recoveryAddress" in sipaArgs)) {
      await assertSubsidySweepsSipa(this.publicClient, {
        depositSubsidy: requireTupleField(tuple, "depositSubsidy") as Address,
        portal: requireTupleField(tuple, "portal") as Address,
        sipaFactory: requireTupleField(tuple, "sipaFactory") as Address,
        intent: OxideSipaIntent.Deposit,
        deployArgs: sipaArgs,
        intentData: intent.intentData,
        sipa: address,
      })
    }

    // The sponsor leg first: a registration the rollup has not imported yet throws here, before
    // anything slow.
    const sponsor =
      prebuiltSponsor ??
      (await claimSponsorContext(
        { wallet, account: keys.account, contractService },
        RAIL_REGISTERED,
      ))
    const { fpcAddress, fpcArtifact, railId, policy, subscribe } = sponsor

    onStage?.("broadcasting")
    const token = await getWebOxideToken(
      wallet,
      contractService,
      requireTupleField(tuple, "l2Token"),
    )
    const broadcaster = await this.broadcasterFor(wallet, tuple)
    const interactions = buildSipaSweepBroadcasts(token, broadcaster, {
      recipient: user,
      sharedSecretSalt: messageSecret,
      resweepable: sipaArgs.resweepable,
      intentHash: intent.intentHash,
      sipa: address,
      deployed,
      sipaFactory: requireTupleField(tuple, "sipaFactory") as Address,
      intent: OxideSipaIntent.Deposit,
      deployArgs: sipaArgs,
      intentData: intent.intentData,
      proofs: intent.proofs,
      operationExecutor: requireTupleField(tuple, "operationExecutor") as Address,
      depositSubsidy: requireTupleField(tuple, "depositSubsidy") as Address,
      chainId: BigInt(this.config.l1ChainId),
      // TODO(benesjan): the relayer copies this sweep for each other token it accepts.
      // https://linear.app/aztec-labs/issue/OX-1877/for-v6-handle-multi-token-balance-condition-l1-operations-properly
      tokens: [requireTupleField(tuple, "token") as Address],
    })
    const broadcastCalls = (await Promise.all(interactions.map((call) => call.request()))).flatMap(
      (payload) => payload.calls,
    )

    // A first-ever broadcast folds the deferred subscription into this very tx. Later ones ride
    // `sponsor`, which spends one SubscriptionNote use.
    const common = {
      fpcAddress,
      fpcArtifact,
      railId,
      policy,
      user,
      innerCalls: broadcastCalls,
      // The broadcast matches by address or the `ByAny` entry — no class witness.
      classWitnesses: [],
    }
    const payload = subscribe
      ? await buildClaimSubscribePayload({ ...common, gate: subscribe.gate })
      : await buildClaimSponsorPayload(common)

    // NO_FROM: the entrypoint's subscription is the eligibility — no user signature at all. The
    // `SIPA` event is sent to this account, so this PXE discovers what it just broadcast.
    // Resolves once mined.
    const { receipt } = await wallet.sendTx(payload, {
      from: NO_FROM,
      sendMessagesAs: user,
      additionalScopes: [user],
      fee: claimFpcSponsoredFee(policy, common.innerCalls),
      operationId,
      ...(onTxHash ? { onTxHash } : {}),
    })
    const txHash = receipt.txHash.toString()
    if (subscribe) noteSubscribed(keys.account, fpcAddress, railId)
    maybeRefuelFpc({ wallet, contractService, fpc: { address: fpcAddress, artifact: fpcArtifact } })
    return txHash
  }

  async broadcastTxHashes(
    wallet: ObsidionWallet,
    user: AztecAddress,
    fromBlock: number,
  ): Promise<Set<string>> {
    const tuple = await getOxideTuple(this.config)
    await this.ensureDiscovery(wallet, tuple)
    const token = AztecAddress.fromStringUnsafe(requireTupleField(tuple, "l2Token"))
    return readSipaBroadcastTxHashes(wallet, token, user, fromBlock)
  }

  async broadcastResolvedSipa(
    wallet: ObsidionWallet,
    contractService: ContractService,
    sipa: SelfResolvedSipa,
    operationId?: string,
  ): Promise<void> {
    this.bind(wallet)
    const tuple = await getOxideTuple(this.config)
    const keys = await this.unlockedKeys(wallet)
    if (!keys) throw new Error("no account for this session — enter with your passkey first")
    await this.broadcastSipa(
      wallet,
      contractService,
      tuple,
      keys,
      {
        address: sipa.sipaAddress,
        day: sipa.resolution.day,
        nonce: sipa.resolution.nonce,
        published: false,
      },
      { operationId },
    )
  }

  async deposit(
    params: Parameters<SipaDepositGateway["deposit"]>[0],
  ): Promise<{ txHash: Hex; address: Address; name: string }> {
    const onStage = params.onStage ?? (() => {})
    // Funds the address the caller is already showing. Deriving one here would send to an address
    // the user never saw — and, since each derivation is single-use, burn a second proof.
    const { address, name, publish, owe } = params.target
    const [meta, tuple] = await Promise.all([this.tokenMeta(), getOxideTuple(this.config)])
    const token = params.token?.address ?? (requireTupleField(tuple, "token") as Address)
    const decimals = params.token?.decimals ?? meta.decimals
    const amount = parseUnits(params.amountDisplay, decimals)

    const fee = await this.quotedFee(tuple)
    // Fee is quoted in the manifest token; every picker token is a dollar stable, so compare 1:1.
    const feeDisplay = formatUnits(fee, meta.decimals)
    const outside = depositWindowError(
      amount,
      parseUnits(feeDisplay, decimals),
      decimals,
      params.tokenSymbol ?? meta.symbol,
    )
    if (outside) throw new Error(outside)

    // Form gate should have stopped a known shortfall. Re-check before waiting on publish / mint so
    // an overspend never burns a long prove-and-broadcast wait then a reportable modal.
    if (params.from && !params.mint) {
      const balance = await readL1DepositTokenBalance(params.from, token)
      if (balance.raw < amount) throw new InsufficientL1BalanceError(balance)
    }

    // Funds sent before the broadcast lands wait at the address, and the ledger keeps the broadcast
    // owed until it does: owing it is all funding needs.
    if (owe) await owe()
    if (publish) void publish().catch(() => {})

    // Desktop launcher: no injected wallet exists in the dedicated Chrome profile, so the prepared
    // transfer is handed to a helper page in the user's DEFAULT browser (where their wallet lives)
    // and we wait for the reported hash. Receipt-watching runs over our own RPC client.
    if (isDesktopL1SubmitActive()) {
      if (params.mint) {
        throw new Error(
          "Minting test tokens isn't available through the browser bridge — use a browser with an injected wallet",
        )
      }
      await params.preflight({ feeDisplay })
      onStage("awaiting-browser")
      const txHash = await submitViaDesktopBridge({
        onHelperOpened: params.onBrowserSubmit,
        // The helper page can stay open for minutes, so capacity is read again when it is about to send.
        recheck: () => params.preflight({ feeDisplay }),
        beforeApprove: params.beforeApprove,
        tx: {
          to: token,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "transfer",
            args: [address, amount],
          }),
          chainId: this.config.l1ChainId,
        },
        display: {
          title: "Fund your zk.money deposit",
          lines: [
            ["Amount", `${params.amountDisplay} ${params.tokenSymbol ?? meta.symbol}`],
            ["Deposit address", address],
            ["Token contract", token],
            ["Network", l1ChainFor(this.config.l1ChainId).name],
            [
              "Network capacity",
              "Checked again when you click send. A check doesn't reserve capacity, so processing can still wait.",
            ],
          ],
        },
      })
      onStage("confirming")
      params.onSubmitted?.(txHash)
      await confirmed(this.publicClient, txHash)
      if (params.record !== false)
        await this.stampFunding(address, {
          fundingTxHash: txHash,
          walletName: params.walletName,
          tokenSymbol: params.tokenSymbol,
        })
      onStage("done")
      return { txHash, address, name }
    }

    onStage("connecting")
    const { walletClient, account, chain } = await getL1Clients(this.config.l1ChainId, params.from)

    if (params.mint) {
      onStage("minting")
      const mintHash = await walletClient.writeContract({
        address: token,
        abi: TEST_ERC20_MINT_ABI,
        functionName: "mint",
        args: [account, amount],
        account,
        chain,
      })
      await this.publicClient.waitForTransactionReceipt({ hash: mintHash })
    }

    // Last stop before the wallet prompt — account may have moved since the form ceiling was read.
    const balance = await readL1DepositTokenBalance(account, token)
    if (balance.raw < amount) throw new InsufficientL1BalanceError(balance)
    await params.preflight({ feeDisplay })

    onStage("sending")
    const txHash = await walletClient.writeContract({
      address: token,
      abi: erc20Abi,
      functionName: "transfer",
      args: [address, amount],
      account,
      chain,
    })
    onStage("confirming")
    params.onSubmitted?.(txHash)
    await confirmed(this.publicClient, txHash)
    if (params.record !== false)
      await this.stampFunding(address, {
        fundingTxHash: txHash,
        walletName: params.walletName,
        walletAddress: account,
        tokenSymbol: params.tokenSymbol,
      })
    onStage("done")
    return { txHash, address, name }
  }

  /**
   * The transfer is already confirmed on L1 by the time this runs, so a failed local write costs a
   * display row and nothing more. Reporting it as a failed deposit would be a lie.
   */
  private async stampFunding(address: Address, stamp: FundingStamp): Promise<void> {
    try {
      await stampFundingTx(this.store, this.pendingFundingTx, address, stamp)
    } catch (err) {
      console.warn("[sipaGateway] could not record the funding transaction locally", err)
    }
    // Funds wait on its broadcast now: it goes first among what is owed.
    await getBroadcastLedger()
      .markFunded(address)
      .catch(() => {})
  }

  /** They run while the first balance is read, and the pass finds them cached. */
  async warm(): Promise<void> {
    const tuple = await getOxideTuple(this.config)
    await Promise.all([
      this.tokenMeta(),
      deploymentScanRange(this.publicClient, tuple),
      this.depositImplementation(tuple),
      // The discovery setup the first pass waits on selects from these.
      readResolverOperatorRecords(
        this.publicClient,
        requireTupleField(tuple, "accountMetadataRegistry") as Address,
        tuple,
      ),
    ])
  }

  /**
   * An observe-only pass over `recipient`'s SIPAs: L1 reads and record writes, no PXE work and no
   * account built. Null while locked.
   */
  async observe(wallet: ObsidionWallet, recipient: string): Promise<SipaDepositSyncResult | null> {
    const msk = await getAuthService().getSecretKey()
    if (!msk) return null
    const tuple = await getOxideTuple(this.config)
    const meta = await this.tokenMeta()
    const token = {
      address: requireTupleField(tuple, "token") as Address,
      symbol: meta.symbol,
      decimals: meta.decimals,
    }
    return this.serial(() =>
      syncSipaDeposits({
        ...this.syncDeps(wallet, tuple, token, msk, AztecAddress.fromStringUnsafe(recipient)),
        observeOnly: true,
      }),
    )
  }

  // Passes write the same records and cursor, so one runs at a time.
  private passes: Promise<unknown> = Promise.resolve()
  private serial<T>(pass: () => Promise<T>): Promise<T> {
    const next = this.passes.then(pass, pass)
    this.passes = next.catch(() => {})
    return next
  }

  /** What every pass shares, full or observe-only. */
  private syncDeps(
    wallet: ObsidionWallet,
    tuple: OxideEnvTuple,
    token: { address: Address; symbol: string; decimals: number },
    msk: Fr,
    recipient: AztecAddress,
  ) {
    return {
      publicClient: this.publicClient,
      node: wallet.node as never,
      wallet,
      store: this.store,
      tuple,
      recipient,
      stealthPublicKey: deriveStealthKey(msk).publicKey,
      masterNullifierHidingKey: deriveMasterNullifierHidingSecretKey(msk),
      recoveryAccount: predictAccountAddressLocally(
        requireTupleField(tuple, "accountFactory") as Address,
        deriveBootstrapKey(msk).address,
      ),
      token,
      fundingTokens: sipaFundingTokens(this.config.network, token),
      l1ChainId: this.config.l1ChainId,
      registrationScheduleFor: registrationScheduleForSipa,
      onFundingWalletDetected: upsertDepositL1WalletContact,
      onSweptAddressFunded: async (sipa: Address) => {
        const since = Number(await wallet.node.getBlockNumber())
        if (!(await getBroadcastLedger().republish(sipa, since)))
          console.warn(
            `[sipaGateway] ${sipa} has no landed broadcast to repeat; stuck exits remain`,
          )
      },
      // Only this wallet's own broadcasts can be repeated; a resolver-published address cannot.
      onSweepOverdue: async (sipa: Address) =>
        getBroadcastLedger().republish(sipa, Number(await wallet.node.getBlockNumber())),
      // The account has no on-chain creation block, and no deposit to it predates the deployment.
      historyStartBlock: async (head: bigint) =>
        (await deploymentScanRange(this.publicClient, tuple, head)).fromBlock,
      fpcFundingCut: () =>
        fpcFundingCut(this.publicClient, requireTupleField(tuple, "portal") as Address),
    }
  }

  async sync(
    wallet: ObsidionWallet,
    tokenService: TokenService,
    opts: { onProgress?: (done: number, total: number) => void } = {},
  ): Promise<SipaDepositSyncResult | null> {
    this.bind(wallet)
    // Discovery needs no key, but the claim path derives the stealth key and
    // simulates from the account — both need an unlocked session.
    const keys = await this.unlockedKeys(wallet)
    if (!keys) return null
    const tuple = await getOxideTuple(this.config)

    await this.ensureDiscovery(wallet, tuple)

    const meta = await this.tokenMeta()
    const token = {
      address: requireTupleField(tuple, "token") as Address,
      symbol: meta.symbol,
      decimals: meta.decimals,
    }

    // A frozen portal's rollup never settles a sweep's message, so nothing is claimed or retried.
    const portalFrozen = await readPortalFrozen().catch(() => false)
    const result = await this.serial(() =>
      syncSipaDeposits({
        ...this.syncDeps(wallet, tuple, token, keys.msk, keys.account.getAddress()),
        tokenService,
        observeOnly: portalFrozen,
        refreshBalance: () => WalletSyncCoordinator.refreshBalance(),
        onProgress: opts.onProgress,
      }),
    )
    // This pass is what creates the records the funding hashes were waiting on.
    await drainFundingTxStash(this.store, this.pendingFundingTx)
    await this.markOwedFunded()

    // The sync loop is the pool's heartbeat: fills it before the first Receive of a session and
    // retries failed fills. No-ops while full, locked, or pre-claim (no handle yet). A fill is a
    // proof, so it waits for the boot balance.
    const tag = loadWalletIdentity()?.handle
    if (tag) {
      void bootPriority
        .whenReady("depositPool")
        .then(() =>
          this.refillPool(
            wallet,
            ContractService.getInstance(),
            tuple,
            this.addressCacheKey(tuple, tag),
          ),
        )
    }
    return result
  }

  resolverPayments(onFunded: () => void): ResolverPaymentWatcher {
    let cached: { at: number; deployments: Promise<ResolverDeployment[]> } | undefined
    const deployments = () => {
      if (!cached || Date.now() - cached.at > RESOLVER_DEPLOYMENTS_TTL_MS) {
        const pending = this.resolverDeployments()
        cached = { at: Date.now(), deployments: pending }
        pending.catch(() => {
          if (cached?.deployments === pending) cached = undefined
        })
      }
      return cached.deployments
    }
    return new ResolverPaymentWatcher({
      deployments,
      keys: async () => {
        const keys = await resolverPaymentKeys()
        return (
          keys && { stealthScalar: deriveStealthKey(keys.msk).scalar, recipient: keys.recipient }
        )
      },
      readHoldings: (holdings) => readSipaHoldingsAtHead(this.publicClient, holdings),
      store: this.store,
      l1ChainId: this.config.l1ChainId,
      onFunded,
    })
  }

  /**
   * The primary deployment with the tokens its SIPAs take. Only its portal: the sync pass claims
   * there alone, so a payment watched on another portal could never be claimed.
   */
  private async resolverDeployments(): Promise<ResolverDeployment[]> {
    const keys = await resolverPaymentKeys()
    if (!keys) throw new Error("locked")
    const tuple = await getOxideTuple(this.config)
    const meta = await this.tokenMeta()
    const sources: ResolverDeploymentSource[] = [
      {
        tuple,
        tokens: sipaFundingTokens(this.config.network, {
          address: requireTupleField(tuple, "token") as Address,
          symbol: meta.symbol,
          decimals: meta.decimals,
        }),
      },
    ]
    return readResolverDeployments({
      publicClient: this.publicClient,
      sources,
      recoveryAccount: predictAccountAddressLocally(
        requireTupleField(tuple, "accountFactory") as Address,
        deriveBootstrapKey(keys.msk).address,
      ),
      recipient: keys.recipient,
      stealthPublicKey: deriveStealthKey(keys.msk).publicKey,
    })
  }

  hydrate(): Promise<void> {
    return this.store.load()
  }

  records(): SIPADepositRecord[] {
    return this.store.list()
  }

  subscribe(listener: (records: SIPADepositRecord[]) => void): () => void {
    return this.store.onListChanged(listener)
  }
}

/**
 * The master secret and the entered account's L2 address, or null while locked. Read without the
 * PXE account, so polling never waits on or adds to PXE work.
 */
async function resolverPaymentKeys(): Promise<{ msk: Fr; recipient: AztecAddress } | null> {
  const msk = await getAuthService().getSecretKey()
  const address = loadWalletIdentity()?.address
  return msk && address ? { msk, recipient: AztecAddress.fromStringUnsafe(address) } : null
}

/** A mined-but-reverted transfer funded nothing; it must never be stamped as a deposit. */
async function confirmed(publicClient: PublicClient, hash: Hex): Promise<void> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== "success") throw new Error(`Funding transfer ${hash} reverted`)
}

type FundingTxStore = Pick<SIPADepositStore, "load" | "get" | "upsert">

/** What the self-initiated funding path knows about the transfer it just made. */
export type FundingStamp = Pick<
  SIPADepositRecord,
  "fundingTxHash" | "walletName" | "walletAddress"
> &
  Partial<Pick<SIPADepositRecord, "tokenSymbol">> & {
    fundingTxHash: Hex
  }

/**
 * Stamp the transfer onto the deposit it funded, carrying the record's own phase and reorg epoch so
 * the patch neither moves the record nor is fenced as a stale forward write. Keyed off the record's
 * own address so its stored casing survives. False when event discovery has not created it yet.
 */
async function patchFundingTx(
  store: FundingTxStore,
  sipa: Address,
  stamp: FundingStamp,
): Promise<boolean> {
  await store.load()
  const record = store.get(sipa)
  if (!record) return false
  // Upsert spreads the patch over the record, so an undefined field here would blank a stored one.
  const defined = Object.fromEntries(Object.entries(stamp).filter(([, v]) => v !== undefined))
  await store.upsert(record.sipaAddress, {
    ...defined,
    phase: record.phase,
    reorgEpoch: record.reorgEpoch,
  })
  return true
}

/**
 * Record the confirmed L1 transfer on the deposit it funded. Only the self-initiated path knows the
 * hash — a third-party sender's is invisible — and only the sync loop's event discovery may CREATE
 * a record, since the event fields recovery needs are not in hand here. The funding receipt usually
 * beats that discovery by several seconds, so an unmatched hash waits in `pending` for the next
 * sync to drain. The stash is in memory only: an app close before that tick costs a display row.
 *
 * Exported with `drainFundingTxStash` for the race test — the stamp and the record's creation are
 * concurrent, and losing to it is the common case, not the edge one.
 */
export async function stampFundingTx(
  store: FundingTxStore,
  pending: Map<string, FundingStamp>,
  sipa: Address,
  stamp: FundingStamp,
): Promise<void> {
  if (!(await patchFundingTx(store, sipa, stamp))) {
    pending.set(sipa.toLowerCase(), stamp)
  }
}

/** Land every stashed hash whose record now exists, leaving the rest for a later pass. */
export async function drainFundingTxStash(
  store: FundingTxStore,
  pending: Map<string, FundingStamp>,
): Promise<void> {
  for (const [sipa, stamp] of [...pending]) {
    if (await patchFundingTx(store, sipa as Address, stamp)) pending.delete(sipa)
  }
}
