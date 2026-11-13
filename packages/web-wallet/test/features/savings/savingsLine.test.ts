// @vitest-environment node
// The Savings line prices the holding it shows, so shares of an unlisted holding can leave.
import { describe, expect, it } from "vitest"
import {
  pinnedHoldings,
  pinnedOxideDeployment,
  type DeploymentHoldings,
  type OxideBridge,
  type SkyEscrowHolding,
} from "@obsidion/core/oxide"
import type { BalanceEntry, MoveRecord, QueryState, RecordSet } from "@obsidion/front-core"
import {
  moveOutSource,
  savingsTotal,
  selectHoldingPrices,
  selectOtherLines,
  selectSavingsEarned,
  selectSavingsLine,
  selectSavingsListed,
} from "../../../src/features/savings/savingsLine"
import prodReleases from "../../../../front-core/test/fixtures/oxideReleases.v6-prod.json"
import { moveRecord } from "../../support/moves"
import type { SavingsPrice, SavingsPriceRead } from "../../../src/session/pageChain"

const SCOPE = "sandbox:0xacc"
const WAD = 10n ** 18n

const bridge = (byte: string) => ({ portal: `0x${byte.repeat(20)}` } as OxideBridge)
const sky = (id: string, byte: string): SkyEscrowHolding => ({
  id,
  kind: "yield",
  rail: "skyEscrow",
  l2Token: `0x${byte.repeat(32)}`,
  base: bridge("d1"),
  held: bridge(byte),
  terms: "erc4626",
  conversion: "DaiUsds",
  escrow: { factory: `0x${"fa".repeat(20)}`, withdrawalExecutor: `0x${"e5".repeat(20)}` },
})
const LISTED = sky("fea-sky-new", "b1")
const HELD = sky("fea-sky-old", "b2")
const deployment: DeploymentHoldings = { holdings: [LISTED, HELD], rejected: [] }
const price = (holding: SkyEscrowHolding, sharePrice: bigint): SavingsPrice => ({
  sharePrice,
  shareDecimals: 18,
  assetDecimals: 18,
  readAt: 1,
  holding,
})
const balances: RecordSet<BalanceEntry> = {
  records: [{ scope: SCOPE, token: HELD.l2Token, atomic: 10n * WAD, readAt: 1 }],
  loaded: true,
  failed: false,
}
const ready = <T>(value: T) => ({ status: "ready", value, refreshing: false } as const)

