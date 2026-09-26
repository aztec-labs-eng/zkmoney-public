import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Address } from "viem"
import { keccak256 } from "@aztec/foundation/crypto/keccak"
import type { OxideEnvTuple } from "@obsidion/core/types"

const mocks = vi.hoisted(() => ({
  fetchSipaEvents: vi.fn(),
  readSweepEvents: vi.fn(),
  readRecoveredEvents: vi.fn(async () => []),
  readBlockTimeMs: vi.fn(async () => undefined),
  readDepositMessageKey: vi.fn(),
  readFundingTransfers: vi.fn(),
  readSipaFundingStatus: vi.fn(),
  readDepositFee: vi.fn(),
  readFpcFundingCut: vi.fn(),
  readDepositSIPAImplementation: vi.fn(),
  readRegistrationSIPAImplementation: vi.fn(),
  computeStealthRecipientHash: vi.fn(),
  deriveRecoveryAddress: vi.fn(),
  computeSIPAAddress: vi.fn(),
  isL1ToL2MessageReady: vi.fn(),
  canonicalGenerationStack: vi.fn(() => "v5"),
}))

// The composition's collaborators are all unit-tested in their own modules
// (sdk reads, front-core crypto); here they are mocked so the test pins the
// ORCHESTRATION: sequencing, store patches, dedup, and failure isolation.
vi.mock("@obsidion/sdk", () => ({
  fetchSipaEvents: mocks.fetchSipaEvents,
  readSweepEvents: mocks.readSweepEvents,
  readRecoveredEvents: mocks.readRecoveredEvents,
  readBlockTimeMs: mocks.readBlockTimeMs,
  readDepositMessageKey: mocks.readDepositMessageKey,
  readFundingTransfers: mocks.readFundingTransfers,
  readSipaFundingStatus: mocks.readSipaFundingStatus,
  readDepositFee: mocks.readDepositFee,
  readFpcFundingCut: mocks.readFpcFundingCut,
  readDepositSIPAImplementation: mocks.readDepositSIPAImplementation,
  readRegistrationSIPAImplementation: mocks.readRegistrationSIPAImplementation,
}))
vi.mock("../../src/core/services/deposits/sipa/sipaAddress", () => ({
  computeSIPAAddress: mocks.computeSIPAAddress,
}))
vi.mock("../../src/core/services/deposits/sipa/stealth", () => ({
  computeStealthRecipientHash: mocks.computeStealthRecipientHash,
  deriveRecoveryAddress: mocks.deriveRecoveryAddress,
}))
vi.mock("src/core", () => ({
  canonicalGenerationStack: mocks.canonicalGenerationStack,
}))
vi.mock("@aztec/aztec.js/messaging", () => ({
  isL1ToL2MessageReady: mocks.isL1ToL2MessageReady,
}))
vi.mock("@aztec/foundation/eth-address", () => ({
  EthAddress: { fromString: (value: string) => ({ toString: () => value.toLowerCase() }) },
}))

import { syncSipaDeposits, type SipaDepositSyncDeps } from "../../src/oxide/sipaClaims"
import { globalEventEmitter } from "../../src/core/services/GlobalEventEmitter"

const SIPA_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address
const SIPA_B = "0xcccccccccccccccccccccccccccccccccccccccc" as Address
const SIPA_C = "0xdddddddddddddddddddddddddddddddddddddddd" as Address
/** Stand-in for the sdk's TX_AMOUNT_CAP — the sdk is mocked, so the funding read decides its own. */
const CAP = 1_000n
/** The rollup version's blessed deposit implementation, as the factory pointer reports it. */
const IMPLEMENTATION = "0x39dd57b9f2b16e5c9e9e35e18b73c8a2a5d1f7c4" as Address
const REGISTRATION_IMPLEMENTATION = "0x5a1e0c2f3b4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f" as Address
/** L1 head every run is bounded by — the block a completed scan persists. */
const HEAD = 11_390_182n
const RECIPIENT_HEX = "0x2589c51355cabd0722def6dabd818a309c4a8fc2d4cbc3ce2bf2eaaf59318456"
const TX_HASH = `0x${"ab".repeat(32)}`
/** The recovered token and where it went, as a `Recovered` log reports them. */
const TOKEN = "0x6b175474e89094c44da98b954eedeac495271d0f" as Address
const TARGET = "0x45e6000000000000000000000000000000000ed64" as Address

const TUPLE = {
  registry: "0x0b903b955dbc0c97252f1ce9e43f8c26e8f5635f",
  sipaFactory: "0x239474855dff1eb58dca3ee877d599e3c6bd0bd2",
  l2Token: "0x0f1c7a8b2b8a1f6de4b6a2c1c7e8d9f0a1b2c3d4e5f60718293a4b5c6d7e8f90",
  portal: "0x7992CD55908B19b60bc46926dEb9B1f1DFb6E0A9",
  rollupVersion: "4127419662",
} as unknown as OxideEnvTuple

/** Fr-like fake. `toBuffer` is a deterministic 32-byte image of the string (the derivation
 *  hashes the commitment for its intentHash; the label need not be valid hex). */
function fr(hex: string) {
  return {
    toString: () => hex,
    toBigInt: () => {
      try {
        return BigInt(hex)
      } catch {
        return 0n
      }
    },
    toBuffer: () => {
      const b = Buffer.alloc(32)
      Buffer.from(hex).copy(b, 0, 0, 32)
      return b
    },
  }
}

/** The deposit intentHash the derivation computes from a commitment: keccak256 of its 32 bytes. */
function intentHashOf(commitment: ReturnType<typeof fr>): Buffer {
  return keccak256(commitment.toBuffer())
}

function makeStore() {
  const records = new Map<string, Record<string, unknown>>()
  return {
    records,
    get: vi.fn((address: string) => records.get(address.toLowerCase()) ?? null),
    list: vi.fn(() => Array.from(records, ([sipaAddress, r]) => ({ sipaAddress, ...r }))),
    upsert: vi.fn(
      async (
        address: string,
        patch: Record<string, unknown>,
        fallback?: Record<string, unknown>,
      ) => {
        const key = address.toLowerCase()
        const existing = records.get(key)
        const next = existing ? { ...existing, ...patch } : { ...(fallback ?? {}), ...patch }
        records.set(key, next)
        return next
      },
    ),
  }
}

function makeDeps(store = makeStore()) {
  const tokenService = { claimSweptDeposit: vi.fn(async () => undefined) }
  const deps = {
    publicClient: {
      getBlockNumber: vi.fn(async () => HEAD),
    } as never,
    node: {} as never,
    wallet: { getPrivateEvents: vi.fn() } as never,
    tokenService,
    store,
    tuple: TUPLE,
    recipient: { toString: () => RECIPIENT_HEX } as never,
    stealthPublicKey: { x: 1n, y: 2n },
    token: {
      address: "0x163a94b604dfcee8fac53ea6d24db032e8f5cd6b" as Address,
      symbol: "DAI",
      decimals: 6,
    },
    l1ChainId: 11155111,
  } satisfies SipaDepositSyncDeps
  return { deps, store, tokenService }
}

const SECRET_A = fr(`0x${"11".repeat(32)}`)
const SECRET_B = fr(`0x${"22".repeat(32)}`)
const SECRET_C = fr(`0x${"33".repeat(32)}`)

/** The commitment the mocked derivation returns for `secret`. */
function commitmentOf(secret: ReturnType<typeof fr>) {
  return fr(`0xhash${secret.toString().slice(4, 8)}`)
}

/** `SipaEvent`-shaped fake for the fetchSipaEvents mock. Plain deposits carry the deposit intentHash. */
function sipaEvent(
  secret: ReturnType<typeof fr>,
  intentHash = `0x${intentHashOf(commitmentOf(secret)).toString("hex")}`,
) {
  return { sharedSecretSalt: secret, resweepable: false, intentHash }
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.computeStealthRecipientHash.mockImplementation((secret: { toString(): string }) =>
    fr(`0xhash${secret.toString().slice(4, 8)}`),
  )
  mocks.deriveRecoveryAddress.mockImplementation(() => ({
    toString: () => "0xfd9df8ea9d7350063da52e60e7e1b6d78449786a",
  }))
  mocks.computeSIPAAddress.mockImplementation(() => ({ toString: () => SIPA_A }))
  mocks.isL1ToL2MessageReady.mockResolvedValue(true)
  mocks.readDepositMessageKey.mockResolvedValue(fr(`0x${"0a".repeat(32)}`))
  mocks.readDepositFee.mockResolvedValue(100n)
  mocks.readFpcFundingCut.mockResolvedValue(40n)
  mocks.readDepositSIPAImplementation.mockResolvedValue(IMPLEMENTATION)
  mocks.readRegistrationSIPAImplementation.mockResolvedValue(REGISTRATION_IMPLEMENTATION)
  mocks.readFundingTransfers.mockResolvedValue([])
  mocks.readRecoveredEvents.mockResolvedValue([])
})

