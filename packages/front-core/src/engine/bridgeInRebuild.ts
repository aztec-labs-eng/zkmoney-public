import type { Address, Hex } from "viem"
import type {
  BridgeFill,
  BridgeInDepositLookup,
  BridgeInProviderId,
  BridgeInRecord,
} from "../core/services/crossChain/types"
import { bridgeInPaying, type BridgeIns } from "./bridgeIns"
import { mayBeBridgedIn } from "./depositFunding"
import type { OriginChain } from "./bridgeInTracker"
import type { Database } from "./database"
import { bestEffort, WalletError } from "./errors"
import { task, within, type Task } from "./runtime"
import type { SipaDeposit, SipaDeposits } from "./sipaDeposits"
import { derived } from "./store"
import { rescale } from "../utils/rescale"

/** Reads a deposit's funding transaction on L1. Throws when the read fails. */
export interface FillReader {
  /** The bridge fill in `txHash` that paid `recipient`; undefined when none did. */
  fill(txHash: Hex, recipient: Address): Promise<BridgeFill | undefined>
}

export interface BridgeInRebuildDeps {
  /** The account's database: a fill's bridge-in and its deposit's stamp commit together. */
  db: Pick<Database, "write">
  /** The deposits read, and where each one's `funding` is stamped. */
  deposits: Pick<SipaDeposits, "view" | "apply">
  bridgeIns: BridgeIns
  /** Undefined where the profile names no bridge whose fills can be read: nothing is stamped. */
  fills: FillReader | undefined
  /** Where `bridge` looks its deposits up; undefined where this build has none for it. */
  provider(bridge: BridgeInProviderId): BridgeInDepositLookup | undefined
  /** Reads a token on a chain the profile lists. */
  origin: Pick<OriginChain, "token">
  /** Whether the profile lists `chainId`: only then can its tokens be read. */
  listsChain(chainId: number): boolean
  /** The symbol the profile lists for `token` on a bridge chain. */
  listedSymbol(chainId: number, token: Address): string | undefined
  /** The decimals of `token` on L1, where the fill lands. Throws when the read fails. */
  landingDecimals(token: Address): Promise<number>
  now: () => number
}

/** How long past a fill's deadline, or its read where it has none, the bridge is still asked. */
export const FILL_LOOKUP_GRACE_MS = 60 * 60_000

/** How long a pass waits to ask again when all it has left is fills the bridge has not recorded. */
export const FILL_LOOKUP_WAIT_MS = 120_000

/** The most deposits one pass reads off the chain: the rest wait for the next pass. */
export const FUNDING_READS_PER_PASS = 10

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/**
 * The bridge-in `fill` finished, from the fill alone. The origin chain's RPC names the input token;
 * a chain the profile does not list has none to ask, so its bridge-in counts what landed.
 */
async function bridgeInOf(
  deposit: SipaDeposit,
  fill: BridgeFill,
  deps: BridgeInRebuildDeps,
): Promise<Omit<BridgeInRecord, "id">> {
  const { originChainId: chainId } = fill
  // The deposit's own decimals are the row token's once swept, not the fill's.
  const outputDecimals = await deps.landingDecimals(fill.token)
  const outputSymbol = deposit.fundingTokenSymbol ?? deposit.tokenSymbol
  const token = deps.listsChain(chainId)
    ? await deps.origin.token(chainId, fill.inputToken)
    : undefined
  const fee = token ? fill.inputAmount - rescale(fill.value, outputDecimals, token.decimals) : 0n
  return {
    originChainId: chainId,
    depositor: fill.depositor,
    recipient: deposit.sipaAddress,
    symbol: token ? deps.listedSymbol(chainId, fill.inputToken) ?? token.symbol : outputSymbol,
    inputAmount: (token ? fill.inputAmount : fill.value).toString(),
    outputAmount: fill.value.toString(),
    fee: (fee > 0n ? fee : 0n).toString(),
    inputDecimals: token?.decimals ?? outputDecimals,
    outputSymbol,
    outputDecimals,
    status: "filled",
    fillTxHash: deposit.fundingTxHash,
    startTime: deposit.startTime,
    endTime: deposit.startTime,
    replayed: true,
  }
}

/**
 * Reads whether a deposit's funding was a bridge fill and stamps the answer once. A fill's
 * bridge-in is rebuilt from the fill in the stamp's write, so a stamped fill always has one. The bridge
 * is then asked for the fill's origin call: `waiting` while it has not recorded the fill, and a
 * record that disagrees with the fill ends the asking. Nothing is saved while a read fails.
 */
