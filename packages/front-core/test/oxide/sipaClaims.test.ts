import { beforeEach, describe, expect, it, vi } from "vitest"
import { encodeEventTopics, erc20Abi, pad, toHex, type Address } from "viem"
import { keccak256 } from "@aztec/foundation/crypto/keccak"
import type { OxideEnvTuple } from "@obsidion/core/types"

const ZERO = "0x0000000000000000000000000000000000000000"

const mocks = vi.hoisted(() => ({
  fetchSipaEvents: vi.fn(),
  readSweepEvents: vi.fn(),
  readRecoveredEvents: vi.fn(async () => []),
  readBlockTimeMs: vi.fn(async () => undefined),
  readDepositMessageKey: vi.fn(),
  readFundingTransfers: vi.fn(),
  readSipaFundingStatus: vi.fn(),
  /** What the observation's balance read sees at a SIPA in the fee token; zero when unset. */
  observedTokenBalance: vi.fn<(sipa: string) => bigint | undefined>(),
  readDepositFee: vi.fn(),
  readFpcFundingCut: vi.fn(),
  readDepositSIPAImplementation: vi.fn(),
  readRegistrationSIPAImplementation: vi.fn(),
  computeStealthRecipientHash: vi.fn(),
  deriveRecoveryAddress: vi.fn(),
  computeSIPAAddress: vi.fn(),
  isL1ToL2MessageReady: vi.fn(),
  readSipaDepositsConsumed: vi.fn(),
}))

// The composition's collaborators are all unit-tested in their own modules
// (sdk reads, front-core crypto); here they are mocked so the test pins the
// ORCHESTRATION: sequencing, store patches, dedup, and failure isolation.
vi.mock("@obsidion/sdk", async () => ({
  isAlreadyClaimedDepositError: (await import("../../../sdk/src/services/depositReceipt.js"))
    .isAlreadyClaimedDepositError,
  fetchSipaEvents: mocks.fetchSipaEvents,
  readSipaDepositsConsumed: mocks.readSipaDepositsConsumed,
  // ETH comes off the client's getBalance; the fee token's balance off `observedTokenBalance`.
  readSipaBalancesMany: vi.fn(
    async (
      client: { getBalance: (p: { address: string }) => Promise<bigint> },
      sipas: string[],
      tokens: string[],
    ) =>
      new Map(
        await Promise.all(
          sipas.map(
            async (sipa) =>
              [
                sipa.toLowerCase(),
                new Map([
                  [ZERO, await client.getBalance({ address: sipa })],
                  [tokens[0]!.toLowerCase(), mocks.observedTokenBalance(sipa) ?? 0n],
                ]),
              ] as const,
          ),
        ),
      ),
  ),
  readBlockTimeMs: mocks.readBlockTimeMs,
  readSipaFundingStatus: mocks.readSipaFundingStatus,
  readDepositFee: mocks.readDepositFee,
  readFpcFundingCut: mocks.readFpcFundingCut,
  readDepositSIPAImplementation: mocks.readDepositSIPAImplementation,
  readRegistrationSIPAImplementation: mocks.readRegistrationSIPAImplementation,
}))
// The observation answered by the per-SIPA mocks, so each test pins what one SIPA's logs and
// balances were. `observeSipas` itself is covered by sipaObservation.test.ts.
vi.mock("../../src/oxide/sipaObservation", async () => {
  const { parseEventLogs } = await import("viem")
  const sdk = await import("@obsidion/sdk")
  return {
    observeSipas: vi.fn(
      async (
        client: {
          getBalance: (p: { address: string }) => Promise<bigint>
          getTransactionReceipt?: (p: { hash: string }) => Promise<{ logs: never[] }>
        },
        params: {
          portal: string
          tokens: string[]
          head: bigint
          subjects: { address: string; fromBlock: bigint; inflows: boolean }[]
        },
      ) => {
        const out = new Map()
        for (const subject of params.subjects) {
          const address = subject.address
          const sweeps = await Promise.all(
            (
              (await mocks.readSweepEvents(client, address, subject.fromBlock, params.head)) ?? []
            ).map(
              async (sweep: {
                index: bigint
                amount: bigint
                blockNumber: bigint
                txHash: string
              }) => ({
                ...sweep,
                messageKey: String(
                  await mocks.readDepositMessageKey(
                    client,
                    params.portal,
                    sweep.txHash,
                    sweep.index,
                  ),
                ),
              }),
            ),
          )
          const outflows = []
          for (const sweep of sweeps) {
            const receipt = await client
              .getTransactionReceipt?.({ hash: sweep.txHash })
              .catch(() => undefined)
            for (const log of parseEventLogs({
              abi: erc20Abi,
              eventName: "Transfer",
              logs: receipt?.logs ?? [],
            })) {
              if (log.args.from.toLowerCase() !== address.toLowerCase()) continue
              outflows.push({
                token: log.address,
                from: log.args.from,
                to: log.args.to,
                value: log.args.value,
                blockNumber: sweep.blockNumber,
                txHash: sweep.txHash,
                logIndex: 0,
              })
            }
          }
          const recoveries = (
            ((await mocks.readRecoveredEvents(client, address, subject.fromBlock, params.head)) ??
              []) as {
              token: string
              target: string
              amount: bigint
              txHash: string
            }[]
          ).map((r) => ({
            token: r.token,
            from: address,
            to: r.target,
            value: r.amount,
            txHash: r.txHash,
          }))
          const inflows = subject.inflows
            ? (
                await Promise.all(
                  params.tokens.map(async (token) =>
                    (
                      ((await mocks.readFundingTransfers(
                        client,
                        token,
                        address,
                        subject.fromBlock,
                        params.head,
                      )) ?? []) as {
                        from: string
                        amount: bigint
                        blockNumber: bigint
                        txHash: string
                      }[]
                    ).map((t) => ({
                      token,
                      from: t.from,
                      to: address,
                      value: t.amount,
                      blockNumber: t.blockNumber,
                      txHash: t.txHash,
                      logIndex: 0,
                    })),
                  ),
                )
              ).flat()
            : undefined
          out.set(address.toLowerCase(), {
            sweeps,
            outflows,
            recoveries,
            inflows,
            balances: (
              await sdk.readSipaBalancesMany(
                client as never,
                [address as never],
                params.tokens as never,
              )
            ).get(address.toLowerCase()),
          })
        }
        return { observed: out, strays: [] }
      },
    ),
  }
})
vi.mock("../../src/core/services/deposits/sipa/sipaAddress", () => ({
  computeSIPAAddress: mocks.computeSIPAAddress,
}))
vi.mock("../../src/core/services/deposits/sipa/stealth", () => ({
  computeStealthRecipientHash: mocks.computeStealthRecipientHash,
  deriveRecoveryAddress: mocks.deriveRecoveryAddress,
}))
vi.mock("@aztec/aztec.js/messaging", () => ({
  isL1ToL2MessageReady: mocks.isL1ToL2MessageReady,
}))
vi.mock("@aztec/foundation/eth-address", () => ({
  EthAddress: { fromString: (value: string) => ({ toString: () => value.toLowerCase() }) },
}))

import * as sdk from "@obsidion/sdk"
import { observeSipas } from "../../src/oxide/sipaObservation"
import { syncSipaDeposits, type SipaDepositSyncDeps } from "../../src/oxide/sipaClaims"
import { resetDepositFeesForTests } from "../../src/oxide/sipaImplementations"
import { globalEventEmitter } from "../../src/core/services/GlobalEventEmitter"
import { isStuckSweep, STUCK_SWEEP_MS } from "../../src/core/services/deposits/sipaStuck"
import {
  isUnfundedSipaDeposit,
  sipaSweepsReceived,
} from "../../src/core/services/deposits/SIPADepositStore"

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
    remove: vi.fn(async (address: string) => {
      records.delete(address.toLowerCase())
    }),
    cursor: undefined as bigint | undefined,
    observedThrough: vi.fn(async function (this: { cursor?: bigint }) {
      return this.cursor
    }),
    setObservedThrough: vi.fn(async function (
      this: { cursor?: bigint },
      _portal: string,
      block: bigint,
    ) {
      this.cursor = block
    }),
  }
}

