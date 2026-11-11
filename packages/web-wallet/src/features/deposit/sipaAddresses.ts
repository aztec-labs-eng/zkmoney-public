/**
 * The account's own deposit addresses: the one writer of `derived` and `shown`. Each view hands out
 * an address nobody was shown, so senders paying this wallet cannot be linked to each other by a
 * shared address: a pooled one broadcast in the background, else a pool fill still proving, else a
 * fresh derivation. `SipaSelfResolver` derives the address from a key only this wallet holds, and
 * the address, its slot and its owed broadcast save in one write before it is handed out; the
 * broadcasts task then proves the broadcast that tells the relayer it exists.
 */
import { Fr } from "@aztec-labs/aztec.js/fields"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { getAddress, type Address } from "viem"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  chainEpochDay,
  deriveSelfSipaSecret,
  epochDay,
  readDepositSIPAImplementation,
  fetchSipaEvents,
  selfSipaNonce,
  SipaSelfResolver,
  type ObsidionWallet,
} from "@obsidion/sdk"
import {
  broadcastJob,
  broadcastJobs,
  deriveSelfSipaKey,
  findOwnSlot,
  loadRecords,
  RESOLVER_LOOKBACK_DAYS,
  SELF_SLOTS,
  selfDeployment,
  selfSipaResolverKeys,
  task,
  WalletError,
  watchJob,
  type After,
  type IdentityView,
  type ReadonlyStore,
  type SipaDeposit,
  type SipaDepositFields,
  type SipaDeposits,
  type Task,
  type Service,
} from "@obsidion/front-core"
import { l1PublicClient, requireTupleField } from "../../config/oxideTuple"
import type { PageFacts } from "../../session/pageChain"
import { RegistrationPendingError } from "../registration/registrationRail"
import { railPendingOf, type RailQuery } from "../registration/sponsoredRailReadiness"
import { AddressesPublishingError, addressesPublishing } from "./addressesPublishing"
import { pinnedToken, windowKeys, type SipaDiscovery, type SipaKeys } from "./sipaRail"
import type { DepositAddress } from "../sipa/depositTarget"

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

/** A pool fill is a proof: it waits for the history read to head. */
const POOL_AFTER: After = {
  firstBalance: true,
  depositsReplayed: true,
  movesReplayed: true,
  historyAtHead: true,
}

/**
 * The rollup and portal a pooled address was broadcast on. Only that deployment's relayer learns of
 * the address, so a pooled address or fill is served only while its deployment is pinned.
 */
export function sipaPoolDeployment(tuple: OxideEnvTuple): string {
  return `${tuple.rollupVersion}:${requireTupleField(tuple, "portal").toLowerCase()}`
}

/**
 * Whether `record` is in `account`'s pool for `tuple`: broadcast ahead of need on its deployment,
 * under its forwarding table, shown to nobody, and derived after `oldestDay`.
 */
export function inSipaPool(
  record: SipaDeposit,
  account: string,
  tuple: OxideEnvTuple,
  oldestDay: number,
): boolean {
  const table = record.origin?.protocol === "account" ? record.origin.forwardingTable : undefined
  return (
    record.broadcast?.kind === "pool" &&
    record.slot?.deployment === sipaPoolDeployment(tuple) &&
    record.slot.day > oldestDay &&
    record.recipientL2Address.toLowerCase() === account.toLowerCase() &&
    (!table || table.toLowerCase() === tuple.forwardingTable?.toLowerCase())
  )
}

/**
 * The next slot of `day` for `user`: past `floor`, what the chain shows broadcast, and past every
 * slot this device recorded, so a slot is never handed out twice.
 */
export function nextSipaSlot(
  records: readonly SipaDeposit[],
  user: string,
  day: number,
  floor: number,
): number {
  const top = selfSipaNonce(0)
  return records.reduce(
    (next, r) =>
      r.slot?.day === day && r.recipientL2Address.toLowerCase() === user.toLowerCase()
        ? Math.max(next, top - r.slot.nonce + 1)
        : next,
    floor,
  )
}

/** `account`'s slots from the self window's days that owe a broadcast not yet landed. */
export function unpublishedSlots(records: readonly SipaDeposit[], account: string, now: number) {
  const oldestDay = now / DAY_MS - RESOLVER_LOOKBACK_DAYS
  return records.filter(
    (r) =>
      r.slot &&
      r.slot.day > oldestDay &&
      r.broadcast &&
      r.broadcast.state !== "landed" &&
      r.recipientL2Address.toLowerCase() === account.toLowerCase(),
  ).length
}

