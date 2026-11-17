/**
 * Funds on their way count in the balance they land in, at what will land, so a balance only drops
 * for a send or a withdrawal: a deposit from its sweep, a migration or a Savings move from its burn.
 */
import { describe, expect, it } from "vitest"
import { PaylinkActionEnum } from "@obsidion/core/constants"
import type { SipaDeposit } from "../../src/engine/sipaDeposits"
import type { WithdrawalPhase, WithdrawalRecord } from "../../src/core/services/bridge/types"
import type { MoveQuote, MoveRecord } from "../../src/engine/moveTransition"
import type { Transaction } from "../../src/types/transactions"
import { arrivingFunds } from "../../src/engine/activityFeed"
import type { HoldingPrice } from "../../src/core/services/holdings/holdingFigures"

const E18 = 10n ** 18n
const SIPA = `0x${"5a".repeat(20)}` as const
const SUSDS = "0xa3931d71877c0e7a3148cb7eb4463524fec27fbd"
const none = { deposits: [], burns: [], moves: [], rows: [] }

const deposit = (patch: Partial<SipaDeposit>): SipaDeposit =>
  ({ sipaAddress: SIPA, phase: "broadcast", amount: "800", ...patch } as SipaDeposit)

/** 85 gross, 0.1 tip, 0.3 arrival fee: 84.6 reaches the new balance. */
const migration = (phase: WithdrawalPhase): WithdrawalRecord =>
  ({
    localId: "m1",
    intent: "migration",
    recipient: SIPA,
    amount: "85",
    rawAmount: (85n * E18).toString(),
    relayerTip: (E18 / 10n).toString(),
    arrivalFee: ((3n * E18) / 10n).toString(),
    tokenSymbol: "DAI",
    phase,
    startTime: 1_000,
  } as WithdrawalRecord)

const quote = (out: bigint): MoveQuote => ({
  routed: out,
  relayerTip: 0n,
  conversionOut: out,
  conversionMinOut: out,
  expectedOut: out,
  minOut: out,
  withdrawalFee: 0n,
})

const move = (patch: Partial<MoveRecord>): MoveRecord =>
  ({
    id: "w1",
    holdingId: "fea-sky",
    rail: "executor",
    direction: "in",
    withdrawalLocalId: "w1",
    amount: 800n * E18,
    quote: quote((79_937n * E18) / 100n),
    phase: "burned",
    startTime: 1_000,
    ...patch,
  } as MoveRecord)

/** Each holding's price by its id, for 18-decimal shares of an asset of `assetDecimals`. */
const pricedAt = (prices: Record<string, bigint>, assetDecimals = 18) =>
  new Map<string, HoldingPrice>(
    Object.entries(prices).map(([id, sharePrice]) => [
      id,
      { sharePrice, shareDecimals: 18, assetDecimals, readAt: 0 },
    ]),
  )

const deposited = (amount: bigint) => ({ inboxIndex: 1n, amount, at: 1_000 })

/** A move's burn: 800 DAI, its release tip, and the escrow's tip. */
const moveBurn = (phase: WithdrawalPhase = "l2_mined"): WithdrawalRecord =>
  ({
    localId: "w1",
    amount: "800",
    rawAmount: (800n * E18).toString(),
    relayerTip: (E18 / 10n).toString(),
    skyMove: { direction: "in", relayerTip: (E18 / 2n).toString() },
    tokenSymbol: "DAI",
    phase,
    startTime: 1_000,
  } as WithdrawalRecord)
const mined = [moveBurn()]

const claim = (status: Transaction["status"], action: string = PaylinkActionEnum.CLAIM) =>
  ({ action, status, amountAtomic: 25n * E18, token: { decimals: 18 } } as unknown as Transaction)

