// @vitest-environment node
// An upgraded device's Savings moves, as the base build wrote them (`savingsStore.base.json`), read
// by the moves store and the rail. The rail's keys come from the fixture's secret and each nonce.
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { deploymentHoldings, oxideManifestDeployments } from "@obsidion/core/oxide"
import { computeRecipientCommitment } from "@oxide/oxide-lib/recipient_commitment.js"
import { getAddress, isAddressEqual, type Address, type Hex } from "viem"
import { describe, expect, it, vi } from "vitest"
import { selectMoveRecoverable } from "../../src/core/services/moves/openMoves"
import { replayPass } from "../../src/core/services/moves/replayMoves"
import { settlePass } from "../../src/core/services/moves/settleMoves"
import { skyEscrowRoutes, type SkyEscrowRoute } from "../../src/core/services/moves/skyEscrowRoutes"
import {
  bindRail,
  type DepositClaim,
  type MoveBurn,
  type MovePorts,
} from "../../src/core/services/moves/types"
import { savingsValue } from "../../src/core/services/savings/savingsMath"
import type { WithdrawalRecord } from "../../src/core/services/bridge/types"
import { openDatabase } from "../../src/engine/database"
import { moveExitOffer } from "../../src/engine/feedRules"
import { savingsHoldingRef } from "../../src/engine/holdings"
import { memoryBackend } from "../../src/engine/memoryBackend"
import { selectMoveState } from "../../src/engine/moveState"
import { isMoveSettled, type MovePhase, type MoveRecord } from "../../src/engine/moveTransition"
import { createMoveStore } from "../../src/engine/moves"
import { memoryStore } from "../../src/engine/store"
import { decodeRecord, loadRecords } from "../../src/engine/persistentStore"
import { createWithdrawals } from "../../src/engine/withdrawals"
import { selectFeed, type FeedItem, type FeedSources } from "../../src/engine/activityFeed"
import { holdingEarned, holdingLedger } from "../../src/engine/holdingLedger"
import { deriveSkyEscrowSalts } from "../../src/oxide/oxideAccountKeys"
import { SAVED_START_MARGIN_MS } from "../../src/storageMigrations/savingsMoves"
import base from "../fixtures/savingsStore.base.json"
import prodReleases from "../fixtures/oxideReleases.v6-prod.json"
import {
  fakeAccount,
  fakeEscrowRoutes,
  fakeL1,
  SKY_FACTORY,
  SKY_HOLDING,
} from "../services/moves/fixtures"

type Case = keyof typeof base.cases
type Stored = { depositScanFloor?: string; depositScanFrom?: string; vault?: { assets: string } }

const [PROD] = oxideManifestDeployments(prodReleases)
const SKY = savingsHoldingRef(deploymentHoldings(PROD!), ["fea-sky-v6"])!
/** The fake escrow rail over the one listed Sky holding, under `id`. */
const skyRail = (routes: ReturnType<typeof fakeEscrowRoutes>, id = SKY.id) =>
  bindRail({ routes, holdings: [{ ...SKY_HOLDING, id }], listed: new Set([id]) })
const CURRENT: Record<string, string> = base.databases.current
const ACCOUNT = AztecAddress.fromStringUnsafe(base.recipient)
const salts = (nonce: Hex) => deriveSkyEscrowSalts(base.secret as Hex, nonce)
const keys = (nonce: Hex) => ({
  salt: salts(nonce).recovery,
  account: base.recoveryAccount as Address,
})

/** The conversion reads L1 only for a move that kept no floor to search from. */
const noL1 = async (): Promise<bigint> => {
  throw new Error("this conversion reads no L1 block")
}

function open(entries: Record<string, string>, blockAt = noL1) {
  const backend = memoryBackend(new Map(Object.entries(entries)))
  const db = openDatabase(backend)
  const now = () => base.now
  const withdrawals = createWithdrawals({ db, now })
  const saved = { withdrawals: withdrawals.ready, sky: async () => SKY, blockAt }
  const moves = createMoveStore(db, saved)
  return { backend, db, now, withdrawals, moves }
}