/** How many of today's slots are already broadcast: slot k is used when its salt is among `salts`. */
export function slotFloor(salts: ReadonlySet<string>, selfSipaKey: Fr, day: number): number {
  let used = 0
  while (salts.has(deriveSelfSipaSecret(selfSipaKey, day, selfSipaNonce(used)).toString())) used++
  return used
}

/**
 * Everything the address depends on: the salt hashed from this wallet's self-SIPA key, and the
 * Registry's CREATE2 prediction over the resulting recipient hash. Deterministic in `(day, nonce)`,
 * so the broadcast re-derives it rather than threading state through.
 */
export async function deriveSipa(
  page: PageFacts,
  wallet: ObsidionWallet,
  tuple: OxideEnvTuple,
  keys: SipaKeys,
  day: number,
  nonce: number,
) {
  const { config } = page
  const selfResolver = new SipaSelfResolver(selfSipaResolverKeys(keys.msk))
  const user = keys.recipient
  const sipaFactory = requireTupleField(tuple, "sipaFactory") as Address
  const {
    sipaAddress: address,
    sipaArgs,
    intent,
    resolution,
  } = await selfResolver.resolveAddress({
    protocol: tuple.sipaRecoveryProtocol ?? "legacy-eoa",
    user,
    recoveryAccount: keys.recoveryAccount,
    day,
    nonce,
    publicClient: l1PublicClient(config),
    sipaFactory,
    forwardingTable: requireTupleField(tuple, "forwardingTable") as Address,
    rollupVersion: BigInt(requireTupleField(tuple, "rollupVersion")),
  })
  const meta = await pinnedToken(page, tuple)
  const fields: SipaDepositFields = {
    sipaAddress: address,
    phase: "resolved",
    origin:
      "recoveryAddress" in sipaArgs
        ? {
            protocol: "legacy-eoa",
            sipaFactory,
            ...sipaArgs,
            rollupVersion: sipaArgs.rollupVersion.toString(),
          }
        : {
            protocol: "account",
            sipaFactory,
            ...sipaArgs,
            rollupVersion: sipaArgs.rollupVersion.toString(),
            recoveryAccount: resolution.recoveryAccount.toString() as Address,
            accountFactory: requireTupleField(tuple, "accountFactory") as Address,
          },
    recipientL2Address: user.toString(),
    messageSecret: resolution.messageSecret.toString(),
    recipientHash: resolution.recipientHash.toString(),
    recoveryAddress: "",
    l1ChainId: config.l1ChainId,
    networkId: wallet.networkId,
    tokenAddress: meta.address,
    amount: "0",
    tokenSymbol: meta.symbol,
    startTime: Date.now(),
  }
  return { address, fields, resolution, user, intent, sipaArgs }
}

export interface SipaAddressesDeps {
  page: PageFacts
  store: SipaDeposits
  wallet: Service<ObsidionWallet>
  keys: Service<SipaKeys>
  discovery: () => Service<SipaDiscovery>
  /** Whose pooled addresses a hand-out takes. */
  identity: ReadonlyStore<IdentityView>
  /** Why the account cannot ride the sponsored rail yet. */
  railPending: RailQuery
  /** Runs the broadcasts task now: something it owes changed. */
  wakeBroadcasts(): void
  wake(task: Task): Promise<void>
}