describe("arrivingFunds", () => {
  it("counts a deposit from its sweep, at its net, until it is claimed", () => {
    const net = (7995n * E18) / 10n
    const at = (patch: Partial<SipaDeposit>) =>
      arrivingFunds({ ...none, deposits: [deposit(patch)] }).main
    expect(at({ phase: "broadcast" })).toBe(0n)
    expect(at({ phase: "sweeping" })).toBe(0n)
    expect(at({ phase: "pendingClaim", netAmount: net.toString() })).toBe(net)
    expect(at({ phase: "claimed", netAmount: net.toString() })).toBe(0n)
    expect(at({ phase: "recoverable" })).toBe(0n)
  })

  it("stops counting a deposit once Main is read after its claim landed, before it records claimed", () => {
    const net = (75n * E18) / 100n
    const landed = deposit({
      phase: "pendingClaim",
      inboxIndex: "26",
      netAmount: net.toString(),
      claimLanded: { inboxIndex: "26", at: 500 },
    })
    const at = (record: SipaDeposit, main?: number) =>
      arrivingFunds({ ...none, deposits: [record], balanceReadAt: { main } }).main
    expect(at(landed)).toBe(net)
    expect(at(landed, 499)).toBe(net)
    expect(at(landed, 500)).toBe(0n)
    // A later sweep on the same address is still on its way.
    expect(at({ ...landed, inboxIndex: "28" }, 500)).toBe(net)
  })

  it("stops counting a Savings deposit once Savings, not Main, is read after its claim landed", () => {
    const shares = 5n * E18
    const landed = deposit({
      phase: "pendingClaim",
      tokenAddress: SUSDS,
      inboxIndex: "26",
      netAmount: shares.toString(),
      claimLanded: { inboxIndex: "26", at: 500 },
    })
    const at = (balanceReadAt: { main?: number; holdings?: ReadonlyMap<string, number> }) =>
      arrivingFunds({
        ...none,
        deposits: [landed],
        savingsTokens: new Map([[SUSDS, "fea-sky"]]),
        holdingPrices: pricedAt({ "fea-sky": 2n * E18 }),
        balanceReadAt,
      })
    expect(at({ main: 500 })).toEqual({
      main: 0n,
      savings: 2n * shares,
      vaultSwapping: new Map(),
      savingsInto: new Map([["fea-sky", 2n * shares]]),
    })
    expect(at({ holdings: new Map([["fea-sky", 500]]) })).toEqual({
      main: 0n,
      savings: 0n,
      vaultSwapping: new Map(),
      savingsInto: new Map(),
    })
  })

  it("matches a share deposit to its holding by its token, whatever the holdings' rails", () => {
    const OTHER = `0x${"b7".repeat(20)}`
    const shares = 5n * E18
    const landed = deposit({
      phase: "pendingClaim",
      tokenAddress: OTHER.toUpperCase().replace("0X", "0x"),
      inboxIndex: "26",
      netAmount: shares.toString(),
      claimLanded: { inboxIndex: "26", at: 500 },
    })
    const at = (read: Record<string, number>, prices: Record<string, bigint>) =>
      arrivingFunds({
        ...none,
        deposits: [landed],
        savingsTokens: new Map([
          [SUSDS, "fea-first"],
          [OTHER, "fea-second"],
        ]),
        holdingPrices: pricedAt(prices),
        balanceReadAt: { holdings: new Map(Object.entries(read)) },
      })
    const prices = { "fea-first": 2n * E18, "fea-second": 3n * E18 }
    // Its own holding's price values it, and only its own holding's read holds it.
    expect(at({}, prices)).toEqual({
      main: 0n,
      savings: 3n * shares,
      vaultSwapping: new Map(),
      savingsInto: new Map([["fea-second", 3n * shares]]),
    })
    expect(at({ "fea-first": 900 }, prices).savings).toBe(3n * shares)
    expect(at({ "fea-second": 500 }, prices).savings).toBe(0n)
    // Unknown while its own holding is unpriced: the first holding's price never stands in.
    expect(at({}, { "fea-first": 2n * E18 })).toEqual({
      main: 0n,
      savings: 0n,
      vaultSwapping: new Map(),
      savingsInto: new Map(),
    })
  })

  it("counts a migration from its burn, then from its deposit's own net, never both", () => {
    const net = (846n * E18) / 10n
    const at = (burn: WithdrawalRecord, arrival?: Partial<SipaDeposit>) =>
      arrivingFunds({ ...none, burns: [burn], deposits: arrival ? [deposit(arrival)] : [] }).main
    expect(at(migration("l2_mined"))).toBe(net)
    expect(at(migration("l2_mined"), { phase: "broadcast", amount: "0" })).toBe(net)
    expect(at(migration("done"), { phase: "pendingClaim", netAmount: net.toString() })).toBe(net)
    expect(at(migration("done"), { phase: "claimed", netAmount: net.toString() })).toBe(0n)
    expect(at(migration("failed"))).toBe(0n)
  })

  it("counts a move into Savings at its quote, then at the shares it landed, at its holding's price", () => {
    const quoted = (79_937n * E18) / 100n
    const holdingPrices = pricedAt({ "fea-sky": (105n * E18) / 100n })
    expect(arrivingFunds({ ...none, burns: mined, moves: [move({})], holdingPrices })).toEqual({
      main: 0n,
      savings: quoted,
      vaultSwapping: new Map(),
      savingsInto: new Map([["fea-sky", quoted]]),
    })
    const landed = move({ phase: "depositSeen", deposit: deposited(760n * E18) })
    expect(arrivingFunds({ ...none, burns: mined, moves: [landed], holdingPrices }).savings).toBe(
      798n * E18,
    )
    // Unknown until its own holding is priced: another holding's price never stands in.
    const elsewhere = pricedAt({ "fea-other": E18 })
    for (const moves of [[move({})], [landed]])
      expect(
        arrivingFunds({ ...none, burns: mined, moves, holdingPrices: elsewhere }).savings,
      ).toBe(0n)
  })

  it("counts a swap in Savings, on the holding it leaves, at what its destination takes in, then at the shares it landed, at the destination's price", () => {
    const vaultSwapped = move({ direction: "out", holdingId: "fea-a", intoHoldingId: "fea-b" })
    const landed = {
      ...vaultSwapped,
      phase: "depositSeen" as const,
      deposit: deposited(760n * E18),
    }
    const holdingPrices = pricedAt({ "fea-b": (105n * E18) / 100n })
    const quoted = (79_937n * E18) / 100n
    expect(arrivingFunds({ ...none, burns: mined, moves: [vaultSwapped], holdingPrices })).toEqual({
      main: 0n,
      savings: quoted,
      vaultSwapping: new Map([["fea-a", quoted]]),
      savingsInto: new Map([["fea-b", quoted]]),
    })
    expect(arrivingFunds({ ...none, burns: mined, moves: [landed], holdingPrices })).toMatchObject({
      savings: 798n * E18,
      vaultSwapping: new Map([["fea-a", 798n * E18]]),
    })
    const source = pricedAt({ "fea-a": E18 })
    expect(
      arrivingFunds({ ...none, burns: mined, moves: [vaultSwapped], holdingPrices: source }),
    ).toEqual({ main: 0n, savings: 0n, vaultSwapping: new Map(), savingsInto: new Map() })
  })

  it("counts a move into a vault of a 6-decimal asset at dollars, at DEFAULT_DECIMALS", () => {
    // 800 DAI in, a Psm's 799.37 USDC quoted, 760 shares landed at 1.05 USDC each.
    const usdc = (79_937n * 10n ** 6n) / 100n
    const into = move({
      holdingId: "fea-vault",
      quote: { ...quote(760n * E18), conversionOut: usdc },
    })
    const holdingPrices = pricedAt({ "fea-vault": 1_050_000n }, 6)
    expect(arrivingFunds({ ...none, burns: mined, moves: [into], holdingPrices }).savings).toBe(
      (79_937n * E18) / 100n,
    )
    const landed = { ...into, phase: "depositSeen" as const, deposit: deposited(760n * E18) }
    expect(arrivingFunds({ ...none, burns: mined, moves: [landed], holdingPrices }).savings).toBe(
      798n * E18,
    )
  })

  it("counts a move back to Main at its quote, then at what it deposited", () => {
    const out = move({ direction: "out", quote: quote(500n * E18) })
    expect(arrivingFunds({ ...none, burns: mined, moves: [out] })).toEqual({
      main: 500n * E18,
      savings: 0n,
      vaultSwapping: new Map(),
      savingsInto: new Map(),
    })
    const landed = { ...out, phase: "depositSeen" as const, deposit: deposited(499n * E18) }
    expect(arrivingFunds({ ...none, burns: mined, moves: [landed] }).main).toBe(499n * E18)
  })

  it("counts nothing while a burn is still proving, as its source still holds the funds", () => {
    const proving = [moveBurn("submitting")]
    expect(arrivingFunds({ ...none, burns: proving, moves: [move({})] }).savings).toBe(0n)
    expect(arrivingFunds({ ...none, moves: [move({})] }).savings).toBe(0n)
    expect(arrivingFunds({ ...none, burns: [migration("submitting")] }).main).toBe(0n)
  })

  it("never counts a replayed move, whose deposit another device may have claimed already", () => {
    const out = move({
      direction: "out",
      amount: 100n * E18,
      quote: undefined,
      withdrawalLocalId: undefined,
      replayedFrom: "0xburn",
    })
    const found = { ...out, phase: "depositSeen" as const, deposit: deposited(103n * E18) }
    const claimed = { ...found, phase: "claimed" as const, endTime: 2_000 }
    const read = { main: 1_000 }
    for (const moves of [[out], [found], [claimed]])
      expect(arrivingFunds({ ...none, moves, balanceReadAt: read }).main).toBe(0n)
  })

  it("keeps a claim on its way until its own holding's balance is read after it", () => {
    const stored = move({ phase: "claimed", deposit: deposited(10n * E18), endTime: 500 })
    const at = (read: Record<string, number>) =>
      arrivingFunds({
        ...none,
        burns: mined,
        moves: [stored],
        holdingPrices: pricedAt({ "fea-sky": E18, "fea-other": E18 }),
        balanceReadAt: { holdings: new Map(Object.entries(read)) },
      }).savings
    expect(at({})).toBe(10n * E18)
    expect(at({ "fea-sky": 499 })).toBe(10n * E18)
    expect(at({ "fea-sky": 500 })).toBe(0n)
    // Another holding's read says nothing of this one's shares.
    expect(at({ "fea-other": 900 })).toBe(10n * E18)
  })

  it("clears a claimed move into the only holding listed, a vault on the executor", () => {
    const usdc = 10n * 10n ** 6n
    const claimed = move({
      holdingId: "fea-vault",
      quote: { ...quote(10n * E18), conversionOut: usdc },
      phase: "claimed",
      deposit: deposited(10n * E18),
      endTime: 500,
    })
    const at = (holdings: ReadonlyMap<string, number>) =>
      arrivingFunds({
        ...none,
        burns: mined,
        moves: [claimed],
        holdingPrices: pricedAt({ "fea-vault": 10n ** 6n }, 6),
        balanceReadAt: { main: 900, holdings },
      }).savings
    expect(at(new Map())).toBe(10n * E18)
    expect(at(new Map([["fea-vault", 600]]))).toBe(0n)
  })

  it("stops counting a move once it is claimed, recovered, or its burn failed", () => {
    const claimed = move({ phase: "claimed", deposit: deposited(1n) })
    const recovered = move({ phase: "recovered" })
    expect(arrivingFunds({ ...none, burns: mined, moves: [claimed] }).savings).toBe(0n)
    expect(arrivingFunds({ ...none, burns: mined, moves: [recovered] }).savings).toBe(0n)
    expect(arrivingFunds({ ...none, burns: [moveBurn("failed")], moves: [move({})] }).savings).toBe(
      0n,
    )
  })

  it("counts a link claim while its transaction is pending, and no send", () => {
    expect(arrivingFunds({ ...none, rows: [claim("pending")] }).main).toBe(25n * E18)
    expect(arrivingFunds({ ...none, rows: [claim("success")] }).main).toBe(0n)
    expect(arrivingFunds({ ...none, rows: [claim("pending", "send")] }).main).toBe(0n)
  })
})

