// @vitest-environment node
// The link codec's byte checks need one realm, which jsdom splits.
/**
 * The account's created links and their move out of the activity rows: activity's open moves every
 * link in its own write, the secret is in the new record before the row loses it, and the paylinks
 * store opens after it.
 */
import { describe, expect, it } from "vitest"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { DEFAULT_CONTRACTS, PaylinkActionEnum } from "@obsidion/core/constants"
import { Grumpkin } from "@aztec-labs/foundation/crypto/grumpkin"
import { encodePaylinkInline, type PaylinkParams } from "@obsidion/sdk"
import { paylinkIdentity } from "../../src/core/services/paylink/paylinkIdentity"
import { ACCOUNT_STORAGE_KEY, TRANSACTIONS_STORAGE_KEY } from "../../src/core/storages/constants"
import { openDatabase } from "../../src/engine/database"
import { memoryBackend, type MemoryBackend } from "../../src/engine/memoryBackend"
import {
  OPEN,
  createPaylinks,
  linkId,
  linkIdFor,
  linkIdentity,
  legacyLinkRows,
  moveLinksOut,
} from "../../src/engine/paylinks"
import { decodeRecord, encodeRecord, loadRecords } from "../../src/engine/persistentStore"
import { createTransfers } from "../../src/engine/transfers"
import { operationIndex } from "../../src/engine/operations"
import type { PaylinkRecord } from "../../src/engine/paylinkTransition"
import type { OperationRecord } from "../../src/engine/operationTransition"
import type { PaylinkTransaction, Transaction } from "../../src/types/transactions"

const NS = "obsidion.ns."
const SECRET = new Fr(7n).toString()
const OTHER_SECRET = new Fr(8n).toString()
/** The rows' URLs name no rollup this build reads, so their records' rollup is their network. */
const ID = linkId("direct", SECRET, "0xnet")

/** A created link's activity row as builds before this one saved it. */
const linkRow = (over: Record<string, unknown> = {}) => ({
  id: "op-1",
  operationId: "op-1",
  action: "Pay To Email",
  emailPaymentAction: "Pay To Email",
  flavor: "direct",
  kind: "paylink-create",
  timestamp: 1_000,
  status: "success",
  txHash: "0xfund",
  amountAtomic: 25n,
  networkId: "0xnet",
  token: {
    symbol: "DAI",
    name: "Dai",
    address: "0xtoken",
    logo: "",
    amount: 25,
    decimals: 18,
    price: 1,
  },
  tokenAddress: "0xtoken",
  payToEmailSecret: SECRET,
  fallbackSecret: "0xfallback",
  obsidionAccountAddress: "0xme",
  paylink: `https://wallet/link#${SECRET}`,
  to: "alice@example.com",
  memo: "dinner",
  fromClaimable: 10,
  untilClaimable: 20,
  refundableUntil: 30,
  reorgEpoch: 2,
  ...over,
})

/** Rows an `activity` store at `activityVersion` kept, or, with none, rows under `transfers`. */
function seed(rows: Record<string, unknown>[], activityVersion: string | null = "3") {
  const backend = memoryBackend()
  const prefix = activityVersion ? "acct/activity" : "acct/transfers"
  for (const row of rows) backend.entries.set(`${NS}${prefix}/${row.id}`, encodeRecord(row))
  if (activityVersion) backend.entries.set(`${NS}acct/meta/activity`, activityVersion)
  return backend
}
const db = (backend: MemoryBackend) => openDatabase(backend).scoped(NS)
const row = (backend: MemoryBackend, id: string, prefix = "acct/transfers") =>
  decodeRecord(backend.entries.get(`${NS}${prefix}/${id}`)!) as Record<string, unknown>
/** The session's two stores: activity's open moves the links, and paylinks opens after it. */
const openStores = (backend: MemoryBackend) =>
  createPaylinks({
    db: db(backend),
    transfers: createTransfers({ db: db(backend), now: () => Date.now() }),
  })
/** What an activity migration does with the rows it holds. */
const activityMoves = (backend: MemoryBackend, ids: string[]) =>
  db(backend).write((w) => moveLinksOut(w, ids))
