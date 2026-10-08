/**
 * The two-leg fresh-address withdrawal: the gas leg first, the funds leg only once the gas burn is
 * mined, one signature and one group id over both, each leg's burn carrying its route floor on top
 * of what the recipient should receive, and the bell's entry when the funds leg does not go out.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { formatUnits, getAddress, parseUnits, type Address, type Hex } from "viem"
import { AppNotificationStore, newWithdrawalLocalId } from "@obsidion/front-core"
import type { WithdrawalRecord } from "@obsidion/front-core"
import { ProvingStage, provingProgress } from "@obsidion/proving-progress"

const GAS_TX = `0x${"0a".repeat(32)}` as Hex
const FUNDS_TX = `0x${"0b".repeat(32)}` as Hex
// What the stubbed portal reads back as FPC_FUNDING_CUT.
const CUT = 250_000_000_000_000_000n
const RECIPIENT = getAddress(`0x${"dd".repeat(20)}`) as Address
const ACCOUNT = getAddress(`0x${"ac".repeat(20)}`)
const SWAP_TUPLE = {
  swapEscrowFactory: `0x${"fa".repeat(20)}`,
  accountFactory: `0x${"af".repeat(20)}`,
  portal: `0x${"70".repeat(20)}`,
  token: `0x${"da".repeat(20)}`,
  l2Broadcaster: `0x${"1b".repeat(32)}`,
}

// Two routes, two floors: the ETH route's is the steeper one.
const GAS_QUOTE = {
  relayerTip: 2n * 10n ** 18n,
  amountOut: parseUnits("0.002", 18),
  decimals: 18,
  floorAtomic: parseUnits("3.25", 18),
}
const FUNDS_QUOTE = {
  relayerTip: 1n * 10n ** 18n,
  amountOut: 118_000_000n,
  decimals: 6,
  floorAtomic: parseUnits("2.5", 18),
}
const INPUT = {
  recipient: RECIPIENT,
  recipientAlias: "Fresh",
  fundsDisplay: "120",
  gasDisplay: "5",
  fundsAsset: "USDC" as const,
  quotes: { funds: FUNDS_QUOTE, gas: GAS_QUOTE },
}
const GAS_BURN = parseUnits("5", 18) + GAS_QUOTE.floorAtomic
const FUNDS_BURN = parseUnits("120", 18) + FUNDS_QUOTE.floorAtomic

vi.mock("../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/env")>()),
  getConfig: () => ({ l1ChainId: 11155111 }),
  l1Transport: () => ({}),
}))
const readContract = vi.fn(async ({ functionName }: { functionName: string }) =>
  functionName === "$frozen" ? false : functionName === "predictAccountAddress" ? ACCOUNT : CUT,
)
vi.mock("../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/oxideTuple")>()),
  getOxideTuple: async () => ({ ...SWAP_TUPLE }),
  l1PublicClient: () => ({ readContract }),
}))
const claimSponsorContext = vi.fn(async () => ({ fpcAddress: {}, policy: {} }))
vi.mock("../src/features/onboarding/claimSponsorship", () => ({
  claimSponsorContext: (...args: unknown[]) => claimSponsorContext(...(args as [])),
  noteSubscribed: vi.fn(),
}))
vi.mock("../src/features/fees/fpcRefuel", () => ({ maybeRefuelFpc: vi.fn() }))
const MASTER_SECRET = { toString: () => `0x${"11".repeat(32)}` }
const mockSecretKey = vi.fn(async () => MASTER_SECRET as never)
vi.mock("../src/platform/auth/useAuthenticator", () => ({
  getAuthService: () => ({ getSecretKey: mockSecretKey }),
}))

const gateway = await import("../src/features/withdraw/freshAddressGateway")
const { resumeFreshAddressFunds, submitFreshAddressWithdrawal } = gateway
const { getWithdrawalStore } = await import("../src/features/withdraw/withdrawGateway")
const { webStorage } = await import("../src/platform/storage/WebStorageAdapter")

type Withdrawal = { group?: { id: Hex; leg: string }; swap?: unknown }
type ExitOpts = {
  operationId: string
  useRawAmount?: boolean
  withdrawal: Withdrawal
  authorization?: unknown
  proverTip?: bigint
}
type ExitCall = [{ toString(): string }, string, unknown, ExitOpts]

/** The group the gateway names for each burn's operation while the burn runs. */
const groupsWhileRunning: (Hex | undefined)[] = []