/** An upgrade's own deposits never count: the upgrade lock holds Home's figure until the balance holds them. */
describe("arrivingFunds beside an upgrade", () => {
  const NET = 99n * E18
  const swept = (patch: Partial<SipaDeposit>) =>
    deposit({ phase: "pendingClaim", netAmount: NET.toString(), ...patch })

  it("counts no deposit an upgrade's batch pays", () => {
    const funds = arrivingFunds({
      ...none,
      deposits: [swept({ sipaAddress: `0x${"b2".repeat(20)}` })],
      upgradeRecipients: new Set([`0x${"b2".repeat(20)}`]),
    })

    expect(funds.main).toBe(0n)
  })

  it("counts no deposit a backup passkey rotation pays itself", () => {
    const funds = arrivingFunds({
      ...none,
      deposits: [swept({ sipaAddress: `0x${"c3".repeat(20)}`, intent: "add-passkey" })],
    })

    expect(funds.main).toBe(0n)
  })

  it("counts an ordinary deposit and what old versions hold", () => {
    expect(
      arrivingFunds({ ...none, deposits: [swept({})], oldVersions: { main: E18, savings: 0n } })
        .main,
    ).toBe(NET + E18)
  })

  it("keeps old Savings in Savings beside old Main and an ordinary deposit", () => {
    expect(
      arrivingFunds({
        ...none,
        deposits: [swept({})],
        oldVersions: { main: 59n * E18, savings: 40n * E18 },
      }),
    ).toEqual({
      main: NET + 59n * E18,
      savings: 40n * E18,
      vaultSwapping: new Map(),
      savingsInto: new Map(),
    })
  })
})