const secretInKeys = (backend: MemoryBackend, secret: string) =>
  [...backend.entries.keys()].some((key) =>
    key.toLowerCase().includes(secret.slice(2).toLowerCase()),
  )

/** A link's fragment params on rollup `rollupVersion`. */
const params = (rollupVersion: number): PaylinkParams => ({
  secret: new Fr(7n),
  paylinkType: DEFAULT_CONTRACTS.paylinkDirect,
  classId: new Fr(2n),
  chainId: 31337,
  fallbackKeyHash: new Fr(3n),
  rollupVersion,
  escrowTagSecret: Grumpkin.generator,
})
const urlOn = (rollupVersion: number) =>
  `https://wallet/link#${encodePaylinkInline(params(rollupVersion))}`

describe("a link's key", () => {
  it("keeps two rollups' links with one secret apart through a historic import", async () => {
    const backend = seed([linkRow({ paylink: urlOn(1), txHash: "0xone" })], null)
    const transfers = createTransfers({ db: db(backend), now: () => Date.now() })
    await transfers.ready
    const other = linkRow({ id: "op-2", operationId: "op-2", paylink: urlOn(2), txHash: "0xtwo" })
    expect(await transfers.importHistoricRows([other])).toBe(1)
    const paylinks = openStores(backend)
    const one = await paylinks.get(linkIdFor(params(1)))
    const two = await paylinks.get(linkIdFor(params(2)))
    expect([one?.paylink, one?.txHash]).toEqual([urlOn(1), "0xone"])
    expect([two?.paylink, two?.txHash]).toEqual([urlOn(2), "0xtwo"])
  })
})

describe("linkIdentity", () => {
  it("is the key paylinkIdentity derives from the escrow's params", () => {
    expect(linkIdentity(DEFAULT_CONTRACTS.paylinkDirect, SECRET)).toBe(
      paylinkIdentity({ paylinkType: DEFAULT_CONTRACTS.paylinkDirect, secret: new Fr(7n) }),
    )
  })
})

