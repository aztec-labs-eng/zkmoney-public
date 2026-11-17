// @vitest-environment node
// "You're earning on" lists every line, named by the profile, valued in dollars.
import { describe, expect, it } from "vitest"
import type {
  DeploymentHoldings,
  ExecutorHolding,
  Holding,
  OxideBridge,
  SkyEscrowHolding,
} from "@obsidion/core/oxide"
import {
  RATE_SCALE,
  type BalanceEntry,
  type QueryState,
  type RecordSet,
} from "@obsidion/front-core"
import { selectHoldingRows } from "../../../src/features/savings/holdingRows"
import { selectSavingsLine } from "../../../src/features/savings/savingsLine"
import type { SavingsPriceRead } from "../../../src/session/pageChain"

const SCOPE = "sandbox:0xacc"
const WAD = 10n ** 18n
const bridge = (byte: string) =>
  ({ portal: `0x${byte.repeat(20)}`, underlying: `0x${byte.repeat(20)}` } as OxideBridge)
const SKY: SkyEscrowHolding = {
  id: "fea-sky-v6",
  kind: "yield",
  rail: "skyEscrow",
  l2Token: `0x${"b1".repeat(32)}`,
  base: bridge("d1"),
  held: bridge("b1"),
  terms: "erc4626",
  conversion: "DaiUsds",
  escrow: { factory: `0x${"fa".repeat(20)}`, withdrawalExecutor: `0x${"e5".repeat(20)}` },
}
const vault = (id: string, byte: string): ExecutorHolding => ({
  id,
  kind: "yield",
  rail: "executor",
  l2Token: `0x${byte.repeat(32)}`,
  base: bridge("d1"),
  held: bridge(byte),
  terms: "erc4626",
  conversion: "Psm",
  executor: { id: "fea-multistep", address: `0x${"e0".repeat(20)}`, adapters: {} },
})
const NEW_VAULT = vault("fea-vault-new-v6", "c1")
const OLD_VAULT = vault("fea-vault-old-v6", "c2")
const deployment: DeploymentHoldings = { holdings: [SKY, NEW_VAULT, OLD_VAULT], rejected: [] }
const FACTS = {
  yieldFrom: "Yield",
  moveBack: "Any time",
  risk: "Low",
  provider: "Sky",
  terms: [{ label: "Terms of Use", url: "https://example.com/terms" }],
}
const WORDS = {
  [SKY.id]: { rateName: "Sky Savings Rate", ...FACTS },
  [NEW_VAULT.id]: { rateName: "New Vault Rate", new: true, ...FACTS },
  [OLD_VAULT.id]: { rateName: "Old Vault Rate", new: true, ...FACTS },
}
/** A 6-decimal asset's vault at 1.05 a share, at 5% a year. */
const usdcPrice = (holding: Holding): SavingsPriceRead => ({
  holding,
  sharePrice: 1_050_000n,
  shareDecimals: 18,
  shareSymbol: "vUSDC",
  assetDecimals: 6,
  assetSymbol: "USDC",
  rate: RATE_SCALE / 20n,
  readAt: 1,
})
const skyPrice: SavingsPriceRead = {
  holding: SKY,
  sharePrice: (11n * WAD) / 10n,
  shareDecimals: 18,
  shareSymbol: "sUSDS",
  assetDecimals: 18,
  assetSymbol: "USDS",
  readAt: 1,
}
const held = (shares: Record<string, bigint>): RecordSet<BalanceEntry> => ({
  records: Object.entries(shares).map(([token, atomic]) => ({ scope: SCOPE, token, atomic })),
  loaded: true,
  failed: false,
})
const ready = <T>(value: T): QueryState<T> => ({ status: "ready", value, refreshing: false })
const rows = (
  prices: QueryState<readonly SavingsPriceRead[]>,
  shares: Record<string, bigint>,
  listed = [SKY.id, NEW_VAULT.id],
) =>
  selectHoldingRows(
    selectSavingsLine(listed, ready(deployment), prices, held(shares), SCOPE, [], []),
    WORDS,
  )

describe("selectHoldingRows", () => {
  it("lists the profile's lines in order, then an unlisted one held, never tagged new", () => {
    const shares = { [SKY.l2Token]: 0n, [NEW_VAULT.l2Token]: 0n, [OLD_VAULT.l2Token]: WAD }
    const prices = ready([skyPrice, usdcPrice(NEW_VAULT), usdcPrice(OLD_VAULT)])
    expect(rows(prices, shares)).toMatchObject([
      { id: SKY.id, words: WORDS[SKY.id], isNew: false, exitOnly: false },
      { id: NEW_VAULT.id, words: WORDS[NEW_VAULT.id], isNew: true, exitOnly: false },
      { id: OLD_VAULT.id, words: WORDS[OLD_VAULT.id], isNew: false, exitOnly: true },
    ])
  })

  it("values each line in dollars at its asset's decimals, with its symbol and rate", () => {
    const shares = { [SKY.l2Token]: 500n * WAD, [NEW_VAULT.l2Token]: 300n * WAD }
    const [sky, usdc] = rows(ready([skyPrice, usdcPrice(NEW_VAULT)]), shares)
    expect(sky).toMatchObject({ symbol: "USDS", value: 550n * WAD })
    expect(sky).not.toHaveProperty("rate")
    expect(usdc).toMatchObject({ symbol: "USDC", value: 315n * WAD, rate: RATE_SCALE / 20n })
  })

  it("shows nothing held as zero without a price, and held shares without one as unvalued", () => {
    const failed = ready([skyPrice, { holding: NEW_VAULT, failed: true as const }])
    const empty = rows(failed, { [SKY.l2Token]: WAD, [NEW_VAULT.l2Token]: 0n })[1]
    expect(empty).toMatchObject({ value: 0n, held: false })
    expect(empty).not.toHaveProperty("symbol")
    const funded = rows(failed, { [SKY.l2Token]: WAD, [NEW_VAULT.l2Token]: WAD })[1]
    expect(funded).toMatchObject({ held: true })
    expect(funded).not.toHaveProperty("value")
  })

  it("lists nothing until every line's shares and the prices are read", () => {
    expect(rows({ status: "pending" }, { [SKY.l2Token]: WAD, [NEW_VAULT.l2Token]: 0n })).toEqual([])
    expect(rows(ready([skyPrice, usdcPrice(NEW_VAULT)]), { [SKY.l2Token]: WAD })).toEqual([])
  })
})