describe("syncSipaDeposits", () => {
  it("discovers an event, reads its settled Sweep, claims, and lands the record on claimed", async () => {
    const { deps, store, tokenService } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: 1n, txHash: TX_HASH },
    ])

    const result = await syncSipaDeposits(deps)

    expect(result).toMatchObject({ discovered: 1, claimed: 1, pendingSettlement: 0, failed: 0 })
    // The recipient's events are read off the manifest's L2 token.
    const [wallet, token, recipient] = mocks.fetchSipaEvents.mock.calls[0]!
    expect(wallet).toBe(deps.wallet)
    expect(token.toString()).toBe(TUPLE.l2Token)
    expect(recipient).toBe(deps.recipient)
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledWith({
      inboxIndex: 7n,
      amount: 990_000n,
      recipient: deps.recipient,
      sharedSecretSalt: SECRET_A,
    })
    const record = store.records.get(SIPA_A)
    expect(record).toMatchObject({
      phase: "claimed",
      inboxIndex: "7",
      claimedInboxIndexes: ["7"],
      netAmount: "990000",
      amount: "0.99",
      sweepTxHash: TX_HASH,
      messageSecret: SECRET_A.toString(),
      recipientL2Address: RECIPIENT_HEX,
    })
  })

  it("marks an unsettled sweep pendingClaim and does not claim yet", async () => {
    const { deps, store, tokenService } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: 1n, txHash: TX_HASH },
    ])
    mocks.isL1ToL2MessageReady.mockResolvedValue(false)

    const result = await syncSipaDeposits(deps)

    expect(result).toMatchObject({ claimed: 0, pendingSettlement: 1 })
    expect(tokenService.claimSweptDeposit).not.toHaveBeenCalled()
    expect(store.records.get(SIPA_A)).toMatchObject({
      phase: "pendingClaim",
      inboxIndex: "7",
      netAmount: "990000",
      amount: "0.99",
    })
  })

  it("on the v4 generation, checks readiness via getBlock/checkpoint instead of the v5 helper", async () => {
    mocks.canonicalGenerationStack.mockReturnValue("v4")
    try {
      const store = makeStore()
      const { deps, tokenService } = makeDeps(store)
      ;(deps as { node: unknown }).node = {
        getL1ToL2MessageCheckpoint: vi.fn(async () => 5),
        getBlock: vi.fn(async () => ({ checkpointNumber: 6 })),
      }
      mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
      mocks.readSweepEvents.mockResolvedValue([
        { index: 7n, amount: 990_000n, blockNumber: 1n, txHash: TX_HASH },
      ])

      const result = await syncSipaDeposits(deps)

      expect(result).toMatchObject({ claimed: 1, failed: 0 })
      expect(tokenService.claimSweptDeposit).toHaveBeenCalledTimes(1)
      expect(mocks.isL1ToL2MessageReady).not.toHaveBeenCalled()
    } finally {
      mocks.canonicalGenerationStack.mockReturnValue("v5")
    }
  })

  it("skips inbox indexes already claimed; a NEW sweep on the same SIPA claims independently", async () => {
    const store = makeStore()
    store.records.set(SIPA_A, {
      phase: "claimed",
      claimedInboxIndexes: ["7"],
      messageSecret: SECRET_A.toString(),
    })
    const { deps, tokenService } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: 1n, txHash: TX_HASH },
      { index: 9n, amount: 500_000n, blockNumber: 2n, txHash: TX_HASH },
    ])

    const result = await syncSipaDeposits(deps)

    expect(result.claimed).toBe(1)
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledTimes(1)
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ inboxIndex: 9n }),
    )
    expect(store.records.get(SIPA_A)).toMatchObject({ claimedInboxIndexes: ["7", "9"] })
  })

  it("prices a claimed record whose fee never landed, and reads nothing once it has", async () => {
    const store = makeStore()
    store.records.set(SIPA_A, {
      phase: "claimed",
      claimedInboxIndexes: ["7"],
      messageSecret: SECRET_A.toString(),
      netAmount: "990000",
      amount: "0.99",
      startTime: Date.now() - 86_400_000,
    })
    const { deps, tokenService } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: 11_000_000n, txHash: TX_HASH },
    ])

    await syncSipaDeposits(deps)

    expect(tokenService.claimSweptDeposit).not.toHaveBeenCalled()
    expect(store.records.get(SIPA_A)).toMatchObject({
      phase: "claimed",
      fee: "140",
      fpcFundingCut: "40",
    })

    // Off the slow lane's near side, so the second pass scans rather than skips.
    store.records.get(SIPA_A)!.lastScanAt = Date.now() - 6 * 60_000
    mocks.readDepositFee.mockClear()
    mocks.readFpcFundingCut.mockClear()

    await syncSipaDeposits(deps)

    expect(mocks.readDepositFee).not.toHaveBeenCalled()
    expect(mocks.readFpcFundingCut).not.toHaveBeenCalled()
  })

  it("backfills a fee the claiming pass lost on a later tick that reads no sweep", async () => {
    const { deps, store } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: HEAD - 1_000n, txHash: TX_HASH },
    ])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 0n,
      scaledBalance: 0n,
      fee: 100n,
      fpcFundingCut: 40n,
      sweepable: false,
    })
    mocks.readFpcFundingCut.mockRejectedValueOnce(new Error("temporary RPC failure"))

    await syncSipaDeposits(deps)

    const claimed = store.records.get(SIPA_A)!
    expect(claimed).toMatchObject({ phase: "claimed", lastScannedBlock: HEAD.toString() })
    expect(claimed.fee).toBeUndefined()

    // Off the slow lane's near side, and the cursor sits past the sweep: nothing in this window
    // carries the fee, so only the per-tick backfill can land it.
    claimed.lastScanAt = Date.now() - 6 * 60_000
    mocks.readSweepEvents.mockResolvedValue([])

    await syncSipaDeposits(deps)

    expect(store.records.get(SIPA_A)).toMatchObject({
      phase: "claimed",
      fee: "140",
      fpcFundingCut: "40",
    })
  })

  it("flips a funding outside the sweep window to recoverable at either end; in-window stays sweeping", async () => {
    const { deps, store } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([
      sipaEvent(SECRET_A),
      sipaEvent(SECRET_B),
      sipaEvent(SECRET_C),
    ])
    mocks.computeSIPAAddress
      .mockImplementationOnce(() => ({ toString: () => SIPA_A }))
      .mockImplementationOnce(() => ({ toString: () => SIPA_B }))
      .mockImplementationOnce(() => ({ toString: () => SIPA_C }))
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus
      .mockResolvedValueOnce({
        balance: 50n,
        scaledBalance: 50n,
        fee: 100n,
        fpcFundingCut: 40n,
        sweepable: false,
      })
      .mockResolvedValueOnce({
        balance: 500n,
        scaledBalance: 500n,
        fee: 100n,
        fpcFundingCut: 40n,
        sweepable: true,
      })
      // Past the window's top: the credited amount is `balance − fee − cut`, so the ceiling sits
      // both of those above `CAP`.
      .mockResolvedValueOnce({
        balance: CAP + 101n,
        scaledBalance: CAP + 101n,
        fee: 100n,
        fpcFundingCut: 40n,
        sweepable: false,
      })

    const result = await syncSipaDeposits(deps)

    expect(result).toMatchObject({ discovered: 3, recoverable: 2 })
    // The whole fee lands on every funding write, with the portal's part alongside.
    expect(store.records.get(SIPA_B)).toMatchObject({ fee: "140", fpcFundingCut: "40" })
    expect(store.records.get(SIPA_A)).toMatchObject({ phase: "recoverable" })
    expect(store.records.get(SIPA_B)).toMatchObject({ phase: "sweeping" })
    expect(store.records.get(SIPA_C)).toMatchObject({ phase: "recoverable" })
  })

  it.each([0n, 1n, 10n ** 24n])(
    "finds sweepable USDC despite an unsweepable DAI balance of %s",
    async (daiBalance) => {
      const { deps, store } = makeDeps()
      const usdc = {
        address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as Address,
        symbol: "USDC",
        decimals: 6,
      }
      mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
      mocks.readSweepEvents.mockResolvedValue([])
      mocks.readSipaFundingStatus
        .mockResolvedValueOnce({
          balance: daiBalance,
          scaledBalance: daiBalance,
          fee: 100n,
          sweepable: false,
        })
        .mockResolvedValueOnce({
          balance: 5_000_000n,
          scaledBalance: 5_000_000n * 10n ** 12n,
          fee: 100n,
          sweepable: true,
        })
      mocks.readFundingTransfers.mockImplementation(async (_client: unknown, token: string) =>
        token === usdc.address
          ? [{ from: "0xfeed", amount: 5_000_000n, blockNumber: 5n, txHash: "0xtx" }]
          : [],
      )

      const result = await syncSipaDeposits({
        ...deps,
        token: { ...deps.token, decimals: 18 },
        fundingTokens: [deps.token, usdc],
      })

      expect(result).toMatchObject({ discovered: 1, active: 1 })
      expect(mocks.readSipaFundingStatus).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ token: usdc.address, balanceScale: 10n ** 12n }),
      )
      expect(store.records.get(SIPA_A)).toMatchObject({
        phase: "sweeping",
        amount: "5",
        tokenAddress: usdc.address,
        tokenSymbol: "USDC",
        tokenDecimals: 6,
        fundingTxHash: "0xtx",
      })
    },
  )

  it("targets the largest normalized balance for recovery when no token is sweepable", async () => {
    const { deps, store } = makeDeps()
    const usdc = {
      address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as Address,
      symbol: "USDC",
      decimals: 6,
    }
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus
      .mockResolvedValueOnce({
        balance: 10n ** 12n,
        scaledBalance: 10n ** 12n,
        fee: 10n ** 18n,
        sweepable: false,
      })
      .mockResolvedValueOnce({
        balance: 500_000n,
        scaledBalance: 500_000n * 10n ** 12n,
        fee: 10n ** 18n,
        sweepable: false,
      })

    await syncSipaDeposits({
      ...deps,
      token: { ...deps.token, decimals: 18 },
      fundingTokens: [deps.token, usdc],
    })

    expect(store.records.get(SIPA_A)).toMatchObject({
      phase: "recoverable",
      amount: "0.5",
      tokenAddress: usdc.address,
      tokenSymbol: "USDC",
    })
  })

  it.each([true, false])(
    "preserves credited metadata after delayed attribution (settled: %s)",
    async (settled) => {
      const { deps, store } = makeDeps()
      const usdc = {
        address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as Address,
        symbol: "USDC",
        decimals: 6,
      }
      const syncDeps = {
        ...deps,
        token: { ...deps.token, decimals: 18 },
        fundingTokens: [deps.token, usdc],
      }
      mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
      mocks.readSweepEvents.mockResolvedValue([
        { index: 7n, amount: 4n * 10n ** 18n, blockNumber: HEAD, txHash: TX_HASH },
      ])
      mocks.isL1ToL2MessageReady.mockResolvedValue(settled)
      mocks.readFundingTransfers.mockRejectedValue(new Error("temporary RPC failure"))
      await syncSipaDeposits(syncDeps)
      store.records.get(SIPA_A)!.lastScanAt = 0
      mocks.readFundingTransfers.mockImplementation(async (_client: unknown, token: string) =>
        token === usdc.address
          ? [{ from: "0xfeed", amount: 5_000_000n, blockNumber: HEAD, txHash: "0xfund" }]
          : [],
      )

      await syncSipaDeposits(syncDeps)

      expect(store.records.get(SIPA_A)).toMatchObject({
        phase: settled ? "claimed" : "pendingClaim",
        amount: "4",
        tokenAddress: deps.token.address,
        tokenSymbol: "DAI",
        tokenDecimals: 18,
        fundingTxHash: "0xfund",
        fundingFromAddress: "0xfeed",
      })
    },
  )

  it("stamps the larger of the deposit fee and the seeded registration fee, plus the portal's cut", async () => {
    const store = makeStore()
    const pinned = (secret: ReturnType<typeof fr>, registrationFee: string) => ({
      phase: "broadcast",
      intent: "registration",
      registrationFee,
      messageSecret: secret.toString(),
      recipientL2Address: RECIPIENT_HEX,
      recipientHash: "0xset",
      recoveryAddress: "0xset",
    })
    store.records.set(SIPA_A, pinned(SECRET_A, "140"))
    store.records.set(SIPA_B, pinned(SECRET_B, "0"))
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A), sipaEvent(SECRET_B)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 500n,
      scaledBalance: 500n,
      fee: 100n,
      sweepable: true,
    })

    await syncSipaDeposits(deps)

    expect(store.records.get(SIPA_A)).toMatchObject({ phase: "sweeping", fee: "180" })
    expect(store.records.get(SIPA_B)).toMatchObject({ phase: "sweeping", fee: "140" })
    expect(mocks.readFpcFundingCut).toHaveBeenCalledTimes(1)
  })

  it("prices a registration SIPA's floor off the routed schedule fee, not the implementation's", async () => {
    const store = makeStore()
    store.records.set(SIPA_A, {
      phase: "broadcast",
      intent: "registration",
      registrationFee: "140",
      messageSecret: SECRET_A.toString(),
      recipientL2Address: RECIPIENT_HEX,
      recipientHash: "0xset",
      recoveryAddress: "0xset",
    })
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 500n,
      scaledBalance: 500n,
      fee: 140n,
      sweepable: true,
    })

    await syncSipaDeposits(deps)

    expect(mocks.readSipaFundingStatus).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ fee: 140n, fpcFundingCut: 40n }),
    )
  })

  it.each([
    ["short of the schedule minimum", 200n, "recoverable"],
    ["at the registration floor", 341n, "sweeping"],
  ])("holds a registration deposit %s", async (_case, balance, phase) => {
    const store = makeStore()
    store.records.set(SIPA_A, {
      phase: "broadcast",
      intent: "registration",
      registrationFee: "140",
      messageSecret: SECRET_A.toString(),
      recipientL2Address: RECIPIENT_HEX,
      recipientHash: "0xset",
      recoveryAddress: "0xset",
    })
    // fee 140 + max(min 200, cut 40 + 1) = 340: what `RegistrationController._checkPayment` takes.
    const deps: SipaDepositSyncDeps = {
      ...makeDeps(store).deps,
      registrationScheduleFor: () => ({ min: 200n, fee: 140n }),
    }
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance,
      scaledBalance: balance,
      fee: 140n,
      sweepable: true,
    })

    await syncSipaDeposits(deps)

    expect(store.records.get(SIPA_A)).toMatchObject({ phase })
  })

  it("leaves a plain deposit's window at the fee plus the cut", async () => {
    const store = makeStore()
    const deps: SipaDepositSyncDeps = {
      ...makeDeps(store).deps,
      registrationScheduleFor: () => ({ min: 10_000n, fee: 10_000n }),
    }
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 500n,
      scaledBalance: 500n,
      fee: 100n,
      sweepable: true,
    })

    await syncSipaDeposits(deps)

    expect(store.records.get(SIPA_A)).toMatchObject({ phase: "sweeping" })
  })

  it("records a funded SIPA's amount but holds its phase when the fee read fails", async () => {
    const { deps, store } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readDepositFee.mockRejectedValue(new Error("temporary RPC failure"))
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 500n,
      scaledBalance: 500n,
      fee: 0n,
      sweepable: true,
    })

    const result = await syncSipaDeposits(deps)

    expect(result).toMatchObject({ discovered: 1, failed: 0 })
    const record = store.records.get(SIPA_A)!
    // An unread fee prices the window at zero, under which dust reads as sweepable.
    expect(record).toMatchObject({ phase: "broadcast", amount: "0.0005" })
    expect(record.fee).toBeUndefined()
    expect(record.fpcFundingCut).toBeUndefined()
  })

  it("holds a registration SIPA's phase while its own schedule is not in hand", async () => {
    const store = makeStore()
    store.records.set(SIPA_A, {
      phase: "recoverable",
      intent: "registration",
      registrationFee: "140",
      startTime: 1,
      messageSecret: SECRET_A.toString(),
      recipientL2Address: RECIPIENT_HEX,
      recipientHash: "0xset",
      recoveryAddress: "0xset",
    })
    const deps: SipaDepositSyncDeps = {
      ...makeDeps(store).deps,
      // Ours, but the terms that price its floor are missing or name another fee.
      registrationScheduleFor: () => null,
    }
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 500n,
      scaledBalance: 500n,
      fee: 140n,
      sweepable: true,
    })

    await syncSipaDeposits(deps)

    expect(store.records.get(SIPA_A)).toMatchObject({ phase: "recoverable", amount: "0.0005" })
  })

  it("recovers a registration SIPA no schedule can ever sweep", async () => {
    const store = makeStore()
    store.records.set(SIPA_A, {
      phase: "broadcast",
      intent: "registration",
      registrationFee: "140",
      startTime: 1,
      messageSecret: SECRET_A.toString(),
      recipientL2Address: RECIPIENT_HEX,
      recipientHash: "0xset",
      recoveryAddress: "0xset",
    })
    const deps: SipaDepositSyncDeps = {
      ...makeDeps(store).deps,
      // Ours, and closed: the claim cannot be re-issued at the fee its address commits to.
      registrationScheduleFor: () => "unsweepable",
    }
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 500n,
      scaledBalance: 500n,
      fee: 140n,
      sweepable: true,
    })

    const result = await syncSipaDeposits(deps)

    expect(result).toMatchObject({ recoverable: 1 })
    expect(store.records.get(SIPA_A)).toMatchObject({ phase: "recoverable", amount: "0.0005" })
  })

  it("classifies a SIPA this wallet never registered on the fee and the cut alone", async () => {
    const store = makeStore()
    const deps: SipaDepositSyncDeps = {
      ...makeDeps(store).deps,
      registrationScheduleFor: () => undefined,
    }
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 500n,
      scaledBalance: 500n,
      fee: 100n,
      sweepable: true,
    })

    await syncSipaDeposits(deps)

    expect(store.records.get(SIPA_A)).toMatchObject({ phase: "sweeping" })
  })

  it("claims a swept deposit even when the fee read fails", async () => {
    const { deps, store, tokenService } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: 1n, txHash: TX_HASH },
    ])
    mocks.readFpcFundingCut.mockRejectedValue(new Error("temporary RPC failure"))

    const result = await syncSipaDeposits(deps)

    expect(result).toMatchObject({ claimed: 1, failed: 0 })
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledTimes(1)
    const record = store.records.get(SIPA_A)!
    expect(record).toMatchObject({ phase: "claimed", claimedInboxIndexes: ["7"] })
    expect(record.fee).toBeUndefined()
  })

  it("retries a rejected fee read for the next event in the same pass", async () => {
    const store = makeStore()
    const pinned = (secret: ReturnType<typeof fr>) => ({
      phase: "broadcast",
      messageSecret: secret.toString(),
      recipientL2Address: RECIPIENT_HEX,
      recipientHash: "0xset",
      recoveryAddress: "0xset",
    })
    store.records.set(SIPA_A, pinned(SECRET_A))
    store.records.set(SIPA_B, pinned(SECRET_B))
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A), sipaEvent(SECRET_B)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readDepositFee
      .mockRejectedValueOnce(new Error("temporary RPC failure"))
      .mockResolvedValue(100n)
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 500n,
      scaledBalance: 500n,
      fee: 100n,
      sweepable: true,
    })

    await syncSipaDeposits(deps)

    expect(mocks.readDepositFee).toHaveBeenCalledTimes(2)
    expect(store.records.get(SIPA_A)!.fee).toBeUndefined()
    expect(store.records.get(SIPA_B)).toMatchObject({ fee: "140" })
  })

  it("settles a recoverable SIPA emptied without a Sweep as recovered", async () => {
    const store = makeStore()
    store.records.set(SIPA_A, { phase: "recoverable", startTime: 1, amount: "0.4" })
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 0n,
      scaledBalance: 0n,
      fee: 100n,
      fpcFundingCut: 40n,
      sweepable: false,
    })

    await syncSipaDeposits(deps)

    // `recoverERC20` is the only thing that empties a SIPA silently, but which transaction did it
    // is not knowable from here.
    expect(store.records.get(SIPA_A)).toMatchObject({ phase: "recovered" })
    expect(store.records.get(SIPA_A)).not.toHaveProperty("recoveryTxHash")
  })

  it("settles a SIPA with a Recovered log as recovered, stamping its tx", async () => {
    const store = makeStore()
    store.records.set(SIPA_A, { phase: "sweeping", startTime: 1, amount: "15" })
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 0n,
      scaledBalance: 0n,
      fee: 100n,
      sweepable: false,
    })
    mocks.readRecoveredEvents.mockResolvedValue([
      { token: TOKEN, target: TARGET, amount: 15_000_000n, blockNumber: 9n, txHash: TX_HASH },
    ])

    await syncSipaDeposits(deps)

    expect(store.records.get(SIPA_A)).toMatchObject({
      phase: "recovered",
      recoveryTxHash: TX_HASH,
    })
  })

  it("leaves an empty SIPA alone unless it was recoverable and nothing was ever claimed off it", async () => {
    const store = makeStore()
    // A `sweeping` zero balance is funds that never arrived, not funds pulled back out.
    store.records.set(SIPA_A, { phase: "sweeping", startTime: 1 })
    // A claim off this SIPA explains the empty balance without any recovery.
    store.records.set(SIPA_B, { phase: "recoverable", startTime: 1, claimedInboxIndexes: ["4"] })
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A), sipaEvent(SECRET_B)])
    mocks.computeSIPAAddress
      .mockImplementationOnce(() => ({ toString: () => SIPA_A }))
      .mockImplementationOnce(() => ({ toString: () => SIPA_B }))
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 0n,
      scaledBalance: 0n,
      fee: 100n,
      fpcFundingCut: 40n,
      sweepable: false,
    })

    await syncSipaDeposits(deps)

    expect(store.records.get(SIPA_A)).toMatchObject({ phase: "sweeping" })
    expect(store.records.get(SIPA_B)).toMatchObject({ phase: "recoverable" })
  })

  it("does not clobber a recovery that landed while the funding read was in flight", async () => {
    const store = makeStore()
    store.records.set(SIPA_A, { phase: "sweeping", startTime: 1 })
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockImplementation(async () => {
      // `runSipaRecovery` settling the record inside the awaits this write straddles.
      await store.upsert(SIPA_A, { phase: "recovered", recoveryTxHash: TX_HASH })
      return { balance: 0n, scaledBalance: 0n, fee: 100n, fpcFundingCut: 40n, sweepable: false }
    })

    await syncSipaDeposits(deps)

    expect(store.records.get(SIPA_A)).toMatchObject({
      phase: "recovered",
      recoveryTxHash: TX_HASH,
    })
  })

  it("processes duplicate secrets once and isolates per-event failures", async () => {
    const { deps, store, tokenService } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([
      sipaEvent(SECRET_A),
      sipaEvent(SECRET_A),
      sipaEvent(SECRET_B),
    ])
    // SECRET_A resolves to commitment `0xhash1111` (the stealth-hash mock), so its deposit
    // intentHash is what maps to SIPA_A; every other event is SIPA_B.
    const intentHashA = intentHashOf(fr("0xhash1111"))
    mocks.computeSIPAAddress.mockImplementation((inputs: { intentHash: Buffer }) =>
      inputs.intentHash.equals(intentHashA)
        ? { toString: () => SIPA_A }
        : { toString: () => SIPA_B },
    )
    mocks.readSweepEvents.mockImplementation(async (_client: never, sipa: string) => {
      if (sipa === SIPA_A) throw new Error("rpc hiccup")
      return [{ index: 3n, amount: 100_000n, blockNumber: 1n, txHash: TX_HASH }]
    })

    const result = await syncSipaDeposits(deps)

    expect(result).toMatchObject({ discovered: 2, claimed: 1, failed: 1 })
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledTimes(1)
    expect(store.records.get(SIPA_B)).toMatchObject({ phase: "claimed" })
  })

  it("backfills empty discovery-derived fields on an existing self-initiated record", async () => {
    const store = makeStore()
    // Self-initiated create: record exists before discovery, derived fields empty.
    store.records.set(SIPA_A, {
      phase: "funded",
      messageSecret: "",
      recipientHash: "",
      recoveryAddress: "",
      amount: "1.0",
    })
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 0n,
      scaledBalance: 0n,
      fee: 100n,
      fpcFundingCut: 40n,
      sweepable: false,
    })

    await syncSipaDeposits(deps)

    expect(store.records.get(SIPA_A)).toMatchObject({
      phase: "funded",
      messageSecret: SECRET_A.toString(),
      recipientHash: `0xhash1111`,
      recoveryAddress: "0xfd9df8ea9d7350063da52e60e7e1b6d78449786a",
      amount: "1.0",
    })
  })

  it("never overwrites non-empty derived fields; patches only the empty ones", async () => {
    const store = makeStore()
    store.records.set(SIPA_A, {
      phase: "funded",
      messageSecret: "",
      recipientHash: "0xexistinghash",
      recoveryAddress: "0xexistingrecovery",
    })
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 0n,
      scaledBalance: 0n,
      fee: 100n,
      fpcFundingCut: 40n,
      sweepable: false,
    })

    await syncSipaDeposits(deps)

    expect(store.records.get(SIPA_A)).toMatchObject({
      messageSecret: SECRET_A.toString(),
      recipientHash: "0xexistinghash",
      recoveryAddress: "0xexistingrecovery",
    })
  })

  it("leaves a fully-populated existing record untouched by the backfill", async () => {
    const store = makeStore()
    store.records.set(SIPA_A, {
      phase: "broadcast",
      messageSecret: "0xoldsecret",
      recipientHash: "0xoldhash",
      recoveryAddress: "0xoldrecovery",
    })
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 0n,
      scaledBalance: 0n,
      fee: 100n,
      fpcFundingCut: 40n,
      sweepable: false,
    })

    await syncSipaDeposits(deps)

    expect(store.upsert).not.toHaveBeenCalledWith(
      SIPA_A,
      expect.objectContaining({ messageSecret: expect.anything() }),
      expect.anything(),
    )
    expect(store.records.get(SIPA_A)).toMatchObject({
      messageSecret: "0xoldsecret",
      recipientHash: "0xoldhash",
      recoveryAddress: "0xoldrecovery",
    })
  })

  it("fails fast on a staging-shaped tuple (no SIPA surface)", async () => {
    const { deps } = makeDeps()
    const tuple = { ...TUPLE, sipaFactory: undefined } as unknown as OxideEnvTuple
    await expect(syncSipaDeposits({ ...deps, tuple })).rejects.toThrow(/SIPA surface/)
  })

  it("reconciles a deposit the PXE already holds instead of wedging the SIPA's later sweeps", async () => {
    const { deps, store, tokenService } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: 1n, txHash: TX_HASH },
      { index: 9n, amount: 500_000n, blockNumber: 2n, txHash: TX_HASH },
    ])
    // index 7 was claimed before the store write landed (crash) — the
    // contract rejects the retry; index 9 must still claim.
    tokenService.claimSweptDeposit
      .mockRejectedValueOnce(new Error("Assertion failed: deposit already stored"))
      .mockResolvedValueOnce(undefined)

    const result = await syncSipaDeposits(deps)

    expect(result).toMatchObject({ reconciled: 1, claimed: 1, failed: 0 })
    expect(store.records.get(SIPA_A)).toMatchObject({
      phase: "claimed",
      claimedInboxIndexes: ["7", "9"],
    })
  })

  it("isolates a failing sweep so the SIPA's other sweeps still claim", async () => {
    const { deps, store, tokenService } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: 1n, txHash: TX_HASH },
      { index: 9n, amount: 500_000n, blockNumber: 2n, txHash: TX_HASH },
    ])
    // index 7's message key is unreadable this run (rpc trouble); 9 claims.
    mocks.readDepositMessageKey
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(fr(`0x${"0a".repeat(32)}`))

    const result = await syncSipaDeposits(deps)

    expect(result).toMatchObject({ claimed: 1, failed: 1 })
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledTimes(1)
    expect(store.records.get(SIPA_A)).toMatchObject({ claimedInboxIndexes: ["9"] })
  })
})

