/**
 * The web side of the self-sweep exit: who is offered it, the pre-submit funding guard, the deposit
 * intent's create2 args the deploy-and-sweep is bound to, and the two submission channels.
 * `buildSipaSweepCall` runs for real, so the target and calldata assertions are byte-exact against
 * the SIPA-intents encoder (the local mirror until it vendors).
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { decodeFunctionData, multicall3Abi, parseEther, type Address, type Hex } from "viem"
import type { SIPADepositRecord } from "@obsidion/front-core"
import type { OxideEnvTuple } from "@obsidion/core/types"

const SIPA = `0x${"11".repeat(20)}` as Address
const OTHER_SIPA = `0x${"99".repeat(20)}` as Address
const TUPLE_TOKEN = `0x${"22".repeat(20)}` as Address
const RECORD_TOKEN = `0x${"33".repeat(20)}` as Address
const WALLET = `0x${"44".repeat(20)}` as Address
const TYPED = `0x${"55".repeat(20)}` as Address
const REGISTRY = `0x${"66".repeat(20)}` as Address
const SIPA_FACTORY = `0x${"77".repeat(20)}` as Address
const PORTAL = `0x${"cc".repeat(20)}` as Address
const SUBSIDY = `0x${"aa".repeat(20)}` as Address
const COMMITMENT = `0x${"1f".repeat(32)}` as Hex
const RECOVERY_ADDRESS = `0x${"bb".repeat(20)}` as Address
const IMPL = `0x${"ee".repeat(20)}` as Address
const HASH = `0x${"ab".repeat(32)}` as Hex
const FEE = 10n
const CUT = 5n

const l1Clients = vi.hoisted(() => ({ getL1Clients: vi.fn() }))
const bridge = vi.hoisted(() => ({
  submitViaDesktopBridge: vi.fn(),
  isDesktopL1SubmitActive: vi.fn(() => false),
}))

vi.mock("../src/features/deposit/l1Wallet", () => l1Clients)
vi.mock("../src/platform/desktopBridge", () => bridge)

const {
  SELF_BROADCAST_RESWEEPABLE,
  TX_AMOUNT_CAP,
  buildDepositIntent,
  encodeSweep,
  MULTICALL3_ADDRESS,
} = await import("@obsidion/sdk")
const { canSelfSweep, selfSweepDeposit, sweepChannel, sweepDeployArgs, sweepManifestFrom } =
  await import("../src/features/deposit/sipaSweep")
const { STUCK_SWEEP_MS } = await import("../src/features/deposit/sipaRecovery")

/** The deposit intent this wallet's stealth `recipientHash` (COMMITMENT) commits to. */
const depositIntent = buildDepositIntent({ implementation: IMPL, recipientCommitment: COMMITMENT })

/**
 * The sweep calldata the encoder produces for `token` tipped to `relayer`, revealing the deposit
 * intent — byte equality against it pins the selector, the argument order, and the values in one
 * assertion.
 */
const sweepCalldata = (token: Address, relayer: Address): Hex =>
  encodeSweep({
    token,
    relayer,
    intentData: depositIntent.intentData,
    proofs: depositIntent.proofs,
  })

const NOW = 1_700_000_000_000

const record = (patch: Partial<SIPADepositRecord> = {}): SIPADepositRecord =>
  ({
    sipaAddress: SIPA,
    recipientL2Address: "0xaa",
    messageSecret: "0x1",
    recipientHash: COMMITMENT,
    recoveryAddress: RECOVERY_ADDRESS,
    l1ChainId: 11155111,
    amount: "0.5",
    tokenSymbol: "DAI",
    phase: "sweeping",
    startTime: NOW - STUCK_SWEEP_MS,
    ...patch,
  } as SIPADepositRecord)

const manifest = {
  sipaFactory: SIPA_FACTORY,
  portal: PORTAL,
  rollupVersion: 4127419662n,
  token: TUPLE_TOKEN,
}

const tuple = {
  version: "t",
  gitSha: "0".repeat(40),
  timestamp: new Date(0).toISOString(),
  deployedAt: new Date(0).toISOString(),
  portal: PORTAL,
  token: TUPLE_TOKEN,
  l2Token: `0x${"dd".repeat(32)}`,
  enclaveUrl: "https://enclave.invalid",
  pcr0: "0".repeat(96),
  rollupVersion: "4127419662",
  registry: REGISTRY,
  sipaFactory: SIPA_FACTORY,
  depositSubsidy: SUBSIDY,
} satisfies OxideEnvTuple