describe("createPaylinks: the move out of activity", () => {
  it("files a link with every field, and leaves activity the funding transfer", async () => {
    const backend = seed([linkRow()])
    const paylinks = openStores(backend)
    await paylinks.ready

    expect(await paylinks.get(ID)).toEqual({
      id: ID,
      timestamp: 1_000,
      operationId: "op-1",
      txHash: "0xfund",
      networkId: "0xnet",
      kind: "paylink-create",
      amountAtomic: 25n,
      token: linkRow().token,
      tokenAddress: "0xtoken",
      flavor: "direct",
      payToEmailSecret: SECRET,
      fallbackSecret: "0xfallback",
      obsidionAccountAddress: "0xme",
      paylink: `https://wallet/link#${SECRET}`,
      to: "alice@example.com",
      memo: "dinner",
      fromClaimable: 10,
      untilClaimable: 20,
      refundableUntil: 30,
      reorgEpoch: 2,
    })
    const funding = row(backend, "op-1")
    for (const field of ["payToEmailSecret", "fallbackSecret", "paylink", "to", "memo"])
      expect(funding).not.toHaveProperty(field)
    expect(funding).toMatchObject({ txHash: "0xfund", status: "success", amountAtomic: 25n })
    expect(secretInKeys(backend, SECRET)).toBe(false)
  })

  it.each([
    ["an email link", { flavor: "email" }, DEFAULT_CONTRACTS.paylinkEmail],
    [
      "a claimed link with its URL scrubbed",
      { isClaimed: true, claimedAt: 5, claimedBy: "self", paylink: undefined },
      DEFAULT_CONTRACTS.paylinkDirect,
    ],
    [
      "a refunded link",
      { isRefunded: true, refundTxHash: "0xrefund", refundKind: "cancel", paylink: undefined },
      DEFAULT_CONTRACTS.paylinkDirect,
    ],
    [
      "a link on a retired network",
      { networkId: "0xold", isMigrated: true },
      DEFAULT_CONTRACTS.paylinkDirect,
    ],
    [
      "a link still proving, with no hash",
      { status: "pending", txHash: "" },
      DEFAULT_CONTRACTS.paylinkDirect,
    ],
  ])("moves %s under its type's identity", async (_, over, type) => {
    const backend = seed([linkRow(over)])
    const paylinks = openStores(backend)
    await paylinks.ready
    const flavor = type === DEFAULT_CONTRACTS.paylinkEmail ? "email" : "direct"
    const network = (over as { networkId?: string }).networkId ?? "0xnet"
    const link = await paylinks.get(linkId(flavor, SECRET, network))
    expect(link).toMatchObject(
      Object.fromEntries(
        Object.entries(over).filter(
          ([k, v]) => v !== undefined && k !== "status" && k !== "txHash" && k !== "flavor",
        ),
      ),
    )
    expect(row(backend, "op-1")).not.toHaveProperty("payToEmailSecret")
  })

  it("leaves a create with no secret yet and another's claim as they are", async () => {
    const prepared = linkRow({ id: "op-2", payToEmailSecret: undefined, paylink: undefined })
    const claim = linkRow({ id: "op-3", action: "Claim", emailPaymentAction: "Claim" })
    const backend = seed([prepared, claim])
    const before = new Map(backend.entries)
    await openStores(backend).ready
    for (const id of ["op-2", "op-3"])
      expect(backend.entries.get(`${NS}acct/transfers/${id}`)).toBe(
        before.get(`${NS}acct/activity/${id}`),
      )
  })

  it("reads the secret and flavor of a row that saved only its URL", async () => {
    const fragment = encodePaylinkInline({
      secret: new Fr(7n),
      paylinkType: DEFAULT_CONTRACTS.paylinkEmail,
      fallbackKeyHash: new Fr(1n),
      classId: new Fr(2n),
      chainId: 1,
      rollupVersion: 1,
    })
    const url = `https://wallet/link#${fragment}`
    const backend = seed([
      linkRow({ payToEmailSecret: undefined, flavor: undefined, paylink: url }),
    ])
    const paylinks = openStores(backend)
    await paylinks.ready
    expect(await paylinks.get(linkId("email", SECRET, "1:1"))).toMatchObject({
      payToEmailSecret: SECRET,
      flavor: "email",
      paylink: url,
      fallbackSecret: "0xfallback",
    })
    expect(row(backend, "op-1")).not.toHaveProperty("paylink")
    expect(secretInKeys(backend, fragment)).toBe(false)
  })

  it("takes a URL-only blob row's flavor from its URL, over the legacy reader's default", async () => {
    const fragment = encodePaylinkInline({
      secret: new Fr(7n),
      paylinkType: DEFAULT_CONTRACTS.paylinkEmail,
      fallbackKeyHash: new Fr(1n),
      classId: new Fr(2n),
      chainId: 1,
      rollupVersion: 1,
    })
    const url = `https://wallet/link#${fragment}`
    const backend = seed([], null)
    const legacy = { ...linkRow(), amountAtomic: "25", payToEmailSecret: undefined, paylink: url }
    delete (legacy as Record<string, unknown>).flavor
    delete (legacy as Record<string, unknown>).to
    backend.entries.set(`${NS}${TRANSACTIONS_STORAGE_KEY}`, JSON.stringify([legacy]))
    const paylinks = openStores(backend)
    await paylinks.ready
    const email = linkId("email", SECRET, "1:1")
    expect(await paylinks.get(email)).toMatchObject({ flavor: "email", paylink: url })
  })

  it("keeps a funding that failed with a hash as its failed operation when none is left", async () => {
    const failed = linkRow({ status: "failed", endTime: 1_500 })
    const kept = linkRow({ id: "op-2", operationId: "op-2", payToEmailSecret: OTHER_SECRET })
    const backend = seed([failed, { ...kept, status: "failed" }])
    const saved = { operationId: "op-2", flow: "paylink-create", state: "sent", txHash: "0xfund" }
    backend.entries.set(`${NS}acct/operations/op-2`, encodeRecord(saved))
    await openStores(backend).ready
    const op = decodeRecord(backend.entries.get(`${NS}acct/operations/op-1`)!) as OperationRecord
    expect(op).toMatchObject({ state: "failed", txHash: "0xfund", endedAt: 1_500, readAt: 1_500 })
    expect(decodeRecord(backend.entries.get(`${NS}acct/operations/op-2`)!)).toEqual(saved)
  })

  it("keeps a failed funding whose row names no operation, so the link reads failed", async () => {
    const backend = seed([linkRow({ status: "failed", operationId: undefined })])
    await openStores(backend).ready
    const ops = [...backend.entries]
      .filter(([key]) => key.startsWith(`${NS}acct/operations/`))
      .map(([, raw]) => decodeRecord(raw) as OperationRecord)
    expect(ops).toMatchObject([{ state: "failed", txHash: "0xfund" }])
    expect(operationIndex(ops).byHash.get("0xfund")?.state).toBe("failed")
  })

  it("files one link for two rows of the same escrow, keeping what either knew", async () => {
    const rebuilt = linkRow({
      id: "0xfund",
      operationId: undefined,
      memo: undefined,
      isClaimed: true,
      claimedAt: 7,
    })
    const backend = seed([linkRow({ claimedAt: undefined }), rebuilt])
    const paylinks = openStores(backend)
    await paylinks.ready
    expect(await paylinks.get(ID)).toMatchObject({
      operationId: "op-1",
      memo: "dinner",
      isClaimed: true,
      claimedAt: 7,
    })
    expect(row(backend, "0xfund")).not.toHaveProperty("payToEmailSecret")
  })

  it("files the legacy blob's links when activity never opened, and never edits the blob", async () => {
    const backend = seed([], null)
    const blob = JSON.stringify([{ ...linkRow(), amountAtomic: "25" }])
    backend.entries.set(`${NS}${TRANSACTIONS_STORAGE_KEY}`, blob)
    const paylinks = openStores(backend)
    await paylinks.ready
    expect(await paylinks.get(ID)).toMatchObject({ payToEmailSecret: SECRET, txHash: "0xfund" })
    expect(backend.entries.get(`${NS}${TRANSACTIONS_STORAGE_KEY}`)).toBe(blob)
    const rows = [...backend.entries].filter(([k]) => k.includes("acct/transfers/"))
    expect(rows.length).toBe(1)
    expect(rows.some(([, raw]) => raw.includes(SECRET))).toBe(false)
  })

  it("reads the account blob's rows where no build split them out", async () => {
    const backend = seed([], null)
    backend.entries.set(
      `${NS}${ACCOUNT_STORAGE_KEY}`,
      JSON.stringify({ transactions: [{ ...linkRow(), amountAtomic: "25" }] }),
    )
    const paylinks = openStores(backend)
    await paylinks.ready
    expect(await paylinks.get(ID)).toBeDefined()
  })

  it("moves nothing when the open's write fails, and moves everything on the next open", async () => {
    const backend = seed([linkRow()])
    backend.failing.commits = true
    await expect(openStores(backend).ready).rejects.toThrow()
    expect(row(backend, "op-1", "acct/activity")).toHaveProperty("payToEmailSecret", SECRET)

    backend.failing.commits = false
    const paylinks = openStores(backend)
    await paylinks.ready
    expect(await paylinks.get(ID)).toBeDefined()
  })
})

