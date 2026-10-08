import { describe, expect, it, vi } from "vitest"
import type { PublicClient } from "viem"
import { createRegistrationDepositReader } from "../../src/oxide/oxideRegistrationDeps"

const REGISTRY = "0x0000000000000000000000000000000000000e40"
const REGISTRATION_IMPL = "0x0000000000000000000000000000000000000fee"
const PORTAL = "0x0000000000000000000000000000000000000b0a"
const TOKEN = "0x00000000000000000000000000000000000000da"
const DAI = 10n ** 18n
/** `OxidePortal.FPC_FUNDING_CUT`. */
const CUT = DAI / 4n
/** The registration implementation's `depositFee()`: the relayer's take on a sweep. */
const SWEEP = DAI / 2n

/** Chain stub: the schedule immutables, the portal's cut and the implementation's sweep fee. */
function client(values: { min: bigint; fee: bigint; fail?: boolean; cutFail?: boolean }) {
  const readContract = vi.fn(async ({ address, functionName }: never) => {
    if ((address as string).toLowerCase() === REGISTRY) {
      if (values.fail) throw new Error("registry read refused")
      return functionName === "REGISTRATION_MIN" ? values.min : values.fee
    }
    if ((address as string).toLowerCase() === REGISTRATION_IMPL) return SWEEP
    if (values.cutFail) throw new Error("portal read refused")
    return CUT
  })
  return { client: { readContract } as unknown as PublicClient, readContract }
}

describe("registration deposit floor", () => {
  it("prices the registry's own requirement from the chain immutables", async () => {
    const { client: publicClient } = client({ min: 10n * DAI, fee: 1n * DAI })
    const reader = createRegistrationDepositReader({
      publicClient,
      registrationImplementation: REGISTRATION_IMPL,
      registry: REGISTRY,
      portal: PORTAL,
    })
    // 5 DAI against the 11 floor is the bug this guards: min+fee, not the mirrored constants.
    expect(await reader.floor(TOKEN, "0xacc1")).toBe(11n * DAI)
  })

  it("prices the floor off an account's signed terms, immutables for everyone else", async () => {
    const { client: publicClient } = client({ min: 10n * DAI, fee: 1n * DAI })
    const reader = createRegistrationDepositReader({
      publicClient,
      registrationImplementation: REGISTRATION_IMPL,
      registry: REGISTRY,
      portal: PORTAL,
      termsFor: (account) =>
        account === "0xsigned" ? { fee: SWEEP, minDeposit: 2n * DAI } : undefined,
    })
    expect(await reader.floor(TOKEN, "0xsigned")).toBe(2n * DAI + SWEEP)
    expect(await reader.floor(TOKEN, "0xother")).toBe(11n * DAI)
  })

  it("the cut binds the floor once the minimum falls to it", async () => {
    const { client: publicClient } = client({ min: 10n * DAI, fee: 1n * DAI })
    const reader = createRegistrationDepositReader({
      publicClient,
      registrationImplementation: REGISTRATION_IMPL,
      registry: REGISTRY,
      portal: PORTAL,
      termsFor: () => ({ fee: 1n * DAI, minDeposit: CUT }),
    })
    expect(await reader.floor(TOKEN, "0xwaived")).toBe(1n * DAI + CUT + 1n)
  })

  it("gives no floor for a schedule whose fee cannot pay the sweep", async () => {
    const { client: publicClient } = client({ min: 0n, fee: 0n })
    const reader = createRegistrationDepositReader({
      publicClient,
      registrationImplementation: REGISTRATION_IMPL,
      registry: REGISTRY,
      portal: PORTAL,
      termsFor: (account) =>
        account === "0xshort" ? { fee: SWEEP - 1n, minDeposit: 2n * DAI } : undefined,
    })
    // The controller reverts such a sweep, so no balance can fund either registration.
    expect(await reader.floor(TOKEN, "0xacc1")).toBeNull()
    expect(await reader.floor(TOKEN, "0xshort")).toBeNull()
  })

  it("caches the immutables and the portal's cut after the first read", async () => {
    const { client: publicClient, readContract } = client({ min: 10n * DAI, fee: 1n * DAI })
    const reader = createRegistrationDepositReader({
      publicClient,
      registrationImplementation: REGISTRATION_IMPL,
      registry: REGISTRY,
      portal: PORTAL,
    })
    await reader.floor(TOKEN, "0xacc1")
    await reader.floor(TOKEN, "0xacc1")
    const reads = (target: string) =>
      readContract.mock.calls.filter(
        ([{ address }]: never[]) => (address as string).toLowerCase() === target,
      ).length
    expect(reads(REGISTRY)).toBe(2)
    expect(reads(PORTAL)).toBe(1)
    expect(reads(REGISTRATION_IMPL)).toBe(1)
  })

  it("gives no floor while the portal's cut is unreadable", async () => {
    const values = { min: 10n * DAI, fee: 1n * DAI, cutFail: true }
    const { client: publicClient } = client(values)
    const reader = createRegistrationDepositReader({
      publicClient,
      registrationImplementation: REGISTRATION_IMPL,
      registry: REGISTRY,
      portal: PORTAL,
    })
    expect(await reader.floor(TOKEN, "0xacc1")).toBeUndefined()
    values.cutFail = false
    expect(await reader.floor(TOKEN, "0xacc1")).toBe(11n * DAI)
  })

  it("gives no floor while the immutables read fails, and prices one once it lands", async () => {
    const values = { min: 10n * DAI, fee: 1n * DAI, fail: true }
    const { client: publicClient } = client(values)
    const reader = createRegistrationDepositReader({
      publicClient,
      registrationImplementation: REGISTRATION_IMPL,
      registry: REGISTRY,
      portal: PORTAL,
    })
    expect(await reader.floor(TOKEN, "0xacc1")).toBeUndefined()
    await expect(reader.scheduleFee()).rejects.toThrow()
    values.fail = false
    expect(await reader.floor(TOKEN, "0xacc1")).toBe(11n * DAI)
    expect(await reader.scheduleFee()).toBe(1n * DAI)
  })
})

describe("registration deposit balance", () => {
  it("reads the address in whichever accepted token funds it, in fee-token units", async () => {
    const USDC = "0x00000000000000000000000000000000000000c0"
    const readContract = vi.fn(async ({ address }: { address: string }) =>
      address === USDC ? 15_000_000n : 0n,
    )
    const reader = createRegistrationDepositReader({
      publicClient: { readContract } as unknown as PublicClient,
      registrationImplementation: REGISTRATION_IMPL,
      registry: REGISTRY,
      portal: PORTAL,
      fundingTokens: [
        { address: TOKEN, symbol: "DAI", decimals: 18 },
        { address: USDC, symbol: "USDC", decimals: 6 },
      ],
    })
    expect(await reader.readBalance("0x0000000000000000000000000000000000005195", TOKEN)).toBe(
      15n * DAI,
    )
  })
})
