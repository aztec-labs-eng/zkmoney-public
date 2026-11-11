// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { testCore } from "../support/page"
import { sessionPage } from "../support/session"
import { operationRows, type PaylinkTransaction } from "@obsidion/front-core"
import { activeNamespace, closeSession, type Session } from "../../src/session/session"
import { PaylinkActionEnum } from "@obsidion/core/constants"
import { decodePaylinkInline } from "@obsidion/sdk"
import { captureOn, fixtureState, operation } from "../../scripts/ui-capture/fixtures/control"
import { capturePaylinkRows, claimSponsoredLink, createSponsoredLink } from "../../scripts/ui-capture/fixtures/paylinks"
import { runContactPay as runCaptureContactPay } from "../../scripts/ui-capture/fixtures/contact-pay"
import { demoClaimFragments, demoFundingTxHash } from "../../src/dev/demoFixtures"
import { EmailPaylinkUnsupportedError, type SponsoredPaylinkDeps } from "../../src/features/paylink/sponsoredPaylink"
import { fundDeposit } from "../../scripts/ui-capture/fixtures/deposits"
import { SIPA } from "../../scripts/ui-capture/fixtures/data"
import { DesktopSendUnresolvedError } from "../../src/platform/desktopBridge"

const demo = vi.hoisted(() => ({ enabled: true }))
vi.mock("../../src/dev/demoFlag", () => ({ isDemoMode: () => demo.enabled }))

let session: Session
const deps = {
  account: { getAddress: () => ({ toString: () => `0x${"22".repeat(32)}` }) },
  get session() {
    return session
  },
} as unknown as SponsoredPaylinkDeps

function state(value: string) {
  vi.stubGlobal("location", new URL(`http://localhost/?demo=activity&flowFixture=${value}`))
}

const handled = <T,>(promise: Promise<T>) => promise.then(
  (value) => ({ value, error: undefined }),
  (error: unknown) => ({ value: undefined, error }),
)