describe("canSelfSweep", () => {
  it("offers the sweep to a stuck deposit, with or without the note's message secret", () => {
    // A sweep carries no signature — only the deploy args and the sweep args.
    expect(canSelfSweep(record(), NOW)).toBe(true)
    expect(canSelfSweep(record({ messageSecret: "" }), NOW)).toBe(true)
  })

  it("withholds it from a sweep the relayer may still land", () => {
    expect(canSelfSweep(record({ startTime: NOW - STUCK_SWEEP_MS + 1 }), NOW)).toBe(false)
    expect(canSelfSweep(record({ startTime: NOW }), NOW)).toBe(false)
  })

  it("withholds it from a deposit under the fee floor, where Recover is the only exit", () => {
    // The sweep hard-reverts at or below the fee, so none can ever land.
    expect(canSelfSweep(record({ phase: "recoverable", startTime: 0 }), NOW)).toBe(false)
  })

  it("withholds it once a self-sweep has been submitted", () => {
    expect(canSelfSweep(record({ sweepTxHash: HASH }), NOW)).toBe(false)
  })

  it("withholds it without the derived inputs the CREATE2 address is bound to", () => {
    expect(canSelfSweep(record({ recipientHash: "" }), NOW)).toBe(false)
    expect(canSelfSweep(record({ recoveryAddress: "" }), NOW)).toBe(false)
  })

  it("offers it to a stale broadcast record no relayer ever acknowledged", () => {
    expect(canSelfSweep(record({ phase: "broadcast", startTime: 0 }), NOW)).toBe(true)
    expect(canSelfSweep(record({ phase: "broadcast", startTime: NOW - 1 }), NOW)).toBe(false)
  })

  it("withholds it on every other phase", () => {
    for (const phase of [
      "resolved",
      "funding",
      "funded",
      "pendingClaim",
      "claimed",
      "failed",
      "recovered",
    ] as const) {
      expect(canSelfSweep(record({ phase, startTime: 0 }), NOW)).toBe(false)
    }
  })
})

describe("sweepManifestFrom", () => {
  it("reads the four fields the derivation and the sweep bind to", () => {
    expect(sweepManifestFrom(tuple)).toEqual(manifest)
  })

  it("names the manifest field a thin deployment is missing", () => {
    const { sipaFactory: _dropped, ...thin } = tuple
    expect(() => sweepManifestFrom(thin)).toThrow(/sipaFactory/)
  })

  // The self-sweep claims no deposit subsidy, so a deployment that omits it still sweeps.
  it("builds without the deposit subsidy", () => {
    const { depositSubsidy: _dropped, ...thin } = tuple
    expect(sweepManifestFrom(thin)).toEqual(manifest)
  })

  it("refuses a non-numeric rollupVersion the CREATE2 derivation binds to", () => {
    expect(() => sweepManifestFrom({ ...tuple, rollupVersion: "v5" })).toThrow(/rollupVersion/)
  })
})

describe("sweepDeployArgs", () => {
  it("reproduces the deposit intent's create2 arguments from the record and the manifest", () => {
    // Field-for-field against the deposit intent the address was derived under: any drift here
    // deploys to a different address and the sweep reverts. `intentHash` binds the recipient
    // commitment, `implementation` the deposit intent type.
    expect(sweepDeployArgs(record(), manifest, IMPL)).toEqual({
      implementation: IMPL,
      intentHash: depositIntent.intentHash,
      recoveryAddress: RECOVERY_ADDRESS,
      rollupVersion: 4127419662n,
      resweepable: SELF_BROADCAST_RESWEEPABLE,
    })
  })
})