describe("createPaylinks: the move keeps every copy until it is filed", () => {
  it("fills what an already filed link lacks before the row loses it", async () => {
    const backend = seed([linkRow()], null)
    await activityMoves(backend, ["op-1"])
    const id = `${NS}acct/paylinks/${ID}`
    const filed = decodeRecord(backend.entries.get(id)!) as Record<string, unknown>
    delete filed.fallbackSecret
    backend.entries.set(id, encodeRecord(filed))
    backend.entries.set(`${NS}acct/transfers/op-2`, encodeRecord(linkRow({ id: "op-2" })))

    await activityMoves(backend, ["op-2"])
    expect(decodeRecord(backend.entries.get(id)!)).toHaveProperty("fallbackSecret", "0xfallback")
    expect(row(backend, "op-2")).not.toHaveProperty("fallbackSecret")
  })

  it("drops activity's index entries that name the secret, the escrow or the claim", async () => {
    const backend = seed([linkRow({ refundTxHash: "0xrefund", claimedAt: 5 })])
    const keys = [
      `${NS}acct/activity.i/link/${SECRET.toLowerCase()}/op-1`,
      `${NS}acct/activity.i/open/1/op-1`,
      `${NS}acct/activity.i/claimed/${String(5).padStart(16, "0")}/op-1`,
      `${NS}acct/activity.i/hash/0xrefund/op-1`,
    ]
    for (const key of keys) backend.entries.set(key, "")
    backend.entries.set(`${NS}acct/activity.i/hash/0xfund/op-1`, "")
    await openStores(backend).ready
    for (const key of keys) expect(backend.entries.has(key)).toBe(false)
    expect(backend.entries.has(`${NS}acct/transfers.i/hash/0xfund/op-1`)).toBe(true)
    expect(secretInKeys(backend, SECRET)).toBe(false)
  })

  it("moves the rows of an activity open still building its indexes", async () => {
    const backend = seed([linkRow()])
    backend.entries.delete(`${NS}acct/meta/activity`)
    backend.entries.set(`${NS}acct/meta/activity.build`, JSON.stringify({ to: 3, phase: "build" }))
    const paylinks = openStores(backend)
    await paylinks.ready
    expect(await paylinks.get(ID)).toBeDefined()
    expect(row(backend, "op-1")).not.toHaveProperty("payToEmailSecret")
  })

  it("carries empty fields as they were", async () => {
    const backend = seed([linkRow({ memo: "" })])
    const paylinks = openStores(backend)
    await paylinks.ready
    expect(await paylinks.get(ID)).toHaveProperty("memo", "")
  })

  it("fails the open when the rows cannot be read, and moves nothing", async () => {
    const backend = seed([linkRow()])
    backend.failing.reads = true
    await expect(openStores(backend).ready).rejects.toThrow()
    backend.failing.reads = false
    expect(row(backend, "op-1", "acct/activity")).toHaveProperty("payToEmailSecret", SECRET)
  })
})

