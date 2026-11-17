// @vitest-environment node
// Savings prices each line at its own holding, on any rail, so every line's shares count.
import { describe, expect, it } from "vitest"
import {
  pinnedHoldings,
  pinnedOxideDeployment,
  type DeploymentHoldings,
  type ExecutorHolding,
  type Holding,
  type OxideBridge,
  type SkyEscrowHolding,
} from "@obsidion/core/oxide"
import {
  arrivingFunds,
  RATE_SCALE,
  type BackupRotationRecord,
  type BalanceEntry,
  type MoveRecord,
  type QueryState,
  type RecordSet,
  type WithdrawalRecord,
} from "@obsidion/front-core"
import {
  moveInLine,
  moveLine,
  moveLines,
  moveOutSource,
  savingsTotal,
  selectHoldingPrices,
  selectSavingsEarned,
  selectSavingsLine,
  selectSavingsListed,
  selectBackupShares,
  selectSavingsRate,
  selectSavingsTokens,
  selectVaultSwappable,
} from "../../../src/features/savings/savingsLine"
import { selectHoldingRows } from "../../../src/features/savings/holdingRows"
import prodReleases from "../../../../front-core/test/fixtures/oxideReleases.v6-prod.json"
import { moveRecord } from "../../support/moves"
import type { SavingsPrice, SavingsPriceRead } from "../../../src/session/pageChain"

const SCOPE = "sandbox:0xacc"
const WAD = 10n ** 18n

const bridge = (byte: string) =>
  ({
    portal: `0x${byte.repeat(20)}`,
    underlying: `0x${byte.toUpperCase().repeat(20)}`,
  } as OxideBridge)
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
const price = (holding: Holding, sharePrice: bigint): SavingsPrice => ({
  sharePrice,
  shareDecimals: 18,
  shareSymbol: "sUSDS",
  assetDecimals: 18,
  assetSymbol: "USDS",
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
    expect(line.lines).toHaveLength(1)
    expect(line.lines[0]).toMatchObject({
      line: { id: HELD.id, exitOnly: true },
      position: { shares: 10n * WAD, value: 11n * WAD },
    })
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
    expect(line.lines[0]?.position).toMatchObject({
      sharesReadAt: 1,
      sharesAnchor: 7,
      sharesToken: HELD.l2Token,
    })
  })

  it("keeps valuing the shares, with no rate, at a price kept through a failed re-read", () => {
    const kept = { ...ready([price(HELD, (11n * WAD) / 10n)]), error: new Error("rpc down") }
    const line = selectSavingsLine([], ready(deployment), kept, balances, SCOPE, [], [])
    expect(line.lines[0]?.position).toMatchObject({ shares: 10n * WAD, value: 11n * WAD })
    expect(line.lines[0]?.position?.rate).toBeUndefined()
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
    expect(savings.lines).toMatchObject([
      {
        line: { id: LISTED.id, exitOnly: false },
        position: { shares: 5n * WAD, value: 10n * WAD },
      },
      { line: { id: HELD.id, exitOnly: true }, position: { shares: 10n * WAD, value: 11n * WAD } },
    ])
    expect(savingsTotal(savings)).toBe(21n * WAD)
  })

  it("takes a move out from a funded unlisted vault first, and a move in never reaches it", () => {
    const savings = select(both)
    expect(moveOutSource(savings)).toMatchObject({
      line: { id: HELD.id },
      position: { shares: 10n * WAD },
    })
    expect(moveInLine(savings)?.line.id).toBe(LISTED.id)
    const listedOnly = { ...both, records: both.records.filter((e) => e.token !== HELD.l2Token) }
    expect(moveOutSource(select(listedOnly))).toMatchObject({ line: { id: LISTED.id } })
  })

  it("passes over an unlisted vault holding under a cent: no move can carry it", () => {
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

    it("adds up what every line earned", () => {
      expect(selectSavingsEarned(lines([put, listedPut]))).toBe(4n * WAD)
      const unpriced = select(both, [price(LISTED, 2n * WAD), { holding: HELD, failed: true }])
      expect(selectSavingsEarned(unpriced)).toBeUndefined()
    })

    it("adds what a carried value gained to what the value read had earned", () => {
      const carried = selectSavingsEarned(lines([put, listedPut]), (p) => p.value + WAD)
      expect(carried).toBe(6n * WAD)
    })

    it("reads Earned as unknown while a line's cost is, since its balance would read as earnings", () => {
      expect(selectSavingsEarned(lines([listedPut]))).toBeUndefined()
      expect(selectSavingsEarned(lines([put]))).toBeUndefined()
    })

    it("shows what an unlisted vault earned when it alone holds shares", () => {
      const empty = { scope: SCOPE, token: LISTED.l2Token, atomic: 0n, readAt: 1 }
      const only = lines([put], { ...balances, records: [...balances.records, empty] })
      expect(only.lines.map((l) => l.line.id)).toEqual([LISTED.id, HELD.id])
      expect(selectSavingsEarned(only)).toBe(2n * WAD)
      // Nothing held and nothing moved: there is no Earned to show.
      expect(selectSavingsEarned(lines([], { ...balances, records: [empty] }))).toBeUndefined()
    })
  })

  it("reads a line whose own price failed as unpriced, never as nothing, and keeps the others'", () => {
    const savings = select(both, [price(LISTED, 2n * WAD), { holding: HELD, failed: true }])
    expect(savings.lines).toMatchObject([
      { position: { value: 10n * WAD } },
      { line: { id: HELD.id }, shares: 10n * WAD, position: null },
    ])
    expect(savingsTotal(savings)).toBeUndefined()
    // Its shares cannot be sized without a price: a move out takes the line that has one.
    expect(moveOutSource(savings)).toMatchObject({ line: { id: LISTED.id } })
  })
})