describe("selfSweepDeposit", () => {
  const channel = {
    target: WALLET,
    sendTransaction: vi.fn(async () => HASH),
    waitForReceipt: vi.fn(async () => true),
  }
  const store = { upsert: vi.fn(), get: vi.fn(() => null as SIPADepositRecord | null) }
  const predict = vi.fn(async () => SIPA)

  const deps = (
    over: {
      balance?: bigint
      /** `10^(feeDecimals - sentDecimals)`, as `readSipaFundingStatus` is given it. */
      scale?: bigint
      fee?: bigint
      cut?: bigint
      deployed?: boolean
      predicted?: Address
    } = {},
  ) => {
    const balance = over.balance ?? 1_000n
    const scaledBalance = balance * (over.scale ?? 1n)
    const fee = over.fee ?? FEE
    const fpcFundingCut = over.cut ?? CUT
    const floor = fee + fpcFundingCut
    return {
      channel,
      manifest,
      implementation: IMPL,
      readDeployed: vi.fn(async () => over.deployed ?? false),
      readFunding: vi.fn(async () => ({
        balance,
        scaledBalance,
        fee,
        fpcFundingCut,
        // The fee and the cut come off first, and only what is forwarded meets the cap.
        sweepable: scaledBalance > floor && scaledBalance - floor <= TX_AMOUNT_CAP,
      })),
      predict: predict.mockResolvedValue(over.predicted ?? SIPA),
      store,
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    channel.sendTransaction.mockResolvedValue(HASH)
    channel.waitForReceipt.mockResolvedValue(true)
    store.get.mockReturnValue(null)
  })

  it("refuses a deposit whose derived address inputs are missing", async () => {
    const d = deps()
    await expect(selfSweepDeposit(record({ recipientHash: "" }), d)).rejects.toThrow(
      /still looking up this deposit's details/,
    )
    expect(d.readFunding).not.toHaveBeenCalled()
  })

  it("aborts on an empty SIPA — the relayer won the race", async () => {
    await expect(selfSweepDeposit(record(), deps({ balance: 0n }))).rejects.toThrow(
      /already been swept/,
    )
    expect(channel.sendTransaction).not.toHaveBeenCalled()
  })

  it("aborts on a balance that no longer clears the deposit fee, and says so", async () => {
    await expect(selfSweepDeposit(record(), deps({ balance: FEE }))).rejects.toThrow(
      /at or below the network's deposit fee, so it can't be moved into your private balance/,
    )
    expect(channel.sendTransaction).not.toHaveBeenCalled()
  })

  it("refuses a balance that clears the sweep fee but not the portal's cut", async () => {
    // The portal takes its cut out of what the sweep forwards, so the floor is both halves.
    await expect(selfSweepDeposit(record(), deps({ balance: FEE + CUT }))).rejects.toThrow(
      /at or below the network's deposit fee/,
    )
    expect(channel.sendTransaction).not.toHaveBeenCalled()
    // One unit above both halves is the first balance that moves.
    await expect(selfSweepDeposit(record(), deps({ balance: FEE + CUT + 1n }))).resolves.toBe(HASH)
  })

  it("blames the cap, not the fee, on a balance topped up past the per-transaction ceiling", async () => {
    // Over the ceiling by one unit: the portal credits `balance − fee − cut`, so the window's top is
    // the whole floor above the cap.
    const over = deps({ balance: TX_AMOUNT_CAP + FEE + CUT + 1n })
    await expect(selfSweepDeposit(record(), over)).rejects.toThrow(
      /over the network's per-transaction deposit cap, so it can't be moved into your private balance/,
    )
    expect(channel.sendTransaction).not.toHaveBeenCalled()
    // Exactly at it still sweeps.
    await expect(
      selfSweepDeposit(record(), deps({ balance: TX_AMOUNT_CAP + FEE + CUT })),
    ).resolves.toBe(HASH)
  })

  it("blames the cap on a 6-decimal deposit measured against the 18-decimal fee it swaps into", async () => {
    // 5,000 USDC. In raw token units the balance reads as dust below the fee floor; in the fee's
    // own denomination it is far over the cap, which is what the sender has to be told.
    const usdc = deps({
      balance: 5_000_000_000n,
      scale: 10n ** 12n,
      fee: parseEther("0.25"),
      cut: parseEther("0.1"),
    })
    await expect(selfSweepDeposit(record(), usdc)).rejects.toThrow(
      /over the network's per-transaction deposit cap/,
    )
    expect(channel.sendTransaction).not.toHaveBeenCalled()
  })

  it("deploy-and-sweeps an undeployed SIPA through Multicall3, tipping the channel's target", async () => {
    const d = deps({ deployed: false })
    await expect(selfSweepDeposit(record({ tokenAddress: RECORD_TOKEN }), d)).resolves.toBe(HASH)
    expect(d.readFunding).toHaveBeenCalledWith(SIPA, RECORD_TOKEN)

    const [to, data] = channel.sendTransaction.mock.calls[0] as unknown as [Address, Hex]
    expect(to).toBe(MULTICALL3_ADDRESS)
    const decoded = decodeFunctionData({ abi: multicall3Abi, data })
    const [calls] = decoded.args as unknown as [{ target: Address; callData: Hex }[]]
    expect(calls.map((c) => c.target.toLowerCase())).toEqual([SIPA_FACTORY, SIPA])
    // The tip returns to the submitter, not to a relayer.
    expect(calls[1]!.callData).toBe(sweepCalldata(RECORD_TOKEN, WALLET))
  })

  it("sweeps a deployed SIPA directly, and never predicts an address it will not deploy", async () => {
    const d = deps({ deployed: true })
    await expect(selfSweepDeposit(record(), d)).resolves.toBe(HASH)
    const [to, data] = channel.sendTransaction.mock.calls[0] as unknown as [Address, Hex]
    expect(to).toBe(SIPA)
    // Falls back to the manifest token for a record predating `tokenAddress` tracking.
    expect(data).toBe(sweepCalldata(TUPLE_TOKEN, WALLET))
    expect(d.predict).not.toHaveBeenCalled()
  })

  it("refuses to deploy when the args predict a different address", async () => {
    const d = deps({ predicted: OTHER_SIPA })
    await expect(selfSweepDeposit(record(), d)).rejects.toThrow(/different address/)
    expect(d.predict).toHaveBeenCalledWith(sweepDeployArgs(record(), manifest, IMPL))
    expect(channel.sendTransaction).not.toHaveBeenCalled()
  })

  it("marks the sweep submitted without settling the record the sync loop still owns", async () => {
    // A sweep only reaches the portal; the claim rides the next scan of this very tx's Sweep log.
    await selfSweepDeposit(record(), deps())
    expect(store.upsert).toHaveBeenCalledWith(SIPA, { phase: "sweeping", sweepTxHash: HASH })
  })

  it("keeps a claim that landed while the receipt was awaited", async () => {
    // Rewinding to `sweeping` would never heal: later scans short-circuit on the claimed index.
    store.get.mockReturnValue(record({ phase: "claimed" }))
    await selfSweepDeposit(record(), deps())
    expect(store.upsert).toHaveBeenCalledWith(SIPA, { phase: "claimed", sweepTxHash: HASH })
  })

  it("reports a reverted sweep as a lost race and writes nothing", async () => {
    channel.waitForReceipt.mockResolvedValue(false)
    await expect(selfSweepDeposit(record(), deps())).rejects.toThrow(/swept this deposit first/)
    expect(store.upsert).not.toHaveBeenCalled()
  })
})