describe("createPaylinks: the open order", () => {
  it("paylinks never reads loaded before activity's move lands", async () => {
    const backend = seed([linkRow()], null)
    let opened!: () => void
    const ready = new Promise<void>((resolve) => (opened = resolve))
    const paylinks = createPaylinks({ db: db(backend), transfers: { ready } })
    const off = paylinks.view.subscribe(() => {})
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(paylinks.view.get().loaded).toBe(false)
    await activityMoves(backend, ["op-1"])
    opened()
    expect((await loadRecords(paylinks.view)).map((l) => l.id)).toEqual([ID])
    off()
  })

  it("paylinks fails, never reads empty, when activity's open fails", async () => {
    const transfers = { ready: Promise.reject(new Error("locked")) }
    const paylinks = createPaylinks({ db: db(seed([linkRow()])), transfers })
    const off = paylinks.view.subscribe(() => {})
    await expect(paylinks.ready).rejects.toThrow("locked")
    expect(paylinks.view.get()).toMatchObject({ loaded: false, failed: true })
    off()
  })

  it("activity first: the link is filed and indexed, and paylinks' open keeps it", async () => {
    const backend = seed([linkRow()], null)
    await activityMoves(backend, ["op-1"])
    expect(row(backend, "op-1")).not.toHaveProperty("payToEmailSecret")

    const paylinks = openStores(backend)
    await paylinks.ready
    expect((await loadRecords(paylinks.view)).map((l) => l.id)).toEqual([ID])
    expect((await loadRecords(paylinks.where("hash", "0xfund"))).map((l) => l.id)).toEqual([ID])
    expect((await loadRecords(paylinks.where("operation", "op-1"))).map((l) => l.id)).toEqual([ID])
  })

  it("a crash between the two opens loses nothing, and a later run changes nothing", async () => {
    const backend = seed([linkRow()])
    await activityMoves(backend, ["op-1"])
    // The page dies here; the next one opens paylinks over what the first committed.
    await openStores(backend).ready
    const settled = new Map(backend.entries)
    await activityMoves(backend, ["op-1"])
    await openStores(backend).ready
    expect(new Map(backend.entries)).toEqual(settled)
  })
})