/**
 * The resumable cursor and the slow lane, plus the cases where holding either back is
 * what keeps a deposit claimable.
 */
describe("syncSipaDeposits self-initiated records", () => {
  it("claims a record with no event at its recorded address", async () => {
    const store = makeStore()
    store.records.set(SIPA_B, {
      phase: "broadcast",
      messageSecret: `0x${"22".repeat(32)}`,
      recipientL2Address: RECIPIENT_HEX,
      startTime: 1,
      amount: "0",
    })
    const { deps, tokenService } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 3n, amount: 975_000n, blockNumber: 1n, txHash: TX_HASH },
    ])

    const result = await syncSipaDeposits(deps)

    expect(result).toMatchObject({ claimed: 1, failed: 0 })
    expect(mocks.readSweepEvents.mock.calls[0][1]).toBe(SIPA_B)
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledOnce()
    expect(store.records.get(SIPA_B)).toMatchObject({
      phase: "claimed",
      claimedInboxIndexes: ["3"],
    })
  })

  it("skips another recipient's record and a settled one", async () => {
    const store = makeStore()
    store.records.set(SIPA_B, {
      phase: "broadcast",
      messageSecret: `0x${"22".repeat(32)}`,
      recipientL2Address: "0x9999999999999999999999999999999999999999999999999999999999999999",
    })
    store.records.set(SIPA_C, {
      phase: "claimed",
      messageSecret: `0x${"33".repeat(32)}`,
      recipientL2Address: RECIPIENT_HEX,
    })
    const { deps, tokenService } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([])

    const result = await syncSipaDeposits(deps)

    expect(result).toMatchObject({ discovered: 0, claimed: 0, failed: 0 })
    expect(mocks.readSweepEvents).not.toHaveBeenCalled()
    expect(tokenService.claimSweptDeposit).not.toHaveBeenCalled()
  })

  it("derives a registration event's address from its intentHash on the registration implementation and marks the record", async () => {
    const { deps, store, tokenService } = makeDeps()
    const registrationHash = `0x${"77".repeat(32)}`
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A, registrationHash)])
    mocks.computeSIPAAddress.mockImplementation(
      (inputs: { implementation: { toString(): string }; intentHash: Buffer }) =>
        inputs.implementation.toString() === REGISTRATION_IMPLEMENTATION &&
        inputs.intentHash.equals(Buffer.from("77".repeat(32), "hex"))
          ? { toString: () => SIPA_C }
          : { toString: () => SIPA_A },
    )
    mocks.readSweepEvents.mockImplementation(async (_pc: unknown, sipa: string) =>
      sipa === SIPA_C ? [{ index: 9n, amount: 975_000n, blockNumber: 1n, txHash: TX_HASH }] : [],
    )

    const result = await syncSipaDeposits(deps)

    expect(result).toMatchObject({ claimed: 1, failed: 0 })
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledOnce()
    expect(store.records.get(SIPA_C)).toMatchObject({
      phase: "claimed",
      intent: "registration",
      claimedInboxIndexes: ["9"],
    })
    expect(store.records.get(SIPA_A)).toBeUndefined()
  })

  it("takes a pinned record's missing intent from its event: registration pricing, and backfills it", async () => {
    const store = makeStore()
    store.records.set(SIPA_C, {
      phase: "broadcast",
      messageSecret: SECRET_C.toString(),
      recipientL2Address: RECIPIENT_HEX,
      recipientHash: "0xset",
      recoveryAddress: "0xset",
    })
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_C, `0x${"77".repeat(32)}`)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 0n,
      scaledBalance: 0n,
      fee: 100n,
      sweepable: false,
    })

    await syncSipaDeposits(deps)

    expect(mocks.readSipaFundingStatus).toHaveBeenCalledWith(
      deps.publicClient,
      expect.objectContaining({ sipa: SIPA_C, implementation: REGISTRATION_IMPLEMENTATION }),
    )
    expect(store.records.get(SIPA_C)).toMatchObject({ intent: "registration" })
  })

  it("prices a registration event's funding probe off the registration implementation", async () => {
    const { deps } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A, `0x${"77".repeat(32)}`)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 0n,
      scaledBalance: 0n,
      fee: 100n,
      sweepable: false,
    })

    await syncSipaDeposits(deps)

    expect(mocks.readDepositFee).toHaveBeenCalledWith(
      deps.publicClient,
      REGISTRATION_IMPLEMENTATION,
    )
    expect(mocks.readSipaFundingStatus).toHaveBeenCalledWith(
      deps.publicClient,
      expect.objectContaining({ implementation: REGISTRATION_IMPLEMENTATION }),
    )
  })

  it("claims an event whose salt matches a local record at the recorded address, not the derived one", async () => {
    const store = makeStore()
    store.records.set(SIPA_C, {
      phase: "broadcast",
      messageSecret: SECRET_C.toString(),
      recipientL2Address: RECIPIENT_HEX,
    })
    const { deps, tokenService } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_C)])
    // The deposit-intent derivation points elsewhere; the recorded address must win.
    mocks.computeSIPAAddress.mockImplementation(() => ({ toString: () => SIPA_A }))
    mocks.readSweepEvents.mockImplementation(async (_pc: unknown, sipa: string) =>
      sipa === SIPA_C ? [{ index: 5n, amount: 975_000n, blockNumber: 1n, txHash: TX_HASH }] : [],
    )

    const result = await syncSipaDeposits(deps)

    expect(result).toMatchObject({ claimed: 1, failed: 0 })
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledOnce()
    expect(store.records.get(SIPA_C)).toMatchObject({
      phase: "claimed",
      claimedInboxIndexes: ["5"],
    })
    expect(store.records.get(SIPA_A)).toBeUndefined()
  })

  it("scans every record sharing a salt: a restarted registration's replacement claims its own sweep", async () => {
    const store = makeStore()
    // Listed newest first: the replacement, then the recovered original it restarted from.
    store.records.set(SIPA_B, {
      phase: "broadcast",
      messageSecret: SECRET_C.toString(),
      recipientL2Address: RECIPIENT_HEX,
      intent: "registration",
      startTime: 2,
    })
    store.records.set(SIPA_A, {
      phase: "recovered",
      messageSecret: SECRET_C.toString(),
      recipientL2Address: RECIPIENT_HEX,
      intent: "registration",
      recoveryTxHash: TX_HASH,
      startTime: 1,
    })
    const { deps, tokenService } = makeDeps(store)
    // Both broadcasts share the salt; only their intents differ.
    mocks.fetchSipaEvents.mockResolvedValue([
      sipaEvent(SECRET_C, `0x${"0a".repeat(32)}`),
      sipaEvent(SECRET_C, `0x${"0b".repeat(32)}`),
    ])
    mocks.readSweepEvents.mockImplementation(async (_pc: unknown, sipa: string) =>
      sipa === SIPA_B ? [{ index: 8n, amount: 975_000n, blockNumber: 1n, txHash: TX_HASH }] : [],
    )
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 0n,
      scaledBalance: 0n,
      fee: 100n,
      sweepable: false,
    })

    const result = await syncSipaDeposits(deps)

    expect(result).toMatchObject({ claimed: 1, failed: 0 })
    // The pinned addresses decide which records sync; the derivation only tags a record's origin.
    expect([...store.records.keys()].sort()).toEqual([SIPA_A, SIPA_B].sort())
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledOnce()
    expect(store.records.get(SIPA_B)).toMatchObject({
      phase: "claimed",
      claimedInboxIndexes: ["8"],
    })
    expect(store.records.get(SIPA_A)).toMatchObject({ phase: "recovered", recoveryTxHash: TX_HASH })
  })

  it("scans two unsettled records sharing a salt when neither has an event", async () => {
    const store = makeStore()
    for (const sipa of [SIPA_B, SIPA_C]) {
      store.records.set(sipa, {
        phase: "broadcast",
        messageSecret: SECRET_B.toString(),
        recipientL2Address: RECIPIENT_HEX,
        startTime: 1,
        amount: "0",
      })
    }
    const { deps, tokenService } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([])
    mocks.readSweepEvents.mockImplementation(async (_pc: unknown, sipa: string) =>
      sipa === SIPA_C ? [{ index: 9n, amount: 975_000n, blockNumber: 1n, txHash: TX_HASH }] : [],
    )
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 0n,
      scaledBalance: 0n,
      fee: 100n,
      sweepable: false,
    })

    const result = await syncSipaDeposits(deps)

    expect(result).toMatchObject({ claimed: 1, failed: 0 })
    expect(mocks.readSweepEvents.mock.calls.map((c) => c[1])).toEqual([SIPA_B, SIPA_C])
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledOnce()
    expect(store.records.get(SIPA_C)).toMatchObject({ phase: "claimed" })
  })
})

