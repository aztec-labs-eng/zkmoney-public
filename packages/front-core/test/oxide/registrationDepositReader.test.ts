import { describe, expect, it, vi } from "vitest"
import type { PublicClient } from "viem"
import { SipaIntent } from "@oxide/l1-contracts"
import { createRegistrationDepositReader } from "../../src/oxide/oxideRegistrationDeps"

const REGISTRY = "0x0000000000000000000000000000000000000e40"
const TABLE = "0x0000000000000000000000000000000000000fb1"
const PORTAL = "0x0000000000000000000000000000000000000a01"
const TOKEN = "0x00000000000000000000000000000000000000da"
const DAI = 10n ** 18n
/** The registration row's sweep tip: the relayer's take on a sweep. */
const SWEEP = DAI / 2n
const ROUTE = { forwardingTable: TABLE, token: TOKEN, intent: SipaIntent.Registration } as const
/** The rail's store; the floor never reads it. */
const STORE = { load: async () => {}, get: () => null }

/** Chain stub: the schedule immutables, the table's registration row and its portal's cap. */
function client(values: { min: bigint; fee: bigint; fail?: boolean; sweepFail?: boolean }) {
  const readContract = vi.fn(async ({ address, functionName }: never) => {
    if ((address as string).toLowerCase() === REGISTRY) {
      if (values.fail) throw new Error("registry read refused")
      return functionName === "REGISTRATION_MIN" ? values.min : values.fee
    }
    if ((address as string).toLowerCase() === TABLE) {
      if (values.sweepFail) throw new Error("table read refused")
      return [PORTAL, `0x${"0".repeat(40)}`, 0n, SWEEP]
    }
    if ((address as string).toLowerCase() === PORTAL) return 10n ** 30n
    throw new Error(`unexpected read of ${address}`)
  })
  return { client: { readContract } as unknown as PublicClient, readContract }
}

describe("registration deposit floor", () => {
  it("prices the registry's own requirement from the chain immutables", async () => {
    const { client: publicClient } = client({ min: 10n * DAI, fee: 1n * DAI })
    const reader = createRegistrationDepositReader({
      publicClient,
      registrationRoute: ROUTE,
      registry: REGISTRY,
      store: STORE,
    })
    // 5 DAI against the 11 floor is the bug this guards: min+fee, not the mirrored constants.
    expect(await reader.floor(TOKEN, "0xacc1")).toBe(11n * DAI)
  })

  it("prices the floor off an account's signed terms, immutables for everyone else", async () => {
    const { client: publicClient } = client({ min: 10n * DAI, fee: 1n * DAI })
    const reader = createRegistrationDepositReader({
      publicClient,
      registrationRoute: ROUTE,
      registry: REGISTRY,
      store: STORE,
      termsFor: (account) =>
        account === "0xsigned" ? { fee: SWEEP, minDeposit: 2n * DAI } : undefined,
    })
    expect(await reader.floor(TOKEN, "0xsigned")).toBe(2n * DAI + SWEEP)
    expect(await reader.floor(TOKEN, "0xother")).toBe(11n * DAI)
  })

  it("gives no floor for a schedule whose fee cannot pay the sweep", async () => {
    const { client: publicClient } = client({ min: 0n, fee: 0n })
    const reader = createRegistrationDepositReader({
      publicClient,
      registrationRoute: ROUTE,
      registry: REGISTRY,
      store: STORE,
      termsFor: (account) =>
        account === "0xshort" ? { fee: SWEEP - 1n, minDeposit: 2n * DAI } : undefined,
    })
    // The controller reverts such a sweep, so no balance can fund either registration.
    expect(await reader.floor(TOKEN, "0xacc1")).toBeNull()
    expect(await reader.floor(TOKEN, "0xshort")).toBeNull()
  })

  it("caches the immutables and the sweep fee after the first read", async () => {
    const { client: publicClient, readContract } = client({ min: 10n * DAI, fee: 1n * DAI })
    const reader = createRegistrationDepositReader({
      publicClient,
      registrationRoute: ROUTE,
      registry: REGISTRY,
      store: STORE,
    })
    await reader.floor(TOKEN, "0xacc1")
    await reader.floor(TOKEN, "0xacc1")
    const reads = (target: string) =>
      readContract.mock.calls.filter(
        ([{ address }]: never[]) => (address as string).toLowerCase() === target,
      ).length
    expect(reads(REGISTRY)).toBe(2)
    expect(reads(TABLE)).toBe(1)
  })

  it("gives no floor while the sweep fee is unreadable", async () => {
    const values = { min: 10n * DAI, fee: 1n * DAI, sweepFail: true }
    const { client: publicClient } = client(values)
    const reader = createRegistrationDepositReader({
      publicClient,
      registrationRoute: ROUTE,
      registry: REGISTRY,
      store: STORE,
    })
    expect(await reader.floor(TOKEN, "0xacc1")).toBeUndefined()
    values.sweepFail = false
    expect(await reader.floor(TOKEN, "0xacc1")).toBe(11n * DAI)
  })

  it("gives no floor while the immutables read fails, and prices one once it lands", async () => {
    const values = { min: 10n * DAI, fee: 1n * DAI, fail: true }
    const { client: publicClient } = client(values)
    const reader = createRegistrationDepositReader({
      publicClient,
      registrationRoute: ROUTE,
      registry: REGISTRY,
      store: STORE,
    })
    expect(await reader.floor(TOKEN, "0xacc1")).toBeUndefined()
    await expect(reader.scheduleFee()).rejects.toThrow()
    values.fail = false
    expect(await reader.floor(TOKEN, "0xacc1")).toBe(11n * DAI)
    expect(await reader.scheduleFee()).toBe(1n * DAI)
  })
})

describe("registration deposit state", () => {
  const SIPA = "0x0000000000000000000000000000000000005195"
  const reader = (record: Record<string, unknown> | null) =>
    createRegistrationDepositReader({
      publicClient: {} as PublicClient,
      registrationRoute: ROUTE,
      registry: REGISTRY,
      store: { load: async () => {}, get: () => record as never },
    })

  it("reads the balance the rail last observed, in fee-token units", async () => {
    expect(await reader({ heldBalance: (15n * DAI).toString() }).readBalance(SIPA, TOKEN)).toBe(
      15n * DAI,
    )
  })

  it("leaves the balance unread until the rail has observed the address", async () => {
    await expect(reader({ phase: "broadcast" }).readBalance(SIPA, TOKEN)).rejects.toThrow(
      "not observed",
    )
    await expect(reader(null).readBalance(SIPA, TOKEN)).rejects.toThrow("not observed")
  })

  it("reads the sweeps from the record's ledger, else its sweep tx, else none", async () => {
    expect(
      await reader({ sweeps: [{ sweepTxHash: "0x01" }, { sweepTxHash: "0x02" }] }).readSweeps(SIPA),
    ).toEqual([{ txHash: "0x01" }, { txHash: "0x02" }])
    expect(await reader({ sweepTxHash: "0x03" }).readSweeps(SIPA)).toEqual([{ txHash: "0x03" }])
    expect(await reader(null).readSweeps(SIPA)).toEqual([])
  })

  it("names the funding transfer once the rail attributed it", async () => {
    expect(
      await reader({ fundingTxHash: "0xf0", heldBalance: "7" }).readFunding(SIPA, TOKEN),
    ).toEqual([{ amount: 7n, txHash: "0xf0" }])
    expect(await reader({ heldBalance: "7" }).readFunding(SIPA, TOKEN)).toEqual([])
  })
})
