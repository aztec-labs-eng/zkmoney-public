// @vitest-environment node
// What values an upgrade run: the pinned bridge's underlying for Main, the Savings asset and the
// share price. Its Main token holds while the manifest is read again.
import { describe, expect, it } from "vitest"
import { memoryStore, type QueryState } from "@obsidion/front-core"
import { upgradePricing } from "../../../../src/features/migration/upgradeRunAccount"
import type { ChainSavingsPrice } from "../../../../src/features/savings/savingsTasks"
import { sandboxConfig } from "../../../support/seedBootConfig"

type Tuple = { token: string; underlying?: string }
const DAI = `0x${"da".repeat(20)}`
const USDS = `0x${"5d".repeat(20)}`
const ready = <T>(value: T): QueryState<T> => ({ status: "ready", value, refreshing: false })

async function pricing() {
  const config = await sandboxConfig()
  const tuple = memoryStore<QueryState<Tuple>>({ status: "pending" })
  const price = memoryStore<QueryState<ChainSavingsPrice | null>>({ status: "pending" })
  // The chain holds the pinned tuple alone: the pricing reads nothing but its inputs.
  const store = upgradePricing(
    { config, chain: { oxideTuple: tuple.readonly } as never },
    price.readonly,
  )
  store.subscribe(() => {})
  return { config, tuple, price, store }
}

describe("upgradePricing", () => {
  it("knows nothing until the tuple and the price are read", async () => {
    const { store } = await pricing()
    expect(store.get()).toMatchObject({
      mainToken: undefined,
      savingsToken: undefined,
      sharePrice: undefined,
      settled: false,
    })
  })

  it("prices Main in the pinned underlying, Savings in the asset its price was read on", async () => {
    const { config, tuple, price, store } = await pricing()
    tuple.set(ready({ token: `0x${"aa".repeat(20)}`, underlying: DAI }))
    price.set(ready({ sharePrice: 2n, readAt: 1, asset: USDS }))
    expect(store.get()).toMatchObject({ mainToken: DAI, savingsToken: USDS, sharePrice: 2n })
    const main = `migration/${config.oxideProfile.portal.toLowerCase()}/1`
    expect(store.get().runToken?.(main)).toBe(DAI)
    expect(store.get().runToken?.("migration/0xsavings/1")).toBe(USDS)
    // A price read on another Savings tuple brings its asset.
    const other = `0x${"0f".repeat(20)}`
    price.set(ready({ sharePrice: 3n, readAt: 2, asset: other }))
    expect(store.get()).toMatchObject({ savingsToken: other, sharePrice: 3n })
  })

  it("takes the bridge's token where it names no underlying", async () => {
    const { tuple, store } = await pricing()
    tuple.set(ready({ token: DAI }))
    expect(store.get().mainToken).toBe(DAI)
  })

  it("settles once the tuple and the price answer, a failed first price read included", async () => {
    const { tuple, price, store } = await pricing()
    tuple.set(ready({ token: DAI }))
    expect(store.get().settled).toBe(false)
    price.set({ status: "failed", error: new Error("rpc down") })
    expect(store.get()).toMatchObject({ settled: true, sharePrice: undefined })
    // No Savings: the price answers null.
    price.set(ready(null))
    expect(store.get()).toMatchObject({ settled: true, savingsToken: undefined })
  })
})