/** A burn that mines what it was asked to burn, with its own hash per leg; `failing`'s is not sent. */
const exitMock = (failing?: string) =>
  vi.fn(async (_to: unknown, amount: string, _sponsor: unknown, opts: ExitOpts) => {
    groupsWhileRunning.push(gateway.groupOfOperation(opts.operationId))
    const leg = opts.withdrawal.group?.leg ?? "funds"
    if (leg === failing) throw new Error("proving failed")
    return {
      txHash: leg === "gas" ? GAS_TX : FUNDS_TX,
      blockNumber: leg === "gas" ? 42 : 43,
      amount: BigInt(amount),
      humanReadableAmount: formatUnits(BigInt(amount), 18),
      l1Recipient: RECIPIENT,
    }
  })

const SHARES = [{ share: "gas" }, { share: "funds" }]

type Given = { screen?: () => Promise<unknown>; failing?: string }
const deps = ({ screen = async () => ({ compliant: true }), failing }: Given = {}) =>
  ({
    wallet: { node: { getContract: async () => ({}) }, pxe: {} },
    account: { getAddress: () => ({ toString: () => "0xuser" }) },
    contractService: {},
    screener: { screen: vi.fn(screen) },
    tokenService: {
      fetchTokenInformation: vi.fn(async () => ({ symbol: "DAI" })),
      exitToL1PrivateSponsored: exitMock(failing),
      authorizeSponsoredExits: vi.fn(async () => SHARES),
    },
  } as unknown as Parameters<typeof submitFreshAddressWithdrawal>[0])

const exitCalls = (d: ReturnType<typeof deps>) =>
  (d.tokenService.exitToL1PrivateSponsored as ReturnType<typeof vi.fn>).mock.calls as ExitCall[]

const bell = AppNotificationStore.get(webStorage)
const bellEntry = (groupId?: Hex) =>
  bell.list().find((e) => e.id === `bridge:withdrawal-group:${groupId}:remaining` && !e.dismissedAt)

const stagesOf = (onStage: ReturnType<typeof vi.fn>) =>
  onStage.mock.calls.map(([s]) => `${s.index}:${s.leg}:${s.stage}`)

/** A mined leg: grouped, its amount plus its floor burned raw to its escrow, on its own quote. */
function expectLeg(record: WithdrawalRecord, call: ExitCall, groupId: Hex, leg: "gas" | "funds") {
  const [burn, quote, l2TxHash] =
    leg === "gas" ? [GAS_BURN, GAS_QUOTE, GAS_TX] : [FUNDS_BURN, FUNDS_QUOTE, FUNDS_TX]
  expect(record).toMatchObject({
    groupId,
    groupLeg: leg,
    phase: "l2_mined",
    l2TxHash,
    recipient: RECIPIENT,
    recipientAlias: "Fresh",
    rawAmount: burn.toString(),
    amount: formatUnits(burn, 18),
    swapRelayerTip: quote.relayerTip.toString(),
    swapEstimatedOut: quote.amountOut.toString(),
  })
  const [to, amount, , opts] = call
  expect(to.toString().toLowerCase()).toBe(record.swapEscrow!.toLowerCase())
  expect(amount).toBe(burn.toString())
  expect(opts.useRawAmount).toBe(true)
  expect(opts.withdrawal.group).toEqual({ id: groupId, leg })
}

const seed = (fields: Partial<WithdrawalRecord> & Pick<WithdrawalRecord, "groupId" | "groupLeg">) =>
  getWithdrawalStore().create({
    localId: newWithdrawalLocalId(),
    recipient: RECIPIENT,
    recipientProvenance: "saved-recipient",
    amount: "8",
    tokenSymbol: "DAI",
    phase: "l2_mined",
    startTime: 1,
    ...fields,
  })