describe("a vault's line beside Sky's", () => {
  const USDC = 10n ** 6n
  const VAULT: ExecutorHolding = {
    id: "fea-vault-usdc",
    kind: "yield",
    rail: "executor",
    l2Token: `0x${"c1".repeat(32)}`,
    base: bridge("d1"),
    held: bridge("c1"),
    terms: "erc4626",
    conversion: "None",
    executor: { id: "fea-multistep", address: `0x${"e0".repeat(20)}`, adapters: {} },
  }
  const holdings: DeploymentHoldings = { holdings: [LISTED, VAULT], rejected: [] }
  const rate = (percent: bigint) => (percent * RATE_SCALE) / 100n
  /** A vault share is worth 1.05 USDC: six decimals, against Sky's eighteen. */
  const vaultPrice = (over: Partial<SavingsPrice> = {}): SavingsPrice => ({
    ...price(VAULT, (105n * USDC) / 100n),
    assetDecimals: 6,
    assetSymbol: "USDC",
    rate: rate(8n),
    ...over,
  })
  const skyPrice = { ...price(LISTED, 2n * WAD), rate: rate(4n) }
  const held = (sky: bigint | undefined, vault: bigint | undefined): RecordSet<BalanceEntry> => ({
    ...balances,
    records: [
      ...(sky === undefined ? [] : [{ scope: SCOPE, token: LISTED.l2Token, atomic: sky }]),
      ...(vault === undefined ? [] : [{ scope: SCOPE, token: VAULT.l2Token, atomic: vault }]),
    ],
  })
  const select = (
    shares: RecordSet<BalanceEntry>,
    prices: SavingsPriceRead[] = [skyPrice, vaultPrice()],
    listed = [LISTED.id, VAULT.id],
    moves: MoveRecord[] = [],
  ) => selectSavingsLine(listed, ready(holdings), ready(prices), shares, SCOPE, moves, [])

  it("counts the vault's shares in the total, in dollars whatever its asset's decimals", () => {
    // 5 Sky shares at 2 and 100 vault shares at 1.05 USDC.
    const savings = select(held(5n * WAD, 100n * WAD))
    expect(savings.lines.map((l) => l.line.rail)).toEqual(["skyEscrow", "executor"])
    expect(savings.lines[1]?.position).toMatchObject({ value: 105n * USDC, assetDecimals: 6 })
    expect(savingsTotal(savings)).toBe(115n * WAD)
    expect(savings.hydrated).toBe(true)
  })

  it("counts a vault the profile no longer lists, and lets its shares leave first", () => {
    const savings = select(held(5n * WAD, 100n * WAD), undefined, [LISTED.id])
    expect(savings.lines[1]).toMatchObject({ line: { id: VAULT.id, exitOnly: true } })
    expect(savingsTotal(savings)).toBe(115n * WAD)
    expect(moveOutSource(savings)?.line.id).toBe(VAULT.id)
    expect(moveInLine(savings)?.line.id).toBe(LISTED.id)
  })

  it("moves through the vault a user picked, and a move in past a vault no longer listed", () => {
    const savings = select(held(5n * WAD, 100n * WAD))
    expect(moveLine(savings, "in", VAULT.id)?.line.id).toBe(VAULT.id)
    expect(moveLine(savings, "out", LISTED.id)?.line.id).toBe(LISTED.id)
    expect(moveLine(savings, "in")?.line.id).toBe(LISTED.id)
    const delisted = select(held(5n * WAD, 100n * WAD), undefined, [LISTED.id])
    expect(moveLine(delisted, "out", LISTED.id)?.line.id).toBe(LISTED.id)
    expect(moveLine(delisted, "out")?.line.id).toBe(VAULT.id)
  })

  it("never swaps a picked vault for another: one that cannot take the move is no line", () => {
    const delisted = select(held(5n * WAD, 100n * WAD), undefined, [LISTED.id])
    expect(moveLine(delisted, "in", VAULT.id)).toBeUndefined()
    expect(moveLine(delisted, "in", "fea-unknown")).toBeUndefined()
    expect(moveLine(delisted, "out", "fea-unknown")).toBeUndefined()
  })

  it("offers each listed line for a move in, and each line with shares for a move out", () => {
    const ids = (lines: readonly { line: { id: string } }[]) => lines.map(({ line }) => line.id)
    const savings = select(held(5n * WAD, 0n))
    expect(ids(moveLines(savings, "in"))).toEqual([LISTED.id, VAULT.id])
    expect(ids(moveLines(savings, "out"))).toEqual([LISTED.id])
    const delisted = select(held(5n * WAD, 100n * WAD), undefined, [LISTED.id])
    expect(ids(moveLines(delisted, "in"))).toEqual([LISTED.id])
    expect(ids(moveLines(delisted, "out"))).toEqual([LISTED.id, VAULT.id])
  })

  it("names a move out a swap only from a line with shares the engine can swap", () => {
    const savings = select(held(5n * WAD, 0n))
    const targets = new Map([
      [LISTED.id, [VAULT.id]],
      [VAULT.id, [LISTED.id]],
    ])
    expect(selectVaultSwappable(savings, targets)).toBe(true)
    expect(selectVaultSwappable(savings, targets, LISTED.id)).toBe(true)
    expect(selectVaultSwappable(savings, targets, VAULT.id)).toBe(false)
    expect(selectVaultSwappable(savings, new Map([[LISTED.id, []]]))).toBe(false)
  })

  it("earns in dollars on the vault's line: its value less what its shares cost", () => {
    const put = moveRecord({
      holdingId: VAULT.id,
      phase: "claimed",
      assets: 100n * USDC,
      deposit: { amount: 100n * WAD } as MoveRecord["deposit"],
    })
    const savings = select(held(0n, 100n * WAD), undefined, undefined, [put])
    expect(selectSavingsEarned(savings)).toBe(5n * WAD)
  })

  it("blanks the total while a funded vault is unpriced, or a line's shares are unread", () => {
    const failed: SavingsPriceRead[] = [skyPrice, { holding: VAULT, failed: true }]
    expect(savingsTotal(select(held(5n * WAD, 100n * WAD), failed))).toBeUndefined()
    const unread = select(held(5n * WAD, undefined))
    expect(savingsTotal(unread)).toBeUndefined()
    expect(unread.hydrated).toBe(false)
    // An empty line is worth nothing at any price.
    expect(savingsTotal(select(held(5n * WAD, 0n), failed))).toBe(10n * WAD)
  })

  describe("the rate Savings shows", () => {
    it("weighs each funded line's rate by its value", () => {
      // 10 at 4% and 105 at 8%.
      const both = selectSavingsRate(select(held(5n * WAD, 100n * WAD)))
      expect(both).toBe((10n * rate(4n) + 105n * rate(8n)) / 115n)
      // An unfunded line has no weight.
      expect(selectSavingsRate(select(held(0n, 100n * WAD)))).toBe(rate(8n))
      expect(selectSavingsRate(select(held(5n * WAD, 0n)))).toBe(rate(4n))
    })

    it("leaves out a funded line without a rate or a price", () => {
      const { rate: _, ...unrated } = vaultPrice()
      expect(selectSavingsRate(select(held(5n * WAD, 100n * WAD), [skyPrice, unrated]))).toBe(
        rate(4n),
      )
      const failed: SavingsPriceRead[] = [skyPrice, { holding: VAULT, failed: true }]
      expect(selectSavingsRate(select(held(5n * WAD, 100n * WAD), failed))).toBe(rate(4n))
      // Funds held only where no rate is read: the first line's rate is not theirs.
      expect(selectSavingsRate(select(held(0n, 100n * WAD), [skyPrice, unrated]))).toBeUndefined()
    })

    it("shows no rate while nothing is held or arriving", () => {
      expect(selectSavingsRate(select(held(0n, 0n)))).toBeUndefined()
      expect(selectSavingsRate(select(held(undefined, undefined)))).toBeUndefined()
    })

    it("weighs funds arriving into a vault before its shares are read", () => {
      // 10 held at 4%, 100 on its way into the vault at 8%.
      const arriving = new Map([[VAULT.id, 100n * WAD]])
      const expected = (10n * rate(4n) + 100n * rate(8n)) / 110n
      expect(selectSavingsRate(select(held(5n * WAD, 0n)), arriving)).toBe(expected)
      expect(selectSavingsRate(select(held(5n * WAD, undefined)), arriving)).toBe(expected)
      expect(selectSavingsRate(select(held(0n, 0n)), arriving)).toBe(rate(8n))
    })

    it("is the funded line's own rate, to the unit, wherever one line is all there is", () => {
      const one = (shares: bigint | undefined, read: SavingsPriceRead = skyPrice) =>
        select(held(shares, undefined), [read], [LISTED.id])
      // A rate no division by a value returns whole.
      const odd = { ...skyPrice, rate: rate(4n) + 7n }
      const { rate: _, ...unrated } = skyPrice
      const cases = [
        one(3n * WAD + 1n, odd),
        one(1n, odd),
        // Shares worth nothing.
        one(1n, { ...odd, sharePrice: WAD / 2n }),
        one(5n * WAD, unrated),
        one(5n * WAD, { holding: LISTED, failed: true }),
      ]
      for (const savings of cases) {
        expect(savings.lines).toHaveLength(1)
        expect(selectSavingsRate(savings)).toBe(savings.lines[0]!.position?.rate)
      }
      expect(cases.slice(0, 3).map((s) => selectSavingsRate(s))).toEqual(Array(3).fill(odd.rate))
    })
  })
})