async function converted(entries: Record<string, string> = CURRENT, blockAt = noL1) {
  const opened = open(entries, blockAt)
  await opened.moves.ready
  const byId = new Map((await loadRecords(opened.moves.view)).map((r) => [r.id, r]))
  return { ...opened, byId }
}

const caseOf = (name: Case) =>
  base.cases[name] as (typeof base.cases)[Case] & Record<string, string>
const recordOf = (byId: Map<string, MoveRecord>, name: Case) => {
  const record = byId.get(caseOf(name).withdrawalLocalId)
  if (!record) throw new Error(`${name} was not converted`)
  return record
}

/** The phase each base state converts to. A release nobody ran leaves the route unrun: `burned`. */
const PHASES: [Case, MovePhase][] = [
  ["burned", "burned"],
  ["releasedNoDeposit", "burned"],
  ["depositSeen", "depositSeen"],
  ["claimed", "claimed"],
  ["recovered", "recovered"],
  ["failedBurn", "failed"],
  ["noFactory", "claimed"],
  ["retiredOpen", "migrated"],
  ["retiredClaimed", "claimed"],
]

describe("converting the base build's Savings moves", () => {
  it.each(PHASES)(
    "converts a %s move to %s, with its escrow, keys and deposit",
    async (name, phase) => {
      vi.spyOn(console, "warn").mockImplementation(() => {})
      const { byId } = await converted()
      const saved = caseOf(name)
      const stored = JSON.parse(CURRENT[`acct/savingsMoves/${saved.withdrawalLocalId}`]!) as Stored
      const record = recordOf(byId, name)
      expect(record).toMatchObject({
        phase,
        holdingId: "fea-sky-v6",
        rail: "skyEscrow",
        direction: saved.direction,
        amount: BigInt(saved.amount),
        nonce: saved.nonce,
        recipientCommitment: saved.recipientCommitment,
        scanFrom: BigInt(stored.depositScanFloor ?? stored.depositScanFrom!),
      })
      if (record.rail !== "skyEscrow") throw new Error("not an escrow move")
      expect(isAddressEqual(record.escrow.factory, base.addresses.factory as Address)).toBe(true)
      expect(isAddressEqual(record.escrow.address, saved.escrow as Address)).toBe(true)
      if (saved.inboxIndex)
        expect(record.deposit).toMatchObject({
          inboxIndex: BigInt(saved.inboxIndex),
          amount: BigInt(saved.depositShares),
        })
      else expect(record.deposit).toBeUndefined()
      expect(record.assets).toBe(stored.vault ? BigInt(stored.vault.assets) : undefined)
      // The quote keeps the executor's fee a move in paid, and the burn's figures still add up.
      const quote = record.quote!
      const burn = JSON.parse(CURRENT[`acct/withdrawals/${saved.withdrawalLocalId}`]!) as {
        withdrawalFee?: string
      }
      expect(quote.withdrawalFee).toBe(
        BigInt((saved.direction === "in" && burn.withdrawalFee) || 0),
      )
      expect(quote.relayerTip + quote.withdrawalFee + quote.routed).toBe(record.amount)
    },
  )

  it("converts a move only the older blob holds", async () => {
    const { byId } = await converted(base.databases.blobOnly)
    expect(recordOf(byId, "blobOnly")).toMatchObject({ phase: "claimed", holdingId: "fea-sky-v6" })
  })

  it("skips a damaged move, logging it, and converts the rest", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { byId } = await converted()
    expect(byId.has(caseOf("damaged").withdrawalLocalId)).toBe(false)
    expect(byId.size).toBe(PHASES.length)
    expect(warn.mock.calls.flat().join(" ")).toMatch(/skipped 1 saved move\(s\): damaged/)
  })

  it("keeps every key the base build wrote, byte for byte", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const { backend } = await converted()
    const kept = Object.fromEntries(Object.keys(CURRENT).map((k) => [k, backend.entries.get(k)]))
    expect(kept).toEqual(CURRENT)
  })

  it("converts once: a second open reads the same records, and replay adds none", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const first = await converted()
    const again = createMoveStore(first.db, {
      withdrawals: first.withdrawals.ready,
      sky: async () => SKY,
    })
    await again.ready
    expect(await loadRecords(again.view)).toEqual([...first.byId.values()])

    // The chain shows every converted move's burn; a fresh store writes them, this one none.
    const l1 = fakeL1()
    const account = fakeAccount(l1)
    const burns: MoveBurn[] = [...first.byId.values()].flatMap((r) =>
      r.rail === "skyEscrow"
        ? [
            {
              rail: "skyEscrow",
              escrow: { ...r.escrow, factory: SKY_FACTORY },
              txHash: `0x${r.nonce.slice(4, 66).padStart(64, "0")}`,
              timestampMs: r.startTime,
              withdrawalId: r.nonce,
              amount: r.amount,
              nonce: r.nonce,
              recipientCommitment: l1.commitment(
                account.salts(r.nonce, "skyEscrow").recipient,
                account.address,
              ),
            },
          ]
        : [],
    )
    const ports: MovePorts = {
      rails: memoryStore([skyRail(fakeEscrowRoutes(l1), SKY_HOLDING.id)]).readonly,
      account: { ...account, moveBurns: async () => ({ burns, unread: false }) },
    }
    const signal = new AbortController().signal
    const replay = (opened: ReturnType<typeof open>) =>
      replayPass({ ...opened, moves: opened.moves }, ports, signal)
    expect((await replay(first)).written).toBe(0)
    expect((await replay(open({}))).written).toBe(burns.length)
  })
})

