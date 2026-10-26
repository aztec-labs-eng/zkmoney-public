import { useEffect, useState } from "react"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  assertExecutorServesPortal,
  readExecutorSubsidy,
  readWithdrawalExecutor,
  type WithdrawalExecutor,
  type WithdrawalExecutorKind,
} from "@obsidion/sdk"
import { readSkyFactoryPortals, type SkyFactoryPortals } from "@obsidion/front-core"
import { getAddress, type Address } from "viem"
import { getConfig } from "../../config/env"
import { getOxideTuple, l1PublicClient, requireTupleField } from "../../config/oxideTuple"

const executors = new Map<string, Promise<WithdrawalExecutor>>()
const subsidies = new Map<string, Promise<Address>>()
const factoryPortals = new Map<string, Promise<SkyFactoryPortals>>()

/** One read per key for the session; a failed read is dropped. */
function readOnce<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  read: () => Promise<T>,
): Promise<T> {
  let value = cache.get(key)
  if (!value) {
    value = read()
    value.catch(() => cache.delete(key))
    cache.set(key, value)
  }
  return value
}

/** The terms of the withdrawal executor at `address`. Immutables, so one read serves the session. */
export function withdrawalExecutorAt(
  address: Address,
  kind: WithdrawalExecutorKind = "plain",
): Promise<WithdrawalExecutor> {
  return readOnce(executors, `${kind}:${getAddress(address)}`, () =>
    readWithdrawalExecutor(l1PublicClient(getConfig()), address, kind),
  )
}

/** The withdrawal subsidy the executor at `address` created; an immutable, read once per session. */
export function executorSubsidyAt(address: Address): Promise<Address> {
  return readOnce(subsidies, getAddress(address), () =>
    readExecutorSubsidy(l1PublicClient(getConfig()), address),
  )
}

/** The portals a Sky escrow factory's escrows deposit into; immutables, read once per session. */
export function skyFactoryPortalsAt(factory: Address): Promise<SkyFactoryPortals> {
  return readOnce(factoryPortals, getAddress(factory), () =>
    readSkyFactoryPortals(l1PublicClient(getConfig()), factory),
  )
}

/** The executor a deployment's burns pay, checked to serve the deployment's portal. */
export async function withdrawalExecutor(
  tuple: OxideEnvTuple,
  kind: WithdrawalExecutorKind = "plain",
): Promise<WithdrawalExecutor> {
  const executor = await withdrawalExecutorAt(
    requireTupleField(tuple, "plainWithdrawalExecutor") as Address,
    kind,
  )
  assertExecutorServesPortal(executor, requireTupleField(tuple, "portal") as Address)
  return executor
}

/** The `FEE()` a deployment's plain withdrawal executor takes from each withdrawal. */
export async function withdrawalExecutorFee(tuple: OxideEnvTuple): Promise<bigint> {
  return (await withdrawalExecutor(tuple)).fee
}

/** The active deployment's executor. */
export async function activeWithdrawalExecutor(): Promise<WithdrawalExecutor> {
  return withdrawalExecutor(await getOxideTuple(getConfig()))
}

/** The active deployment's executor fee. */
export async function activeWithdrawalFee(): Promise<bigint> {
  return (await activeWithdrawalExecutor()).fee
}

/** {@link activeWithdrawalFee} for a render; undefined until it lands, or while `enabled` is false. */
export function useActiveWithdrawalFee(enabled = true): bigint | undefined {
  const [fee, setFee] = useState<bigint>()
  useEffect(() => {
    if (!enabled) return
    let live = true
    activeWithdrawalFee().then(
      (value) => live && setFee(value),
      (err) => console.warn("[withdrawalFee] executor fee read failed", err),
    )
    return () => {
      live = false
    }
  }, [enabled])
  return fee
}