describe("arrivingFunds during a backup passkey add", () => {
  it("counts what the move still owes, Main as is and each holding's shares at its own price", () => {
    const shares = new Map([
      ["fea-sky", 4n * E18],
      ["fea-vault", 10n * E18],
    ])
    const backupMove = { main: 2n * E18, shares }
    const oldVersions = { main: E18, savings: 0n }
    const holdingPrices = new Map([
      ...pricedAt({ "fea-sky": E18 / 2n }),
      ...pricedAt({ "fea-vault": 1_100_000n }, 6),
    ])
    expect(arrivingFunds({ ...none, oldVersions, backupMove, holdingPrices })).toEqual({
      main: 3n * E18,
      savings: 2n * E18 + 11n * E18,
      vaultSwapping: new Map(),
      savingsInto: new Map([
        ["fea-sky", 2n * E18],
        ["fea-vault", 11n * E18],
      ]),
    })
    // A holding's shares count once it is priced.
    expect(
      arrivingFunds({ ...none, backupMove, holdingPrices: pricedAt({ "fea-sky": E18 / 2n }) })
        .savings,
    ).toBe(2n * E18)
    expect(arrivingFunds({ ...none, backupMove }).savings).toBe(0n)
  })
})

/** A rotated wallet's previous account shows its own arrivals on Home, apart from Main. */
describe("arrivingFunds beside a previous account", () => {
  const NET = 50n * E18
  const SESSION = `0x${"5e".repeat(32)}`
  const PREVIOUS = `0x${"0d".repeat(32)}`
  const swept = (recipientL2Address: string, fill: string) =>
    deposit({
      sipaAddress: `0x${fill.repeat(20)}`,
      phase: "pendingClaim",
      netAmount: NET.toString(),
      recipientL2Address,
    })

  it("adds nothing to Main for a swept deposit to the previous account", () => {
    const funds = arrivingFunds({
      ...none,
      deposits: [swept(`0x${"0D".repeat(32)}`, "d1")],
      previousAccount: PREVIOUS,
    })

    expect(funds.main).toBe(0n)
  })

  it("still counts the session account's own deposit beside it", () => {
    const funds = arrivingFunds({
      ...none,
      deposits: [swept(PREVIOUS, "d1"), swept(SESSION, "d2")],
      previousAccount: PREVIOUS,
    })

    expect(funds.main).toBe(NET)
  })

  it("counts a deposit with no recipient in Main, as before", () => {
    const funds = arrivingFunds({
      ...none,
      deposits: [swept("", "d3")],
      previousAccount: PREVIOUS,
    })

    expect(funds.main).toBe(NET)
  })

  it("counts every deposit in Main while no previous account is known", () => {
    expect(arrivingFunds({ ...none, deposits: [swept(PREVIOUS, "d1")] }).main).toBe(NET)
  })
})