describe("syncSipaDeposits scan rationing", () => {
  /** Args of the Nth readSweepEvents call: [client, sipa, fromBlock, toBlock]. */
  const scanArgs = (n = 0) => mocks.readSweepEvents.mock.calls[n] as unknown[]
  /** The [fromBlock, toBlock] of every readSweepEvents call. */
  const scanRanges = () => mocks.readSweepEvents.mock.calls.map((c) => [c[2], c[3]])

  /** Sweep reader that honors the requested range, so a [block, block] retry read is visible. */
  const rangeSweeps =
    (sweeps: { block: bigint; index: bigint }[]) =>
    async (_client: unknown, _sipa: string, from: bigint | undefined, to: bigint) =>
      sweeps
        .filter((s) => (from === undefined || s.block >= from) && s.block <= to)
        .map((s) => ({ index: s.index, amount: 990_000n, blockNumber: s.block, txHash: TX_HASH }))

  it("walks the full look-back for a never-scanned SIPA and pins the run's head as toBlock", async () => {
    const { deps } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 0n,
      scaledBalance: 0n,
      fee: 100n,
      fpcFundingCut: 40n,
      sweepable: false,
    })

    await syncSipaDeposits(deps)

    // undefined fromBlock = readSweepEvents applies its own look-back.
    expect(scanArgs()[2]).toBeUndefined()
    expect(scanArgs()[3]).toBe(HEAD)
  })

  it("resumes a scanned SIPA from its cursor less the reorg overlap, not the full look-back", async () => {
    const store = makeStore()
    store.records.set(SIPA_A, {
      phase: "broadcast",
      startTime: Date.now(),
      messageSecret: SECRET_A.toString(),
      lastScannedBlock: "11390000",
    })
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 0n,
      scaledBalance: 0n,
      fee: 100n,
      fpcFundingCut: 40n,
      sweepable: false,
    })

    await syncSipaDeposits(deps)

    // 11_390_000 − 128 overlap.
    expect(scanArgs()[2]).toBe(11_389_872n)
  })

  it("reaches the head in one read from a cursor far behind it, claiming the sweep in the gap", async () => {
    const cursor = HEAD - 200_000n
    const swept = HEAD - 150_000n
    const store = makeStore()
    store.records.set(SIPA_A, {
      phase: "sweeping",
      startTime: Date.now(),
      messageSecret: SECRET_A.toString(),
      lastScannedBlock: cursor.toString(),
    })
    const { deps, tokenService } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockImplementation(rangeSweeps([{ block: swept, index: 7n }]))

    await syncSipaDeposits(deps)

    expect(mocks.readSweepEvents).toHaveBeenCalledTimes(1)
    expect(scanArgs()[2]).toBe(cursor - 128n)
    expect(scanArgs()[3]).toBe(HEAD)
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledTimes(1)
    expect(store.records.get(SIPA_A)).toMatchObject({
      phase: "claimed",
      lastScannedBlock: HEAD.toString(),
    })
  })

  it("re-reads a listed sweep that sits below the window and claims it", async () => {
    const swept = HEAD - 60_000n
    const store = makeStore()
    store.records.set(SIPA_A, {
      phase: "pendingClaim",
      startTime: Date.now(),
      messageSecret: SECRET_A.toString(),
      lastScannedBlock: (HEAD - 1n).toString(),
      unresolvedSweepBlocks: [swept.toString()],
    })
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockImplementation(rangeSweeps([{ block: swept, index: 7n }]))

    const result = await syncSipaDeposits(deps)

    expect(scanRanges()).toContainEqual([swept, swept])
    expect(result.claimed).toBe(1)
    expect(store.records.get(SIPA_A)).toMatchObject({
      phase: "claimed",
      unresolvedSweepBlocks: [],
      lastScannedBlock: HEAD.toString(),
    })
  })

  it("claims a listed sweep while an older one that is still unsettled stays on the list", async () => {
    const unsettled = HEAD - 70_000n
    const claimable = HEAD - 60_000n
    const store = makeStore()
    store.records.set(SIPA_A, {
      phase: "pendingClaim",
      startTime: Date.now(),
      messageSecret: SECRET_A.toString(),
      lastScannedBlock: (HEAD - 1n).toString(),
      unresolvedSweepBlocks: [unsettled.toString(), claimable.toString()],
    })
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockImplementation(
      rangeSweeps([
        { block: unsettled, index: 7n },
        { block: claimable, index: 9n },
      ]),
    )
    // Sweeps are processed oldest first, so the first readiness check is the unsettled one's.
    mocks.isL1ToL2MessageReady.mockResolvedValueOnce(false).mockResolvedValue(true)

    const result = await syncSipaDeposits(deps)

    expect(result).toMatchObject({ claimed: 1, pendingSettlement: 1 })
    expect(store.records.get(SIPA_A)).toMatchObject({
      unresolvedSweepBlocks: [unsettled.toString()],
      lastScannedBlock: HEAD.toString(),
    })
  })

  it("processes a sweep that is both in the window and on the list once", async () => {
    const swept = HEAD - 500n
    const store = makeStore()
    store.records.set(SIPA_A, {
      phase: "pendingClaim",
      startTime: Date.now(),
      messageSecret: SECRET_A.toString(),
      lastScannedBlock: (HEAD - 1_000n).toString(),
      unresolvedSweepBlocks: [swept.toString()],
    })
    const { deps, tokenService } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockImplementation(rangeSweeps([{ block: swept, index: 7n }]))

    const result = await syncSipaDeposits(deps)

    // The window already covers the listed block, so it costs no extra read and one claim.
    expect(mocks.readSweepEvents).toHaveBeenCalledTimes(1)
    expect(result.claimed).toBe(1)
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledTimes(1)
    expect(store.records.get(SIPA_A)).toMatchObject({
      claimedInboxIndexes: ["7"],
      unresolvedSweepBlocks: [],
    })
  })

  it("advances the cursor to the head once every sweep in the window resolved", async () => {
    const { deps, store } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: 11_000_000n, txHash: TX_HASH },
    ])

    await syncSipaDeposits(deps)

    expect(store.records.get(SIPA_A)).toMatchObject({
      phase: "claimed",
      lastScannedBlock: HEAD.toString(),
    })
  })

  it("lists an unsettled sweep so the next run still sees it, and still reaches the head", async () => {
    const { deps, store } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: 11_000_000n, txHash: TX_HASH },
    ])
    mocks.isL1ToL2MessageReady.mockResolvedValue(false)

    const result = await syncSipaDeposits(deps)

    expect(result.pendingSettlement).toBe(1)
    expect(store.records.get(SIPA_A)).toMatchObject({
      unresolvedSweepBlocks: ["11000000"],
      lastScannedBlock: HEAD.toString(),
    })
  })

  it("drops a listed block the reader returns no sweep for", async () => {
    const gone = HEAD - 60_000n
    const store = makeStore()
    store.records.set(SIPA_A, {
      phase: "broadcast",
      startTime: Date.now(),
      messageSecret: SECRET_A.toString(),
      lastScannedBlock: (HEAD - 1n).toString(),
      unresolvedSweepBlocks: [gone.toString()],
    })
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 0n,
      scaledBalance: 0n,
      fee: 100n,
      fpcFundingCut: 40n,
      sweepable: false,
    })

    await syncSipaDeposits(deps)

    // The block was re-read and held nothing, so it is not re-read again.
    expect(scanRanges()).toContainEqual([gone, gone])
    expect(store.records.get(SIPA_A)).toMatchObject({
      unresolvedSweepBlocks: [],
      lastScannedBlock: HEAD.toString(),
    })
  })

  it("lists a sweep whose claim failed", async () => {
    const { deps, store } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: 11_000_000n, txHash: TX_HASH },
      { index: 9n, amount: 500_000n, blockNumber: 11_000_500n, txHash: TX_HASH },
    ])
    mocks.readDepositMessageKey.mockResolvedValueOnce(null)

    const result = await syncSipaDeposits(deps)

    // The older sweep failed, so its block is kept for retry even though the newer one claimed.
    expect(result).toMatchObject({ claimed: 1, failed: 1 })
    expect(store.records.get(SIPA_A)).toMatchObject({
      unresolvedSweepBlocks: ["11000000"],
      lastScannedBlock: HEAD.toString(),
    })
  })

  it("skips a settled SIPA scanned within the slow-lane interval, spending no L1 read", async () => {
    const store = makeStore()
    store.records.set(SIPA_A, {
      phase: "claimed",
      startTime: Date.now() - 86_400_000,
      messageSecret: SECRET_A.toString(),
      claimedInboxIndexes: ["7"],
      lastScannedBlock: "11390000",
      lastScanAt: Date.now() - 30_000,
    })
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])

    const result = await syncSipaDeposits(deps)

    expect(result).toMatchObject({ discovered: 1, active: 0, skipped: 1 })
    expect(mocks.readSweepEvents).not.toHaveBeenCalled()
    expect(mocks.readSipaFundingStatus).not.toHaveBeenCalled()
  })

  it("re-scans a settled SIPA once the slow-lane interval has elapsed — a re-used one is re-swept with no new broadcast", async () => {
    const store = makeStore()
    store.records.set(SIPA_A, {
      phase: "claimed",
      startTime: Date.now() - 86_400_000,
      messageSecret: SECRET_A.toString(),
      claimedInboxIndexes: ["7"],
      lastScannedBlock: "11390000",
      lastScanAt: Date.now() - 6 * 60_000,
    })
    const { deps, tokenService } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 9n, amount: 500_000n, blockNumber: 11_390_100n, txHash: TX_HASH },
    ])

    const result = await syncSipaDeposits(deps)

    expect(result).toMatchObject({ skipped: 0, claimed: 1 })
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ inboxIndex: 9n }),
    )
  })

  it("counts an in-flight sweep as active however old the record is", async () => {
    const store = makeStore()
    store.records.set(SIPA_A, {
      phase: "pendingClaim",
      startTime: Date.now() - 86_400_000,
      messageSecret: SECRET_A.toString(),
      lastScanAt: Date.now() - 1_000,
    })
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: 11_000_000n, txHash: TX_HASH },
    ])
    mocks.isL1ToL2MessageReady.mockResolvedValue(false)

    // Settlement can outlast the fresh window; dropping to the slow lane would stall the claim.
    expect(await syncSipaDeposits(deps)).toMatchObject({ active: 1, skipped: 0 })
  })

  it("drops an unfunded SIPA off the fast lane once its fresh window has passed", async () => {
    const store = makeStore()
    store.records.set(SIPA_A, {
      phase: "broadcast",
      startTime: Date.now() - 20 * 60_000,
      messageSecret: SECRET_A.toString(),
      lastScanAt: Date.now() - 6 * 60_000,
    })
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 0n,
      scaledBalance: 0n,
      fee: 100n,
      fpcFundingCut: 40n,
      sweepable: false,
    })

    // Still scanned this tick (slow-lane interval elapsed), but no longer counted active.
    expect(await syncSipaDeposits(deps)).toMatchObject({ active: 0, skipped: 0 })
    expect(mocks.readSweepEvents).toHaveBeenCalledTimes(1)
  })

  it("scans a replayed unfunded address on the pass that discovers it, then skips it", async () => {
    const { deps, store } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 0n,
      scaledBalance: 0n,
      fee: 100n,
      fpcFundingCut: 40n,
      sweepable: false,
    })

    expect(await syncSipaDeposits(deps)).toMatchObject({ discovered: 1, active: 1, skipped: 0 })
    expect(mocks.readSweepEvents).toHaveBeenCalledTimes(1)
    expect(store.records.get(SIPA_A)).toMatchObject({ replayed: true })

    mocks.readSweepEvents.mockClear()
    mocks.readSipaFundingStatus.mockClear()

    expect(await syncSipaDeposits(deps)).toMatchObject({ active: 0, skipped: 1 })
    expect(mocks.readSweepEvents).not.toHaveBeenCalled()
    expect(mocks.readSipaFundingStatus).not.toHaveBeenCalled()
  })

  it("keeps a self-initiated record inside its fresh window on the fast lane", async () => {
    const store = makeStore()
    store.records.set(SIPA_A, {
      phase: "broadcast",
      startTime: Date.now() - 60_000,
      messageSecret: SECRET_A.toString(),
      lastScanAt: Date.now() - 6 * 60_000,
    })
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 0n,
      scaledBalance: 0n,
      fee: 100n,
      fpcFundingCut: 40n,
      sweepable: false,
    })

    expect(await syncSipaDeposits(deps)).toMatchObject({ active: 1, skipped: 0 })
    expect(mocks.readSweepEvents).toHaveBeenCalledTimes(1)
  })

  it("reads the fee floor once per run however many SIPAs reach the funding probe", async () => {
    const { deps } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A), sipaEvent(SECRET_B)])
    mocks.computeSIPAAddress
      .mockImplementationOnce(() => ({ toString: () => SIPA_A }))
      .mockImplementationOnce(() => ({ toString: () => SIPA_B }))
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 0n,
      scaledBalance: 0n,
      fee: 100n,
      fpcFundingCut: 40n,
      sweepable: false,
    })

    await syncSipaDeposits(deps)

    expect(mocks.readDepositFee).toHaveBeenCalledTimes(1)
    expect(mocks.readFpcFundingCut).toHaveBeenCalledTimes(1)
    expect(mocks.readSipaFundingStatus).toHaveBeenCalledTimes(2)
    // The prefetched floor rides along, so the probe spends one read (balanceOf), not two.
    expect(mocks.readSipaFundingStatus.mock.calls[1][1]).toMatchObject({
      fee: 100n,
      fpcFundingCut: 40n,
    })
  })

  it("spends no floor read when the swept record already carries its breakdown", async () => {
    const store = makeStore()
    store.records.set(SIPA_A, {
      phase: "claimed",
      startTime: 1,
      amount: "0.99",
      fee: "140",
      fpcFundingCut: "40",
    })
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: 11_000_000n, txHash: TX_HASH },
    ])

    await syncSipaDeposits(deps)

    expect(mocks.readDepositFee).not.toHaveBeenCalled()
    expect(mocks.readFpcFundingCut).not.toHaveBeenCalled()
  })

  it("stamps the fee on a deposit swept before the wallet's first scan", async () => {
    const { deps, store } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: 11_000_000n, txHash: TX_HASH },
    ])

    await syncSipaDeposits(deps)

    // The funding probe never ran, so the claim write is the only place the fee can land.
    expect(mocks.readSipaFundingStatus).not.toHaveBeenCalled()
    expect(store.records.get(SIPA_A)).toMatchObject({
      phase: "claimed",
      fee: "140",
      fpcFundingCut: "40",
    })
  })

  it("reads the head once per run, not once per SIPA", async () => {
    const { deps } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A), sipaEvent(SECRET_B)])
    mocks.computeSIPAAddress
      .mockImplementationOnce(() => ({ toString: () => SIPA_A }))
      .mockImplementationOnce(() => ({ toString: () => SIPA_B }))
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 0n,
      scaledBalance: 0n,
      fee: 100n,
      fpcFundingCut: 40n,
      sweepable: false,
    })

    await syncSipaDeposits(deps)

    expect(
      (deps.publicClient as unknown as { getBlockNumber: ReturnType<typeof vi.fn> }).getBlockNumber,
    ).toHaveBeenCalledTimes(1)
  })
})