/** `entries` with `name`'s saved move and burn edited. */
function edited(
  entries: Record<string, string>,
  name: Case,
  edit: {
    move?: (m: Record<string, unknown>) => void
    burn?: (b: Record<string, unknown>) => void
  },
) {
  const id = caseOf(name).withdrawalLocalId
  const [moveKey, burnKey] = [`acct/savingsMoves/${id}`, `acct/withdrawals/${id}`]
  const move = JSON.parse(entries[moveKey]!) as Record<string, unknown>
  const burn = JSON.parse(entries[burnKey]!) as Record<string, unknown>
  edit.move?.(move)
  edit.burn?.(burn)
  return { ...entries, [moveKey]: JSON.stringify(move), [burnKey]: JSON.stringify(burn) }
}

/** `console.warn` silenced, holding the calls made from here on. */
function warnings() {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  warn.mockClear()
  return warn
}

/** Saved moves that pass the shape check and hold a figure or field that does not read. */
const MALFORMED: [string, Case, Parameters<typeof edited>[2]][] = [
  ["an amount that is no whole number", "burned", { move: (m) => (m.amount = "12.5") }],
  [
    "a deposit with no inbox index",
    "depositSeen",
    { move: (m) => (m.deposit = { amount: "5", claimed: false }) },
  ],
  [
    "a deposit amount that is no whole number",
    "claimed",
    { move: (m) => (m.deposit = { inboxIndex: "1", amount: "1e3", claimed: true }) },
  ],
  ["a quote figure that is no number", "burned", { move: (m) => (m.net = "n/a") }],
  ["a search cursor that is no number", "burned", { move: (m) => (m.depositScanFloor = "latest") }],
  ["a vault figure that is missing", "claimed", { move: (m) => (m.vault = {}) }],
  [
    "a recovery with no transactions",
    "recovered",
    { move: (m) => (m.recovered = { to: base.recoveredTo }) },
  ],
  ["a factory that is no address", "burned", { move: (m) => (m.factory = 7) }],
  ["no escrow", "burned", { move: (m) => delete m.escrow }],
  ["no nonce", "depositSeen", { move: (m) => delete m.nonce }],
  ["no recipient commitment", "burned", { move: (m) => delete m.recipientCommitment }],
  ["a burn tip that is no whole number", "burned", { burn: (b) => (b.relayerTip = "0.42") }],
]