function makeDeps(store = makeStore()) {
  const tokenService = { claimSweptDeposit: vi.fn(async () => undefined) }
  const deps = {
    publicClient: {
      getBlockNumber: vi.fn(async () => HEAD),
      getBalance: vi.fn(async () => 0n),
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
  resetDepositFeesForTests()
  vi.clearAllMocks()
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
      sweeps: [{ inboxIndex: "7", sweepTxHash: TX_HASH, netAmount: "990000" }],
      netAmount: "990000",
      amount: "0.99",
      sweepTxHash: TX_HASH,
      messageSecret: SECRET_A.toString(),
      recipientL2Address: RECIPIENT_HEX,
    })
  })

  /** A receipt in which the sweep moved `value` of `token` off the SIPA. */
  const sweepReceipt = (token: Address, value: bigint) => ({
    logs: [
      {
        address: token,
        topics: encodeEventTopics({
          abi: erc20Abi,
          eventName: "Transfer",
          args: { from: SIPA_A, to: "0x000000000000000000000000000000000000dead" },
        }),
        data: pad(toHex(value)),
      },
    ],
  })

  it("ledgers a claimed sweep with what its receipt took off the SIPA, dated at its block", async () => {
    const { deps, store } = makeDeps()
    ;(deps.publicClient as { getTransactionReceipt: unknown }).getTransactionReceipt = vi.fn(
      async () => sweepReceipt(deps.token.address, 1_000_140n),
    )
    mocks.readBlockTimeMs.mockResolvedValue(1_700_000_000_000)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 1_000_000n, blockNumber: 1n, txHash: TX_HASH },
    ])

    await syncSipaDeposits(deps)

    expect(store.records.get(SIPA_A)).toMatchObject({
      phase: "claimed",
      sweeps: [
        {
          inboxIndex: "7",
          sweepTxHash: TX_HASH,
          settledAt: 1_700_000_000_000,
          netAmount: "1000000",
          grossAmount: "1000140",
          fundingTokenSymbol: "DAI",
          fundingTokenDecimals: 6,
        },
      ],
    })
  })

  it("a failed receipt read with one accepted token still claims, leaving the gross unknown", async () => {
    const { deps, store } = makeDeps()
    ;(deps.publicClient as { getTransactionReceipt: unknown }).getTransactionReceipt = vi.fn(
      async () => {
        throw new Error("rpc down")
      },
    )
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 1_000_000n, blockNumber: 1n, txHash: TX_HASH },
    ])

    expect(await syncSipaDeposits(deps)).toMatchObject({ claimed: 1, failed: 0 })
    const [entry] = store.records.get(SIPA_A)!.sweeps as Record<string, unknown>[]
    expect(entry).toMatchObject({ inboxIndex: "7", netAmount: "1000000" })
    expect(entry!.grossAmount).toBeUndefined()
  })

  it("ledgers the sweeps of a record claimed before the ledger existed, scanning from the history start whatever earlier scans covered", async () => {
    const START = HEAD - 400_000n
    const store = makeStore()
    store.records.set(SIPA_A, {
      phase: "claimed",
      inboxIndex: "9",
      claimedInboxIndexes: ["7", "9"],
      netAmount: "4000000",
      sweepTxHash: "0xsweep9",
      messageSecret: SECRET_A.toString(),
      lastScannedBlock: (HEAD - 10n).toString(),
      historyScanned: true,
      lastScanAt: 0,
    })
    const { deps, tokenService } = makeDeps(store)
    ;(deps.publicClient as { getTransactionReceipt: unknown }).getTransactionReceipt = vi.fn(
      async ({ hash }: { hash: string }) =>
        sweepReceipt(deps.token.address, hash === "0xsweep7" ? 1_000_140n : 4_000_140n),
    )
    mocks.readBlockTimeMs.mockImplementation(async (_client: unknown, block: bigint) =>
      block === START + 5n ? 1_700_000_000_000 : 1_700_000_500_000,
    )
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 1_000_000n, blockNumber: START + 5n, txHash: "0xsweep7" },
      { index: 9n, amount: 4_000_000n, blockNumber: START + 50n, txHash: "0xsweep9" },
    ])

    await syncSipaDeposits({ ...deps, historyStartBlock: async () => START })

    expect(mocks.readSweepEvents.mock.calls[0]![2]).toBe(START)
    expect(tokenService.claimSweptDeposit).not.toHaveBeenCalled()
    expect(store.records.get(SIPA_A)).toMatchObject({
      phase: "claimed",
      claimedInboxIndexes: ["7", "9"],
      netAmount: "4000000",
      sweeps: [
        {
          inboxIndex: "7",
          sweepTxHash: "0xsweep7",
          settledAt: 1_700_000_000_000,
          netAmount: "1000000",
          grossAmount: "1000140",
        },
        {
          inboxIndex: "9",
          sweepTxHash: "0xsweep9",
          settledAt: 1_700_000_500_000,
          netAmount: "4000000",
          grossAmount: "4000140",
        },
      ],
    })

    // Ledgered: the next scan resumes at the cursor.
    store.records.get(SIPA_A)!.lastScanAt = 0
    await syncSipaDeposits({ ...deps, historyStartBlock: async () => START })
    expect(mocks.readSweepEvents.mock.calls[1]![2]).toBeGreaterThan(START)
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
    expect(claimed).toMatchObject({ phase: "claimed", observedFrom: HEAD.toString() })
    expect(claimed.fee).toBeUndefined()

    // The cursor sits past the sweep: nothing in this window carries the fee, so only the
    // per-pass backfill can land it.
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

  it("hands each funding read its batched balance and leaves a token the batch missed to its own read", async () => {
    const { deps } = makeDeps()
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
      sweepable: false,
    })
    vi.mocked(sdk.readSipaBalancesMany).mockResolvedValueOnce(
      new Map([[SIPA_A, new Map([[deps.token.address, 700n]])]]),
    )

    await syncSipaDeposits({
      ...deps,
      token: { ...deps.token, decimals: 18 },
      fundingTokens: [deps.token, usdc],
    })

    expect(mocks.readSipaFundingStatus).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ token: deps.token.address, balance: 700n }),
    )
    expect(mocks.readSipaFundingStatus).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ token: usdc.address, balance: undefined }),
    )
  })

  it("isolates a record whose stored secret does not parse", async () => {
    const store = makeStore()
    store.records.set(SIPA_B, {
      phase: "broadcast",
      messageSecret: "not-a-field",
      recipientL2Address: RECIPIENT_HEX,
      startTime: 1,
      amount: "0",
    })
    const { deps, tokenService } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: 1n, txHash: TX_HASH },
    ])

    const result = await syncSipaDeposits(deps)

    expect(result).toMatchObject({ claimed: 1, failed: 1 })
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledOnce()
  })

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
      ;(deps.publicClient as { getTransactionReceipt: unknown }).getTransactionReceipt = vi.fn(
        async () => ({
          logs: [
            {
              address: usdc.address,
              topics: encodeEventTopics({
                abi: erc20Abi,
                eventName: "Transfer",
                args: { from: SIPA_A, to: "0x000000000000000000000000000000000000dead" },
              }),
              data: pad(toHex(5_000_000n)),
            },
          ],
        }),
      )
      mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
      mocks.readSweepEvents.mockResolvedValue([
        { index: 7n, amount: 4n * 10n ** 18n, blockNumber: HEAD, txHash: TX_HASH },
      ])
      mocks.isL1ToL2MessageReady.mockResolvedValue(settled)
      // The funding transfer is not visible yet on the first pass.
      mocks.readFundingTransfers.mockResolvedValue([])
      await syncSipaDeposits(syncDeps)
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
        fundingTokenSymbol: "USDC",
      })
    },
  )

  it("names the token a sweep took from a re-used address, over its first funding's", async () => {
    const store = makeStore()
    const usdc = {
      address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as Address,
      symbol: "USDC",
      decimals: 6,
    }
    // Funded in USDC once, swept and claimed; then funded again in DAI and swept before any tick.
    store.records.set(SIPA_A, {
      phase: "claimed",
      claimedInboxIndexes: ["7"],
      messageSecret: SECRET_A.toString(),
      netAmount: "990000",
      amount: "0.99",
      fundingTxHash: "0xusdc",
      fundingFromAddress: "0xfeed",
      fundingTokenSymbol: "USDC",
      startTime: Date.now() - 86_400_000,
      lastScanAt: 0,
    })
    const { deps } = makeDeps(store)
    const getTransactionReceipt = vi.fn(async () => ({
      logs: [
        {
          address: deps.token.address,
          topics: encodeEventTopics({
            abi: erc20Abi,
            eventName: "Transfer",
            args: { from: SIPA_A, to: "0x000000000000000000000000000000000000dead" },
          }),
          data: pad(toHex(4n * 10n ** 18n)),
        },
      ],
    }))
    ;(deps.publicClient as { getTransactionReceipt: unknown }).getTransactionReceipt =
      getTransactionReceipt
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 8n, amount: 4n * 10n ** 18n, blockNumber: HEAD, txHash: "0xresweep" },
    ])
    const syncDeps = {
      ...deps,
      token: { ...deps.token, decimals: 18 },
      fundingTokens: [deps.token, usdc],
    }

    await syncSipaDeposits(syncDeps)

    expect(getTransactionReceipt).toHaveBeenCalledWith({ hash: "0xresweep" })
    expect(store.records.get(SIPA_A)).toMatchObject({
      phase: "claimed",
      claimedInboxIndexes: ["7", "8"],
      sweepTxHash: "0xresweep",
      tokenSymbol: "DAI",
      fundingTokenSymbol: "DAI",
    })

    // A batched tx that moved two accepted tokens out of the SIPA names neither.
    getTransactionReceipt.mockResolvedValueOnce({
      logs: [usdc.address, deps.token.address].map((address) => ({
        address,
        topics: encodeEventTopics({
          abi: erc20Abi,
          eventName: "Transfer",
          args: { from: SIPA_A, to: "0x000000000000000000000000000000000000dead" },
        }),
        data: pad(toHex(1n)),
      })),
    })
    mocks.readSweepEvents.mockResolvedValue([
      { index: 9n, amount: 1n, blockNumber: HEAD, txHash: "0xbatch" },
    ])
    store.records.get(SIPA_A)!.lastScanAt = 0
    await syncSipaDeposits(syncDeps)

    expect(store.records.get(SIPA_A)).toMatchObject({
      claimedInboxIndexes: ["7", "8", "9"],
      sweepTxHash: "0xbatch",
      fundingTokenSymbol: "DAI",
    })
  })

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

  it("marks an unswept SIPA holding only ETH recoverable in ETH", async () => {
    const store = makeStore()
    // A token fee priced on an earlier pass must not price the ETH.
    store.records.set(SIPA_A, { phase: "broadcast", startTime: 1, amount: "0", fee: "140" })
    const { deps } = makeDeps(store)
    ;(deps.publicClient.getBalance as ReturnType<typeof vi.fn>).mockResolvedValue(10n ** 16n)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 0n,
      scaledBalance: 0n,
      fee: 100n,
      fpcFundingCut: 40n,
      sweepable: false,
    })

    expect(await syncSipaDeposits(deps)).toMatchObject({ recoverable: 1 })
    expect(store.records.get(SIPA_A)).toMatchObject({
      phase: "recoverable",
      amount: "0.01",
      tokenAddress: "0x0000000000000000000000000000000000000000",
      tokenSymbol: "ETH",
      tokenDecimals: 18,
    })
    expect(store.records.get(SIPA_A)?.fee).toBeUndefined()
  })

  it("never turns a claimed deposit holding leftover ETH into an ETH recovery", async () => {
    const store = makeStore()
    const claimed = {
      phase: "claimed" as const,
      startTime: 1,
      amount: "14.75",
      netAmount: "14750000000000000000",
      fee: "250000000000000000",
      tokenSymbol: "DAI",
      sweepTxHash: TX_HASH,
      inboxIndex: "4",
      claimedInboxIndexes: ["4"],
    }
    store.records.set(SIPA_A, claimed)
    const { deps } = makeDeps(store)
    // ETH sent before the sweep deployed the SIPA stays there; the sweep sits outside this window.
    ;(deps.publicClient.getBalance as ReturnType<typeof vi.fn>).mockResolvedValue(10n ** 16n)
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

    expect(store.records.get(SIPA_A)).toMatchObject(claimed)
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
    mocks.readSweepEvents.mockImplementation(async (_client: never, sipa: string) => [
      { index: sipa === SIPA_A ? 1n : 3n, amount: 100_000n, blockNumber: 1n, txHash: TX_HASH },
    ])
    tokenService.claimSweptDeposit.mockImplementation(
      async ({ inboxIndex }: { inboxIndex: bigint }) => {
        if (inboxIndex === 1n) throw new Error("pxe hiccup")
      },
    )

    const result = await syncSipaDeposits(deps)

    expect(result).toMatchObject({ discovered: 2, claimed: 1, failed: 1 })
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledTimes(2)
    expect(store.records.get(SIPA_B)).toMatchObject({ phase: "claimed" })
  })

  it("reports progress over the pass's unique items, failed ones included", async () => {
    const { deps } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([
      sipaEvent(SECRET_A),
      sipaEvent(SECRET_A),
      sipaEvent(SECRET_B),
    ])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 3n, amount: 100_000n, blockNumber: 1n, txHash: TX_HASH },
    ])
    deps.tokenService.claimSweptDeposit.mockRejectedValueOnce(new Error("pxe hiccup"))
    const progress: [number, number][] = []
    await syncSipaDeposits({ ...deps, onProgress: (done, total) => progress.push([done, total]) })
    expect(progress).toEqual([
      [0, 2],
      [1, 2],
      [2, 2],
    ])
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
    // index 7's claim fails this run; 9 claims.
    tokenService.claimSweptDeposit.mockImplementation(
      async ({ inboxIndex }: { inboxIndex: bigint }) => {
        if (inboxIndex === 7n) throw new Error("pxe hiccup")
      },
    )

    const result = await syncSipaDeposits(deps)

    expect(result).toMatchObject({ claimed: 1, failed: 1 })
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledTimes(2)
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

  it("skips another recipient's record, and watches a settled one without claiming", async () => {
    const store = makeStore()
    store.records.set(SIPA_B, {
      phase: "broadcast",
      messageSecret: `0x${"22".repeat(32)}`,
      recipientL2Address: "0x9999999999999999999999999999999999999999999999999999999999999999",
    })
    store.records.set(SIPA_C, {
      phase: "claimed",
      messageSecret: `0x${"13".repeat(32)}`,
      recipientL2Address: RECIPIENT_HEX,
    })
    const { deps, tokenService } = makeDeps(store)
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 0n,
      scaledBalance: 0n,
      fee: 100n,
      fpcFundingCut: 40n,
      sweepable: false,
    })
    mocks.fetchSipaEvents.mockResolvedValue([])

    const result = await syncSipaDeposits(deps)

    expect(result).toMatchObject({ claimed: 0, failed: 0 })
    expect(mocks.readSweepEvents.mock.calls.map((c) => c[1])).toEqual([SIPA_C])
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

    expect(mocks.readDepositFee).toHaveBeenCalledWith(
      expect.objectContaining({ getBlockNumber: deps.publicClient.getBlockNumber }),
      REGISTRATION_IMPLEMENTATION,
    )
    expect(mocks.readSipaFundingStatus).toHaveBeenCalledWith(
      expect.objectContaining({ getBlockNumber: deps.publicClient.getBlockNumber }),
      expect.objectContaining({ sipa: SIPA_C }),
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
      expect.objectContaining({ getBlockNumber: deps.publicClient.getBlockNumber }),
      REGISTRATION_IMPLEMENTATION,
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
    // One observation for both.
    expect(vi.mocked(observeSipas)).toHaveBeenCalledOnce()
    expect(vi.mocked(observeSipas).mock.calls[0]![1].subjects.map((s) => s.address)).toEqual([
      SIPA_B,
      SIPA_C,
    ])
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledOnce()
    expect(store.records.get(SIPA_C)).toMatchObject({ phase: "claimed" })
  })
})