describe("syncSipaDeposits funding attribution", () => {
  const FUNDER = "0x39dd57b9f2b16e5c9e9e35e18b73c8a2a5d1f7c4" as Address
  const FUNDING_TX = `0x${"cd".repeat(32)}`
  const transfer = { from: FUNDER, amount: 1_000_000n, blockNumber: 5n, txHash: FUNDING_TX }

  it("stamps funder + funding tx, backfills walletAddress, and fires the hook with the bare address", async () => {
    const { deps, store } = makeDeps()
    const onFundingWalletDetected = vi.fn(async () => undefined)
    ;(deps as { onFundingWalletDetected?: unknown }).onFundingWalletDetected =
      onFundingWalletDetected
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readFundingTransfers.mockResolvedValue([transfer])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 1_000_000n,
      scaledBalance: 1_000_000n,
      fee: 100n,
      fpcFundingCut: 40n,
      sweepable: true,
    })

    await syncSipaDeposits(deps)

    expect(store.records.get(SIPA_A)).toMatchObject({
      fundingTxHash: FUNDING_TX,
      fundingFromAddress: FUNDER,
      walletAddress: FUNDER,
    })
    // Third-party deposit: no session identity to pass through.
    expect(onFundingWalletDetected).toHaveBeenCalledTimes(1)
    expect(onFundingWalletDetected).toHaveBeenCalledWith(
      expect.objectContaining({
        address: FUNDER,
        walletName: undefined,
        walletProvider: undefined,
      }),
    )
  })

  it("never re-reads transfers once attributed", async () => {
    const store = makeStore()
    store.records.set(SIPA_A, {
      phase: "sweeping",
      fundingFromAddress: FUNDER,
      fundingTxHash: FUNDING_TX,
      messageSecret: SECRET_A.toString(),
    })
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 0n,
      scaledBalance: 0n,
      fee: 100n,
      fpcFundingCut: 40n,
      sweepable: false,
    })

    await syncSipaDeposits(deps)

    expect(mocks.readFundingTransfers).not.toHaveBeenCalled()
  })

  it("keeps the connected-session identity when the on-chain funder differs, and passes it when matching", async () => {
    const sessionWallet = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    const store = makeStore()
    store.records.set(SIPA_A, {
      phase: "funded",
      walletAddress: sessionWallet,
      walletName: "Rainbow",
      walletProvider: "rainbow",
      messageSecret: SECRET_A.toString(),
    })
    const { deps } = makeDeps(store)
    const onFundingWalletDetected = vi.fn(async () => undefined)
    ;(deps as { onFundingWalletDetected?: unknown }).onFundingWalletDetected =
      onFundingWalletDetected
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readFundingTransfers.mockResolvedValue([transfer])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 1_000_000n,
      scaledBalance: 1_000_000n,
      fee: 100n,
      fpcFundingCut: 40n,
      sweepable: true,
    })

    await syncSipaDeposits(deps)

    // Divergence: both fields kept, session identity not overwritten.
    expect(store.records.get(SIPA_A)).toMatchObject({
      walletAddress: sessionWallet,
      fundingFromAddress: FUNDER,
    })
    expect(onFundingWalletDetected).toHaveBeenCalledWith(
      expect.objectContaining({ address: FUNDER, walletName: undefined }),
    )

    // Matching funder: the record's session identity rides along.
    onFundingWalletDetected.mockClear()
    store.records.set(SIPA_A, {
      phase: "funded",
      walletAddress: FUNDER.toUpperCase().replace("0X", "0x"),
      walletName: "Rainbow",
      walletProvider: "rainbow",
      messageSecret: SECRET_A.toString(),
    })
    await syncSipaDeposits(deps)
    expect(onFundingWalletDetected).toHaveBeenCalledWith(
      expect.objectContaining({
        address: FUNDER,
        walletName: "Rainbow",
        walletProvider: "rainbow",
      }),
    )
  })

  it("isolates attribution failures from the claim path", async () => {
    const { deps, store, tokenService } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readFundingTransfers.mockRejectedValue(new Error("rpc down"))
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: 1n, txHash: TX_HASH },
    ])

    const result = await syncSipaDeposits(deps)

    expect(result).toMatchObject({ claimed: 1, failed: 0 })
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledTimes(1)
    expect(store.records.get(SIPA_A)).toMatchObject({ phase: "claimed" })
  })

  it("reads sweeps without waiting for the funding transfers", async () => {
    const { deps, store, tokenService } = makeDeps()
    let sweepStarted: () => void = () => {}
    const sweepRead = new Promise<void>((resolve) => {
      sweepStarted = resolve
    })
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockImplementation(async () => {
      sweepStarted()
      return [{ index: 7n, amount: 990_000n, blockNumber: 1n, txHash: TX_HASH }]
    })
    // Resolves only once the sweep read has started, so a serialized pass would never finish.
    mocks.readFundingTransfers.mockImplementation(async () => {
      await sweepRead
      return [transfer]
    })

    const result = await syncSipaDeposits(deps)

    expect(result).toMatchObject({ claimed: 1, failed: 0 })
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledTimes(1)
    expect(store.records.get(SIPA_A)).toMatchObject({
      phase: "claimed",
      fundingFromAddress: FUNDER,
    })
  })

  it("reads every funding token in one fan-out and stamps the earliest transfer", async () => {
    const { deps, store } = makeDeps()
    const usdc = {
      address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as Address,
      symbol: "USDC",
      decimals: 6,
    }
    let usdcStarted: () => void = () => {}
    const usdcRead = new Promise<void>((resolve) => {
      usdcStarted = resolve
    })
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 0n,
      scaledBalance: 0n,
      fee: 100n,
      fpcFundingCut: 40n,
      sweepable: false,
    })
    // The first token resolves only once the second has started, so a serialized pass would hang.
    mocks.readFundingTransfers.mockImplementation(async (_client: unknown, token: string) => {
      if (token === usdc.address) {
        usdcStarted()
        return [{ from: "0xfeed", amount: 5n, blockNumber: 3n, txHash: "0xusdc" }]
      }
      await usdcRead
      return [{ from: FUNDER, amount: 1n, blockNumber: 9n, txHash: "0xdai" }]
    })

    await syncSipaDeposits({ ...deps, fundingTokens: [deps.token, usdc] })

    expect(store.records.get(SIPA_A)).toMatchObject({
      fundingTxHash: "0xusdc",
      fundingFromAddress: "0xfeed",
      tokenAddress: usdc.address,
      tokenSymbol: "USDC",
    })
  })

  it("breaks a tie on block number with the first listed token", async () => {
    const { deps, store } = makeDeps()
    const usdc = {
      address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as Address,
      symbol: "USDC",
      decimals: 6,
    }
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 0n,
      scaledBalance: 0n,
      fee: 100n,
      fpcFundingCut: 40n,
      sweepable: false,
    })
    mocks.readFundingTransfers.mockImplementation(async (_client: unknown, token: string) =>
      token === usdc.address
        ? [{ from: "0xfeed", amount: 5n, blockNumber: 4n, txHash: "0xusdc" }]
        : [{ from: FUNDER, amount: 1n, blockNumber: 4n, txHash: "0xdai" }],
    )

    await syncSipaDeposits({ ...deps, fundingTokens: [deps.token, usdc] })

    expect(store.records.get(SIPA_A)).toMatchObject({
      fundingTxHash: "0xdai",
      fundingFromAddress: FUNDER,
      tokenAddress: deps.token.address,
      tokenSymbol: "DAI",
    })
  })
})