/** The account's deposit addresses, and the task that keeps the pool full. */
export function createSipaAddresses(deps: SipaAddressesDeps) {
  const { store } = deps
  /** Derivations run one at a time: each reads the slots the one before it saved. */
  let deriving: Promise<unknown> = Promise.resolve()
  /** The youngest pool a hand-out asked for since the last fill: older entries do not count. */
  let wanted: number | undefined

  /**
   * The records alone would let a fresh device re-derive a slot another device already broadcast
   * today, so the floor is read off the chain, from the salts this wallet's own `SIPA` events carry.
   * A slot shown elsewhere and never broadcast is invisible here, so this device derives and
   * broadcasts the same address. From the next day nothing derives it: the scan's self window finds
   * its funds for {@link RESOLVER_LOOKBACK_DAYS} chain days, and Settings recovery after that.
   */
  const eventSalts = async (wallet: ObsidionWallet, tuple: OxideEnvTuple, keys: SipaKeys) => {
    await deps.discovery().ready()
    const events = await fetchSipaEvents(
      wallet,
      AztecAddress.fromStringUnsafe(requireTupleField(tuple, "l2Token")),
      keys.recipient,
    )
    return new Set(events.map((event) => event.sharedSecretSalt.toString()))
  }
  const nextNonce = async (
    wallet: ObsidionWallet,
    tuple: OxideEnvTuple,
    keys: SipaKeys,
    day: number,
  ) => {
    const salts = await eventSalts(wallet, tuple, keys)
    const used = slotFloor(salts, deriveSelfSipaKey(keys.msk), day)
    console.debug(`[sipaAddresses] slot floor ${used} from ${salts.size} events`)
    const records = await loadRecords(store.view)
    return selfSipaNonce(nextSipaSlot(records, keys.recipient.toString(), day, used))
  }

  /**
   * Derives the account's next address and saves it with its slot and its owed broadcast, in one
   * write: from then on it is never handed out again, and its broadcast lands whatever the page does.
   * A new slot is refused while `SELF_SLOTS.lookahead` are unpublished; a `shown` one never is.
   */
  const deriveSlot = (
    wallet: ObsidionWallet,
    tuple: OxideEnvTuple,
    keys: SipaKeys,
    owed: { kind: "deposit"; shownAt: number } | { kind: "pool"; deployment: string },
    shown?: { day: number; nonce: number },
  ): Promise<Address> => {
    const run = deriving.then(async () => {
      const records = await loadRecords(store.view)
      const unpublished = unpublishedSlots(records, keys.recipient.toString(), Date.now())
      if (!shown && unpublished >= SELF_SLOTS.lookahead) throw new AddressesPublishingError()
      const day = shown?.day ?? (await chainEpochDay(wallet))
      const nonce = shown?.nonce ?? (await nextNonce(wallet, tuple, keys, day))
      const { address, fields } = await deriveSipa(deps.page, wallet, tuple, keys, day, nonce)
      const slot = { day, nonce, ...(owed.kind === "pool" ? { deployment: owed.deployment } : {}) }
      const owes = owed.kind === "pool" ? { kind: owed.kind } : owed
      await store.applyAll([
        [address, { type: "derived", fields: { ...fields, slot } }],
        [
          address,
          {
            type: "broadcastOwed",
            address,
            owed: { ...owes, source: { type: "slot" } },
            at: Date.now(),
          },
        ],
      ])
      deps.wakeBroadcasts()
      return getAddress(address)
    })
    // The next derivation waits for this one to settle; its caller gets the outcome.
    deriving = Promise.allSettled([run])
    return run
  }

  /**
   * Hands out the account's oldest pooled address, landed ones first, else a fill still proving when
   * `filling`: one write takes it out of the pool and makes its broadcast the user's.
   */
  const handOutPooled = async (
    account: string,
    tuple: OxideEnvTuple,
    maxAgeMs: number,
    filling: boolean,
  ) => {
    const oldestDay = (Date.now() - maxAgeMs) / DAY_MS
    const proving = (r: SipaDeposit) => (r.broadcast?.state === "landed" ? 0 : 1)
    const pool = (await loadRecords(store.view))
      .filter((r) => inSipaPool(r, account, tuple, oldestDay) && (filling || !proving(r)))
      .sort((a, b) => proving(a) - proving(b) || a.broadcast!.createdAt - b.broadcast!.createdAt)
    return store.handOut(
      pool.map((r) => r.sipaAddress),
      Date.now(),
    )
  }

  /**
   * Keeps SIPA_POOL_TARGET broadcast addresses ready so a Receive or paylink hands one out without
   * proving. A fill only derives and owes: the broadcasts task proves it, after anything the user is
   * waiting on, and the landed broadcast is the pool's.
   */
  const refillPool = async (
    wallet: ObsidionWallet,
    keys: SipaKeys,
    maxAgeMs: number = SIPA_POOL_MAX_AGE_MS,
  ) => {
    const tuple = await deps.page.chain.oxideTuple.read()
    const oldestDay = (Date.now() - maxAgeMs) / DAY_MS
    const account = keys.recipient.toString()
    const pooled = (await loadRecords(store.view)).filter((r) =>
      inSipaPool(r, account, tuple, oldestDay),
    ).length
    if (pooled >= SIPA_POOL_TARGET) return
    await deriveSlot(wallet, tuple, keys, { kind: "pool", deployment: sipaPoolDeployment(tuple) })
  }

  /**
   * Settles once the address's broadcast landed. Rejects with the registration's wait while no rail
   * can pay for it, and with the attempt's error once one fails.
   */
  const publish = (address: Address, onStage?: (stage: DepositStage) => void) => async () => {
    if (broadcastJob(store.view.get().records, address)?.state === "landed") return
    onStage?.("broadcasting")
    let failures: number | undefined
    const failed = await watchJob(store.view, address, (job): Error | null | undefined => {
      failures ??= job?.failures ?? 0
      if (!job) return new WalletError("deposit.addressUnpublished")
      if (job.state === "landed") return null
      if (job.state !== "queued") return undefined
      if (job.wait === "registration")
        return new RegistrationPendingError(
          railPendingOf(deps.railPending.get()) || { pending: "message" },
        )
      if (job.failures > failures)
        return new WalletError(job.failure?.code ?? "deposit.broadcastFailed")
      return undefined
    })
    if (failed) throw failed
  }

  const pool: Task = task("sipaPool", {
    needs: { wallet: deps.wallet, keys: deps.keys },
    after: POOL_AFTER,
    every: 12_000,
    backoff: { baseMs: 300_000, maxMs: 300_000 },
    async run({ wallet, keys }) {
      const maxAgeMs = wanted
      wanted = undefined
      await refillPool(wallet, keys, maxAgeMs)
    },
  })

  return {
    pool,
    /**
     * A single-use deposit address for this wallet, never one shown before. A fresh derivation
     * waits for the unlocked account's keys, until `signal` aborts, and owes the broadcasts task a
     * proof. `publishingLimit` refuses a fresh derivation with `AddressesPublishingError`.
     */
    async depositAddress(
      tag: string,
      opts?: {
        onStage?: (stage: DepositStage) => void
        publishingLimit?: number
        signal?: AbortSignal
      },
    ): Promise<DepositAddress> {
      const tuple = await deps.page.chain.oxideTuple.read()
      const name = tuple.ensDomain ? `${tag}.${tuple.ensDomain}` : tag
      const account = deps.identity.get().value?.address
      const pooled = account && (await handOutPooled(account, tuple, SIPA_POOL_MAX_AGE_MS, true))
      if (pooled) {
        void deps.wake(pool)
        const address = getAddress(pooled.sipaAddress)
        return pooled.broadcast?.state === "landed"
          ? { address, name, source: "pool" }
          : { address, name, publish: publish(address, opts?.onStage), source: "filling" }
      }
      if (
        opts?.publishingLimit !== undefined &&
        addressesPublishing(broadcastJobs(store.view.get().records)) >= opts.publishingLimit
      )
        throw new AddressesPublishingError()
      const [wallet, keys] = await Promise.all([
        deps.wallet.ready(opts?.signal),
        deps.keys.ready(opts?.signal),
      ])
      opts?.onStage?.("resolving")
      // The address is fully determined by the derivation — the proof and broadcast only tell the
      // relayer it exists — so it is handed back now and its broadcast lands behind it.
      const address = await deriveSlot(wallet, tuple, keys, {
        kind: "deposit",
        shownAt: Date.now(),
      })
      return { address, name, publish: publish(address, opts?.onStage), source: "derived" }
    },
    /**
     * Records `sipa` with its slot and owed broadcast when it is one of this account's own addresses,
     * searched offline from the deployment's first day: Settings recovery's search. False when not.
     */
    async recordShown(sipa: Address): Promise<boolean> {
      const [wallet, keys] = await Promise.all([deps.wallet.ready(), deps.keys.ready()])
      const tuple = await deps.page.chain.oxideTuple.read()
      const factory = requireTupleField(tuple, "sipaFactory") as Address
      const implementation = await readDepositSIPAImplementation(
        l1PublicClient(deps.page.config),
        factory,
      )
      const deployment = selfDeployment(tuple, implementation, keys.recoveryAccount, [])
      if (!deployment) return false
      const [records, salts] = await Promise.all([
        loadRecords(store.view),
        eventSalts(wallet, tuple, keys),
      ])
      const firstDay = epochDay(Math.floor(Date.parse(tuple.deployedAt) / 1000))
      const found = await findOwnSlot(
        windowKeys(keys),
        deployment,
        sipa,
        records,
        salts,
        firstDay,
        await chainEpochDay(wallet),
      )
      if (!found) return false
      await deriveSlot(wallet, tuple, keys, { kind: "deposit", shownAt: Date.now() }, found)
      return true
    },
    /**
     * A pooled address published within `maxAgeMs`, handed out as `depositAddress` hands out a
     * pooled one, else null. Never derives, so never asks for the passkey.
     */
    async readyAddress(maxAgeMs: number): Promise<{ address: Address; day: number } | null> {
      const account = deps.identity.get().value?.address
      if (!account) return null
      const tuple = await deps.page.chain.oxideTuple.read()
      const pooled = await handOutPooled(account, tuple, maxAgeMs, false)
      wanted = Math.min(wanted ?? maxAgeMs, maxAgeMs)
      void deps.wake(pool)
      return pooled?.slot ? { address: getAddress(pooled.sipaAddress), day: pooled.slot.day } : null
    },
  }
}

export type SipaAddresses = ReturnType<typeof createSipaAddresses>