describe("syncSipaDeposits observation windows", () => {
  const START = HEAD - 400_000n
  /** The [fromBlock, toBlock] of every per-SIPA sweep read the observation made. */
  const scanRanges = () => mocks.readSweepEvents.mock.calls.map((c) => [c[2], c[3]])
  const empty = {
    balance: 0n,
    scaledBalance: 0n,
    fee: 100n,
    fpcFundingCut: 40n,
    sweepable: false,
  }
  /** Sweep reader that honors the requested range. */
  const rangeSweeps =
    (sweeps: { block: bigint; index: bigint }[]) =>
    async (_client: unknown, _sipa: string, from: bigint, to: bigint) =>
      sweeps
        .filter((s) => s.block >= from && s.block <= to)
        .map((s) => ({ index: s.index, amount: 990_000n, blockNumber: s.block, txHash: TX_HASH }))

  it("reads a new SIPA's whole history, then only the blocks since the deployment's cursor", async () => {
    const { deps, store } = makeDeps()
    const historyStartBlock = vi.fn(async () => START)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue(empty)

    await syncSipaDeposits({ ...deps, historyStartBlock })
    expect(store.records.get(SIPA_A)).toMatchObject({ observedFrom: HEAD.toString() })
    expect(store.cursor).toBe(HEAD)
    await syncSipaDeposits({ ...deps, historyStartBlock })

    expect(scanRanges()).toEqual([
      [START, HEAD],
      [HEAD - 128n, HEAD],
    ])
    expect(historyStartBlock).toHaveBeenCalledTimes(1)
  })

  it("takes the default look-back for a new SIPA when the history start cannot be read", async () => {
    const { deps, store } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue(empty)

    await syncSipaDeposits({
      ...deps,
      historyStartBlock: async () => {
        throw new Error("rpc down")
      },
    })

    expect(scanRanges()).toEqual([[HEAD - 50_000n, HEAD]])
    // A partial read marks nothing read: the next pass tries the history again.
    expect(store.records.get(SIPA_A)?.observedFrom).toBeUndefined()
  })

  it("observes the other SIPAs when one window fails, and leaves the failed one its window", async () => {
    const store = makeStore()
    store.cursor = HEAD - 1n
    store.records.set(SIPA_B, {
      phase: "broadcast",
      messageSecret: SECRET_B.toString(),
      recipientL2Address: RECIPIENT_HEX,
      startTime: 1,
      amount: "0",
      observedFrom: (HEAD - 1_000n).toString(),
    })
    const { deps, tokenService } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: HEAD, txHash: TX_HASH },
    ])
    const real = vi.mocked(observeSipas).getMockImplementation()!
    vi.mocked(observeSipas).mockImplementationOnce(async (client, params) => {
      const result = await real(client, params)
      result.observed.delete(SIPA_B.toLowerCase())
      return result
    })

    const result = await syncSipaDeposits({ ...deps, historyStartBlock: async () => START })

    expect(result).toMatchObject({ claimed: 1, failed: 1 })
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledOnce()
    expect(store.records.get(SIPA_B)).toMatchObject({ rescanFrom: (HEAD - 1n - 128n).toString() })
    expect(store.cursor).toBe(HEAD)
  })

  it("finds a deposit swept long before the cursor on a fresh device", async () => {
    const { deps, store, tokenService } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockImplementation(rangeSweeps([{ block: HEAD - 300_000n, index: 7n }]))

    await syncSipaDeposits({ ...deps, historyStartBlock: async () => START })

    expect(tokenService.claimSweptDeposit).toHaveBeenCalledTimes(1)
    expect(store.records.get(SIPA_A)).toMatchObject({ phase: "claimed", amount: "0.99" })
  })

  it("reads a record added after the cursor from the start, beside one that rides the cursor", async () => {
    const store = makeStore()
    store.cursor = HEAD - 10n
    store.records.set(SIPA_B, {
      phase: "claimed",
      messageSecret: SECRET_B.toString(),
      recipientL2Address: RECIPIENT_HEX,
      startTime: 1,
      amount: "1",
      observedFrom: (HEAD - 1_000n).toString(),
    })
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue(empty)

    await syncSipaDeposits({ ...deps, historyStartBlock: async () => START })

    const ranges = new Map(mocks.readSweepEvents.mock.calls.map((c) => [c[1], [c[2], c[3]]]))
    expect(ranges.get(SIPA_A)).toEqual([START, HEAD])
    expect(ranges.get(SIPA_B)).toEqual([HEAD - 10n - 128n, HEAD])
  })

  it("watches a settled SIPA every pass, so a second payment is seen at once", async () => {
    const store = makeStore()
    store.cursor = HEAD - 1n
    store.records.set(SIPA_A, {
      phase: "claimed",
      claimedInboxIndexes: ["7"],
      messageSecret: SECRET_A.toString(),
      recipientL2Address: RECIPIENT_HEX,
      startTime: 1,
      amount: "0.99",
      fee: "140",
      fpcFundingCut: "40",
      observedFrom: (HEAD - 1_000n).toString(),
      sweeps: [{ inboxIndex: "7", sweepTxHash: TX_HASH, netAmount: "990000" }],
    })
    const { deps, tokenService } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 8n, amount: 500_000n, blockNumber: HEAD, txHash: "0xresweep" },
    ])

    const result = await syncSipaDeposits(deps)

    expect(result).toMatchObject({ claimed: 1 })
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ inboxIndex: 8n }),
    )
    expect(store.records.get(SIPA_A)).toMatchObject({ claimedInboxIndexes: ["7", "8"] })
  })

  it("writes nothing for a quiet settled SIPA", async () => {
    const store = makeStore()
    store.cursor = HEAD - 1n
    store.records.set(SIPA_A, {
      phase: "claimed",
      claimedInboxIndexes: ["7"],
      messageSecret: SECRET_A.toString(),
      recipientL2Address: RECIPIENT_HEX,
      startTime: 1,
      amount: "0.99",
      fee: "140",
      fpcFundingCut: "40",
      inboxIndex: "7",
      sweepTxHash: TX_HASH,
      observedFrom: (HEAD - 1_000n).toString(),
      sweeps: [{ inboxIndex: "7", sweepTxHash: TX_HASH, netAmount: "990000" }],
    })
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue(empty)
    // The first pass backfills what discovery derives; the next has nothing to write.
    await syncSipaDeposits(deps)
    store.upsert.mockClear()

    await syncSipaDeposits(deps)

    expect(store.upsert).not.toHaveBeenCalled()
    expect(store.cursor).toBe(HEAD)
  })

  it("keeps an unsettled sweep's claim inputs, and claims it on a later pass that no longer sees it", async () => {
    const { deps, store, tokenService } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValueOnce([
      { index: 7n, amount: 990_000n, blockNumber: HEAD - 5_000n, txHash: TX_HASH },
    ])
    mocks.isL1ToL2MessageReady.mockResolvedValueOnce(false)

    await syncSipaDeposits(deps)
    expect(store.records.get(SIPA_A)).toMatchObject({
      phase: "pendingClaim",
      pendingSweeps: [
        {
          inboxIndex: "7",
          amount: "990000",
          messageKey: `0x${"0a".repeat(32)}`,
          blockNumber: (HEAD - 5_000n).toString(),
          sweepTxHash: TX_HASH,
        },
      ],
    })

    mocks.readSweepEvents.mockResolvedValue([])
    mocks.isL1ToL2MessageReady.mockResolvedValue(true)
    await syncSipaDeposits(deps)

    expect(tokenService.claimSweptDeposit).toHaveBeenCalledTimes(1)
    expect(store.records.get(SIPA_A)).toMatchObject({
      phase: "claimed",
      claimedInboxIndexes: ["7"],
    })
    expect(store.records.get(SIPA_A)?.pendingSweeps).toBeUndefined()
  })

  it("processes a sweep that is both observed and pending once", async () => {
    const store = makeStore()
    store.cursor = HEAD - 1n
    store.records.set(SIPA_A, {
      phase: "pendingClaim",
      messageSecret: SECRET_A.toString(),
      recipientL2Address: RECIPIENT_HEX,
      startTime: 1,
      amount: "0.99",
      observedFrom: (HEAD - 1_000n).toString(),
      pendingSweeps: [
        {
          inboxIndex: "7",
          amount: "990000",
          messageKey: `0x${"0a".repeat(32)}`,
          blockNumber: (HEAD - 10n).toString(),
          sweepTxHash: TX_HASH,
        },
      ],
    })
    const { deps, tokenService } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: HEAD - 10n, txHash: TX_HASH },
    ])

    await syncSipaDeposits(deps)

    expect(tokenService.claimSweptDeposit).toHaveBeenCalledTimes(1)
  })

  it("keeps a sweep whose claim failed for the next pass", async () => {
    const { deps, store, tokenService } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: HEAD - 5n, txHash: TX_HASH },
    ])
    tokenService.claimSweptDeposit.mockRejectedValueOnce(new Error("pxe busy"))

    expect(await syncSipaDeposits(deps)).toMatchObject({ claimed: 0, failed: 1 })
    expect(store.records.get(SIPA_A)?.pendingSweeps).toEqual([
      expect.objectContaining({ inboxIndex: "7" }),
    ])
  })

  it("re-reads a SIPA from the window a failed pass missed, while the cursor moves on", async () => {
    const store = makeStore()
    store.cursor = HEAD - 1n
    store.records.set(SIPA_A, {
      phase: "broadcast",
      messageSecret: SECRET_A.toString(),
      recipientL2Address: RECIPIENT_HEX,
      startTime: 1,
      amount: "0",
      observedFrom: (HEAD - 1_000n).toString(),
      rescanFrom: (HEAD - 600n).toString(),
    })
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue(empty)

    await syncSipaDeposits(deps)

    // The saved bound already holds the overlap.
    expect(scanRanges()).toEqual([[HEAD - 600n, HEAD]])
    expect(store.records.get(SIPA_A)?.rescanFrom).toBeUndefined()
  })

  it("leaves a SIPA whose scan threw to re-read from its window", async () => {
    const store = makeStore()
    store.cursor = HEAD - 1n
    store.records.set(SIPA_A, {
      phase: "broadcast",
      messageSecret: SECRET_A.toString(),
      recipientL2Address: RECIPIENT_HEX,
      startTime: 1,
      amount: "0",
      observedFrom: (HEAD - 1_000n).toString(),
    })
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockRejectedValue(new Error("rpc down"))

    expect(await syncSipaDeposits(deps)).toMatchObject({ failed: 1 })
    expect(store.records.get(SIPA_A)).toMatchObject({ rescanFrom: (HEAD - 1n - 128n).toString() })
    expect(store.cursor).toBe(HEAD)
  })

  const observedRecord = (fields: Record<string, unknown> = {}) => ({
    phase: "broadcast",
    messageSecret: SECRET_A.toString(),
    recipientL2Address: RECIPIENT_HEX,
    startTime: 1,
    amount: "0",
    observedFrom: (HEAD - 1_000n).toString(),
    ...fields,
  })

  it("leaves a record whose plan failed the window this pass would have read", async () => {
    const store = makeStore()
    store.cursor = HEAD - 1n
    store.records.set(SIPA_A, observedRecord({ intent: "registration" }))
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([])
    mocks.readRegistrationSIPAImplementation.mockRejectedValue(new Error("rpc down"))

    expect(await syncSipaDeposits(deps)).toMatchObject({ failed: 1 })
    expect(store.records.get(SIPA_A)).toMatchObject({ rescanFrom: (HEAD - 1n - 128n).toString() })
    expect(store.cursor).toBe(HEAD)
  })

  it("keeps an observed record's window when a new record falls back to the look-back", async () => {
    const store = makeStore()
    store.cursor = HEAD - 200_000n
    store.records.set(SIPA_B, { ...observedRecord(), messageSecret: SECRET_B.toString() })
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue(empty)

    await syncSipaDeposits({
      ...deps,
      historyStartBlock: async () => {
        throw new Error("rpc down")
      },
    })

    const ranges = new Map(mocks.readSweepEvents.mock.calls.map((c) => [c[1], c[2]]))
    expect(ranges.get(SIPA_A)).toBe(HEAD - 50_000n)
    expect(ranges.get(SIPA_B)).toBe(HEAD - 200_000n - 128n)
  })

  it("drops a saved sweep that the window covers and no longer shows: reorged away", async () => {
    const store = makeStore()
    store.cursor = HEAD - 1n
    store.records.set(
      SIPA_A,
      observedRecord({
        phase: "pendingClaim",
        pendingSweeps: [
          {
            inboxIndex: "7",
            amount: "990000",
            messageKey: `0x${"0a".repeat(32)}`,
            blockNumber: (HEAD - 10n).toString(),
            sweepTxHash: TX_HASH,
          },
        ],
      }),
    )
    const { deps, tokenService } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      ...empty,
      balance: 1_000_000n,
      scaledBalance: 1_000_000n,
      sweepable: true,
    })

    await syncSipaDeposits(deps)

    expect(tokenService.claimSweptDeposit).not.toHaveBeenCalled()
    expect(store.records.get(SIPA_A)?.pendingSweeps).toBeUndefined()
    expect(store.records.get(SIPA_A)?.phase).toBe("sweeping")
  })

  it("keeps a delayed sweep's gross and token with its claim inputs, for a claim past its window", async () => {
    const usdc = {
      address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as Address,
      symbol: "USDC",
      decimals: 6,
    }
    const { deps, store } = makeDeps()
    ;(deps.publicClient as { getTransactionReceipt: unknown }).getTransactionReceipt = vi.fn(
      async () => ({
        logs: [
          {
            address: usdc.address,
            topics: encodeEventTopics({
              abi: erc20Abi,
              eventName: "Transfer",
              args: { from: SIPA_A, to: "0x000000000000000000000000000000000000dead" },
            }),
            data: pad(toHex(5_000_000n)),
          },
        ],
      }),
    )
    const syncDeps = {
      ...deps,
      token: { ...deps.token, decimals: 18 },
      fundingTokens: [deps.token, usdc],
    }
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValueOnce([
      { index: 7n, amount: 4n * 10n ** 18n, blockNumber: HEAD - 5_000n, txHash: TX_HASH },
    ])
    mocks.isL1ToL2MessageReady.mockResolvedValueOnce(false)

    await syncSipaDeposits(syncDeps)
    expect(store.records.get(SIPA_A)?.pendingSweeps).toEqual([
      expect.objectContaining({ grossAmount: "5000000", fundingToken: usdc.address }),
    ])

    mocks.readSweepEvents.mockResolvedValue([])
    mocks.isL1ToL2MessageReady.mockResolvedValue(true)
    await syncSipaDeposits(syncDeps)

    expect(store.records.get(SIPA_A)?.sweeps).toEqual([
      expect.objectContaining({
        inboxIndex: "7",
        grossAmount: "5000000",
        fundingTokenSymbol: "USDC",
      }),
    ])
  })

  it("writes strictly, and holds the cursor when a record write does not land", async () => {
    const { deps, store } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: HEAD - 5n, txHash: TX_HASH },
    ])
    const upsert = store.upsert.getMockImplementation()!
    store.upsert.mockImplementation(async (address, patch, fallback, opts) => {
      if ((patch as { phase?: string }).phase === "claimed") throw new Error("quota exceeded")
      return upsert(address, patch, fallback, opts)
    })

    await syncSipaDeposits(deps)

    expect(store.upsert.mock.calls.every((c) => (c[3] as { strict?: boolean })?.strict)).toBe(true)
    expect(store.cursor).toBeUndefined()
  })

  it("publishes a funded SIPA the relayer left unswept again, at most once a day", async () => {
    const store = makeStore()
    store.cursor = HEAD - 1n
    store.records.set(
      SIPA_A,
      observedRecord({ phase: "sweeping", startTime: Date.now() - 2 * 3_600_000 }),
    )
    const { deps } = makeDeps(store)
    const onSweepOverdue = vi.fn(async () => true)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      ...empty,
      balance: 1_000_000n,
      scaledBalance: 1_000_000n,
      sweepable: true,
    })

    await syncSipaDeposits({ ...deps, onSweepOverdue })
    await syncSipaDeposits({ ...deps, onSweepOverdue })

    expect(onSweepOverdue).toHaveBeenCalledOnce()
    expect(onSweepOverdue).toHaveBeenCalledWith(SIPA_A)
    expect(store.records.get(SIPA_A)?.republishAskedAt).toEqual(expect.any(Number))
  })

  it("asks once a day for an address it cannot publish again, too", async () => {
    const store = makeStore()
    store.cursor = HEAD - 1n
    store.records.set(
      SIPA_A,
      observedRecord({ phase: "sweeping", startTime: Date.now() - 2 * 3_600_000 }),
    )
    const { deps } = makeDeps(store)
    const onSweepOverdue = vi.fn(async () => false)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      ...empty,
      balance: 1_000_000n,
      scaledBalance: 1_000_000n,
      sweepable: true,
    })

    await syncSipaDeposits({ ...deps, onSweepOverdue })
    await syncSipaDeposits({ ...deps, onSweepOverdue })

    expect(onSweepOverdue).toHaveBeenCalledOnce()
  })

  it("leaves a SIPA funded within the hour to the relayer", async () => {
    const store = makeStore()
    store.cursor = HEAD - 1n
    store.records.set(SIPA_A, observedRecord({ phase: "sweeping", startTime: Date.now() - 60_000 }))
    const { deps } = makeDeps(store)
    const onSweepOverdue = vi.fn(async () => true)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      ...empty,
      balance: 1_000_000n,
      scaledBalance: 1_000_000n,
      sweepable: true,
    })

    await syncSipaDeposits({ ...deps, onSweepOverdue })

    expect(onSweepOverdue).not.toHaveBeenCalled()
  })

  it("records the balance it observed, in fee-token units", async () => {
    const store = makeStore()
    store.cursor = HEAD - 1n
    store.records.set(SIPA_A, observedRecord())
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue(empty)
    mocks.observedTokenBalance.mockReturnValue(1_000_000n)

    await syncSipaDeposits(deps)

    expect(store.records.get(SIPA_A)?.heldBalance).toBe("1000000")
  })

  it("records the emptied balance on a pass that sees the sweep", async () => {
    const store = makeStore()
    store.cursor = HEAD - 1n
    store.records.set(SIPA_A, observedRecord({ heldBalance: "1000000" }))
    const { deps } = makeDeps(store)
    mocks.readSipaFundingStatus.mockResolvedValue(empty)
    mocks.observedTokenBalance.mockReturnValue(0n)
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: HEAD - 5n, txHash: TX_HASH },
    ])

    await syncSipaDeposits({ ...deps, tokenService: undefined, observeOnly: true })

    expect(store.records.get(SIPA_A)).toMatchObject({ heldBalance: "0", sweepTxHash: TX_HASH })
  })

  it("observe-only: reads no events or readiness and claims nothing, keeping the sweep's claim inputs", async () => {
    const store = makeStore()
    store.records.set(SIPA_A, observedRecord({ observedFrom: undefined }))
    const { deps, tokenService } = makeDeps(store)
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: HEAD - 5n, txHash: TX_HASH },
    ])

    await syncSipaDeposits({ ...deps, tokenService: undefined, observeOnly: true })

    expect(mocks.fetchSipaEvents).not.toHaveBeenCalled()
    expect(mocks.isL1ToL2MessageReady).not.toHaveBeenCalled()
    expect(tokenService.claimSweptDeposit).not.toHaveBeenCalled()
    expect(store.records.get(SIPA_A)).toMatchObject({
      phase: "pendingClaim",
      sweepTxHash: TX_HASH,
      pendingSweeps: [expect.objectContaining({ inboxIndex: "7" })],
    })
  })

  it("observe-only: a funded deposit address reads as funded, with its balance, token and clock", async () => {
    const store = makeStore()
    store.cursor = HEAD - 1n
    store.records.set(SIPA_A, observedRecord({ phase: "resolved" }))
    const { deps } = makeDeps(store)
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.observedTokenBalance.mockReturnValue(1_000_000n)
    mocks.readSipaFundingStatus.mockResolvedValue({
      ...empty,
      balance: 1_000_000n,
      scaledBalance: 1_000_000n,
      sweepable: true,
    })

    await syncSipaDeposits({ ...deps, tokenService: undefined, observeOnly: true })

    const record = store.records.get(SIPA_A)!
    expect(record).toMatchObject({ heldBalance: "1000000", tokenAddress: deps.token.address })
    expect(isUnfundedSipaDeposit(record as never)).toBe(false)
    // Its clock starts at the funds, not at the hand-out.
    expect(record.startTime).toBeGreaterThan(1)
  })

  it("observe-only: a funded address dated by its funding transfer keeps that date", async () => {
    const store = makeStore()
    store.cursor = HEAD - 1n
    store.records.set(SIPA_A, observedRecord({ phase: "resolved" }))
    const { deps } = makeDeps(store)
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readFundingTransfers.mockResolvedValue([
      { from: SIPA_B, amount: 1_000_000n, blockNumber: HEAD - 20n, txHash: TX_HASH },
    ])
    mocks.readBlockTimeMs.mockResolvedValue(5_000)
    mocks.observedTokenBalance.mockReturnValue(1_000_000n)
    mocks.readSipaFundingStatus.mockResolvedValue({
      ...empty,
      balance: 1_000_000n,
      scaledBalance: 1_000_000n,
      sweepable: true,
    })

    await syncSipaDeposits({ ...deps, tokenService: undefined, observeOnly: true })

    expect(store.records.get(SIPA_A)?.startTime).toBe(5_000)
  })

  it("observe-only: reads nothing past the head while the head has not passed the cursor", async () => {
    const store = makeStore()
    store.cursor = HEAD
    store.records.set(SIPA_A, observedRecord())
    const { deps } = makeDeps(store)

    await syncSipaDeposits({ ...deps, tokenService: undefined, observeOnly: true })
    expect(mocks.readSipaFundingStatus).not.toHaveBeenCalled()

    store.records.set(SIPA_A, observedRecord({ rescanFrom: (HEAD - 50n).toString() }))
    await syncSipaDeposits({ ...deps, tokenService: undefined, observeOnly: true })
    expect(mocks.readSipaFundingStatus).toHaveBeenCalled()
  })

  it("counts an in-flight sweep as active however old the record is", async () => {
    const store = makeStore()
    store.records.set(SIPA_A, {
      phase: "sweeping",
      startTime: 1,
      messageSecret: SECRET_A.toString(),
      recipientL2Address: RECIPIENT_HEX,
      amount: "1",
    })
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      ...empty,
      balance: 1_000_000n,
      scaledBalance: 1_000_000n,
      sweepable: true,
    })

    expect(await syncSipaDeposits(deps)).toMatchObject({ active: 1 })
  })

  it.each([
    ["an unfunded SIPA past its fresh window", { startTime: 1 }, 0],
    ["a replayed unfunded address", { startTime: Date.now(), replayed: true }, 0],
    ["a self-initiated record inside its fresh window", { startTime: Date.now() }, 1],
  ])("counts %s as active: %s", async (_label, fields, active) => {
    const store = makeStore()
    store.records.set(SIPA_A, {
      phase: "broadcast",
      messageSecret: SECRET_A.toString(),
      recipientL2Address: RECIPIENT_HEX,
      amount: "0",
      ...fields,
    })
    const { deps } = makeDeps(store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue(empty)

    expect(await syncSipaDeposits(deps)).toMatchObject({ active })
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

describe("syncSipaDeposits consumed sweeps", () => {
  const NHK = { secret: "nhk" }
  const twoSweeps = () =>
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: 1n, txHash: TX_HASH },
      { index: 9n, amount: 500_000n, blockNumber: 2n, txHash: TX_HASH },
    ])
  const nodeWithLookup = () => ({ findLeavesIndexes: vi.fn() } as never)

  it("records a sweep another device claimed with no readiness read or claim, in one lookup", async () => {
    const { deps, store, tokenService } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    twoSweeps()
    mocks.readSipaDepositsConsumed.mockResolvedValue([true, false])

    const result = await syncSipaDeposits({
      ...deps,
      node: nodeWithLookup(),
      masterNullifierHidingKey: NHK as never,
    })

    expect(result).toMatchObject({ claimed: 1, reconciled: 1, failed: 0 })
    expect(mocks.readSipaDepositsConsumed).toHaveBeenCalledOnce()
    const [, scope, hashes] = mocks.readSipaDepositsConsumed.mock.calls[0]!
    expect(scope).toMatchObject({ masterNullifierHidingKey: NHK })
    expect(hashes).toEqual([`0x${"0a".repeat(32)}`, `0x${"0a".repeat(32)}`])
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledOnce()
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ inboxIndex: 9n }),
    )
    expect(mocks.isL1ToL2MessageReady).toHaveBeenCalledTimes(1)
    expect(store.records.get(SIPA_A)).toMatchObject({
      phase: "claimed",
      claimedInboxIndexes: ["7", "9"],
    })
  })

  it("reads a consumed sweep's block with every other read, before any claim", async () => {
    const { deps, tokenService } = makeDeps()
    const order: string[] = []
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    twoSweeps()
    mocks.readSipaDepositsConsumed.mockResolvedValue([true, false])
    mocks.readBlockTimeMs.mockImplementation(async (_client: unknown, block: bigint) => {
      order.push(`block ${block}`)
      return undefined
    })
    tokenService.claimSweptDeposit.mockImplementation(async () => {
      order.push("claim")
    })

    await syncSipaDeposits({
      ...deps,
      node: nodeWithLookup(),
      masterNullifierHidingKey: NHK as never,
    })

    expect(order.indexOf("block 1")).toBeLessThan(order.indexOf("claim"))
    expect(order.indexOf("block 2")).toBeLessThan(order.indexOf("claim"))
  })

  it("claims every sweep when the lookup fails", async () => {
    const { deps, tokenService } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    twoSweeps()
    mocks.readSipaDepositsConsumed.mockRejectedValue(new Error("node down"))

    const result = await syncSipaDeposits({
      ...deps,
      node: nodeWithLookup(),
      masterNullifierHidingKey: NHK as never,
    })

    expect(result).toMatchObject({ claimed: 2, failed: 0 })
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledTimes(2)
  })

  it("looks nothing up without the hiding key", async () => {
    const { deps } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    twoSweeps()

    await syncSipaDeposits({ ...deps, node: nodeWithLookup() })

    expect(mocks.readSipaDepositsConsumed).not.toHaveBeenCalled()
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

  it("dates a deposit this device handed out by its funding transfer's block", async () => {
    const store = makeStore()
    store.records.set(SIPA_A, {
      phase: "broadcast",
      startTime: 1,
      messageSecret: SECRET_A.toString(),
    })
    const { deps } = makeDeps(store)
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
    mocks.readBlockTimeMs.mockImplementation(async (_client: unknown, block: bigint) =>
      block === transfer.blockNumber ? 1_700_000_000_000 : undefined,
    )

    await syncSipaDeposits(deps)

    expect(store.records.get(SIPA_A)).toMatchObject({ startTime: 1_700_000_000_000 })
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
    mocks.readFundingTransfers.mockResolvedValue([transfer])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: 1n, txHash: TX_HASH },
    ])

    const result = await syncSipaDeposits({
      ...deps,
      onFundingWalletDetected: async () => {
        throw new Error("contacts down")
      },
    })

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

  it.each([
    ["claims", () => {}],
    [
      "reconciles",
      (tokenService: ReturnType<typeof makeDeps>["tokenService"]) =>
        tokenService.claimSweptDeposit.mockRejectedValueOnce(
          new Error("Assertion failed: deposit already stored"),
        ),
    ],
  ])(
    "%s a deposit counted as arriving, and records it claimed only after the balance refresh",
    async (_, claimOutcome) => {
      const store = makeStore()
      store.records.set(SIPA_A, {
        phase: "pendingClaim",
        startTime: Date.now(),
        messageSecret: SECRET_A.toString(),
        netAmount: "990000",
        lastScanAt: Date.now(),
      })
      const { deps, tokenService } = makeDeps(store)
      claimOutcome(tokenService)
      sweptEvent()
      let land: () => void = () => {}
      const refreshBalance = vi.fn(() => new Promise<void>((resolve) => (land = resolve)))

      const pass = syncSipaDeposits({ ...deps, refreshBalance })
      await vi.waitFor(() => expect(refreshBalance).toHaveBeenCalledTimes(1))
      expect(store.records.get(SIPA_A)?.phase).toBe("pendingClaim")

      land()

      await pass
      expect(store.records.get(SIPA_A)?.phase).toBe("claimed")
    },
  )

  it("reads the balance once for a pass's claims across SIPAs, and records them all after it", async () => {
    const { deps, store, tokenService } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A), sipaEvent(SECRET_B)])
    mocks.computeSIPAAddress
      .mockImplementationOnce(() => ({ toString: () => SIPA_A }))
      .mockImplementationOnce(() => ({ toString: () => SIPA_B }))
    mocks.readSweepEvents.mockImplementation(async (_pc: unknown, sipa: string) => [
      sipa === SIPA_A
        ? { index: 7n, amount: 990_000n, blockNumber: 1n, txHash: TX_HASH }
        : { index: 9n, amount: 500_000n, blockNumber: 2n, txHash: TX_HASH },
    ])
    let land: () => void = () => {}
    const refreshBalance = vi.fn(() => new Promise<void>((resolve) => (land = resolve)))

    const pass = syncSipaDeposits({ ...deps, refreshBalance })
    await vi.waitFor(() => expect(refreshBalance).toHaveBeenCalledTimes(1))
    expect(tokenService.claimSweptDeposit).toHaveBeenCalledTimes(2)
    expect(store.records.get(SIPA_A)?.phase).not.toBe("claimed")
    expect(store.records.get(SIPA_B)?.phase).not.toBe("claimed")

    land()

    expect(await pass).toMatchObject({ claimed: 2 })
    expect(refreshBalance).toHaveBeenCalledTimes(1)
    expect(store.records.get(SIPA_A)?.phase).toBe("claimed")
    expect(store.records.get(SIPA_B)?.phase).toBe("claimed")
  })

  it("reads every sweep's message and readiness once, all before the first claim", async () => {
    const { deps, tokenService } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: 1n, txHash: TX_HASH },
      { index: 9n, amount: 500_000n, blockNumber: 2n, txHash: TX_HASH },
    ])
    mocks.readDepositMessageKey.mockImplementation(async (...args: unknown[]) =>
      fr(`0x${(args[3] as bigint).toString(16).padStart(64, "0")}`),
    )

    expect(await syncSipaDeposits(deps)).toMatchObject({ claimed: 2 })

    expect(mocks.readDepositMessageKey).toHaveBeenCalledTimes(2)
    expect(mocks.isL1ToL2MessageReady).toHaveBeenCalledTimes(2)
    const firstClaim = tokenService.claimSweptDeposit.mock.invocationCallOrder[0]!
    for (const order of mocks.isL1ToL2MessageReady.mock.invocationCallOrder)
      expect(order).toBeLessThan(firstClaim)
  })

  it("keeps a newer sweep pending when an older one on the same SIPA claims in the pass", async () => {
    const { deps, store } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: 1n, txHash: TX_HASH },
      { index: 9n, amount: 500_000n, blockNumber: 2n, txHash: TX_HASH },
    ])
    mocks.readDepositMessageKey.mockImplementation(async (...args: unknown[]) =>
      fr(`0x${(args[3] as bigint).toString(16).padStart(64, "0")}`),
    )
    mocks.isL1ToL2MessageReady.mockImplementation(
      async (_node: unknown, key: unknown) => BigInt(String(key)) === 7n,
    )

    expect(await syncSipaDeposits(deps)).toMatchObject({ claimed: 1, pendingSettlement: 1 })

    expect(store.records.get(SIPA_A)).toMatchObject({
      phase: "pendingClaim",
      inboxIndex: "9",
      netAmount: "500000",
      claimedInboxIndexes: ["7"],
    })
  })

  it("reads as received for a migration only once the rail claimed every sweep", async () => {
    const { deps, store } = makeDeps()
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A)])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: 1n, txHash: TX_HASH },
      { index: 9n, amount: 500_000n, blockNumber: 2n, txHash: TX_HASH },
    ])
    mocks.readDepositMessageKey.mockImplementation(async (...args: unknown[]) =>
      fr(`0x${(args[3] as bigint).toString(16).padStart(64, "0")}`),
    )
    mocks.isL1ToL2MessageReady.mockImplementation(
      async (_node: unknown, key: unknown) => BigInt(String(key)) === 7n,
    )

    await syncSipaDeposits(deps)
    expect(sipaSweepsReceived(store.records.get(SIPA_A) as never)).toBe(false)

    mocks.isL1ToL2MessageReady.mockResolvedValue(true)
    vi.mocked(deps.publicClient.getBlockNumber).mockResolvedValue(HEAD + 1n)
    await syncSipaDeposits(deps)
    expect(sipaSweepsReceived(store.records.get(SIPA_A) as never)).toBe(true)
  })

  it("keeps the cursor where it was when a claim's record never lands", async () => {
    const store = makeStore()
    const upsert = store.upsert.getMockImplementation()!
    store.upsert.mockImplementation(async (address, patch, fallback) => {
      if (patch.phase === "claimed") throw new Error("tab closed")
      return upsert(address, patch, fallback)
    })
    const { deps } = makeDeps(store)
    sweptEvent()

    await syncSipaDeposits(deps)

    expect(store.records.get(SIPA_A)?.lastScannedBlock).toBeUndefined()
    expect(store.records.get(SIPA_A)?.historyScanned).toBeUndefined()
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

describe("syncSipaDeposits second payment to a claimed SIPA", () => {
  const funded = { balance: 500n, scaledBalance: 500n, fee: 100n, sweepable: true }

  /** Claims one sweep, then reads the same address with new funds and no new sweep. */
  async function payAgain(resweepable: boolean) {
    const { deps, store } = makeDeps()
    const onSweptAddressFunded = vi.fn(async (_sipa: Address) => {})
    const run = { ...deps, onSweptAddressFunded }
    mocks.fetchSipaEvents.mockResolvedValue([{ ...sipaEvent(SECRET_A), resweepable }])
    mocks.readSweepEvents.mockResolvedValue([
      { index: 7n, amount: 990_000n, blockNumber: HEAD - 1_000n, txHash: TX_HASH },
    ])
    mocks.readSipaFundingStatus.mockResolvedValue({ ...funded, balance: 0n, sweepable: false })
    await syncSipaDeposits(run)
    expect(store.records.get(SIPA_A)).toMatchObject({ phase: "claimed", sweepTxHash: TX_HASH })

    store.records.get(SIPA_A)!.lastScanAt = 0
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue(funded)
    await syncSipaDeposits(run)
    return { run, store, onSweptAddressFunded }
  }

  it("reopens a resweepable address on a fresh stuck clock and asks for one republish", async () => {
    const before = Date.now()
    const { run, store, onSweptAddressFunded } = await payAgain(true)
    const record = store.records.get(SIPA_A)!
    expect(record).toMatchObject({
      phase: "sweeping",
      amount: "0.0005",
      claimedInboxIndexes: ["7"],
    })
    expect(record.sweepTxHash).toBeUndefined()
    expect(record.netAmount).toBeUndefined()
    expect(record.startTime as number).toBeGreaterThanOrEqual(before)
    expect(onSweptAddressFunded.mock.calls).toEqual([[SIPA_A]])

    await syncSipaDeposits(run)
    expect(onSweptAddressFunded).toHaveBeenCalledOnce()
  })

  it("keeps the claim when the republish fails, and republishes on the next scan", async () => {
    const { run, store, onSweptAddressFunded } = await payAgain(true)
    onSweptAddressFunded.mockClear()
    store.records.get(SIPA_A)!.phase = "claimed"
    store.records.get(SIPA_A)!.sweepTxHash = TX_HASH
    store.records.get(SIPA_A)!.lastScanAt = 0
    onSweptAddressFunded.mockRejectedValueOnce(new Error("node down"))

    await syncSipaDeposits(run)
    expect(store.records.get(SIPA_A)).toMatchObject({ phase: "claimed", sweepTxHash: TX_HASH })

    store.records.get(SIPA_A)!.lastScanAt = 0
    await syncSipaDeposits(run)
    expect(store.records.get(SIPA_A)).toMatchObject({ phase: "sweeping" })
    expect(onSweptAddressFunded).toHaveBeenCalledTimes(2)
  })

  it("sends a second payment to an address that refuses a second sweep to recovery", async () => {
    const { store, onSweptAddressFunded } = await payAgain(false)
    expect(store.records.get(SIPA_A)).toMatchObject({ phase: "recoverable" })
    expect(onSweptAddressFunded).not.toHaveBeenCalled()
  })
})

describe("syncSipaDeposits second payment left without an exit", () => {
  it("reopens a sweeping record still stamped with its claimed sweep", async () => {
    const store = makeStore()
    store.records.set(SIPA_A, {
      phase: "sweeping",
      startTime: 1,
      endTime: 2,
      inboxIndex: "7",
      claimedInboxIndexes: ["7"],
      sweepTxHash: TX_HASH,
      messageSecret: SECRET_A.toString(),
      recipientL2Address: RECIPIENT_HEX,
      recipientHash: "0xset",
      recoveryAddress: "0xset",
    })
    const { deps } = makeDeps(store)
    const onSweptAddressFunded = vi.fn(async (_sipa: Address) => {})
    mocks.fetchSipaEvents.mockResolvedValue([{ ...sipaEvent(SECRET_A), resweepable: true }])
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 500n,
      scaledBalance: 500n,
      fee: 100n,
      sweepable: true,
    })

    await syncSipaDeposits({ ...deps, onSweptAddressFunded })

    const record = store.records.get(SIPA_A)!
    expect(record.sweepTxHash).toBeUndefined()
    expect(record.endTime).toBeUndefined()
    expect(isStuckSweep(record as never, (record.startTime as number) + STUCK_SWEEP_MS)).toBe(true)
    expect(onSweptAddressFunded).toHaveBeenCalledOnce()
  })
})