describe("deposit-implementation memo", () => {
  /** Distinct factory per case: the memo is module-level and keyed by factory + portal. */
  const withFactory = (sipaFactory: string) => ({ ...TUPLE, sipaFactory } as OxideEnvTuple)

  it("re-reads after a failed read instead of serving the rejection forever", async () => {
    const first = makeDeps()
    first.deps.tuple = withFactory("0x1111111111111111111111111111111111111111")
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readDepositSIPAImplementation.mockRejectedValueOnce(new Error("rpc down"))

    await expect(syncSipaDeposits(first.deps)).rejects.toThrow("rpc down")

    const second = makeDeps()
    second.deps.tuple = first.deps.tuple
    await expect(syncSipaDeposits(second.deps)).resolves.toMatchObject({ discovered: 1 })
    expect(mocks.readDepositSIPAImplementation).toHaveBeenCalledTimes(2)
  })

  it("reads once per factory + portal across syncs", async () => {
    const tuple = withFactory("0x2222222222222222222222222222222222222222")
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])

    const first = makeDeps()
    first.deps.tuple = tuple
    await syncSipaDeposits(first.deps)
    const second = makeDeps()
    second.deps.tuple = tuple
    await syncSipaDeposits(second.deps)

    expect(mocks.readDepositSIPAImplementation).toHaveBeenCalledTimes(1)
  })
})