export async function readFunding(
  deposit: SipaDeposit,
  deps: BridgeInRebuildDeps,
): Promise<"waiting" | undefined> {
  const { sipaAddress: address, fundingTxHash: hash } = deposit
  if (!deps.fills || !hash || deposit.funding === "plain") return undefined
  const fill = await deps.fills.fill(hash, address)
  const provider = fill && deps.provider(fill.provider)
  if (!deposit.funding) {
    if (!fill) {
      await deps.deposits.apply(address, { type: "fundingRead", funding: "plain" })
      return undefined
    }
    const rebuilt = await bridgeInOf(deposit, fill, deps)
    const lookupUntil = provider && (fill.deadline ?? deps.now()) + FILL_LOOKUP_GRACE_MS
    // The store's open is a write of its own: it lands before this one starts.
    await deps.bridgeIns.ready
    await deps.db.write(async (w) => {
      await deps.bridgeIns.rebuild(rebuilt, w)
      const stamp = { type: "fundingRead", funding: "bridge" } as const
      await deps.deposits.apply(address, { ...stamp, ...(lookupUntil && { lookupUntil }) }, w)
    })
  }
  const rebuilt = bridgeInPaying(await deps.bridgeIns.all(), address)
  const asks = fill && provider && rebuilt && !rebuilt.originTxHash
  const found = asks ? await provider.statusById(fill.originChainId, fill.depositId) : undefined
  if (asks && (!found || found.status.status === "pending")) return "waiting"
  const origin =
    found?.status.status === "filled" && same(found.status.fillTxHash, hash)
      ? found.originTxHash
      : undefined
  await deps.db.write(async (w) => {
    if (rebuilt && origin)
      await deps.bridgeIns.apply(rebuilt.id, [{ type: "originRead", originTxHash: origin }], w)
    await deps.deposits.apply(address, { type: "fundingLookupEnded" }, w)
  })
  return undefined
}

/** The bridge-in this device holds whose fill funded `deposit`. */
function filledBy(bridged: readonly BridgeInRecord[], deposit: SipaDeposit) {
  const record = bridgeInPaying(bridged, deposit.sipaAddress)
  const { fundingTxHash: hash } = deposit
  return record?.fillTxHash && hash && same(record.fillTxHash, hash) ? record : undefined
}

/**
 * Deposits whose funding is unread, or a fill whose origin call the bridge may still name. An unread
 * one a bridge-in pays waits for that bridge-in's fill, and needs no read. With no fills to read,
 * only those are due.
 */
function dueDeposits(
  deposits: readonly SipaDeposit[],
  bridged: readonly BridgeInRecord[],
  readsFills: boolean,
): SipaDeposit[] {
  return deposits.filter((d) => {
    if (!mayBeBridgedIn(d) || !d.fundingTxHash || d.funding === "plain") return false
    if (d.fundingLookupUntil !== undefined) return readsFills
    if (d.funding) return false
    return bridgeInPaying(bridged, d.sipaAddress) ? !!filledBy(bridged, d) : readsFills
  })
}

/**
 * Every 30 s while some deposit is due, reads up to {@link FUNDING_READS_PER_PASS} of them, one at
 * a time: a public RPC rate-limits a burst of receipt reads. Those not read yet go first, newest
 * first, then the longest unread, so one that keeps failing or waiting holds no other back. A pass
 * where every read failed backs off; one left only waiting on a bridge runs again after
 * {@link FILL_LOOKUP_WAIT_MS}. A lookup past its deadline ends unasked.
 */
export function bridgeInRebuild(deps: BridgeInRebuildDeps): Task {
  /** The turn each deposit address was last read on. */
  const readOn = new Map<string, number>()
  let turn = 0
  const lastRead = (d: SipaDeposit) => readOn.get(d.sipaAddress) ?? 0
  const due = derived(
    [deps.deposits.view, deps.bridgeIns.list],
    (deposits, bridged) =>
      deposits.loaded &&
      bridged.hydrated &&
      dueDeposits(deposits.records, bridged.records, !!deps.fills).length > 0,
  )
  return task("bridgeInRebuild", {
    needs: {},
    when: due,
    every: 30_000,
    backoff: { baseMs: 30_000, maxMs: 600_000 },
    async run({ signal }) {
      const { records, loaded } = deps.deposits.view.get()
      if (!loaded) return
      const bridged = await within(deps.bridgeIns.all(), "bridge-ins", { signal })
      const pending = dueDeposits(records, bridged, !!deps.fills).sort(
        (a, b) => lastRead(a) - lastRead(b) || b.startTime - a.startTime,
      )
      let answered = 0
      let waiting = 0
      let reads = 0
      for (const deposit of pending) {
        if (signal.aborted) return
        const { sipaAddress: address } = deposit
        const expired = (deposit.fundingLookupUntil ?? Infinity) <= deps.now()
        const stamped = !deposit.funding && filledBy(bridged, deposit)
        // A stamp off a record this device holds reads nothing, so it is never held back.
        const reading = !stamped && !expired
        if (reading && reads++ >= FUNDING_READS_PER_PASS) continue
        if (reading) readOn.set(address, ++turn)
        const work: Promise<unknown> = stamped
          ? deps.deposits.apply(address, { type: "fundingRead", funding: "bridge" })
          : expired
          ? deps.deposits.apply(address, { type: "fundingLookupEnded" })
          : readFunding(deposit, deps)
        const outcome = await bestEffort(
          "unknown",
          within(work, "bridge-in rebuild", { signal }).then((result) => ({ result })),
        )
        if (outcome?.result === "waiting") waiting++
        else if (outcome) answered++
      }
      if (answered || !pending.length) return undefined
      if (waiting) return { nextMs: FILL_LOOKUP_WAIT_MS }
      throw new WalletError("unknown", "every bridge-in rebuild read failed")
    },
  })
}