describe("syncSipaDeposits upgrade SIPAs", () => {
  const UPGRADE_IMPLEMENTATION = "0x6b1e0c2f3b4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f" as Address
  const UPGRADE_HASH = `0x${"77".repeat(32)}`
  const SIPA_UPGRADE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as Address

  /** Each implementation derives its own address: deposit → A, registration → C, upgrade → E. */
  function deriveByImplementation() {
    mocks.computeSIPAAddress.mockImplementation(
      (inputs: { implementation: { toString(): string } }) => {
        const implementation = inputs.implementation.toString()
        const address =
          implementation === REGISTRATION_IMPLEMENTATION
            ? SIPA_C
            : implementation === UPGRADE_IMPLEMENTATION
            ? SIPA_UPGRADE
            : SIPA_A
        return { toString: () => address }
      },
    )
  }

  /** `deployed` hold code; `swept` also emitted a `Sweep`, as a settled upgrade's SIPA does. */
  function upgradeDeps(deployed: Address[], store = makeStore(), swept: Address[] = deployed) {
    const made = makeDeps(store)
    mocks.readSweepEvents.mockImplementation(async (_pc: unknown, sipa: string) =>
      swept.some((s) => s.toLowerCase() === sipa.toLowerCase())
        ? [{ index: 4n, amount: 975_000n, blockNumber: 1n, txHash: TX_HASH }]
        : [],
    )
    const getCode = vi.fn(async ({ address }: { address: string }) =>
      deployed.some((d) => d.toLowerCase() === address.toLowerCase()) ? "0x6080" : undefined,
    )
    const deps = {
      ...made.deps,
      tuple: {
        ...TUPLE,
        updateMetadataSIPAImplementation: UPGRADE_IMPLEMENTATION,
      } as OxideEnvTuple,
      publicClient: { ...(made.deps.publicClient as object), getCode } as never,
    }
    return { ...made, deps, getCode }
  }

  beforeEach(() => {
    deriveByImplementation()
    mocks.readSweepEvents.mockResolvedValue([])
    mocks.readSipaFundingStatus.mockResolvedValue({
      balance: 0n,
      scaledBalance: 0n,
      fee: 100n,
      sweepable: false,
    })
  })

  it("stores a swept upgrade SIPA at its update-metadata address and prices it there", async () => {
    const { deps, store } = upgradeDeps([SIPA_UPGRADE])
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A, UPGRADE_HASH)])

    await syncSipaDeposits(deps)

    expect(store.records.get(SIPA_UPGRADE)).toMatchObject({ intent: "metadata" })
    expect(store.records.get(SIPA_C)).toBeUndefined()
    expect(mocks.readDepositFee).toHaveBeenCalledWith(
      expect.objectContaining({ getBlockNumber: deps.publicClient.getBlockNumber }),
      UPGRADE_IMPLEMENTATION,
    )
  })

  it("claims a swept upgrade SIPA, so a migration reads its metadata deposit as received", async () => {
    const { deps, store } = upgradeDeps([SIPA_UPGRADE])
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A, UPGRADE_HASH)])
    mocks.isL1ToL2MessageReady.mockResolvedValue(true)

    await syncSipaDeposits(deps)

    expect(store.records.get(SIPA_UPGRADE)).toMatchObject({ intent: "metadata", phase: "claimed" })
    expect(sipaSweepsReceived(store.records.get(SIPA_UPGRADE) as never)).toBe(true)
  })

  it("reads a non-deposit event as a registration until its upgrade address is swept", async () => {
    const { deps, store } = upgradeDeps([])
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A, UPGRADE_HASH)])

    await syncSipaDeposits(deps)

    expect(store.records.get(SIPA_C)).toMatchObject({ intent: "registration", replayed: true })
    expect(store.records.get(SIPA_UPGRADE)).toBeUndefined()
  })

  it("never reads code without an update-metadata implementation", async () => {
    const { deps, store } = makeDeps()
    const getCode = vi.fn()
    Object.assign(deps.publicClient as object, { getCode })
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A, UPGRADE_HASH)])

    await syncSipaDeposits(deps)

    expect(getCode).not.toHaveBeenCalled()
    expect(store.records.get(SIPA_C)).toMatchObject({ intent: "registration" })
  })

  it.each([
    ["upgrade first", [UPGRADE_HASH, undefined]],
    ["deposit first", [undefined, UPGRADE_HASH]],
  ])(
    "keeps an upgrade SIPA and the DepositSIPA sharing its salt apart, %s, across runs",
    async (_order, hashes) => {
      const { deps, store } = upgradeDeps([SIPA_UPGRADE])
      mocks.fetchSipaEvents.mockResolvedValue(hashes.map((hash) => sipaEvent(SECRET_A, hash)))

      await syncSipaDeposits(deps)
      await syncSipaDeposits(deps)

      expect([...store.records.keys()].sort()).toEqual([SIPA_A, SIPA_UPGRADE].sort())
      expect(store.records.get(SIPA_UPGRADE)).toMatchObject({ intent: "metadata" })
      expect(store.records.get(SIPA_A)?.intent).toBeUndefined()
    },
  )

  it("moves a misfiled upgrade from its registration address once its SIPA has code", async () => {
    const store = makeStore()
    store.records.set(SIPA_C, {
      phase: "broadcast",
      replayed: true,
      intent: "registration",
      amount: "0",
      messageSecret: SECRET_A.toString(),
      recipientL2Address: RECIPIENT_HEX,
    })
    const { deps } = upgradeDeps([SIPA_UPGRADE], store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A, UPGRADE_HASH)])

    await syncSipaDeposits(deps)

    expect(store.records.get(SIPA_C)).toBeUndefined()
    expect(store.records.get(SIPA_UPGRADE)).toMatchObject({ intent: "metadata" })
  })

  it("reads a predeployed, never-swept upgrade address as a registration", async () => {
    const { deps, store } = upgradeDeps([SIPA_UPGRADE], makeStore(), [])
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A, UPGRADE_HASH)])

    await syncSipaDeposits(deps)

    expect(store.records.get(SIPA_C)).toMatchObject({ intent: "registration" })
    expect(store.records.get(SIPA_UPGRADE)).toBeUndefined()
  })

  it("resolves a swept upgrade even when its registration address was deployed too", async () => {
    const { deps, store } = upgradeDeps([SIPA_C, SIPA_UPGRADE], makeStore(), [SIPA_UPGRADE])
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A, UPGRADE_HASH)])

    await syncSipaDeposits(deps)

    expect(store.records.get(SIPA_UPGRADE)).toMatchObject({ intent: "metadata" })
    expect(store.records.get(SIPA_C)).toBeUndefined()
  })

  it("keeps a misfiled-shaped registration whose upgrade address was only predeployed", async () => {
    const store = makeStore()
    store.records.set(SIPA_C, {
      phase: "broadcast",
      replayed: true,
      intent: "registration",
      amount: "0",
      messageSecret: SECRET_A.toString(),
      recipientL2Address: RECIPIENT_HEX,
    })
    const { deps } = upgradeDeps([SIPA_UPGRADE], store, [])
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A, UPGRADE_HASH)])

    await syncSipaDeposits(deps)

    expect(store.records.get(SIPA_C)).toMatchObject({ intent: "registration" })
    expect(store.records.get(SIPA_UPGRADE)).toBeUndefined()
  })

  it("keeps tracking stray funds at a misfiled address and gives the upgrade its own record", async () => {
    const store = makeStore()
    store.records.set(SIPA_C, {
      phase: "recoverable",
      replayed: true,
      intent: "registration",
      amount: "0.000001",
      messageSecret: SECRET_A.toString(),
      recipientL2Address: RECIPIENT_HEX,
    })
    const { deps } = upgradeDeps([SIPA_UPGRADE], store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A, UPGRADE_HASH)])

    await syncSipaDeposits(deps)
    await syncSipaDeposits(deps)

    expect(store.records.get(SIPA_C)).toMatchObject({ intent: "registration", amount: "0.000001" })
    expect(store.records.get(SIPA_UPGRADE)).toMatchObject({ intent: "metadata" })
  })

  it("rechecks a misfiled-shaped record on every pass, reading no code", async () => {
    const store = makeStore()
    store.records.set(SIPA_C, {
      phase: "broadcast",
      replayed: true,
      intent: "registration",
      amount: "0",
      messageSecret: SECRET_A.toString(),
      recipientL2Address: RECIPIENT_HEX,
      observedFrom: (HEAD - 1_000n).toString(),
    })
    store.cursor = HEAD - 1n
    const { deps, getCode } = upgradeDeps([SIPA_UPGRADE], store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A, UPGRADE_HASH)])

    await syncSipaDeposits(deps)

    expect(getCode).not.toHaveBeenCalled()
    expect(store.records.get(SIPA_C)).toBeUndefined()
    expect(store.records.get(SIPA_UPGRADE)).toMatchObject({ intent: "metadata" })
  })

  it("leaves a funded registration alone and reads no code for it", async () => {
    const store = makeStore()
    store.records.set(SIPA_C, {
      phase: "claimed",
      intent: "registration",
      amount: "5",
      inboxIndex: "1",
      messageSecret: SECRET_A.toString(),
      recipientL2Address: RECIPIENT_HEX,
    })
    const { deps, getCode } = upgradeDeps([SIPA_UPGRADE], store)
    mocks.fetchSipaEvents.mockResolvedValue([sipaEvent(SECRET_A, UPGRADE_HASH)])

    await syncSipaDeposits(deps)

    expect(getCode).not.toHaveBeenCalled()
    expect(store.records.get(SIPA_C)).toMatchObject({ intent: "registration", phase: "claimed" })
    expect(store.records.get(SIPA_UPGRADE)).toBeUndefined()
  })
})
