/**
 * The funding path's last check runs immediately before any transfer request, on the injected-wallet path and on the
 * desktop hand-off, and again each time the desktop helper is about to send. A failed check requests nothing. With the
 * connected-deposit check, capacity that cannot be established does not stop a USDC or USDT transfer.
 */
import { createPace } from "@obsidion/core/cadence"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { parseUnits, type Address, type Hex } from "viem"
import { createPortalCapacityStore, type PortalCapacityStore } from "@obsidion/front-core"
import type { OxideEnvTuple } from "@obsidion/core/types"
import type { PortalCapacitySnapshot } from "@obsidion/sdk"
import {
  browserSubmission,
  fundDeposit,
  holdEnds,
  type FundDepositDeps,
  type FundDepositParams,
} from "../../../src/features/deposit/fundDeposit"
import { DesktopSendUnresolvedError } from "../../../src/platform/desktopBridge"
import {
  FundingPreflightError,
  runFundingPreflight,
} from "../../../src/features/deposit/fundingPreflight"
import type { L1TokenBalance } from "../../../src/features/deposit/l1DepositTokenBalance"
import { sandboxConfig } from "../../support/seedBootConfig"
import { testQuery } from "../../support/query"
const pace = createPace()

const TOKEN = `0x${"ee".repeat(20)}` as Address
const SIPA = `0x${"ab".repeat(20)}` as Address
const HASH = `0x${"11".repeat(32)}` as Hex
const order: string[] = []
/** Each wallet write: the contract called and its arguments. */
const writes: { address: string; args: unknown[] }[] = []
const bridge = { active: false, submit: vi.fn() }
const TX_AMOUNT_CAP = 5166n * 10n ** 18n
const USDC = `0x${"a0".repeat(20)}` as Address
const USDT = `0x${"da".repeat(20)}` as Address
// The DAI row, with the USDC and USDT its SIPA swaps into DAI.
const DECIMALS: Record<Address, number> = { [TOKEN]: 18, [USDC]: 6, [USDT]: 6 }

const stamp = vi.fn(async () => undefined)
const deps: FundDepositDeps = {
  pace,
  config: undefined as never,
  deposits: { apply: stamp },
  wakeBroadcasts: () => {},
  tuple: async () => ({ token: TOKEN, portal: `0x${"70".repeat(20)}` } as OxideEnvTuple),
  publicClient: {
    waitForTransactionReceipt: (async () => ({ status: "success" })) as never,
  },
  tokenMetadata: async (token) => ({ symbol: "", decimals: DECIMALS[token] ?? 18 }),
  displayFacts: async () => ({
    fee: "0.5",
    token: TOKEN,
    sweepFeeAtomic: parseUnits("0.5", 18),
    txAmountCap: TX_AMOUNT_CAP,
  }),
  balance: async () => {
    order.push("balance")
    return { raw: 10n ** 30n } as L1TokenBalance
  },
  l1Clients: async () => ({
    account: `0x${"aa".repeat(20)}`,
    chain: {} as never,
    walletClient: {
      writeContract: async (call: { functionName: string; address: string; args: unknown[] }) => {
        order.push(call.functionName)
        writes.push({ address: call.address, args: call.args })
        return HASH
      },
    } as never,
  }),
  desktop: { active: () => bridge.active, submit: bridge.submit },
}
const deposit = (params: Record<string, unknown>) =>
  fundDeposit(params as unknown as FundDepositParams, deps)

beforeAll(async () => void (deps.config = await sandboxConfig()))

beforeEach(() => {
  order.length = 0
  writes.length = 0
  stamp.mockClear()
  bridge.active = false
  bridge.submit.mockReset()
})

const send = (
  preflight: (fresh: { feeDisplay: string }) => Promise<void>,
  beforeApprove?: () => Promise<void>,
) =>
  deposit({
    target: { address: SIPA, name: "alice.oxide.eth" },
    amountDisplay: "2.5",
    from: `0x${"aa".repeat(20)}`,
    tokenSymbol: "DAI",
    preflight,
    beforeApprove,
  })

describe("fundDeposit record", () => {
  it.each([
    ["records the wallet's own deposit", undefined, 1],
    ["records nothing for a payer funding someone else's address", false, 0],
  ] as const)("%s", async (_, record, stamps) => {
    await deposit({
      target: { address: SIPA, name: "river" },
      amountDisplay: "2.5",
      from: `0x${"aa".repeat(20)}`,
      tokenSymbol: "DAI",
      preflight: async () => {},
      record,
    })
    expect(stamp).toHaveBeenCalledTimes(stamps)
  })
})

describe("fundDeposit hold before the wallet prompt", () => {
  const params = (beforeSend: () => Promise<void>) => ({
    target: { address: SIPA, name: "river" },
    amountDisplay: "2.5",
    from: `0x${"aa".repeat(20)}`,
    tokenSymbol: "DAI",
    preflight: async () => {},
    record: false,
    beforeSend,
  })

  it("saves it after the last check and before the prompt, so a page lost meanwhile keeps it", async () => {
    await deposit(params(async () => void order.push("held")))
    expect(order).toEqual(["balance", "held", "transfer"])
  })

  it.each([
    ["a browser send the wallet refused", browserSubmission(), { code: 4001 }, true],
    [
      "a browser send that failed otherwise, which may have gone out",
      browserSubmission(),
      new Error("rpc"),
      false,
    ],
    ["a desktop submission that failed", "desk-1", new Error("rpc"), true],
    [
      "a desktop send left unresolved",
      "desk-1",
      new DesktopSendUnresolvedError(new Error("lost")),
      false,
    ],
  ])("ends on %s: %s", (_, submission, error, ends) => {
    expect(holdEnds(submission, error)).toBe(ends)
  })

  it("requests no transfer when it cannot be saved", async () => {
    const unsaved = new Error("hold unsaved")
    await expect(deposit(params(() => Promise.reject(unsaved)))).rejects.toBe(unsaved)
    expect(writes).toEqual([])
  })
})