describe("converting what a move's records cannot place", () => {
  it("converts a move whose escrow ran as released, so it offers no recovery", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const entries = edited(CURRENT, "burned", { move: (m) => (m.vault = { assets: "490" }) })
    const record = recordOf((await converted(entries)).byId, "burned")
    expect(record).toMatchObject({ phase: "released", assets: 490n })
    expect(selectMoveRecoverable(record, new Set(["skyEscrow"]))).toBe(false)
  })

  it("skips a move whose burn is no Sky burn, or names another factory, and converts the rest", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const other = `0x${"0f".repeat(20)}`
    const noMeta = edited(CURRENT, "burned", { burn: (b) => delete b.skyMove })
    const both = edited(noMeta, "claimed", { move: (m) => (m.factory = other) })
    const { byId } = await converted(both)
    expect(byId.has(caseOf("burned").withdrawalLocalId)).toBe(false)
    expect(byId.has(caseOf("claimed").withdrawalLocalId)).toBe(false)
    expect(byId.size).toBe(PHASES.length - 2)
  })

  it.each(MALFORMED)(
    "skips a move with %s, logging it, and converts the rest",
    async (_label, name, edit) => {
      const warn = warnings()
      const entries = edited(CURRENT, name, edit)
      const { byId, backend } = await converted(entries)
      expect(byId.has(caseOf(name).withdrawalLocalId)).toBe(false)
      expect(byId.size).toBe(PHASES.length - 1)
      expect(warn.mock.calls.flat().join(" ")).toMatch(/skipped 1 saved move\(s\): malformed/)
      // As for a damaged move: its old keys stay, and the store's version is saved.
      const kept = Object.fromEntries(Object.keys(entries).map((k) => [k, backend.entries.get(k)]))
      expect(kept).toEqual(entries)
      expect(backend.entries.has("acct/meta/moves")).toBe(true)
    },
  )

  it("logs why a move did not convert, once for its id", async () => {
    const warn = warnings()
    const entries = edited(CURRENT, "burned", { move: (m) => (m.amount = "12.5") })
    await converted(entries)
    const id = caseOf("burned").withdrawalLocalId
    const named = warn.mock.calls.filter((call) => call.some((arg) => String(arg).includes(id)))
    expect(named).toHaveLength(1)
    expect(named[0]?.some((arg) => arg instanceof SyntaxError)).toBe(true)
  })

  it("logs the malformed moves once, with their count", async () => {
    const warn = warnings()
    const one = edited(CURRENT, "burned", { move: (m) => (m.amount = "12.5") })
    const two = edited(one, "depositSeen", { move: (m) => (m.deposit = { amount: "5" }) })
    const { byId } = await converted(two)
    expect(byId.size).toBe(PHASES.length - 2)
    const logged = warn.mock.calls
      .map((call) => call.join(" "))
      .filter((l) => /: malformed/.test(l))
    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatch(/skipped 2 saved move\(s\)/)
  })

  it("fails the open with no Sky holding, keeping the old keys for a later open to convert", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const backend = memoryBackend(new Map(Object.entries(CURRENT)))
    const db = openDatabase(backend)
    const withdrawals = createWithdrawals({ db, now: () => base.now })
    const none = createMoveStore(db, { withdrawals: withdrawals.ready, sky: async () => undefined })
    await expect(none.ready).rejects.toMatchObject({ code: "holding.noRoute" })
    expect(backend.entries.has("acct/meta/moves")).toBe(false)
    expect([...backend.entries.keys()].some((k) => k.startsWith("acct/moves/"))).toBe(false)

    const later = createMoveStore(db, { withdrawals: withdrawals.ready, sky: async () => SKY })
    await later.ready
    expect(await loadRecords(later.view)).toHaveLength(PHASES.length)
    const kept = Object.fromEntries(Object.keys(CURRENT).map((k) => [k, backend.entries.get(k)]))
    expect(kept).toEqual(CURRENT)
  })
})