beforeEach(async () => {
  localStorage.clear()
  await getWithdrawalStore().clearAll()
  claimSponsorContext.mockClear()
  groupsWhileRunning.length = 0
})

describe("submitFreshAddressWithdrawal", () => {
  it("burns the gas leg first, then the funds leg as the picked asset, under one group", async () => {
    const d = deps()
    const onStage = vi.fn()
    const input = { ...INPUT, fundsAsset: "USDT" as const }
    const { groupId, gas, funds } = await submitFreshAddressWithdrawal(d, input, onStage)

    expect(groupId).toMatch(/^0x[0-9a-f]{32}$/)
    expect(exitCalls(d)).toHaveLength(2)
    expectLeg(gas!, exitCalls(d)[0]!, groupId!, "gas")
    expectLeg(funds!, exitCalls(d)[1]!, groupId!, "funds")
    expect([gas!.swapOutput, funds!.swapOutput]).toEqual(["ETH", "USDT"])
    expect(gas!.swapEscrow).not.toBe(funds!.swapEscrow)
    expect(gas!.operationId).not.toBe(funds!.operationId)
    expect(stagesOf(onStage)).toEqual([
      "1:gas:building",
      "1:gas:proving",
      "1:gas:submitting",
      "2:funds:building",
      "2:funds:proving",
      "2:funds:submitting",
    ])
    expect(d.screener.screen).toHaveBeenCalledTimes(1)
    expect(getWithdrawalStore().list()).toHaveLength(2)
  })

  it("burns a DAI funds leg straight to the address, under the same group and signature", async () => {
    const d = deps()
    const floorAtomic = parseUnits("0.35", 18)
    const direct = { relayerTip: 0n, amountOut: 0n, decimals: 18, floorAtomic }
    const quotes = { gas: GAS_QUOTE, funds: direct }
    const input = { ...INPUT, fundsAsset: "DAI" as const, quotes }
    const { groupId, gas, funds } = await submitFreshAddressWithdrawal(d, input, vi.fn())

    expectLeg(gas!, exitCalls(d)[0]!, groupId!, "gas")
    const burn = (parseUnits("120", 18) + floorAtomic).toString()
    expect(funds).toMatchObject({ groupId, groupLeg: "funds", phase: "l2_mined", rawAmount: burn })
    expect([funds!.swapOutput, funds!.swapEscrow]).toEqual([undefined, undefined])
    const [to, amount, , opts] = exitCalls(d)[1]!
    expect([to.toString().toLowerCase(), amount]).toEqual([RECIPIENT.toLowerCase(), burn])
    expect(opts.withdrawal.group).toEqual({ id: groupId, leg: "funds" })
    expect(opts.withdrawal.swap).toBeUndefined()
    expect(opts.authorization).toBe(SHARES[1])
  })

  it("sends the funds alone, under its own signature and no group, at a $0 gas share", async () => {
    const d = deps()
    const onStage = vi.fn()
    const none = { relayerTip: 0n, amountOut: 0n, decimals: 18, floorAtomic: 0n }
    const input = { ...INPUT, gasDisplay: "0", quotes: { gas: none, funds: FUNDS_QUOTE } }
    const { groupId, gas, funds } = await submitFreshAddressWithdrawal(d, input, onStage)

    expect(groupId).toBeUndefined()
    expect(gas).toBeUndefined()
    expect(exitCalls(d)).toHaveLength(1)
    expect(funds).toMatchObject({
      phase: "l2_mined",
      l2TxHash: FUNDS_TX,
      rawAmount: FUNDS_BURN.toString(),
      swapOutput: "USDC",
    })
    expect(funds!.groupId).toBeUndefined()
    expect(funds!.groupLeg).toBeUndefined()
    const [, amount, , opts] = exitCalls(d)[0]!
    expect(amount).toBe(FUNDS_BURN.toString())
    expect(opts.withdrawal.group).toBeUndefined()
    expect(opts.authorization).toBeUndefined()
    expect(d.tokenService.authorizeSponsoredExits).not.toHaveBeenCalled()
    expect(stagesOf(onStage)).toEqual(["1:funds:building", "1:funds:proving", "1:funds:submitting"])
    expect(groupsWhileRunning).toEqual([undefined])
    expect(getWithdrawalStore().list()).toHaveLength(1)
  })

  it("takes one signature over both exits, each burn then running its share of it", async () => {
    const sponsor = { fpcAddress: { fpc: 1 }, policy: {} }
    const subscribing = { ...sponsor, subscribe: { gate: "registration" } }
    claimSponsorContext.mockResolvedValueOnce(subscribing as never)
    const d = deps()
    await submitFreshAddressWithdrawal(d, INPUT, vi.fn())

    const burns = exitCalls(d)
    const exits = burns.map(([l1Recipient, amount, , { withdrawal, proverTip }]) => {
      return { l1Recipient, amount, withdrawal, proverTip }
    })
    expect(exits.map((exit) => exit.withdrawal.group!.leg)).toEqual(["gas", "funds"])
    const { authorizeSponsoredExits, exitToL1PrivateSponsored } = vi.mocked(d.tokenService)
    expect(authorizeSponsoredExits.mock.calls).toEqual([
      [exits, subscribing, { userAccount: d.account, useRawAmount: true }],
    ])
    expect(burns.map((burn) => burn[3].authorization)).toEqual(SHARES)
    // The gas burn mints the rail's subscription, which a second subscribe leg would replay.
    expect(burns.map((burn) => burn[2])).toStrictEqual([subscribing, sponsor])
    // A read that failed between the signature and the gas burn would tell no one.
    const [signed] = authorizeSponsoredExits.mock.invocationCallOrder
    const [sent] = exitToL1PrivateSponsored.mock.invocationCallOrder
    const reads = readContract.mock.invocationCallOrder
    expect(reads.filter((at) => at > signed! && at < sent!)).toEqual([])
  })

  it("burns, signs and records each leg's own prover tip", async () => {
    const tip = parseUnits("0.4", 18)
    const tipped = (quote: typeof GAS_QUOTE) => ({
      ...quote,
      proverTip: tip,
      floorAtomic: quote.floorAtomic + tip,
    })
    const quotes = { gas: tipped(GAS_QUOTE), funds: tipped(FUNDS_QUOTE) }
    const d = deps()
    const { gas, funds } = await submitFreshAddressWithdrawal(d, { ...INPUT, quotes }, vi.fn())

    expect(exitCalls(d).map(([, amount, , opts]) => [amount, opts.proverTip])).toEqual([
      [(GAS_BURN + tip).toString(), tip],
      [(FUNDS_BURN + tip).toString(), tip],
    ])
    const [[exits]] = vi.mocked(d.tokenService.authorizeSponsoredExits).mock.calls
    expect(exits.map((exit) => exit.proverTip)).toEqual([tip, tip])
    expect([gas!.proverTip, funds!.proverTip]).toEqual([tip.toString(), tip.toString()])
  })

  it("stops with the gas leg alone when its burn is left to chain", async () => {
    const d = deps()
    ;(d.wallet as unknown as { node: object }).node = {
      getTxReceipt: vi.fn(async () => ({ status: "pending" })),
    }
    d.tokenService.exitToL1PrivateSponsored = vi.fn(
      async (_to: unknown, _amount: unknown, _sponsor: unknown, opts: { operationId: string }) => {
        provingProgress.emitStageStart(ProvingStage.Mining, opts.operationId, GAS_TX)
        throw new Error("fetch failed")
      },
    ) as never

    const result = await submitFreshAddressWithdrawal(d, INPUT, vi.fn())

    expect(result.gas).toMatchObject({ phase: "submitting", l2TxHash: GAS_TX, groupLeg: "gas" })
    expect(result.funds).toBeUndefined()
    expect(exitCalls(d)).toHaveLength(1)
    expect(getWithdrawalStore().list()).toHaveLength(1)
    expect(bellEntry(result.groupId)).toMatchObject({
      description: gateway.GAS_LEG_PENDING_COPY,
      target: { type: "bridge.txDetail", bridgeKind: "withdrawal", sourceId: result.gas!.localId },
    })
  })

  it.each([
    ["gas", { gas: "failed" }],
    ["funds", { gas: "l2_mined", funds: "failed" }],
  ])("stops at a %s leg that fails before mining, marking it failed", async (failing, phases) => {
    const d = deps({ failing })

    await expect(submitFreshAddressWithdrawal(d, INPUT, vi.fn())).rejects.toThrow(/proving failed/)

    expect(exitCalls(d)).toHaveLength(failing === "gas" ? 1 : 2)
    const stored = getWithdrawalStore().list()
    expect(Object.fromEntries(stored.map((r) => [r.groupLeg, r.phase]))).toEqual(phases)
    expect(new Set(stored.map((r) => r.groupId)).size).toBe(1)
    // A failed gas leg sent nothing, so the bell has no funds to report.
    const notice = failing === "funds" ? gateway.FUNDS_LEG_FAILED_COPY : undefined
    expect(bellEntry(stored[0]!.groupId)?.description).toBe(notice)
  })

  it("keeps the funds leg's own error when the bell cannot be written", async () => {
    vi.spyOn(console, "warn").mockImplementationOnce(() => {})
    vi.spyOn(bell, "createIfAbsent").mockRejectedValueOnce(new Error("storage full"))
    const run = submitFreshAddressWithdrawal(deps({ failing: "funds" }), INPUT, vi.fn())
    await expect(run).rejects.toThrow(/proving failed/)
  })

  const blocked = async () => ({ compliant: false, reason: { message: "Sanctioned address" } })
  const cancel = ({ stage }: { stage: string }) => {
    if (stage === "proving") throw new Error("Cancelled")
  }
  it.each<[string, Given & { locked?: boolean; onStage?: typeof cancel }, RegExp]>([
    ["the screener blocks the address", { screen: blocked }, /Sanctioned/],
    ["the screener throws", { screen: () => Promise.reject(new Error("screener 503")) }, /503/],
    ["the wallet is locked", { locked: true }, /Unlock/],
    ["a cancel lands as the gas leg starts proving", { onStage: cancel }, /Cancelled/],
  ])("aborts before the passkey opens or any record exists when %s", async (_, given, error) => {
    if (given.locked) mockSecretKey.mockResolvedValueOnce(undefined as never)
    const d = deps(given)
    const run = submitFreshAddressWithdrawal(d, INPUT, given.onStage ?? vi.fn())
    await expect(run).rejects.toThrow(error)
    expect(d.tokenService.authorizeSponsoredExits).not.toHaveBeenCalled()
    expect(exitCalls(d)).toHaveLength(0)
    expect(getWithdrawalStore().list()).toHaveLength(0)
  })
})