describe("syncSipaDeposits balance refresh", () => {
  const sweptEvent = () => {
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: 1n, txHash: TX_HASH },
    ])
  }

  it("refreshes the chain view after a claim and holds the catch-up until it lands", async () => {
    const { deps, tokenService } = makeDeps()
    sweptEvent()
    let land: () => void = () => {}
    const refreshBalance = vi.fn(() => new Promise<void>((resolve) => (land = resolve)))

    const pass = syncSipaDeposits({ ...deps, refreshBalance })
    await vi.waitFor(() => expect(refreshBalance).toHaveBeenCalledTimes(1))

    expect(refreshBalance.mock.invocationCallOrder[0]).toBeGreaterThan(
      tokenService.claimSweptDeposit.mock.invocationCallOrder[0],
    )
    expect(globalEventEmitter.isSyncCatchingUp()).toBe(true)

    land()

    expect(await pass).toMatchObject({ claimed: 1 })
    expect(refreshBalance).toHaveBeenCalledTimes(1)
    expect(globalEventEmitter.isSyncCatchingUp()).toBe(false)
  })

  it("completes a pass whose refresh rejects", async () => {
    const { deps } = makeDeps()
    sweptEvent()
    const refreshBalance = vi.fn(async () => {
      throw new Error("node unreachable")
    })

    expect(await syncSipaDeposits({ ...deps, refreshBalance })).toMatchObject({
      claimed: 1,
      failed: 0,
    })
    expect(globalEventEmitter.isSyncCatchingUp()).toBe(false)
  })

  it("begins a catch-up only for a pass that discovers an event with no local record", async () => {
    const begin = vi.spyOn(globalEventEmitter, "beginSyncCatchUp")
    try {
      const store = makeStore()
      store.records.set(SIPA_A, {
        phase: "broadcast",
        startTime: Date.now(),
        messageSecret: SECRET_A.toString(),
        lastScanAt: Date.now(),
      })
      sweptEvent()

      await syncSipaDeposits(makeDeps(store).deps)
      expect(begin).not.toHaveBeenCalled()

      await syncSipaDeposits(makeDeps().deps)
      expect(begin).toHaveBeenCalledTimes(1)
    } finally {
      begin.mockRestore()
    }
  })
})
