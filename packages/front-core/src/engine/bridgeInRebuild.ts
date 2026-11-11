import type { Address, Hex } from "viem"
import type { AcrossFill } from "../core/services/crossChain/acrossFill"
import type { BridgeInDepositLookup, BridgeInRecord } from "../core/services/crossChain/types"
import { bridgeInPaying, mayBeBridgedIn, type BridgeIns } from "./bridgeIns"
import type { OriginChain } from "./bridgeInTracker"
import { bestEffort, WalletError } from "./errors"
import { task, within, type Task } from "./runtime"
import type { SipaDeposit, SipaDeposits } from "./sipaDeposits"
import { derived } from "./store"

/** Reads a deposit's funding transaction on L1. Throws when the read fails. */
export interface FillReader {
  /** The bridge fill in `txHash` that paid `recipient`; undefined when none did. */
  fill(txHash: Hex, recipient: Address): Promise<AcrossFill | undefined>
}

export interface BridgeInRebuildDeps {
  /** The deposits read, and where each one's `funding` is stamped. */
  deposits: Pick<SipaDeposits, "view" | "apply">
  bridgeIns: BridgeIns
  fills: FillReader
  /** The profile's bridge provider; undefined where this build has none. */
  provider(): BridgeInDepositLookup | undefined
  /** Reads a token the provider does not list. */
  origin: Pick<OriginChain, "token">
  /** The symbol the profile lists for `token` on a bridge chain. */
  listedSymbol(chainId: number, token: Address): string | undefined
  /** The decimals of `token` on L1, where the fill lands. Throws when the read fails. */
  landingDecimals(token: Address): Promise<number>
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** `amount` at `from` decimals, at `to` decimals. */
function rescale(amount: bigint, from: number, to: number): bigint {
  return to >= from ? amount * 10n ** BigInt(to - from) : amount / 10n ** BigInt(from - to)
}

/**
 * Reads whether a replayed deposit's funding was a bridge fill, stamps the answer once, and
 * rebuilds the bridge-in a fill finished from the fill and the provider's record. It reads the
 * origin chain only for a token the provider does not list, so the record starts and ends at the
 * fill's time. Nothing is saved while a read fails.
 */
export async function rebuildBridgeIn(
  deposit: SipaDeposit,
  deps: BridgeInRebuildDeps,
): Promise<BridgeInRecord | undefined> {
  const { sipaAddress: address, fundingTxHash: hash } = deposit
  if (!hash || deposit.funding === "transfer") return undefined
  const fill = await deps.fills.fill(hash, address)
  if (!deposit.funding)
    await deps.deposits.apply(address, {
      type: "fundingRead",
      funding: fill ? "bridge" : "transfer",
    })
  if (!fill) return undefined
  const { originChainId: chainId, depositId } = fill
  const provider = deps.provider()
  if (!provider) return undefined
  const found = await provider.statusById(chainId, depositId)
  if (found?.status.status !== "filled" || !same(found.status.fillTxHash, hash)) return undefined
  // The origin chain's RPC names the input token; the provider's listing is never trusted for it.
  const token = await deps.origin.token(chainId, fill.inputToken)
  // The deposit's own decimals are the row token's once swept, not the fill's.
  const outputDecimals = await deps.landingDecimals(fill.token)
  const fee = fill.inputAmount - rescale(fill.value, outputDecimals, token.decimals)
  return deps.bridgeIns.rebuild({
    originTxHash: found.originTxHash,
    originChainId: chainId,
    depositor: fill.depositor,
    recipient: address,
    symbol: deps.listedSymbol(chainId, fill.inputToken) ?? token.symbol,
    inputAmount: fill.inputAmount.toString(),
    outputAmount: fill.value.toString(),
    fee: (fee > 0n ? fee : 0n).toString(),
    inputDecimals: token.decimals,
    outputSymbol: deposit.fundingTokenSymbol ?? deposit.tokenSymbol,
    outputDecimals,
    status: "filled",
    fillTxHash: hash,
    startTime: deposit.startTime,
    endTime: deposit.startTime,
    replayed: true,
  })
}

/** Replayed deposits whose funding is unread, or a bridge fill whose bridge-in is not rebuilt. */
function dueDeposits(
  deposits: readonly SipaDeposit[],
  bridged: readonly BridgeInRecord[],
  provider: BridgeInDepositLookup | undefined,
): SipaDeposit[] {
  return deposits.filter(
    (d) =>
      mayBeBridgedIn(d) &&
      d.fundingTxHash &&
      (d.funding === undefined || (d.funding === "bridge" && provider !== undefined)) &&
      !bridgeInPaying(bridged, d.sipaAddress),
  )
}

/**
 * Every 30 s while some deposit is due, reads each one, one at a time: a public RPC rate-limits a
 * burst of receipt reads. A pass where every lookup failed backs off.
 */
export function bridgeInRebuild(deps: BridgeInRebuildDeps): Task {
  const due = derived(
    [deps.deposits.view, deps.bridgeIns.list],
    (deposits, bridged) =>
      deposits.loaded &&
      bridged.hydrated &&
      dueDeposits(deposits.records, bridged.records, deps.provider()).length > 0,
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
      const pending = dueDeposits(records, bridged, deps.provider())
      let read = 0
      for (const deposit of pending) {
        if (signal.aborted) return
        const done = await bestEffort(
          "unknown",
          within(rebuildBridgeIn(deposit, deps), "bridge-in rebuild", { signal }).then(() => true),
        )
        if (done) read++
      }
      if (pending.length && !read)
        throw new WalletError("unknown", "every bridge-in rebuild lookup failed")
    },
  })
}