describe("submitFreshAddressWithdrawal — the per-withdrawal limit", () => {
  const LIMIT = parseUnits("2500", 18)
  const TIP = parseUnits("0.5", 18)
  const DIRECT = {
    relayerTip: 0n,
    amountOut: 0n,
    decimals: 18,
    floorAtomic: parseUnits("0.35", 18),
  }
  const TIPPED = { ...FUNDS_QUOTE, proverTip: TIP, floorAtomic: FUNDS_QUOTE.floorAtomic + TIP }
  // What the recipient should receive so that the leg burns `burn`, its floor on top.
  const receiving = (burn: bigint, floorAtomic: bigint) => formatUnits(burn - floorAtomic, 18)

  it.each([
    ["a swap", INPUT.quotes.funds, "USDC"],
    ["a direct DAI", DIRECT, "DAI"],
    ["a Faster swap", TIPPED, "USDC"],
  ] as const)(
    "sends %s funds burn of exactly $2,500, whatever the gas leg adds",
    async (_, funds, asset) => {
      const d = deps()
      const input = {
        ...INPUT,
        fundsAsset: asset,
        fundsDisplay: receiving(LIMIT, funds.floorAtomic),
        quotes: { ...INPUT.quotes, funds },
      }
      await submitFreshAddressWithdrawal(d, input, vi.fn())
      expect(exitCalls(d).map(([, amount]) => amount)).toEqual([
        GAS_BURN.toString(),
        LIMIT.toString(),
      ])
    },
  )

  it.each([
    ["the funds burn", { fundsDisplay: receiving(LIMIT + 1n, FUNDS_QUOTE.floorAtomic) }],
    [
      "the funds burn, once the Faster tip is on it",
      {
        fundsDisplay: receiving(LIMIT, FUNDS_QUOTE.floorAtomic),
        quotes: { ...INPUT.quotes, funds: TIPPED },
      },
    ],
    ["the gas burn", { gasDisplay: receiving(LIMIT + 1n, GAS_QUOTE.floorAtomic) }],
  ])(
    "refuses both legs before screening, signing or recording when %s is over",
    async (_, over) => {
      const d = deps()
      const entries = bell.list().length
      const run = submitFreshAddressWithdrawal(d, { ...INPUT, ...over }, vi.fn())
      await expect(run).rejects.toThrow("This withdrawal is over the $2,500 limit, fees included.")
      expect(d.screener.screen).not.toHaveBeenCalled()
      expect(d.tokenService.authorizeSponsoredExits).not.toHaveBeenCalled()
      expect(exitCalls(d)).toHaveLength(0)
      expect(getWithdrawalStore().list()).toHaveLength(0)
      expect(bell.list()).toHaveLength(entries)
    },
  )

  it("resumes a funds burn of exactly $2,500, and refuses one atomic unit more before screening it", async () => {
    const GROUP = `0x${"66".repeat(16)}` as Hex
    await seed({ groupId: GROUP, groupLeg: "gas", l2TxHash: GAS_TX })
    const exact = deps()
    const input = {
      ...INPUT,
      groupId: GROUP,
      fundsDisplay: receiving(LIMIT, FUNDS_QUOTE.floorAtomic),
    }
    await resumeFreshAddressFunds(exact, input, vi.fn())
    expect(exitCalls(exact).map(([, amount]) => amount)).toEqual([LIMIT.toString()])

    const OTHER = `0x${"67".repeat(16)}` as Hex
    await seed({ groupId: OTHER, groupLeg: "gas", l2TxHash: GAS_TX })
    const over = deps()
    const fundsDisplay = receiving(LIMIT + 1n, FUNDS_QUOTE.floorAtomic)
    const run = resumeFreshAddressFunds(over, { ...INPUT, groupId: OTHER, fundsDisplay }, vi.fn())
    await expect(run).rejects.toThrow("This withdrawal is over the $2,500 limit, fees included.")
    expect(over.screener.screen).not.toHaveBeenCalled()
    expect(exitCalls(over)).toHaveLength(0)
    expect(
      getWithdrawalStore()
        .list()
        .filter((r) => r.groupId === OTHER),
    ).toHaveLength(1)
  })
})