/** What the feed counts in each holding, on profiles where no one holding can stand for Savings. */
describe("what the feed counts in each holding", () => {
  const vault = (id: string, byte: string): ExecutorHolding => ({
    id,
    kind: "yield",
    rail: "executor",
    l2Token: `0x${byte.repeat(32)}`,
    base: bridge("d1"),
    held: bridge(byte),
    terms: "erc4626",
    conversion: "None",
    executor: { id: "fea-multistep", address: `0x${"e0".repeat(20)}`, adapters: {} },
  })
  const entry = (holding: Holding, atomic: bigint, readAt: number, anchor?: number) => ({
    scope: SCOPE,
    token: holding.l2Token,
    atomic,
    readAt,
    ...(anchor === undefined ? {} : { anchor }),
  })
  /** Savings as Home shows it: the lines' worth and what is still arriving, in dollars. */
  const shown = (
    profile: Holding[],
    moves: MoveRecord[],
    records: BalanceEntry[],
  ): bigint | undefined => {
    const holdings = ready<DeploymentHoldings>({ holdings: profile, rejected: [] })
    const prices = ready(profile.map((holding, i) => price(holding, BigInt(i + 1) * WAD)))
    const listed = profile.map((holding) => holding.id)
    const stored = { ...balances, records }
    const savings = selectSavingsLine(listed, holdings, prices, stored, SCOPE, [], [])
    const total = savingsTotal(savings)
    const arriving = arrivingFunds({
      deposits: [],
      burns: [{ localId: "w1", phase: "done" } as WithdrawalRecord],
      moves,
      rows: [],
      holdingPrices: selectHoldingPrices(holdings, prices),
      balanceReadAt: { main: 900, holdings: savings.sharesReadAt },
    })
    return total === undefined ? undefined : total + arriving.savings
  }
  /** 10 shares into `holding`, claimed at 500. */
  const claimed = (holding: Holding) =>
    moveRecord({
      holdingId: holding.id,
      phase: "claimed",
      deposit: { inboxIndex: 1n, amount: 10n * WAD, at: 400 },
      endTime: 500,
    })

  it("counts a claimed move into the only holding listed, a vault on the executor, once", () => {
    const only = vault("fea-vault-a", "c1")
    const moves = [claimed(only)]
    // A read from before the claim holds none of its shares; one after holds them all.
    expect(shown([only], moves, [entry(only, 0n, 499)])).toBe(10n * WAD)
    expect(shown([only], moves, [entry(only, 10n * WAD, 500)])).toBe(10n * WAD)
    expect(shown([only], moves, [entry(only, 10n * WAD, 900)])).toBe(10n * WAD)
  })

  it("keeps a claim read once its vault, no longer listed, is emptied and its line is gone", () => {
    const [kept, left] = [vault("fea-vault-a", "c1"), vault("fea-vault-b", "c2")]
    const holdings = ready<DeploymentHoldings>({ holdings: [kept, left], rejected: [] })
    const prices = ready([price(kept, WAD), price(left, WAD)])
    // The shares the claim brought have since moved out: the last read holds none.
    const stored = { ...balances, records: [entry(kept, 5n * WAD, 900), entry(left, 0n, 900)] }
    const savings = selectSavingsLine([kept.id], holdings, prices, stored, SCOPE, [], [])
    expect(savings.lines.map(({ line }) => line.id)).toEqual([kept.id])
    const arriving = arrivingFunds({
      deposits: [],
      burns: [{ localId: "w1", phase: "done" } as WithdrawalRecord],
      moves: [claimed(left)],
      rows: [],
      holdingPrices: selectHoldingPrices(holdings, prices),
      balanceReadAt: { main: 900, holdings: savings.sharesReadAt },
    })
    expect(arriving.savings).toBe(0n)
  })

  it("counts a swap on the line it leaves until the line it lands in is read, then there", () => {
    const [a, b] = [vault("fea-vault-a", "c1"), vault("fea-vault-b", "c2")]
    const holdings = ready<DeploymentHoldings>({ holdings: [a, b], rejected: [] })
    const prices = ready([price(a, WAD), price(b, 2n * WAD)])
    const vaultSwapped = moveRecord({
      holdingId: a.id,
      intoHoldingId: b.id,
      direction: "out",
      amount: 10n * WAD,
      phase: "claimed",
      deposit: { inboxIndex: 1n, amount: 5n * WAD, at: 400 },
      endTime: 500,
    })
    const burns = [{ localId: "w1", phase: "done" } as WithdrawalRecord]
    const figures = (records: BalanceEntry[]) => {
      const stored = { ...balances, records }
      const savings = selectSavingsLine([a.id, b.id], holdings, prices, stored, SCOPE, [], burns)
      const arriving = arrivingFunds({
        deposits: [],
        burns,
        moves: [vaultSwapped],
        rows: [],
        holdingPrices: selectHoldingPrices(holdings, prices),
        balanceReadAt: { main: 900, holdings: savings.sharesReadAt },
      })
      const rows = selectHoldingRows(savings, {}, arriving.vaultSwapping)
      return { shown: savingsTotal(savings)! + arriving.savings, rows: rows.map((r) => r.value) }
    }
    expect(figures([entry(a, 0n, 900), entry(b, 0n, 499)])).toEqual({
      shown: 10n * WAD,
      rows: [10n * WAD, 0n],
    })
    expect(figures([entry(a, 0n, 900), entry(b, 5n * WAD, 500)])).toEqual({
      shown: 10n * WAD,
      rows: [0n, 10n * WAD],
    })
  })

  it("counts a swap into the ledger of the line it lands in", () => {
    const [a, b] = [vault("fea-vault-a", "c1"), vault("fea-vault-b", "c2")]
    const holdings = ready<DeploymentHoldings>({ holdings: [a, b], rejected: [] })
    const prices = ready([price(a, WAD), price(b, WAD)])
    const vaultSwapped = moveRecord({
      holdingId: a.id,
      intoHoldingId: b.id,
      direction: "out",
      phase: "claimed",
      deposit: { inboxIndex: 1n, amount: 5n * WAD, at: 400 },
      endTime: 500,
    })
    const burns = [{ localId: "w1", phase: "done" } as WithdrawalRecord]
    const stored = { ...balances, records: [entry(a, 0n, 900), entry(b, 5n * WAD, 900)] }
    const savings = selectSavingsLine(
      [a.id, b.id],
      holdings,
      prices,
      stored,
      SCOPE,
      [vaultSwapped],
      burns,
    )
    expect(savings.lines[1]?.ledger).toMatchObject({ counted: 1, shares: 5n * WAD })
  })

  const profiles: [string, Holding, Holding][] = [
    ["two vaults and no Sky", vault("fea-vault-a", "c1"), vault("fea-vault-b", "c2")],
    ["two Sky holdings", sky("fea-sky-a", "b1"), sky("fea-sky-b", "b2")],
  ]

  describe.each(profiles)("on a profile of %s", (_, first, second) => {
    const holdings = ready<DeploymentHoldings>({ holdings: [first, second], rejected: [] })
    const listed = [first.id, second.id]

    it("matches a share deposit to its holding by its token", () => {
      const tokens = selectSavingsTokens(holdings, listed)
      for (const holding of [first, second])
        expect(tokens?.get(holding.held.underlying.toLowerCase())).toBe(holding.id)
      expect(selectSavingsTokens({ status: "pending" }, listed)).toBeUndefined()
    })

    it("counts a claimed move once: it stops arriving when its own holding is read", () => {
      const moves = [claimed(second)]
      const before = [entry(first, 5n * WAD, 900), entry(second, 0n, 499)]
      const after = [entry(first, 5n * WAD, 900), entry(second, 10n * WAD, 500)]
      // The first holding's later read says nothing of the second's shares.
      expect(shown([first, second], moves, before)).toBe(25n * WAD)
      expect(shown([first, second], moves, after)).toBe(25n * WAD)
    })

    it("covers every held line's shares in a backup passkey's move", () => {
      const ACCOUNT = `0x${"ac".repeat(32)}`
      const chunk = (holding: Holding, amount: bigint, blockNumber?: number) => ({
        token: holding.l2Token,
        amount: amount.toString(),
        ...(blockNumber === undefined
          ? { state: "planned" }
          : { state: "included", inclusion: { blockNumber } }),
      })
      const rotation = {
        phase: "rerooted",
        plan: { address: ACCOUNT },
        move: {
          runs: [
            { chunks: [chunk(first, 3n * WAD), chunk(second, 4n * WAD), chunk(second, WAD, 6)] },
          ],
        },
      } as unknown as BackupRotationRecord
      const prices = ready([price(first, WAD), price(second, 2n * WAD)])
      // Both lines read at block 7: the second's read holds its chunk from block 6.
      const stored = {
        ...balances,
        records: [entry(first, 0n, 1, 7), entry(second, WAD, 1, 7)],
      }
      const { lines } = selectSavingsLine(listed, holdings, prices, stored, SCOPE, [], [])
      expect(selectBackupShares(lines, [rotation], ACCOUNT)).toEqual(
        new Map([
          [first.id, 3n * WAD],
          [second.id, 4n * WAD],
        ]),
      )
      expect(selectBackupShares(lines, [rotation], undefined)).toEqual(new Map())
    })
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
    expect(moveInLine(line(undefined, 0n))?.line.id).toBe("fea-sky-v6")
    const funded = line(undefined, 10n * WAD)
    expect(moveInLine(funded)?.line.id).toBe("fea-sky-v6")
    expect(moveOutSource(funded)).toMatchObject({
      line: { id: "fea-sky-v6" },
      position: { shares: 10n * WAD },
    })
  })

  it("shows no Savings under an empty list, and only a move out of shares already held", () => {
    expect(line([], 0n).lines).toEqual([])
    const held = line([], 10n * WAD)
    expect(held.lines).toMatchObject([{ line: { id: "fea-sky-v6", exitOnly: true } }])
    expect(moveInLine(held)).toBeUndefined()
  })

  it("lists Savings for the nav under a profile that names no holdings, and not under an empty list", () => {
    expect(selectSavingsListed(ready(PROD), undefined)).toBe(true)
    expect(selectSavingsListed(ready(PROD), ["fea-sky-v6"])).toBe(true)
    expect(selectSavingsListed(ready(PROD), [])).toBe(false)
    expect(selectSavingsListed({ status: "pending" }, undefined)).toBe(false)
  })
})
