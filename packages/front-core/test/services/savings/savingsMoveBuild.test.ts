// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Address } from "viem"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { OxideEnvTuple } from "@obsidion/core/types"

const h = vi.hoisted(() => ({ buildSkyEscrowWithdrawal: vi.fn() }))
vi.mock("@oxide/experiments/sky/withdraw_escrow.js", () => ({
  buildSkyEscrowWithdrawal: h.buildSkyEscrowWithdrawal,
}))

import { buildSavingsMove } from "../../../src/core/services/savings/savingsMoveBuild"
import type { SavingsQuote } from "../../../src/core/services/savings/types"

const ONE = 10n ** 18n
const tuple = (n: string): OxideEnvTuple =>
  ({
    portal: `0x${n.repeat(40)}`,
    plainWithdrawalExecutor: `0x${"e".repeat(39)}${n}`,
    l2Broadcaster: `0x${n.repeat(64)}`,
  } as OxideEnvTuple)

const quote: SavingsQuote = {
  direction: "in",
  amount: 100n * ONE,
  unit: `0x${"d1".repeat(20)}`,
  value: 100n * ONE,
  withdrawalFee: ONE / 10n,
  releaseTip: ONE,
  escrowTip: ONE / 2n,
  escrowFunding: 100n * ONE - ONE / 10n - ONE,
  net: 100n * ONE - ONE / 10n - ONE - ONE / 2n,
  fee: ONE / 10n + ONE + ONE / 2n,
}

const SKY_EXECUTOR = `0x${"5e".repeat(20)}` as Address

const deps = (main: OxideEnvTuple) => ({
  broadcaster: {} as never,
  deployments: { main, savings: tuple("2"), skyExecutor: SKY_EXECUTOR },
  factory: {
    address: `0x${"fa".repeat(20)}` as Address,
    dai: `0x${"da".repeat(20)}` as Address,
    sUsds: `0x${"5d".repeat(20)}` as Address,
  },
  masterSecret: new Fr(7n),
  recipient: AztecAddress.fromBigIntUnsafe(9n),
  recoveryAccount: `0x${"ac".repeat(20)}` as Address,
})

describe("buildSavingsMove", () => {
  beforeEach(() => {
    h.buildSkyEscrowWithdrawal.mockReset().mockReturnValue({
      escrow: { toString: () => `0x${"e5".repeat(20)}` },
      operation: { kind: "withdraw", userPayload: Buffer.alloc(0) },
      l1Operation: {},
      escrowArgs: { recoveryCommitment: `0x${"c0".repeat(32)}` },
    })
  })

  it("builds the escrow and the burn on the fee the quote priced", async () => {
    const main = tuple("1")

    const build = await buildSavingsMove(deps(main), quote)

    const [args] = h.buildSkyEscrowWithdrawal.mock.calls[0]!
    expect(args.withdrawalExecutor.address.toString()).toBe(main.plainWithdrawalExecutor)
    expect(args.withdrawalExecutor.fee).toBe(quote.withdrawalFee)
    expect(args.withdrawalRelayerTip).toBe(quote.releaseTip)
    expect(build.escrowOptions.executor).toBe(main.plainWithdrawalExecutor)
    expect(build.escrowOptions.withdrawalFee).toBe(quote.withdrawalFee)
  })

  it("burns a move out into the Sky executor, not the Savings bridge's own", async () => {
    const out = { ...quote, direction: "out" as const, withdrawalFee: 0n }

    const build = await buildSavingsMove(deps(tuple("1")), out)

    const [args] = h.buildSkyEscrowWithdrawal.mock.calls[0]!
    expect(args.withdrawalExecutor.address.toString()).toBe(SKY_EXECUTOR)
    expect(args.portal.toString()).toBe(tuple("2").portal)
    expect(build.escrowOptions.executor).toBe(SKY_EXECUTOR)
  })
})