describe("resumeFreshAddressFunds", () => {
  const GROUP = `0x${"77".repeat(16)}` as Hex
  const INPUT_RESUME = { ...INPUT, groupId: GROUP }

  it("runs the funds leg alone under the given group", async () => {
    await seed({ groupId: GROUP, groupLeg: "gas", l2TxHash: GAS_TX })
    const d = deps()
    const onStage = vi.fn()

    const result = await resumeFreshAddressFunds(d, INPUT_RESUME, onStage)

    expect(result.gas).toBeUndefined()
    expect(exitCalls(d)).toHaveLength(1)
    expectLeg(result.funds!, exitCalls(d)[0]!, GROUP, "funds")
    // The burn takes its own signature.
    expect(d.tokenService.authorizeSponsoredExits).not.toHaveBeenCalled()
    expect(exitCalls(d)[0]![3].authorization).toBeUndefined()
    expect(result.funds!.swapOutput).toBe("USDC")
    expect(stagesOf(onStage)).toEqual(["2:funds:building", "2:funds:proving", "2:funds:submitting"])
    expect(getWithdrawalStore().list()).toHaveLength(2)
    expect(result.funds!.proverTip).toBeUndefined()
  })

  it("burns and records the funds leg's prover tip", async () => {
    await seed({ groupId: GROUP, groupLeg: "gas", l2TxHash: GAS_TX })
    const tip = parseUnits("0.4", 18)
    const funds = { ...FUNDS_QUOTE, proverTip: tip, floorAtomic: FUNDS_QUOTE.floorAtomic + tip }
    const d = deps()

    const result = await resumeFreshAddressFunds(
      d,
      { ...INPUT_RESUME, quotes: { ...INPUT.quotes, funds } },
      vi.fn(),
    )

    expect(exitCalls(d)[0]![3].proverTip).toBe(tip)
    expect(result.funds!.proverTip).toBe(tip.toString())
  })

  // What the store holds by the time the user confirms, whatever Activity showed at open.
  const dropped = { phase: "failed", droppedBurn: true } as const
  type Leg = Partial<WithdrawalRecord>
  it.each<[string, Leg, Leg | undefined, RegExp]>([
    ["a funds leg is still live", {}, { phase: "submitting" }, /already on its way/],
    ["a funds leg's dropped burn may still land", {}, dropped, /may still land/],
    ["a funds leg failed after its burn was sent", {}, { phase: "failed" }, /may still land/],
    ["the gas burn was dropped", dropped, undefined, /gas withdrawal has not gone through/],
    ["the gas burn reads as dropped", { burnDroppedAt: 1 }, undefined, /is being checked/],
  ])("refuses when %s", async (_, gas, funds, refusal) => {
    await seed({ groupId: GROUP, groupLeg: "gas", l2TxHash: GAS_TX, ...gas })
    if (funds) await seed({ groupId: GROUP, groupLeg: "funds", l2TxHash: FUNDS_TX, ...funds })
    const d = deps()

    const run = resumeFreshAddressFunds(d, INPUT_RESUME, vi.fn())
    await expect(run).rejects.toThrow(refusal)
    expect(exitCalls(d)).toHaveLength(0)
    expect(getWithdrawalStore().list()).toHaveLength(funds ? 2 : 1)
  })

  it("runs again over a failed funds leg, keeping its record and retiring the bell's entry", async () => {
    await submitFreshAddressWithdrawal(deps({ failing: "funds" }), INPUT, vi.fn()).catch(() => {})
    const groupId = getWithdrawalStore().list()[0]!.groupId!
    expect(bellEntry(groupId)).toBeDefined()
    // Another group's live funds leg is not this group's.
    await seed({ groupId: `0x${"88".repeat(16)}` as Hex, groupLeg: "funds", phase: "submitting" })
    const d = deps()

    const result = await resumeFreshAddressFunds(d, { ...INPUT, groupId }, vi.fn())

    expect(result.funds).toMatchObject({ groupId, phase: "l2_mined" })
    expect(exitCalls(d)).toHaveLength(1)
    const stored = getWithdrawalStore().list()
    const fundsLegs = stored.filter((r) => r.groupId === groupId && r.groupLeg === "funds")
    expect(fundsLegs.map((r) => r.phase).sort()).toEqual(["failed", "l2_mined"])
    expect(bellEntry(groupId)).toBeUndefined()
  })

  it("names a leg's group while its operation runs, and not once it settles or throws", async () => {
    const sent = deps({ failing: "funds" })
    await submitFreshAddressWithdrawal(sent, INPUT, vi.fn()).catch(() => {})
    const groupId = getWithdrawalStore().list()[0]!.groupId!
    const resumed = deps()
    await resumeFreshAddressFunds(resumed, { ...INPUT, groupId }, vi.fn())

    expect(groupsWhileRunning).toEqual([groupId, groupId, groupId])
    const operations = [sent, resumed].flatMap(exitCalls).map(([, , , opts]) => opts.operationId)
    expect(operations.map(gateway.groupOfOperation)).toEqual([undefined, undefined, undefined])
  })
})
