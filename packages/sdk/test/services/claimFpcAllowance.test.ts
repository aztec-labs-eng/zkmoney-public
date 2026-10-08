/**
 * The ClaimFPC allowance read: existence, stored uses and the rail's config, from the utilities every
 * deployed ClaimFPC has, scoped to the note owner. A stored zero stays a stored zero; the read does
 * not guess whether the next batch renews it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import type { ContractArtifact } from "@aztec/stdlib/abi"

const { simulate, calls } = vi.hoisted(() => ({
  simulate: new Map<string, () => unknown>(),
  calls: [] as { name: string; args: unknown[]; from: unknown }[],
}))

vi.mock("@aztec/aztec.js/contracts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@aztec/aztec.js/contracts")>()),
  Contract: {
    at: () => ({
      methods: new Proxy(
        {},
        {
          get:
            (_target, name: string) =>
            (...args: unknown[]) => ({
              simulate: async ({ from }: { from: unknown }) => {
                calls.push({ name, args, from })
                const answer = simulate.get(name)
                if (!answer) throw new Error(`unexpected utility ${name}`)
                return { result: answer() }
              },
            }),
        },
      ),
    }),
  },
}))

const { readClaimFpcAllowance } = await import("../../src/services/claimFpcAllowance.js")

const FPC = AztecAddress.fromStringUnsafe(`0x${"0f".repeat(32)}`)
const USER = AztecAddress.fromStringUnsafe(`0x${"05".repeat(32)}`)
const wallet = {} as never
const artifact = { functions: [] } as unknown as ContractArtifact

const railConfig = (rails: { max_tx: bigint; refill_period: bigint }[]) => ({
  rails: rails.map((rail) => ({ gate_selector: 1n, policy_root: 0n, ...rail })),
})

describe("readClaimFpcAllowance", () => {
  beforeEach(() => {
    simulate.clear()
    calls.length = 0
    simulate.set("get_config", () =>
      railConfig([
        { max_tx: 1n, refill_period: 0n },
        { max_tx: 100n, refill_period: 86_400n },
      ]),
    )
  })

  it("reads existence, stored uses and the rail's config at the owner's scope", async () => {
    simulate.set("has_subscription", () => true)
    simulate.set("get_subscription_uses", () => 7n)
    const allowance = await readClaimFpcAllowance(wallet, FPC, artifact, USER, 1)
    expect(allowance).toEqual({ subscribed: true, uses: 7, maxTx: 100, refillPeriod: 86_400 })
    expect(calls.map((call) => call.name).sort()).toEqual([
      "get_config",
      "get_subscription_uses",
      "has_subscription",
    ])
    expect(calls.every((call) => call.from === USER)).toBe(true)
    expect(
      calls.filter((call) => call.name !== "get_config").every((call) => call.args[1] === 1),
    ).toBe(true)
  })

  it("keeps a stored zero as zero, subscribed or not", async () => {
    simulate.set("has_subscription", () => true)
    simulate.set("get_subscription_uses", () => 0n)
    expect(await readClaimFpcAllowance(wallet, FPC, artifact, USER, 1)).toMatchObject({
      subscribed: true,
      uses: 0,
    })
    simulate.set("has_subscription", () => false)
    expect(await readClaimFpcAllowance(wallet, FPC, artifact, USER, 1)).toMatchObject({
      subscribed: false,
      uses: 0,
    })
  })

  it("reports a rail that never renews", async () => {
    simulate.set("has_subscription", () => true)
    simulate.set("get_subscription_uses", () => 0n)
    expect(await readClaimFpcAllowance(wallet, FPC, artifact, USER, 0)).toEqual({
      subscribed: true,
      uses: 0,
      maxTx: 1,
      refillPeriod: 0,
    })
  })

  it("refuses a rail the instance's config does not carry", async () => {
    simulate.set("has_subscription", () => false)
    simulate.set("get_subscription_uses", () => 0n)
    await expect(readClaimFpcAllowance(wallet, FPC, artifact, USER, 3)).rejects.toThrow(
      /has no rail 3/,
    )
  })

  it("fails the read when any utility fails", async () => {
    simulate.set("has_subscription", () => true)
    simulate.set("get_subscription_uses", () => {
      throw new Error("PXE is busy")
    })
    await expect(readClaimFpcAllowance(wallet, FPC, artifact, USER, 1)).rejects.toThrow(
      "PXE is busy",
    )
  })
})