describe("sweepChannel", () => {
  const config = { l1ChainId: 11155111, l1RpcUrl: "http://l1" } as never

  beforeEach(() => {
    vi.clearAllMocks()
    bridge.isDesktopL1SubmitActive.mockReturnValue(false)
  })

  it("tips the connected account in a browser with an injected wallet", async () => {
    l1Clients.getL1Clients.mockResolvedValue({
      walletClient: { sendTransaction: vi.fn(async () => HASH) },
      publicClient: { waitForTransactionReceipt: vi.fn(async () => ({ status: "success" })) },
      account: WALLET,
      chain: { id: 11155111 },
    })
    const channel = await sweepChannel({
      config,
      record: record(),
      publicClient: {} as never,
      opts: { from: WALLET },
    })
    expect(channel.target).toBe(WALLET)
    expect(l1Clients.getL1Clients).toHaveBeenCalledWith(11155111, WALLET)
  })

  it("tips the typed address through the desktop helper page", async () => {
    bridge.isDesktopL1SubmitActive.mockReturnValue(true)
    bridge.submitViaDesktopBridge.mockResolvedValue(HASH)
    const waitForTransactionReceipt = vi.fn(async () => ({ status: "success" }))
    const channel = await sweepChannel({
      config,
      record: record(),
      publicClient: { waitForTransactionReceipt } as never,
      opts: { destination: TYPED },
    })

    expect(channel.target).toBe(TYPED)
    await expect(channel.sendTransaction(MULTICALL3_ADDRESS, "0xdeadbeef")).resolves.toBe(HASH)
    const params = bridge.submitViaDesktopBridge.mock.calls[0]![0]
    expect(params.tx).toEqual({ to: MULTICALL3_ADDRESS, data: "0xdeadbeef", chainId: 11155111 })
    expect(params.display.title).toBe("Finish your zk.money deposit")
    expect(Object.fromEntries(params.display.lines)).toMatchObject({
      "Deposit address": SIPA,
      "Network tip to": TYPED,
    })
    await expect(channel.waitForReceipt(HASH)).resolves.toBe(true)
  })

  it("refuses bridge mode without a valid address to tip", async () => {
    bridge.isDesktopL1SubmitActive.mockReturnValue(true)
    await expect(
      sweepChannel({ config, record: record(), publicClient: {} as never, opts: {} }),
    ).rejects.toThrow(/network tip/)
    await expect(
      sweepChannel({
        config,
        record: record(),
        publicClient: {} as never,
        opts: { destination: "0xnope" as Address },
      }),
    ).rejects.toThrow(/network tip/)
  })
})