describe("a converted move still works", () => {
  it("settles a converted depositSeen move by claiming its deposit with the move's own secret", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const opened = await converted()
    const l1 = fakeL1()
    const claims: DepositClaim[] = []
    const ports: MovePorts = {
      rails: memoryStore([skyRail(fakeEscrowRoutes(l1))]).readonly,
      account: {
        ...fakeAccount(l1),
        address: ACCOUNT,
        salts: (nonce) => salts(nonce),
        claim: async (_bridge, claim) => void claims.push(claim),
      },
    }
    const deps = { ...opened, refreshBalance: async () => undefined }
    await settlePass(deps, ports, new AbortController().signal)
    const saved = caseOf("depositSeen")
    expect((await opened.moves.get(saved.withdrawalLocalId))?.phase).toBe("claimed")
    const [claim] = claims
    expect(claim).toMatchObject({
      inboxIndex: BigInt(saved.inboxIndex),
      amount: BigInt(saved.depositShares),
    })
    // The secret opens the deposit the base build's escrow committed to.
    const opens = (await computeRecipientCommitment(claim!.secret, ACCOUNT)).toString()
    expect(opens).toBe(saved.recipientCommitment)
  })

  it("keeps a stalled move recoverable and runnable, its escrow opening to the account's keys", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const { byId, withdrawals } = await converted()
    const routes = skyEscrowRoutes({
      l1: { readContract: async () => 1n } as never,
      broadcaster: async () => {
        throw new Error("no broadcaster")
      },
    })
    const route = { base: { token: getAddress(base.addresses.main.token) } } as SkyEscrowRoute
    for (const name of ["burned", "releasedNoDeposit"] as const) {
      const record = recordOf(byId, name)
      if (record.rail !== "skyEscrow") throw new Error("not an escrow move")
      expect(isMoveSettled(record)).toBe(false)
      expect(selectMoveRecoverable(record, new Set(["skyEscrow"]))).toBe(true)
      const call = await routes.run!(route, record, keys(record.nonce))
      expect(isAddressEqual(call.to, SKY.factory)).toBe(true)
      const other = { ...keys(record.nonce), salt: salts(base.cases.claimed.nonce as Hex).recovery }
      await expect(routes.run!(route, record, other)).rejects.toMatchObject({
        code: "move.recoveryKeysMismatch",
      })
    }
    // The escrow its release funded, which nobody ran, offers the run.
    const released = recordOf(byId, "releasedNoDeposit")
    const burn = (await withdrawals.get(released.withdrawalLocalId!)) as WithdrawalRecord
    const state = selectMoveState(released, burn, base.now)
    const rail = { recoverable: true, runnable: true }
    expect(moveExitOffer({ state, move: released, burn }, rail, base.now)).toBe("run")
  })

  it("is owned by production's Sky route, so a replay on a fresh device reads it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const { byId } = await converted()
    const routes = skyEscrowRoutes({ l1: {} as never, broadcaster: async () => ({} as never) })
    const route = { factory: getAddress(SKY.factory) } as SkyEscrowRoute
    for (const record of byId.values()) {
      if (record.rail !== "skyEscrow") throw new Error("not an escrow move")
      const burn: MoveBurn = {
        rail: "skyEscrow",
        escrow: record.escrow,
        txHash: "0x",
        timestampMs: record.startTime,
        withdrawalId: record.nonce,
        amount: record.amount,
        nonce: record.nonce,
        recipientCommitment: record.recipientCommitment,
      }
      expect(routes.owns(route, burn)).toBe(true)
      const stray = { ...burn, escrow: { ...record.escrow, factory: SKY_FACTORY } } as MoveBurn
      expect(routes.owns(route, stray)).toBe(false)
    }
  })
})