describe("selectSavingsLine", () => {
  it("values an unlisted holding's shares at that holding's price, not the profile's", () => {
    const prices = ready([price(LISTED, 2n * WAD), price(HELD, (11n * WAD) / 10n)])
    const line = selectSavingsLine([], ready(deployment), prices, balances, SCOPE, [], [])
    expect(line.line).toMatchObject({ id: HELD.id, exitOnly: true })
    expect(line.position).toMatchObject({ shares: 10n * WAD, value: 11n * WAD })
  })

  it("carries the block and token the balance store read the shares at", () => {
    const read = { ...balances, records: [{ ...balances.records[0]!, anchor: 7 }] }
    const line = selectSavingsLine(
      [],
      ready(deployment),
      ready([price(HELD, WAD)]),
      read,
      SCOPE,
      [],
      [],
    )
    expect(line.position).toMatchObject({
      sharesReadAt: 1,
      sharesAnchor: 7,
      sharesToken: HELD.l2Token,
    })
  })

  it("keeps valuing the shares, with no rate, at a price kept through a failed re-read", () => {
    const kept = { ...ready([price(HELD, (11n * WAD) / 10n)]), error: new Error("rpc down") }
    const line = selectSavingsLine([], ready(deployment), kept, balances, SCOPE, [], [])
    expect(line.position).toMatchObject({ shares: 10n * WAD, value: 11n * WAD })
    expect(line.position?.rate).toBeUndefined()
  })

  /** Shares of the listed vault and of one the profile no longer lists. */
  const both: RecordSet<BalanceEntry> = {
    ...balances,
    records: [
      ...balances.records,
      { scope: SCOPE, token: LISTED.l2Token, atomic: 5n * WAD, readAt: 1 },
    ],
  }
  const priced: SavingsPriceRead[] = [price(LISTED, 2n * WAD), price(HELD, (11n * WAD) / 10n)]
  const select = (held: RecordSet<BalanceEntry>, prices = priced) =>
    selectSavingsLine([LISTED.id], ready(deployment), ready(prices), held, SCOPE, [], [])

  it("counts an unlisted vault's shares in Savings beside the listed line's", () => {
    const savings = select(both)
    expect(savings.line).toMatchObject({ id: LISTED.id, exitOnly: false })
    expect(savings.position).toMatchObject({ shares: 5n * WAD, value: 10n * WAD })
    expect(savings.others).toHaveLength(1)
    expect(savings.others[0]).toMatchObject({
      line: { id: HELD.id, exitOnly: true },
      position: { shares: 10n * WAD, value: 11n * WAD },
    })
    expect(savingsTotal(savings)).toBe(21n * WAD)
  })

  it("takes a move out from a funded unlisted vault first, and a move in never reaches it", () => {
    const savings = select(both)
    expect(moveOutSource(savings)).toMatchObject({
      line: { id: HELD.id },
      position: { shares: 10n * WAD },
    })
    expect(savings.line?.exitOnly).toBe(false)
    const listedOnly = { ...both, records: both.records.filter((e) => e.token !== HELD.l2Token) }
    expect(moveOutSource(select(listedOnly))).toMatchObject({ line: { id: LISTED.id } })
  })

  it("passes a move the unlisted vault cannot cover to the listed line, so shares too few to move hold nothing back", () => {
    // The unlisted vault's 10 shares are worth 11; the listed line's 5 are worth 10.
    const savings = select(both)
    expect(moveOutSource(savings, 11n * WAD)).toMatchObject({ line: { id: HELD.id } })
    expect(moveOutSource(savings, 11n * WAD + 1n)).toMatchObject({ line: { id: LISTED.id } })
    // Under a cent's worth is left in the unlisted vault: no move can carry it.
    const dust = {
      ...both,
      records: both.records.map((e) =>
        e.token === HELD.l2Token ? { ...e, atomic: WAD / 1000n } : e,
      ),
    }
    expect(moveOutSource(select(dust))).toMatchObject({ line: { id: LISTED.id } })
  })

  describe("what the lines earned", () => {
    // The unlisted vault's ten shares went in for 9: at 1.1 a share they have earned 2.
    const put = moveRecord({
      holdingId: HELD.id,
      phase: "claimed",
      assets: 9n * WAD,
      deposit: { amount: 10n * WAD } as MoveRecord["deposit"],
    })
    // The listed line's five shares went in for 8: at 2 a share they have earned 2.
    const listedPut = moveRecord({
      id: "m2",
      holdingId: LISTED.id,
      phase: "claimed",
      assets: 8n * WAD,
      deposit: { amount: 5n * WAD } as MoveRecord["deposit"],
    })
    const lines = (moves: MoveRecord[], held = both) =>
      selectSavingsLine([LISTED.id], ready(deployment), ready(priced), held, SCOPE, moves, [])

    it("adds the other lines' value and what they earned to the first's", () => {
      expect(selectOtherLines(lines([put]))).toEqual({ value: 11n * WAD, earned: 2n * WAD })
      const all = lines([put, listedPut])
      expect(selectSavingsEarned(all, all.position!.value)).toBe(4n * WAD)
      const unpriced = select(both, [price(LISTED, 2n * WAD), { holding: HELD, failed: true }])
      expect(selectOtherLines(unpriced)).toBeUndefined()
    })

    it("reads Earned as unknown while a line's cost is, since its balance would read as earnings", () => {
      expect(selectOtherLines(lines([]))).toEqual({ value: 11n * WAD, earned: undefined })
      const some = lines([listedPut])
      expect(selectSavingsEarned(some, some.position!.value)).toBeUndefined()
    })

    it("shows what an unlisted vault earned when it alone holds shares", () => {
      const only = lines([put], balances)
      expect(only.line).toMatchObject({ id: LISTED.id })
      expect(selectSavingsEarned(only, 0n)).toBe(2n * WAD)
      // Nothing held and nothing moved: there is no Earned to show.
      const none = lines([], { ...balances, records: [] })
      expect(selectSavingsEarned(none, 0n)).toBeUndefined()
    })
  })

  it("reads a line whose own price failed as unpriced, never as nothing, and keeps the others'", () => {
    const savings = select(both, [price(LISTED, 2n * WAD), { holding: HELD, failed: true }])
    expect(savings.position).toMatchObject({ value: 10n * WAD })
    expect(savings.others[0]).toMatchObject({ line: { id: HELD.id }, position: null })
    expect(savingsTotal(savings)).toBeUndefined()
    // Its shares cannot be sized without a price: a move out takes the line that has one.
    expect(moveOutSource(savings)).toMatchObject({ line: { id: LISTED.id } })
  })
})