describe("createPaylinks: records", () => {
  const open = async () => {
    const backend = seed([linkRow()])
    const paylinks = openStores(backend)
    await paylinks.ready
    return { backend, paylinks }
  }

  it("keeps a filed link when a rebuild files it again", async () => {
    const { paylinks } = await open()
    const saved = (await paylinks.get(ID))!
    await paylinks.put({ ...saved, memo: "rebuilt" })
    expect((await paylinks.get(ID))?.memo).toBe("dinner")
  })

  it("files a new link, out of escrow once claimed and found by its refund's hash", async () => {
    const { paylinks } = await open()
    const id = linkId("direct", OTHER_SECRET, "0xnet")
    await paylinks.put({
      ...(await paylinks.get(ID))!,
      id,
      payToEmailSecret: OTHER_SECRET,
      txHash: undefined,
      operationId: "op-9",
    })
    await paylinks.apply(id, { type: "sent", txHash: "0xsecond" })
    const escrowed = () => loadRecords(paylinks.where("open", OPEN))
    expect((await escrowed()).map((l) => l.id).sort()).toEqual([ID, id].sort())

    await paylinks.apply(ID, {
      type: "claimed",
      at: 5,
      epoch: 2,
      refundInFlight: false,
      by: "chain",
    })
    expect((await escrowed()).map((l) => l.id)).toEqual([id])
    expect((await loadRecords(paylinks.view)).length).toBe(2)
    await paylinks.apply(id, {
      type: "refundSubmitted",
      refundTxHash: "0xrefund",
      refundKind: "cancel",
    })
    expect((await loadRecords(paylinks.where("hash", "0xrefund"))).map((l) => l.id)).toEqual([id])
    expect((await paylinks.byHash("0xREFUND"))?.id).toBe(id)
  })

  it("drops a link no transaction funded, and keeps a funded one", async () => {
    const { paylinks } = await open()
    const id = linkId("direct", OTHER_SECRET, "0xnet")
    await paylinks.put({ ...(await paylinks.get(ID))!, id, txHash: undefined })
    await paylinks.remove(id)
    expect(await paylinks.get(id)).toBeUndefined()
    await expect(paylinks.remove(ID)).rejects.toMatchObject({ code: "invariant" })
  })

  it("rejects a failed write and changes nothing", async () => {
    const { backend, paylinks } = await open()
    backend.failing.commits = true
    await expect(paylinks.apply(ID, { type: "migrated" })).rejects.toThrow()
    backend.failing.commits = false
    expect((await paylinks.get(ID))?.isMigrated).toBeUndefined()
  })
})

describe("legacyLinkRows", () => {
  const link = (over: Partial<PaylinkRecord>): PaylinkRecord => ({
    id: "l",
    timestamp: 1,
    amountAtomic: 5n,
    flavor: "direct",
    payToEmailSecret: SECRET,
    ...over,
  })
  const row = (over: Partial<Transaction>) =>
    ({
      id: "r",
      timestamp: 1,
      amountAtomic: 5n,
      txHash: "",
      action: "send",
      ...over,
    } as Transaction)
  const op = (state: OperationRecord["state"], txHash: string) =>
    ({
      operationId: "op-1",
      flow: "paylink-create",
      summary: "",
      state,
      txHash,
      startedAt: 1,
    } as OperationRecord)

  it("shows each link as its funding row: its operation's state, else its row's, else its hash", () => {
    const rows = [
      row({ id: "0xfund", txHash: "0xFUND", status: "failed" }),
      row({ id: "0xother", txHash: "0xother", status: "success" }),
    ]
    const links = [
      link({ id: "a", operationId: "op-1", txHash: "0xA" }),
      link({ id: "b", txHash: "0xfund" }),
      link({ id: "c", txHash: "0xC" }),
      link({ id: "d" }),
    ]
    const out = legacyLinkRows(
      rows,
      links,
      operationIndex([op("sent", "0xA")]),
    ) as PaylinkTransaction[]
    expect(out.map((r) => [r.id, r.status, r.emailPaymentAction ?? null])).toEqual([
      ["0xfund", "failed", PaylinkActionEnum.PAY],
      ["0xother", "success", null],
      ["0xa", "pending", PaylinkActionEnum.PAY],
      ["0xc", "success", PaylinkActionEnum.PAY],
      ["d", "failed", PaylinkActionEnum.PAY],
    ])
  })
})
