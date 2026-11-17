// @vitest-environment node
/** The savings capture fixtures are deployments and vaults the wallet's own reads accept. */
import { expect, it } from "vitest"
import { createPublicClient, custom } from "viem"
import { createPace } from "@obsidion/core/cadence"
import { holdingCatalog, pinnedHoldings } from "@obsidion/core/oxide"
import { RATE_SCALE, holdingPrices, memoryStore, queries } from "@obsidion/front-core"
import { createL1RpcHandler } from "../../src/dev/fakeL1Rpc"
import { sheetQuote } from "../../src/features/savings/MoveFundsSheet/MoveFundsSheet"
import {
  savingsDeployment,
  savingsListed,
  savingsQuote,
  savingsRpc,
  savingsVaultSwapTargets,
} from "../../scripts/ui-capture/fixtures/savings-seed"

/** The wallet's price read over the fixture's L1. */
const prices = () => {
  const handle = savingsRpc(createL1RpcHandler(31337))
  const l1 = createPublicClient({
    transport: custom({ request: ({ method, params }) => handle(method, params) }),
  })
  const query = queries({ pace: createPace(), visible: memoryStore(true).readonly, now: () => 0 })
  return holdingPrices(
    query,
    () => l1,
    () => 0,
  )
}

it("lists one Sky holding by default and prices it with a rate", async () => {
  const deployment = pinnedHoldings(savingsDeployment())
  expect(deployment.rejected).toEqual([])
  const [holding, ...others] = holdingCatalog(deployment, undefined).holdings
  expect(others).toEqual([])
  expect(holding?.rail).toBe("skyEscrow")

  const price = await prices()(holding!).read()
  expect(price.sharePrice).toBeGreaterThan(10n ** BigInt(price.shareDecimals))
  expect(price.rate).toBeGreaterThan(RATE_SCALE / 100n)
  expect(price.rate).toBeLessThan(RATE_SCALE / 10n)
  expect(price).toMatchObject({ shareSymbol: "sUSDS", assetSymbol: "USDS" })
})

it("lists a USDC vault on the executor beside Sky, priced in its asset's six decimals", async () => {
  const deployment = pinnedHoldings(savingsDeployment("vaults"))
  expect(deployment.rejected).toEqual([])
  const { holdings } = holdingCatalog(deployment, savingsListed("vaults"))
  expect(holdings.map((h) => h.rail)).toEqual(["skyEscrow", "executor"])

  const price = await prices()(holdings[1]!).read()
  expect(price).toMatchObject({
    shareDecimals: 18,
    shareSymbol: "vUSDC",
    assetDecimals: 6,
    assetSymbol: "USDC",
  })
  expect(price.sharePrice).toBeGreaterThan(10n ** 6n)
  expect(price.rate).toBeGreaterThan(RATE_SCALE / 100n)
  expect(price.rate).toBeLessThan(RATE_SCALE / 10n)
})

it.each(["in", "out"] as const)(
  "quotes a move %s of each listed vault at that vault's own price and decimals",
  async (direction) => {
    const { holdings } = holdingCatalog(
      pinnedHoldings(savingsDeployment("vaults")),
      savingsListed("vaults"),
    )
    const read = prices()
    for (const holding of holdings) {
      const { assetDecimals } = await read(holding).read()
      const amount = 100n * 10n ** 18n
      const { value, fee } = sheetQuote(
        direction,
        amount,
        savingsQuote(holding.id, direction, amount),
        assetDecimals,
      )
      // The fixture's fees: under a dollar on a move worth about a hundred.
      expect(fee).toBeGreaterThan(0n)
      expect(fee).toBeLessThan(10n ** 18n)
      expect(value).toBeGreaterThan(99n * 10n ** 18n)
    }
  },
)

it("offers Sky and the vault each other only on an executor with the Sky converter adapter", () => {
  const [sky, vault] = holdingCatalog(
    pinnedHoldings(savingsDeployment("skySwitch")),
    savingsListed("skySwitch"),
  ).holdings.map((h) => h.id)
  expect(savingsVaultSwapTargets("skySwitch")).toEqual(
    new Map([
      [vault, [sky]],
      [sky, [vault]],
    ]),
  )
  expect(savingsVaultSwapTargets("vaults")).toEqual(new Map([[vault, []]]))
})
