import { describe, expect, it } from "vitest"
import {
  OWED_CLAIM_MAX_AGE_MS,
  createBurnDurations,
  createOwedClaims,
  createReceiveCodes,
  createWithdrawFunnel,
  loadRecords,
  memoryBackend,
  openDatabase,
  type OwedClaim,
  type ReceiveCode,
} from "../../src/index.js"

const NS = "obsidion.acct."
const scoped = (entries: Map<string, string>) => openDatabase(memoryBackend(entries)).scoped(NS)
const under = (entries: Map<string, string>, prefix: string) =>
  [...entries.keys()].filter((key) => key.startsWith(`${NS}${prefix}/`))

const claim = (paylinkId: string, at = 1_000): OwedClaim => ({
  paylinkId,
  paylink_ph: `ph-${paylinkId}`,
  flavor: "direct",
  amount_bucket: "<50",
  at,
})

describe("owed claims", () => {
  it("carries the owed claims older builds saved, and hands each out once across a reload", async () => {
    const saved = { paylink_ph: "ph-a", flavor: "direct", amount_bucket: "<50", at: 1_000 }
    const legacy = JSON.stringify({ a: saved, b: { flavor: 5 } })
    const entries = new Map([[`${NS}analytics.paylinkClaims`, legacy]])
    const mined = (id: string) => id === "a"

    const claims = createOwedClaims({ db: scoped(entries) })
    const [first, second] = await Promise.all([
      claims.settle(mined, 2_000),
      claims.settle(mined, 2_000),
    ])
    expect([...first, ...second]).toEqual([claim("a")])
    expect(await createOwedClaims({ db: scoped(entries) }).settle(mined, 2_000)).toEqual([])
    expect(entries.get(`${NS}analytics.paylinkClaims`)).toBe(legacy)
  })

  it("keeps a claim whose burn has not mined, and drops it unsent once it expires", async () => {
    const entries = new Map<string, string>()
    const claims = createOwedClaims({ db: scoped(entries) })
    await claims.owe(claim("a"))

    expect(await claims.settle(() => false, 1_000 + OWED_CLAIM_MAX_AGE_MS)).toEqual([])
    expect(under(entries, "acct/owedClaims")).toHaveLength(1)
    expect(await claims.settle(() => false, 1_001 + OWED_CLAIM_MAX_AGE_MS)).toEqual([])
    expect(under(entries, "acct/owedClaims")).toEqual([])
  })

  it("carries nothing from a blob that does not parse, and keeps its bytes", async () => {
    const entries = new Map([[`${NS}analytics.paylinkClaims`, "{"]])
    expect(await createOwedClaims({ db: scoped(entries) }).settle(() => true, 0)).toEqual([])
    expect(entries.get(`${NS}analytics.paylinkClaims`)).toBe("{")
  })
})

describe("withdraw funnel", () => {
  it("carries the reported phases, so a carried phase is not reported again after a reload", async () => {
    const legacy = JSON.stringify({ w1: "finalizing_l1", w2: "done", w3: "typo" })
    const entries = new Map([[`${NS}analytics.withdrawFunnel`, legacy]])
    const seen: Record<string, string>[] = []
    const decide = (reported: Record<string, "finalizing_l1" | "done">) => {
      seen.push({ ...reported })
      return { next: { ...reported, w1: "done" as const }, events: [1] }
    }

    const funnel = createWithdrawFunnel({ db: scoped(entries) })
    expect(await funnel.report(["w1", "w2", "w3"], decide)).toEqual([1])
    expect(seen[0]).toEqual({ w1: "finalizing_l1", w2: "done" })
    await createWithdrawFunnel({ db: scoped(entries) }).report(["w1"], decide)
    expect(seen[1]).toEqual({ w1: "done" })
    expect(entries.get(`${NS}analytics.withdrawFunnel`)).toBe(legacy)
  })

  it("drops a mark its decision drops", async () => {
    const entries = new Map<string, string>()
    const funnel = createWithdrawFunnel({ db: scoped(entries) })
    await funnel.report(["w1"], () => ({ next: { w1: "done" }, events: [] }))
    await funnel.report(["w1"], () => ({ next: {}, events: [] }))
    expect(under(entries, "acct/withdrawFunnel")).toEqual([])
  })

  it("reports nothing when the write does not commit", async () => {
    const backend = memoryBackend()
    const funnel = createWithdrawFunnel({ db: openDatabase(backend) })
    backend.failing.commits = true
    const report = funnel.report(["w1"], () => ({ next: { w1: "done" }, events: [1] }))
    await expect(report).rejects.toThrow()
  })
})

describe("burn durations", () => {
  it("carries the samples older builds kept, and only the usable ones", async () => {
    const entries = new Map([[`${NS}burnDurations`, JSON.stringify([90, -1, "x", 60])]])
    const durations = createBurnDurations({ db: scoped(entries) })
    expect(await durations.samples()).toEqual([90, 60])
    await durations.add(30)
    expect(await createBurnDurations({ db: scoped(entries) }).samples()).toEqual([90, 60, 30])
  })

  it("carries none from a list that does not parse", async () => {
    const entries = new Map([[`${NS}burnDurations`, "not json"]])
    expect(await createBurnDurations({ db: scoped(entries) }).samples()).toEqual([])
  })
})

describe("receive codes", () => {
  const code: ReceiveCode = {
    requestId: "0xr1",
    url: "https://wallet.test/pay/river#0xr1",
    amount: 0,
    expiresAt: 9_000,
  }

  it("carries each root code only into the namespace whose requests hold it", async () => {
    const other = { ...code, requestId: "0xr2", url: "https://wallet.test/pay/sea#0xr2" }
    const entries = new Map([
      ["webwallet.receiveCode.0xnet.river", JSON.stringify(code)],
      ["webwallet.receiveCode.0xnet.sea", JSON.stringify(other)],
      ["webwallet.receiveCode.0xnet.broken", "{"],
      ["webwallet.receiveCode.unlisted", JSON.stringify(["0xr2"])],
      // River's requests sit in its store, sea's in the legacy blob.
      ["obsidion.river.acct/requests/0xr1", "{}"],
      ["obsidion.sea.obsidion.payment-requests.v1", JSON.stringify({ requests: [{ id: "0xr2" }] })],
    ])
    const page = openDatabase(memoryBackend(entries))
    const river = createReceiveCodes({ db: page.scoped("obsidion.river."), legacy: page })
    const sea = createReceiveCodes({ db: page.scoped("obsidion.sea."), legacy: page })

    expect(await river.get("0xnet.river")).toEqual(code)
    expect(await river.get("0xnet.sea")).toBeNull()
    expect(await sea.get("0xnet.sea")).toEqual(other)
    expect(await sea.get("0xnet.river")).toBeNull()
    expect(await sea.get("0xnet.broken")).toBeNull()
    expect(entries.get("webwallet.receiveCode.0xnet.river")).toBe(JSON.stringify(code))
  })

  it("shows a put code in its view, by id, once committed", async () => {
    const page = openDatabase(memoryBackend())
    const codes = createReceiveCodes({ db: page.scoped(NS), legacy: page })
    await codes.put("0xnet.river", code)
    expect(await loadRecords(codes.view)).toEqual([{ id: "0xnet.river", code }])
  })
})