describe("a move saved without its search floor", () => {
  const saved = base.cases.cursorOnly
  const was = base.base.cursorOnly
  const FIRST = BigInt(base.chain.firstBlock)
  const DEPOSIT_BLOCK = BigInt(was.move.deposit.blockNumber)
  const ENTRIES: Record<string, string> = base.databases.cursorOnly

  /** The chain the base build's pass read: the release, the run, and the deposit at its block. */
  async function chain() {
    const l1 = fakeL1({ number: FIRST, timeMs: base.chain.firstBlockAt })
    while (l1.head() < DEPOSIT_BLOCK - 3n) await l1.mine()
    await l1.release(SKY_HOLDING.base.portal as Address, saved.withdrawalId as Hex)
    const escrow = { factory: SKY_FACTORY, address: saved.escrow as Address, tip: 0n }
    await l1.run({ rail: "skyEscrow", escrow, target: escrow.address, withdrawal: {} }, 1n)
    const portal = SKY_HOLDING.held.portal as Address
    await l1.deposit(portal, saved.recipientCommitment as Hex, BigInt(was.move.deposit.amount))
    while (l1.head() < BigInt(saved.head)) await l1.mine()
    return l1
  }

  it("finds the deposit below its cursor and claims it, as the base build did", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const l1 = await chain()
    const routes = fakeEscrowRoutes(l1)
    const opened = await converted(ENTRIES, routes.blockAt)
    expect(BigInt(saved.cursor)).toBeGreaterThan(DEPOSIT_BLOCK)
    const claims: DepositClaim[] = []
    const ports: MovePorts = {
      rails: memoryStore([skyRail(routes)]).readonly,
      account: {
        ...fakeAccount(l1),
        address: ACCOUNT,
        salts: (nonce) => salts(nonce),
        claim: async (_bridge, claim) => void claims.push(claim),
      },
    }
    const deps = { ...opened, refreshBalance: async () => undefined }
    await settlePass(deps, ports, new AbortController().signal)
    expect(await opened.moves.get(saved.withdrawalLocalId)).toMatchObject({
      phase: was.move.deposit.claimed ? "claimed" : "depositSeen",
      deposit: { amount: BigInt(was.move.deposit.amount) },
    })
    expect(claims).toHaveLength(was.claims)
  })

  const scanFromOf = async (entries: Record<string, string>, blockAt = noL1) =>
    recordOf((await converted(entries, blockAt)).byId, "cursorOnly").scanFrom

  it("searches from the head its burn kept, before its cursor", async () => {
    const head = FIRST + 550n
    const entries = edited(ENTRIES, "cursorOnly", {
      burn: (b) => ((b.skyMove as Record<string, unknown>).depositScanFrom = String(head)),
    })
    expect(await scanFromOf(entries)).toBe(head)
  })

  it("searches from an hour before its start when its burn kept no head", async () => {
    const l1 = await chain()
    const hour = BigInt(SAVED_START_MARGIN_MS / 12_000)
    const started = FIRST + BigInt((saved.startTime - base.chain.firstBlockAt) / 12_000)
    expect(await scanFromOf(ENTRIES, fakeEscrowRoutes(l1).blockAt)).toBe(started - hour)
  })

  it("searches from the holding's first block when its burn's start time is a guess", async () => {
    const entries = edited(ENTRIES, "cursorOnly", { burn: (b) => (b.startTimeEstimated = true) })
    const first = BigInt(base.addresses.main.deployedAtBlock)
    expect(first).toBeLessThan(BigInt(base.addresses.savings.deployedAtBlock))
    expect(await scanFromOf(entries)).toBe(first)
  })

  it("fails the open when the floor's block cannot be read, for a later open to convert", async () => {
    const down = new Error("rpc down")
    const opened = open(ENTRIES, () => Promise.reject(down))
    await expect(opened.moves.ready).rejects.toBe(down)
    expect(opened.backend.entries.has("acct/meta/moves")).toBe(false)
  })
})

describe("a move the base build rebuilt from its burn", () => {
  it("counts at the cost the base build counted, so Earned reads the same", async () => {
    const entries: Record<string, string> = base.databases.restored
    const { byId } = await converted(entries)
    const burns = Object.entries(entries)
      .filter(([key]) => /^acct\/withdrawals\/[^/]+$/.test(key))
      .map(([, raw]) => decodeRecord(raw) as WithdrawalRecord)
    const ledger = holdingLedger([...byId.values()], new Map(burns.map((w) => [w.localId, w])))
    const was = base.base.restored
    expect(ledger).toMatchObject({
      basis: BigInt(was.ledger.basis),
      shares: BigInt(was.ledger.shares),
      counted: was.ledger.counted,
      excluded: [],
    })
    const held = BigInt(was.held)
    const value = savingsValue(held, BigInt(base.base.sharePrice))
    expect(holdingEarned(ledger, value, held, 18)).toBe(BigInt(was.ledger.earned))
  })
})