describe("selectHoldingPrices", () => {
  const prices = ready([price(LISTED, 2n * WAD), price(HELD, (11n * WAD) / 10n)])
  const sharePrice = (
    holdings: DeploymentHoldings,
    read: QueryState<readonly SavingsPriceRead[]> = prices,
  ) => new Map([...selectHoldingPrices(ready(holdings), read)].map(([id, p]) => [id, p.sharePrice]))

  it("prices each holding at its own share price, not the first line's", () => {
    expect(sharePrice(deployment)).toEqual(
      new Map([
        [LISTED.id, 2n * WAD],
        [HELD.id, (11n * WAD) / 10n],
      ]),
    )
  })

  it("prices an older feature on the same token at that token's price", () => {
    const older = { ...HELD, id: "fea-sky-older" }
    const both = { ...deployment, holdings: [...deployment.holdings, older] }
    expect(sharePrice(both).get(older.id)).toBe((11n * WAD) / 10n)
  })

  it("has no price for a holding whose price failed or is not the deployment's", () => {
    const failed = ready([price(LISTED, 2n * WAD), { holding: HELD, failed: true as const }])
    expect([...sharePrice(deployment, failed).keys()]).toEqual([LISTED.id])
    expect(sharePrice(deployment).has("fea-gone")).toBe(false)
  })
})

describe("on production's deployment", () => {
  const DAI_PORTAL = "0xCB99C58Fe81Ae6b2cB4835e46F7b703745879042"
  const PROD = pinnedHoldings(pinnedOxideDeployment(prodReleases, { portal: DAI_PORTAL }))
  const SKY = PROD.holdings[0] as SkyEscrowHolding
  const shares = (atomic: bigint): RecordSet<BalanceEntry> => ({
    ...balances,
    records: atomic > 0n ? [{ scope: SCOPE, token: SKY.l2Token, atomic, readAt: 1 }] : [],
  })
  const line = (listed: readonly string[] | undefined, atomic: bigint) =>
    selectSavingsLine(listed, ready(PROD), ready([price(SKY, WAD)]), shares(atomic), SCOPE, [], [])

  it("offers Savings under a profile that names no holdings: a move in, and a move out", () => {
    expect(line(undefined, 0n).line).toMatchObject({ id: "fea-sky-v6", exitOnly: false })
    const funded = line(undefined, 10n * WAD)
    expect(funded.line).toMatchObject({ id: "fea-sky-v6", exitOnly: false })
    expect(moveOutSource(funded)).toMatchObject({
      line: { id: "fea-sky-v6" },
      position: { shares: 10n * WAD },
    })
  })

  it("shows no Savings under an empty list, and only a move out of shares already held", () => {
    expect(line([], 0n).line).toBeUndefined()
    expect(line([], 10n * WAD).line).toMatchObject({ id: "fea-sky-v6", exitOnly: true })
  })

  it("lists Savings for the nav under a profile that names no holdings, and not under an empty list", () => {
    expect(selectSavingsListed(ready(PROD), undefined)).toBe(true)
    expect(selectSavingsListed(ready(PROD), ["fea-sky-v6"])).toBe(true)
    expect(selectSavingsListed(ready(PROD), [])).toBe(false)
    expect(selectSavingsListed({ status: "pending" }, undefined)).toBe(false)
  })
})