describe("capture service boundary contracts", () => {
  /** The signatures the page's prover heard, in order. */
  const events: { kind: string; failed?: boolean }[] = []
  let offSigning = () => {}

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-09-01T00:00:00Z"))
    demo.enabled = true
    const tab = new Map<string, string>()
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => tab.get(key) ?? null,
      setItem: (key: string, value: string) => { tab.set(key, value) },
      removeItem: (key: string) => { tab.delete(key) },
    })
    // The faked flows run inside real operations, whose store persists here.
    const local = new Map<string, string>()
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => local.get(key) ?? null,
      setItem: (key: string, value: string) => { local.set(key, value) },
      removeItem: (key: string) => { local.delete(key) },
    })
    state("success")
    events.length = 0
    const page = sessionPage()
    let last = page.prover.progress.get().signing
    offSigning = page.prover.progress.subscribe(() => {
      const { signing } = page.prover.progress.get()
      if (signing.started !== last.started) events.push({ kind: "start" })
      if (signing.ended !== last.ended) events.push({ kind: "end", failed: signing.failed })
      last = signing
    })
    captureOn(page)
    session = page.switchTo(activeNamespace(testCore().device))
  })

  afterEach(() => {
    closeSession()
    offSigning()
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("awaits preparation before the signature is reported", async () => {
    const stages: string[] = []
    let prepared = false
    let release!: () => void
    const preparation = new Promise<void>((resolve) => { release = resolve })
    const result = handled(operation("ordered-operation", (stage) => stages.push(stage), true, {
      operationId: "ordered-id",
      session,
      onPrepared: async () => { await preparation; prepared = true },
    }))
    await vi.advanceTimersByTimeAsync(900)
    expect(stages).toEqual(["proving"])
    expect(events).toEqual([])
    release()
    await vi.advanceTimersByTimeAsync(1400)
    expect(prepared).toBe(true)
    expect(events).toEqual([
      { kind: "start" },
      { kind: "end", failed: false },
    ])
    expect(stages).toEqual(["proving"])
    await vi.advanceTimersByTimeAsync(3300)
    expect((await result).error).toBeUndefined()
    expect(stages).toEqual(["proving", "submitting"])
  })

  it("stops at the cancellation callback before preparation or signing", async () => {
    const cancelled = new Error("test cancellation")
    const prepared = vi.fn()
    const result = handled(operation("cancelled-operation", () => { throw cancelled }, true, { onPrepared: prepared, session }))
    await vi.advanceTimersByTimeAsync(6000)
    expect((await result).error).toBe(cancelled)
    expect(prepared).not.toHaveBeenCalled()
    expect(events).toEqual([])
  })

  it("marks failed signing explicitly and gives a retry its own successful end event", async () => {
    state("signing-retry")
    const first = handled(operation("signing-retry-operation", undefined, true, { operationId: "first", session }))
    await vi.advanceTimersByTimeAsync(6000)
    expect((await first).error).toBeInstanceOf(Error)
    const second = handled(operation("signing-retry-operation", undefined, true, { operationId: "second", session }))
    await vi.advanceTimersByTimeAsync(6000)
    expect((await second).error).toBeUndefined()
    expect(events).toEqual([
      { kind: "start" },
      { kind: "end", failed: true },
      { kind: "start" },
      { kind: "end", failed: false },
    ])
  })

  it("can finish without a signing ceremony while still preparing the result", async () => {
    state("no-signing")
    const prepared = vi.fn()
    const result = handled(operation("no-signing-operation", undefined, true, { onPrepared: prepared, session }))
    await vi.advanceTimersByTimeAsync(6000)
    expect((await result).error).toBeUndefined()
    expect(prepared).toHaveBeenCalledOnce()
    expect(events).toEqual([])
  })

  it("a cancelled capture send creates no row or signing event", async () => {
    const cancelled = new Error("capture cancellation")
    const result = handled(runCaptureContactPay({
      mode: "send", session, tag: "ada", senderTag: "bob", amountDisplay: "24",
    }, (stage) => { if (stage === "proving") throw cancelled }))
    await vi.advanceTimersByTimeAsync(6000)
    expect((await result).error).toBe(cancelled)
    expect(session.operations.view.get().records).toEqual([])
    expect(events).toEqual([])
  })

  it("a later capture send failure updates only its own operation id", async () => {
    const { operations } = session
    await operations.begin({ operationId: "unrelated-send", flow: "send", summary: "$7" })
    await operations.apply("unrelated-send", {
      type: "transfer",
      transfer: {
        kind: "send",
        payload: {
          networkId: "0xnet", amountAtomic: "7", to: "other",
          token: { address: "unrelated", name: "DAI", symbol: "DAI", decimals: 18, amount: 7, price: 1, logo: "" },
        },
      },
    })
    state("signing-failure")
    const result = handled(runCaptureContactPay({
      mode: "send", session, tag: "ada", senderTag: "bob", amountDisplay: "24",
    }, () => {}))
    await vi.advanceTimersByTimeAsync(6000)
    expect((await result).error).toBeInstanceOf(Error)
    const sends = operations.view.get().records.filter((op) => op.kind === "send")
    expect(sends).toHaveLength(2)
    expect(sends.find((op) => op.operationId === "unrelated-send")?.state).toBe("local")
    const failed = sends.find((op) => op.operationId.startsWith("capture-op-"))!
    expect(failed.state).toBe("failed")
    expect(failed.txHash).toBeFalsy()
    expect(events).toEqual([
      { kind: "start" },
      { kind: "end", failed: true },
    ])
    operations.release("unrelated-send")
  })

  it("a desktop send saves its hold at the helper's approval, after the recheck, then ends unresolved", async () => {
    vi.stubGlobal("location", new URL("http://localhost/?demo=activity&flowFixture=success&desktopFixture=unresolved"))
    // No account rows here, and the session's clock would keep every timer running.
    closeSession()
    const calls: string[] = []
    // The fixture sends nothing, so it reads no deps.
    const sent = handled(fundDeposit({
      target: { address: SIPA, name: "demo.sandbox.oxide" },
      amountDisplay: "24",
      onStage: (stage) => calls.push(stage),
      preflight: async () => { calls.push("preflight") },
      beforeApprove: async (submission) => {
        calls.push(`approve:${submission}`)
      },
    }, {} as never))
    await vi.runAllTimersAsync()
    const { error } = await sent
    expect(error).toBeInstanceOf(DesktopSendUnresolvedError)
    expect(calls).toEqual(["preflight", "awaiting-browser", "preflight", `approve:${"1".repeat(32)}`])
  })

  it("requires demo plus an explicit fixture, rejects unknown controls, and clears the latch", async () => {
    expect(fixtureState()).toBe("success")
    state("off")
    expect(fixtureState()).toBeNull()
    vi.stubGlobal("location", new URL("http://localhost/?demo=activity"))
    expect(fixtureState()).toBeNull()
    state("unknown")
    expect(() => fixtureState()).toThrow("Unknown flow fixture")
    demo.enabled = false
    expect(fixtureState()).toBeNull()
    await expect(capturePaylinkRows()).rejects.toThrow("requires an active flow fixture")
  })

  it("publishes a persisted hashless prepared link before signing, then advances the same row", async () => {
    const observations: { url: string; events: number }[] = []
    const result = handled(createSponsoredLink(deps, "24", undefined, {
      memo: "fixture memo",
      onLink: (link) => observations.push({ url: link.url, events: events.length }),
    }))
    await vi.advanceTimersByTimeAsync(900)
    expect(observations).toHaveLength(1)
    expect(observations[0].events).toBe(0)
    const [pending] = await capturePaylinkRows()
    expect(pending).toMatchObject({ kind: "paylink-create", status: "pending", amount: 24, paylink: observations[0].url })
    expect(pending.txHash).toBeFalsy()
    const prepared = decodePaylinkInline(observations[0].url.split("#")[1])
    expect(prepared.secret.toString()).toBe(pending.secret)
    expect(events[0]).toEqual({ kind: "start" })
    await vi.advanceTimersByTimeAsync(4700)
    const { value, error } = await result
    expect(error).toBeUndefined()
    expect(value?.txHash).toMatch(/^0x[0-9a-f]{64}$/)
    const [settled] = await capturePaylinkRows()
    expect(settled).toMatchObject({ operationId: pending.operationId, secret: pending.secret, status: "success", txHash: value?.txHash, paylink: value?.url })
    expect(decodePaylinkInline(value!.url.split("#")[1]).secret.toString()).toBe(pending.secret)
    expect(observations).toHaveLength(1)
  })

  it("keeps failed and retried creator identities distinct even with a fixed clock", async () => {
    state("signing-failure")
    const first = handled(createSponsoredLink(deps, "24"))
    await vi.advanceTimersByTimeAsync(6000)
    expect((await first).error).toBeInstanceOf(Error)
    const [failed] = await capturePaylinkRows()
    expect(failed.status).toBe("failed")
    expect(failed.txHash).toBeFalsy()
    vi.setSystemTime(new Date("2026-09-01T00:00:00Z"))
    state("success")
    const second = handled(createSponsoredLink(deps, "24"))
    await vi.advanceTimersByTimeAsync(6000)
    expect((await second).error).toBeUndefined()
    const rows = await capturePaylinkRows()
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((row) => row.operationId)).size).toBe(2)
    expect(new Set(rows.map((row) => row.secret)).size).toBe(2)
    expect(rows.find((row) => row.operationId === failed.operationId)?.status).toBe("failed")
    expect(rows.filter((row) => row.status === "success")).toHaveLength(1)
  })

  it.each(["success", "no-signing"])("returns the claim row's hash, not the funding hash (%s)", async (fixture) => {
    state(fixture)
    const fragment = demoClaimFragments().direct
    const funding = demoFundingTxHash(fragment)
    const result = handled(claimSponsoredLink(deps, fragment))
    await vi.advanceTimersByTimeAsync(6000)
    const { value, error } = await result
    expect(error).toBeUndefined()
    // The claim's operation is its only record: the chain files no row for it.
    expect(await session.transfers.all()).toEqual([])
    const { operations } = session
    expect(operations.view.get().records.map((op) => op.kind)).toEqual(["paylink-claim"])
    const rows = operationRows(operations.view.get()).records as PaylinkTransaction[]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ emailPaymentAction: PaylinkActionEnum.CLAIM, status: "success", txHash: value, token: { amount: 100 } })
    expect(value).toMatch(/^0x[0-9a-f]{64}$/)
    expect(value).not.toBe(funding)
    expect(fixture === "no-signing" ? events.length : events.filter((event) => event.failed === false).length).toBe(fixture === "no-signing" ? 0 : 1)
  })

  it("refuses an email link before creating a claim row", async () => {
    await expect(claimSponsoredLink(deps, demoClaimFragments().email)).rejects.toThrow(EmailPaylinkUnsupportedError)
    expect(await capturePaylinkRows()).toEqual([])
    expect(events).toEqual([])
  })
})
