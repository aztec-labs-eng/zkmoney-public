/**
 * The claimed event of a claim to Ethereum: saved when the burn starts, sent once its withdrawal
 * record shows the burn mined, at most once from this browser, and only with consent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  createOwedClaims,
  memoryBackend,
  openDatabase,
  type MemoryBackend,
  type OwedClaims,
  type WithdrawalRecord,
} from "@obsidion/front-core"

const a = vi.hoisted(() => ({
  enabled: true,
  firePaylinkEvent: vi.fn(),
}))
vi.mock("../../../../src/lib/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/lib/analytics")>()),
  analyticsEnabled: () => a.enabled,
  firePaylinkEvent: a.firePaylinkEvent,
}))

const { owePaylinkClaim, reportPaylinkClaims } = await import(
  "../../../../src/features/paylink/paylinkClaimReport"
)
const { paylinkPh } = await import("../../../../src/lib/analytics")

const ROLLUP = "0x" + "ab".repeat(20)
const SECRET = { toBuffer: () => new Uint8Array(32).fill(9) }
const LINK = "0x" + "11".repeat(32)

const record = (phase: WithdrawalRecord["phase"], patch: Partial<WithdrawalRecord> = {}) =>
  ({
    localId: `wdraw_${phase}`,
    paylinkId: LINK,
    source: "paylink",
    phase,
    recipient: "0x" + "dd".repeat(20),
    amount: "24.5",
    rawAmount: "25000000000000000000",
    l2TxHash: "0x" + "0a".repeat(32),
    ...patch,
  } as unknown as WithdrawalRecord)

const owe = (claims: OwedClaims, amount = 25n * 10n ** 18n) =>
  owePaylinkClaim(claims, LINK, {
    rollupAddress: ROLLUP,
    secret: SECRET,
    flavor: "direct",
    amount,
    decimals: 18,
  })

let backend: MemoryBackend
let storage: OwedClaims

beforeEach(() => {
  a.enabled = true
  a.firePaylinkEvent.mockClear()
  backend = memoryBackend()
  storage = createOwedClaims({ db: openDatabase(backend) })
  vi.useRealTimers()
})

describe("paylink claim report", () => {
  it("sends one claimed event once the burn is mined, carrying only the hash, flavor and range", async () => {
    await owe(storage)
    await reportPaylinkClaims([record("submitting")], storage)
    expect(a.firePaylinkEvent).not.toHaveBeenCalled()

    await reportPaylinkClaims([record("l2_mined")], storage)
    expect(a.firePaylinkEvent).toHaveBeenCalledTimes(1)
    expect(a.firePaylinkEvent).toHaveBeenCalledWith({
      stage: "claimed",
      flavor: "direct",
      amount_bucket: "<50",
      paylink_ph: await paylinkPh({ rollupAddress: ROLLUP, secret: SECRET }),
    })
    // Nothing that names the recipient, the exact amount or the transaction.
    const wire = JSON.stringify(a.firePaylinkEvent.mock.calls)
    expect(wire).not.toContain("dd".repeat(20))
    expect(wire).not.toContain("25000000000000000000")
    expect(wire).not.toContain("0a".repeat(32))
    expect(wire).not.toContain(LINK.slice(2))

    // Later phases and reloads find nothing left to send.
    await reportPaylinkClaims([record("finalizing_l1")], storage)
    await reportPaylinkClaims([record("done")], createOwedClaims({ db: openDatabase(backend) }))
    expect(a.firePaylinkEvent).toHaveBeenCalledTimes(1)
  })

  it("sends one event when two surfaces see the burn mined at once", async () => {
    await owe(storage)
    await Promise.all([
      reportPaylinkClaims([record("l2_mined")], storage),
      reportPaylinkClaims([record("awaiting_proven")], storage),
    ])
    expect(a.firePaylinkEvent).toHaveBeenCalledTimes(1)
  })

  it("saves nothing without consent, so a later answer replays nothing", async () => {
    a.enabled = false
    await owe(storage)
    expect([...backend.entries.keys()].filter((k) => k.startsWith("acct/owedClaims/"))).toEqual([])
    a.enabled = true
    await reportPaylinkClaims([record("l2_mined")], storage)
    expect(a.firePaylinkEvent).not.toHaveBeenCalled()
  })
})