describe("fundDeposit preflight", () => {
  it("checks right before the wallet transfer, with the fee read for this send", async () => {
    const preflight = vi.fn(async (fresh: { feeDisplay: string }) => {
      order.push(`preflight:${fresh.feeDisplay}`)
    })
    await send(preflight)
    expect(order).toEqual(["balance", "preflight:0.5", "transfer"])
  })

  it("checks before the desktop hand-off, and hands the helper a recheck of the same kind", async () => {
    bridge.active = true
    const preflight = vi.fn(async () => {
      order.push("preflight")
    })
    const beforeApprove = vi.fn()
    bridge.submit.mockImplementation(
      async (submission: {
        recheck: () => Promise<void>
        display: { lines: [string, string][] }
      }) => {
        order.push("handoff")
        await submission.recheck()
        return HASH
      },
    )
    await send(preflight, beforeApprove)
    expect(order).toEqual(["preflight", "handoff", "preflight"])
    expect(preflight).toHaveBeenLastCalledWith({ feeDisplay: "0.5" })
    // The bridge client records the approval; the funding path only hands the caller's hook through.
    expect(bridge.submit.mock.calls[0]![0]).toMatchObject({ beforeApprove })
    const { display } = bridge.submit.mock.calls[0]![0] as {
      display: { lines: [string, string][] }
    }
    expect(display.lines.length).toBeLessThanOrEqual(10)
    expect(
      display.lines.every(([label, value]) => label.length <= 200 && value.length <= 200),
    ).toBe(true)
  })
})

describe("fundDeposit of USDT with the connected-deposit check", () => {
  const symbol = "USDT"
  const token = USDT
  const KEY = { chainId: 1, portal: `0x${"11".repeat(20)}`, token: TOKEN } as const
  const storeReading = (read: () => Promise<PortalCapacitySnapshot>) =>
    createPortalCapacityStore(KEY, {
      read,
      query: testQuery(),
    })
  const unreadable = () =>
    storeReading(async () => {
      throw new Error("rpc down")
    })
  const empty = () =>
    storeReading(async () => ({
      ...KEY,
      decimals: 18,
      blockNumber: 1n,
      blockTimestamp: BigInt(Math.floor(Date.now() / 1000)),
      rateAtomicPerSecond: 10n ** 18n,
      globalLimitAtomic: 50_000n * 10n ** 18n,
      availableAtomic: 0n,
      txAmountCapAtomic: TX_AMOUNT_CAP,
    }))
  // What the connected deposit form passes: a conversion credit is not known before the swap.
  const connectedCheck = (store?: PortalCapacityStore) => (fresh: { feeDisplay: string }) =>
    runFundingPreflight({
      store,
      required: { status: "unknown" },
      unknownCapacity: "proceed",
      shownFee: "0.5",
      freshFee: fresh.feeDisplay,
    })
  const sendStable = (preflight: (fresh: { feeDisplay: string }) => Promise<void>) =>
    deposit({
      target: { address: SIPA, name: "alice.oxide.eth" },
      amountDisplay: "2.5",
      from: `0x${"aa".repeat(20)}`,
      tokenSymbol: symbol,
      token: { address: token, decimals: 6, settlesIn: TOKEN },
      preflight,
      beforeApprove: async () => {},
    })

  it.each([
    ["cannot be read", unreadable],
    ["has no known bucket", () => undefined],
  ])("transfers from the connected wallet when capacity %s", async (_case, store) => {
    await sendStable(connectedCheck(store()))
    expect(order).toEqual(["balance", "transfer"])
    expect(writes).toEqual([{ address: token, args: [SIPA, parseUnits("2.5", 6)] }])
  })

  it("hands off to the desktop helper and passes its recheck when capacity cannot be read", async () => {
    bridge.active = true
    let recheck: Promise<void> | undefined
    bridge.submit.mockImplementation(
      async (submission: { recheck: () => Promise<void>; tx: { to: string } }) => {
        order.push(`handoff:${submission.tx.to}`)
        recheck = submission.recheck()
        await recheck
        return HASH
      },
    )
    await sendStable(connectedCheck(unreadable()))
    expect(order).toEqual([`handoff:${token}`])
    await expect(recheck).resolves.toBeUndefined()
  })

  it("requests no transfer against an empty bucket, on either path", async () => {
    await expect(sendStable(connectedCheck(empty()))).rejects.toBeInstanceOf(FundingPreflightError)
    expect(order).not.toContain("transfer")
    bridge.active = true
    await expect(sendStable(connectedCheck(empty()))).rejects.toBeInstanceOf(FundingPreflightError)
    expect(bridge.submit).not.toHaveBeenCalled()
  })
})