describe("production's manifest", () => {
  it("lists one Sky holding, fea-sky-v6, on the v6 DAI and sUSDS bridges", () => {
    const { holdings, rejected } = deploymentHoldings(PROD!)
    expect(rejected).toEqual([])
    expect(holdings).toHaveLength(1)
    const [sky] = holdings
    if (sky?.rail !== "skyEscrow") throw new Error("not a Sky holding")
    expect(sky.id).toBe("fea-sky-v6")
    expect(isAddressEqual(sky.escrow.factory as Address, base.addresses.factory as Address)).toBe(
      true,
    )
    const executor = sky.escrow.withdrawalExecutor as Address
    expect(isAddressEqual(executor, base.addresses.skyExecutor as Address)).toBe(true)
    expect(isAddressEqual(sky.base.portal as Address, base.addresses.main.portal as Address)).toBe(
      true,
    )
    expect(
      isAddressEqual(sky.held.portal as Address, base.addresses.savings.portal as Address),
    ).toBe(true)
  })
})

describe("an upgraded device shows what the base build showed", () => {
  const view = async (
    entries: Record<string, string>,
    readAt = base.base.arriving.balanceReadAt,
  ) => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const { byId } = await converted(entries)
    const moves = [...byId.values()]
    const withdrawals = Object.entries(entries)
      .filter(([key]) => /^acct\/withdrawals\/[^/]+$/.test(key))
      .map(([, raw]) => decodeRecord(raw) as WithdrawalRecord)
    const loaded = <R>(records: R[]) => ({ records, loaded: true, failed: false })
    const sources: FeedSources = {
      rows: loaded([]),
      links: loaded([]),
      operations: loaded([]),
      requests: [],
      deposits: loaded([]),
      withdrawals: { records: withdrawals, hydrated: true },
      bridgeIns: { records: [], hydrated: true },
      upgrades: { items: [], recipients: new Set(), loaded: true },
      moves: loaded(moves),
      movesReplayed: true,
      oldVersionWithdrawals: [],
      processing: new Map(),
      rotations: [],
      catchingUp: false,
      now: base.now,
    }
    const sharePrice = BigInt(base.base.sharePrice)
    // The app prices each move at its own holding's price: every holding here is Sky's.
    const price = { sharePrice, shareDecimals: 18, assetDecimals: 18, readAt: 0 }
    const feed = selectFeed(sources, {
      contacts: { rows: [], hydrated: true, failed: false },
      registrations: { records: [] },
      sharePrice,
      holdingPrices: new Map(moves.map((move) => [move.holdingId, price])),
      balanceReadAt: readAt,
    })
    const ledger = holdingLedger(moves, new Map(withdrawals.map((w) => [w.localId, w])))
    return { feed, ledger, sharePrice }
  }
  const rows = (items: readonly FeedItem[]) =>
    items.flatMap((i) =>
      i.kind === "move" ? [{ id: i.move.id, pending: i.pending, direction: i.direction }] : [],
    )
  const baseRows = (items: readonly { id: string; pending: boolean; direction: string }[]) =>
    items.map(({ id, pending, direction }) => ({ id, pending, direction }))

  it("lists the same rows in Savings and Main, in order, each pending or not as before", async () => {
    const { feed } = await view(CURRENT)
    expect(rows(feed.savings.items)).toEqual(baseRows(base.base.feed.savings))
    expect(rows(feed.items)).toEqual(baseRows(base.base.feed.main))
  })

  it("counts the same cost, shares and Earned, and the same funds arriving, once each", async () => {
    const { feed, ledger, sharePrice } = await view(CURRENT)
    const was = base.base.ledger
    expect(ledger).toMatchObject({
      basis: BigInt(was.basis),
      shares: BigInt(was.shares),
      counted: was.counted,
      excluded: [],
    })
    const held = BigInt(base.base.held)
    const earned = holdingEarned(ledger, savingsValue(held, sharePrice), held, 18)
    expect(earned).toBe(BigInt(was.earned))
    expect(feed.arriving).toEqual({
      main: BigInt(base.base.arriving.main),
      savings: BigInt(base.base.arriving.savings),
    })
  })

  it("shows a device with only the older blob the same row and Earned", async () => {
    const { feed, ledger, sharePrice } = await view(base.databases.blobOnly)
    const was = base.base.blobOnly
    expect(rows(feed.savings.items)).toEqual(baseRows(was.feed.savings))
    expect(rows(feed.items)).toEqual(baseRows(was.feed.main))
    const held = BigInt(was.held)
    const earned = holdingEarned(ledger, savingsValue(held, sharePrice), held, 18)
    expect(earned).toBe(BigInt(was.ledger.earned))
  })
})
