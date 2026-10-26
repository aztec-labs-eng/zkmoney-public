/**
 * Withdraw in place of the upgrade: refund everything a frozen old version holds for the account to
 * the user's own L1 address. The user's L1 wallet submits each refund and pays its gas, so no relayer
 * and no sponsorship on this version is needed.
 */
import { useSyncExternalStore } from "react"
import { erc20Abi, type Address } from "viem"
import { bridgeUnderlying } from "@obsidion/core/oxide"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { FrozenMetadataMigrationSource } from "@obsidion/sdk"
import { getConfig } from "../../config/env"
import { l1PublicClient } from "../../config/oxideTuple"
import { createExternalState } from "../../lib/externalState"
import { getActiveStorageId } from "../../platform/storage/activeStorage"
import type { FrozenExitRuntime } from "../withdraw/frozenExitRun"
import type { createWebMetadataMigration } from "./createWebMetadataMigration"

/** A frozen old version with refundable funds. */
export interface WithdrawableSource {
  source: OxideEnvTuple
  /** A Savings source, which refunds sUSDS shares. */
  savings: boolean
  /** The source's migration session, which holds its refund runtime. */
  open(tipRecipient?: Address): ReturnType<typeof createWebMetadataMigration>
  /** This version's registration run, which claims the account's name here. */
  registration(): ReturnType<typeof createWebMetadataMigration>
}

const withdrawable = createExternalState<readonly WithdrawableSource[]>([])
let published: readonly WithdrawableSource[] = []
// Each account's portals whose funds no refund batch can take, such as a note above the portal's cap.
const unrefundable = new Set<string>()
const skipKey = (portal: string) => `${getActiveStorageId()}:${portal.toLowerCase()}`

/** Published by the migration check: frozen old versions with funds and no upgrade run. */
export function setWithdrawableSources(next: readonly WithdrawableSource[]): void {
  published = next
  const now = withdrawable.get()
  const shown = next.filter((s) => !unrefundable.has(skipKey(s.source.portal)))
  const key = (list: readonly WithdrawableSource[]) =>
    list.map((s) => s.source.portal.toLowerCase()).join(",")
  if (key(now) !== key(shown)) withdrawable.set(shown)
}

/** No batch refunds `source` now, so Withdraw stops offering it until the page reloads. */
export function skipUnrefundableSource(source: OxideEnvTuple): void {
  unrefundable.add(skipKey(source.portal))
  setWithdrawableSources(published)
}

/** The published source for `portal`, including one Withdraw stopped offering. */
export function withdrawableSourceFor(portal: string): WithdrawableSource | undefined {
  return published.find((s) => s.source.portal.toLowerCase() === portal.toLowerCase())
}

export function useWithdrawableSources(): readonly WithdrawableSource[] {
  return useSyncExternalStore(withdrawable.subscribe, withdrawable.get)
}

const withdrawals = createExternalState(0)

/** A withdrawal ended: the migration check reads the old versions again. */
export function noteOldVersionWithdrawn(): void {
  withdrawals.set(withdrawals.get() + 1)
}

/** Changes after each withdrawal. */
export function useOldVersionWithdrawals(): number {
  return useSyncExternalStore(withdrawals.subscribe, withdrawals.get)
}

export interface OldVersionExit {
  runtime: FrozenExitRuntime
  /** The upgrade run's lock, so a withdrawal never refunds the funds a run plans. */
  lock: <T>(fn: () => Promise<T>) => Promise<T>
  /** The L1 token the source portal refunds. */
  symbol: string
  decimals: number
}

/** A source's refund runtime. Without `recipient`, which submits each refund, it only reads. */
export async function openOldVersionExit(
  { source, open }: WithdrawableSource,
  recipient?: Address,
): Promise<OldVersionExit> {
  const client = l1PublicClient(getConfig())
  const token = bridgeUnderlying(source) as Address
  const [session, symbol, decimals] = await Promise.all([
    open(recipient),
    client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
  ])
  if (!(session.source instanceof FrozenMetadataMigrationSource))
    throw new Error("This version's funds can't be withdrawn yet")
  return { runtime: session.source.runtime, lock: session.lock, symbol, decimals }
}
