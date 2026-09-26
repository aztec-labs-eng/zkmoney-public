/**
 * The web side of the recoverERC20 exit: who is offered it and on what grounds, the balance guard that keeps a
 * recovery from settling a deposit it never moved, and the two submission channels. The signature
 * and store write belong to front-core's `runSipaRecovery` and are covered there — here it is a
 * fake, so what these tests assert is the wiring.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { encodeAbiParameters, encodeEventTopics, erc20Abi, type Address, type Hex } from "viem"
import type { SIPADepositRecord } from "@obsidion/front-core"

const SIPA = `0x${"11".repeat(20)}` as Address
const TUPLE_TOKEN = `0x${"22".repeat(20)}` as Address
const RECORD_TOKEN = `0x${"33".repeat(20)}` as Address
const WALLET = `0x${"44".repeat(20)}` as Address
const TYPED = `0x${"55".repeat(20)}` as Address
const HASH = `0x${"ab".repeat(32)}` as Hex

const l1Clients = vi.hoisted(() => ({ getL1Clients: vi.fn() }))
const bridge = vi.hoisted(() => ({ submitViaDesktopBridge: vi.fn() }))

vi.mock("../src/features/deposit/l1Wallet", () => l1Clients)
// The refund settle prices the entry it buys against the portal's cut, and will not decide without.
vi.mock("../src/features/fees/fpcFundingCut", () => ({
  currentFpcFundingCut: async () => 10n ** 17n,
  fpcFundingCut: async () => 10n ** 17n,
}))
vi.mock("../src/platform/desktopBridge", () => ({
  isDesktopL1SubmitActive: () => false,
  ...bridge,
}))

const {
  STUCK_SWEEP_MS,
  desktopBridgeChannel,
  injectedWalletChannel,
  recoverSipaDeposit,
  recoveryReasonFor,
} = await import("../src/features/deposit/sipaRecovery")
type L1ExitStage = import("../src/features/deposit/sipaRecovery").L1ExitStage
const { unsweepableCopy } = await import("../src/features/deposit/unsweepableCopy")

const NOW = 1_700_000_000_000

const record = (patch: Partial<SIPADepositRecord> = {}): SIPADepositRecord =>
  ({
    sipaAddress: SIPA,
    recipientL2Address: "0xaa",
    messageSecret: "0x1",
    recipientHash: "0x2",
    recoveryAddress: "0x3",
    l1ChainId: 11155111,
    amount: "0.5",
    tokenSymbol: "DAI",
    phase: "recoverable",
    startTime: NOW,
    ...patch,
  } as SIPADepositRecord)

describe("recoveryReasonFor", () => {
  it("always offers the exit to a deposit that can never be swept", () => {
    expect(recoveryReasonFor(record(), NOW)).toBe("unsweepable")
    // No staleness requirement: the sweep is impossible, not slow.
    expect(recoveryReasonFor(record({ startTime: NOW }), NOW)).toBe("unsweepable")
  })

  it("offers a sweeping deposit the exit only once it is stuck", () => {
    const stuck = record({ phase: "sweeping", startTime: NOW - STUCK_SWEEP_MS })
    expect(recoveryReasonFor(stuck, NOW)).toBe("stuck")
    expect(recoveryReasonFor(record({ phase: "sweeping", startTime: NOW - 1 }), NOW)).toBeNull()
    expect(
      recoveryReasonFor(record({ phase: "sweeping", startTime: NOW - STUCK_SWEEP_MS + 1 }), NOW),
    ).toBeNull()
  })

  it("treats a stale broadcast record as stuck too", () => {
    // No relayer ever acknowledged the deposit — the signature of one funded on a since-retired
    // deployment. The exits' own funding reads still gate an unfunded one.
    const stale = record({ phase: "broadcast", startTime: NOW - STUCK_SWEEP_MS })
    expect(recoveryReasonFor(stale, NOW)).toBe("stuck")
    expect(recoveryReasonFor(record({ phase: "broadcast", startTime: NOW - 1 }), NOW)).toBeNull()
  })

  it("offers nothing once a self-sweep has been submitted", () => {
    // The funds are in the portal; the next sync scan claims them. Recovery would find an empty
    // SIPA and abort, so the affordance goes away rather than inviting a doomed attempt.
    expect(
      recoveryReasonFor(
        record({
          phase: "sweeping",
          startTime: NOW - STUCK_SWEEP_MS,
          sweepTxHash: HASH,
        }),
        NOW,
      ),
    ).toBeNull()
  })

  it("offers nothing without the note's message secret", () => {
    // Half the recovery key derives from it — there is nothing to sign with.
    expect(recoveryReasonFor(record({ messageSecret: "" }), NOW)).toBeNull()
    expect(
      recoveryReasonFor(
        record({ messageSecret: "", phase: "sweeping", startTime: NOW - STUCK_SWEEP_MS }),
        NOW,
      ),
    ).toBeNull()
  })

  it("offers nothing on every other phase", () => {
    for (const phase of [
      "resolved",
      "funding",
      "funded",
      "pendingClaim",
      "claimed",
      "failed",
      "recovered",
    ] as const) {
      expect(recoveryReasonFor(record({ phase, startTime: 0 }), NOW)).toBeNull()
    }
  })
})

describe("recoverSipaDeposit", () => {
  const channel = {
    target: WALLET,
    sendTransaction: vi.fn(async () => HASH),
    waitForReceipt: vi.fn(async () => true),
  }
  const run = vi.fn(async () => HASH)
  const store = { get: vi.fn(() => null), upsert: vi.fn() }
  const stealthKey = { scalar: 7n, publicKey: { x: 1n, y: 2n } }

  const deployment = {
    readDeployed: vi.fn(async () => true),
    candidates: [],
    predict: vi.fn(async () => SIPA),
  }
  const deps = (readBalance: () => Promise<bigint>) => ({
    channel,
    chainId: 11155111,
    token: TUPLE_TOKEN,
    readBalance,
    readReceipt: async () =>
      ({
        status: "success",
        logs: [
          {
            address: RECORD_TOKEN,
            topics: encodeEventTopics({
              abi: erc20Abi,
              eventName: "Transfer",
              args: { from: SIPA, to: WALLET },
            }),
            data: encodeAbiParameters([{ type: "uint256" }], [5n]),
          },
        ],
      } as never),
    deployment,
    store,
    stealthKey: async () => stealthKey as never,
    run: run as never,
  })

  beforeEach(() => {
    run.mockClear()
  })

  it("refuses a deposit whose note has not been discovered", async () => {
    const readBalance = vi.fn(async () => 5n)
    await expect(
      recoverSipaDeposit(record({ messageSecret: "" }), deps(readBalance)),
    ).rejects.toThrow(/still looking up this deposit's details/)
    expect(readBalance).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it("aborts on an empty SIPA rather than settling a deposit it never moved", async () => {
    // A sweep that won the race leaves a zero balance: recoverERC20 would still confirm, moving
    // nothing while marking the record recovered.
    await expect(
      recoverSipaDeposit(
        record({ tokenAddress: RECORD_TOKEN }),
        deps(async () => 0n),
      ),
    ).rejects.toThrow(/already been swept/)
    expect(run).not.toHaveBeenCalled()
  })

  it("flags the current-token fallback as inconclusive on a zero balance", async () => {
    // Without its own tokenAddress the read hit the CURRENT deployment's token — wrong contract
    // for a historic-generation SIPA, so zero must not read as "swept".
    await expect(
      recoverSipaDeposit(
        record(),
        deps(async () => 0n),
      ),
    ).rejects.toThrow(/predates token tracking/)
    expect(run).not.toHaveBeenCalled()
  })

  it("runs the recovery against the channel's target and the record's token", async () => {
    const readBalance = vi.fn(async () => 5n)
    const rec = record({ tokenAddress: RECORD_TOKEN })
    await expect(recoverSipaDeposit(rec, deps(readBalance))).resolves.toBe(HASH)
    expect(readBalance).toHaveBeenCalledWith(SIPA, RECORD_TOKEN)
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        record: rec,
        target: WALLET,
        token: RECORD_TOKEN,
        chainId: 11155111,
        stealthKey,
        store,
        deployment,
        sendTransaction: channel.sendTransaction,
        waitForReceipt: channel.waitForReceipt,
      }),
    )
  })

  it("falls back to the manifest token for a record predating token tracking", async () => {
    const readBalance = vi.fn(async () => 5n)
    await expect(recoverSipaDeposit(record(), deps(readBalance))).resolves.toBe(HASH)
    expect(readBalance).toHaveBeenCalledWith(SIPA, TUPLE_TOKEN)
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ token: TUPLE_TOKEN }))
  })

  it("remembers a registration deposit's recovery as its refund, whatever surface ran it", async () => {
    const { getPendingStore } = await import("../src/features/onboarding/webRegistration")
    const { registrationRefunded } = await import(
      "../src/features/onboarding/registrationQuoteRecovery"
    )
    localStorage.clear()
    const pending = await getPendingStore().upsert(
      WALLET,
      {},
      {
        tag: "demo",
        nameHash: HASH,
        l2Address: "0xaa",
        l1ChainId: 11155111,
        sipaAddress: SIPA,
        fee: "1",
        beneficiary: WALLET,
        depositToken: RECORD_TOKEN,
        broadcast: true,
        phase: "funded",
        fundedAt: NOW,
        retries: 0,
        startTime: NOW,
      },
    )
    expect(registrationRefunded(pending)).toBe(false)
    // Another token recovered off the address is not the registration's refund.
    await recoverSipaDeposit(
      record(),
      deps(async () => 5n),
    )
    expect(registrationRefunded(pending)).toBe(false)
    expect(getPendingStore().get(WALLET)?.phase).toBe("funded")
    await recoverSipaDeposit(
      record({ tokenAddress: RECORD_TOKEN }),
      deps(async () => 5n),
    )
    expect(registrationRefunded(pending)).toBe(true)
    expect(getPendingStore().get(WALLET)).toMatchObject({ phase: "awaiting_deposit" })
  })
})

describe("injectedWalletChannel", () => {
  const config = { l1ChainId: 11155111, l1RpcUrl: "http://l1" } as never

  it("pays the connected account and reports a reverted tx", async () => {
    const chain = { id: 11155111 }
    const sendTransaction = vi.fn(async () => HASH)
    const waitForTransactionReceipt = vi.fn(async () => ({ status: "reverted" }))
    const estimateGas = vi.fn(async () => 1_000_001n)
    const getBlock = vi.fn(async () => ({ gasLimit: 60_000_000n }))
    l1Clients.getL1Clients.mockResolvedValue({
      walletClient: { sendTransaction },
      account: WALLET,
      chain,
    })
    const stages: L1ExitStage[] = []
    const channel = await injectedWalletChannel(config, {
      onStage: (s) => stages.push(s),
      readClient: { waitForTransactionReceipt, estimateGas, getBlock } as never,
    })

    expect(channel.target).toBe(WALLET)
    await expect(channel.sendTransaction(SIPA, "0xdeadbeef")).resolves.toBe(HASH)
    expect(sendTransaction).toHaveBeenCalledWith({
      to: SIPA,
      data: "0xdeadbeef",
      account: WALLET,
      chain,
      gas: 1_200_002n,
    })
    expect(estimateGas).toHaveBeenCalledWith({
      to: SIPA,
      data: "0xdeadbeef",
      account: WALLET,
      gas: 16_777_216n,
    })
    // The receipt is the only signal the funds actually moved.
    await expect(channel.waitForReceipt(HASH)).resolves.toBe(false)
    expect(stages).toEqual(["signing", "confirming"])
  })

  it("confirms a successful receipt", async () => {
    l1Clients.getL1Clients.mockResolvedValue({
      walletClient: { sendTransaction: vi.fn(async () => HASH) },
      account: WALLET,
      chain: { id: 11155111 },
    })
    const channel = await injectedWalletChannel(config, {
      from: WALLET,
      readClient: {
        waitForTransactionReceipt: vi.fn(async () => ({ status: "success" })),
      } as never,
    })
    await expect(channel.waitForReceipt(HASH)).resolves.toBe(true)
    expect(l1Clients.getL1Clients).toHaveBeenCalledWith(11155111, WALLET)
  })

  it.each([
    [11155111, 60_000_000n, 15_000_000n, 16_777_216n],
    [1, 60_000_000n, 16_777_216n, 16_777_216n],
    [11155111, 10_000_000n, 9_000_000n, 10_000_000n],
    [31337, 30_000_000n, 20_000_000n, 24_000_000n],
  ])(
    "bounds the margin by chain %s's transaction and block limits",
    async (chainId, blockLimit, estimate, expected) => {
      const sendTransaction = vi.fn(async () => HASH)
      l1Clients.getL1Clients.mockResolvedValue({
        walletClient: { sendTransaction },
        account: WALLET,
        chain: { id: chainId },
      })
      const channel = await injectedWalletChannel({ l1ChainId: chainId } as never, {
        readClient: {
          getBlock: vi.fn(async () => ({ gasLimit: blockLimit })),
          estimateGas: vi.fn(async () => estimate),
        } as never,
      })
      await channel.sendTransaction(SIPA, "0xdeadbeef")
      expect(sendTransaction).toHaveBeenCalledWith(expect.objectContaining({ gas: expected }))
    },
  )

  it.each(["revert", "oversized"])(
    "does not ask the wallet to sign after a %s estimate",
    async (failure) => {
      const sendTransaction = vi.fn(async () => HASH)
      const onStage = vi.fn()
      const revert = new Error("execution reverted: registration fee exceeds deposit")
      l1Clients.getL1Clients.mockResolvedValue({
        walletClient: { sendTransaction },
        account: WALLET,
        chain: { id: 11155111 },
      })
      const channel = await injectedWalletChannel(config, {
        onStage,
        readClient: {
          getBlock: vi.fn(async () => ({ gasLimit: 60_000_000n })),
          estimateGas: vi.fn(async () => {
            if (failure === "revert") throw revert
            return 21_000_000n
          }),
        } as never,
      })
      const submission = channel.sendTransaction(SIPA, "0xdeadbeef")
      if (failure === "revert") await expect(submission).rejects.toBe(revert)
      else await expect(submission).rejects.toThrow(/exceeds.*gas limit/i)
      expect(sendTransaction).not.toHaveBeenCalled()
      expect(onStage).not.toHaveBeenCalled()
    },
  )
})

describe("desktopBridgeChannel", () => {
  it("hands the prepared tx to the helper page and waits on our own client", async () => {
    bridge.submitViaDesktopBridge.mockResolvedValue(HASH)
    const waitForTransactionReceipt = vi.fn(async () => ({ status: "success" }))
    const onHelperOpened = vi.fn()
    const stages: L1ExitStage[] = []
    const channel = desktopBridgeChannel({
      destination: TYPED,
      chainId: 11155111,
      publicClient: { waitForTransactionReceipt } as never,
      display: {
        title: "Recover your zk.money deposit",
        lines: [
          ["Amount", "0.5 DAI"],
          ["Deposit address", SIPA],
          ["Recovered to", TYPED],
        ],
      },
      onHelperOpened,
      onStage: (s) => stages.push(s),
    })

    // The typed address receives the funds; the helper's wallet only pays the gas.
    expect(channel.target).toBe(TYPED)
    await expect(channel.sendTransaction(SIPA, "0xdeadbeef")).resolves.toBe(HASH)
    const params = bridge.submitViaDesktopBridge.mock.calls[0][0]
    expect(params.tx).toEqual({ to: SIPA, data: "0xdeadbeef", chainId: 11155111 })
    expect(params.onHelperOpened).toBe(onHelperOpened)
    expect(params.display.title).toBe("Recover your zk.money deposit")
    expect(Object.fromEntries(params.display.lines)).toMatchObject({
      "Amount": "0.5 DAI",
      "Deposit address": SIPA,
      "Recovered to": TYPED,
    })

    await expect(channel.waitForReceipt(HASH)).resolves.toBe(true)
    expect(waitForTransactionReceipt).toHaveBeenCalledWith({ hash: HASH })
    expect(stages).toEqual(["awaiting-browser", "confirming"])
  })
})

describe("unsweepableCopy", () => {
  const ONE_DAI = "1000000000000000000"
  const QUARTER_DAI = "250000000000000000"
  // A record whose whole deduction is 1.25 DAI, a quarter of it the portal's cut.
  const FEE_WITH_CUT = "1250000000000000000"
  const copy = (patch: Partial<SIPADepositRecord>, settlementSymbol?: string) =>
    unsweepableCopy(record(patch), settlementSymbol)

  it("names the fee when the deposit is at or below the floor", () => {
    for (const amount of ["0.4", "1"]) {
      const text = copy({ amount, fee: ONE_DAI, fpcFundingCut: "0" })
      expect(text).toContain("at or below the network's deposit fee (1 DAI)")
      expect(text).toContain("holds more than 1 DAI in total")
      // Two ways out, read as a choice.
      expect(text).toContain("Alternatively, you can recover the funds")
    }
  })

  it("names the cap only where the amount the pool would forward exceeds it", () => {
    const over = copy({ amount: "4200", fee: ONE_DAI, fpcFundingCut: "0" })
    expect(over).toContain("over the network's per-transaction deposit cap (2583 DAI)")
    expect(over).not.toContain("deposit fee (")
    expect(over).not.toContain("same deposit address")
    expect(over).toContain("You can recover the funds")
    // The pool keeps the fee, so a gross of exactly cap + fee forwards exactly the cap.
    expect(copy({ amount: "2584", fee: ONE_DAI, fpcFundingCut: "0" })).not.toContain(
      "per-transaction deposit cap",
    )
    expect(copy({ amount: "2585", fee: ONE_DAI, fpcFundingCut: "0" })).toContain(
      "per-transaction deposit cap",
    )
    // With no fee on the record the gross is all there is to measure against.
    expect(copy({ amount: "2583" })).not.toContain("per-transaction deposit cap")
    expect(copy({ amount: "2584" })).toContain("per-transaction deposit cap")
  })

  it("names the whole deduction, not the sweep fee alone", () => {
    // 1.2 DAI clears the 1 DAI sweep fee and still cannot move: the record's fee is the 1.25 total.
    const text = copy({ amount: "1.2", fee: FEE_WITH_CUT, fpcFundingCut: QUARTER_DAI })
    expect(text).toContain("at or below the network's deposit fee (1.25 DAI)")
    expect(text).toContain("holds more than 1.25 DAI in total")
  })

  it("names the fee in the token sent and the cap in the DAI the swap forwards", () => {
    const text = copy({ amount: "4200", fee: ONE_DAI, fpcFundingCut: "0", tokenSymbol: "USDC" })
    expect(text).toContain("deposit cap (2583 DAI)")
    expect(text).not.toContain("USDC)")
    const floor = copy({ amount: "0.4", fee: ONE_DAI, fpcFundingCut: "0", tokenSymbol: "USDC" })
    expect(floor).toContain("deposit fee (1 USDC)")
    expect(floor).toContain("holds more than 1 USDC in total")
  })

  it("names the cap in the deployment's settlement token", () => {
    const over = { amount: "4200", fee: ONE_DAI, fpcFundingCut: "0" }
    // Sandbox and testnet settle in the manifest token the picker labels TEST.
    expect(copy({ ...over, tokenSymbol: "TEST" }, "TEST")).toContain("deposit cap (2583 TEST)")
    // Mainnet settles in DAI whatever was sent.
    expect(copy({ ...over, tokenSymbol: "USDC" }, "DAI")).toContain("deposit cap (2583 DAI)")
    // The fee stays in the token the record was funded in.
    const floor = copy(
      { amount: "0.2", fee: "350000000000000000", fpcFundingCut: "0", tokenSymbol: "USDC" },
      "DAI",
    )
    expect(floor).toContain("deposit fee (0.35 USDC)")
  })

  it("claims no cause it cannot prove between the fee and the cap", () => {
    const text = copy({ amount: "95", fee: ONE_DAI, fpcFundingCut: "0" })
    expect(text).toContain("can't be moved into your private balance")
    expect(text).not.toContain("deposit fee (")
    expect(text).not.toContain("per-transaction deposit cap")
    expect(text).toContain("recover the funds")
  })

  it("never claims the floor for a record with no persisted fee", () => {
    expect(copy({ amount: "0.4", fee: undefined })).not.toContain("deposit fee (")
  })

  it("promises no recovery to a deposit discovered without its note secret", () => {
    const text = copy({ amount: "0.4", fee: ONE_DAI, fpcFundingCut: "0", messageSecret: "" })
    expect(text).toContain("at or below the network's deposit fee")
    expect(text).toContain("hasn't discovered yet")
  })
})
