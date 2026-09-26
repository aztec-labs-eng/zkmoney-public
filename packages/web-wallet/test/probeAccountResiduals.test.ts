import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  reconcile: vi.fn(),
  recordPending: vi.fn(),
  latestChainSeconds: vi.fn(),
  probe: vi.fn(),
  detect: vi.fn(),
  derive: vi.fn(),
  setupSipaDiscovery: vi.fn(),
  fetchSipaEvents: vi.fn(),
  serviceDeps: [] as unknown[],
}))

vi.mock("@obsidion/front-core", () => ({
  PendingPaylinkMigrationService: class {
    reconcile = h.reconcile
    recordPending = h.recordPending
    constructor(deps: unknown) {
      h.serviceDeps.push(deps)
    }
  },
  PendingPaylinkMigrationStore: { get: () => ({}) },
  AppNotificationStore: { get: () => ({}) },
  TransactionStorage: { get: () => ({ getTransactions: async () => [] }) },
  WithdrawalStorage: { get: () => ({ load: async () => {}, list: () => [] }) },
  deriveStealthKey: () => ({ publicKey: "pk" }),
  deriveRefundableSipaSources: h.derive,
  setupSipaDiscovery: h.setupSipaDiscovery,
}))
vi.mock("@obsidion/sdk", () => ({
  IntraRollupMigrationService: { detectHistoricDeployments: h.detect },
  getBroadcasterArtifact: async () => ({}),
  fetchSipaEvents: h.fetchSipaEvents,
  isSipaDepositClaimed: vi.fn(),
}))
vi.mock("../src/config/env", () => ({
  getConfig: () => ({ oxideProfile: {}, network: "sandbox", l1ChainId: 1 }),
}))
vi.mock("../src/config/oxideTuple", () => ({
  l1PublicClient: () => ({ getBlockNumber: async () => 1n, readContract: vi.fn() }),
}))
vi.mock("../src/platform/auth/useAuthenticator", () => ({
  getAuthService: () => ({ getSecretKey: async () => "0x01" }),
}))
vi.mock("../src/platform/storage/WebStorageAdapter", () => ({ webStorage: {} }))
vi.mock("../src/features/paylink/chainTime", () => ({ latestChainSeconds: h.latestChainSeconds }))
vi.mock("../src/features/migration/historicResiduals", () => ({
  probeHistoricResiduals: h.probe,
  countPendingWithdrawals: () => 0,
}))

const { probeAccountResiduals, reconcilePendingPaylinks } = await import(
  "../src/features/migration/probeAccountResiduals"
)

const wallet = { node: {}, pxe: {} } as never
const account = {
  getAddress: () => ({ toString: () => "0xacct" }),
  makeDepositSpendMetadataResolver: async () => async () => ({ masterNullifierHidingKey: 1 }),
} as never
const tuple = { portal: "0xhistoric", l2Token: `0x${"0c".repeat(32)}` }
const current = { portal: "0xcurrent", l2Token: "0xtok2", timestamp: "2026-08-14T10:00:00.000Z" }
const lockedRow = { txHash: "0xRow", untilClaimable: 1_800_000_000 }
const lockedSummary = {
  tuple,
  balance: 0n,
  sweptDeposits: 0,
  inTransitDeposits: 0,
  paylinkEscrows: 0,
  lockedPaylinks: [lockedRow],
  paylinkCandidates: [lockedRow],
  hasResiduals: true,
}

beforeEach(() => {
  vi.clearAllMocks()
  h.reconcile.mockResolvedValue([])
  h.recordPending.mockResolvedValue(undefined)
  h.setupSipaDiscovery.mockResolvedValue({ broadcaster: "0xbroadcaster" })
  h.fetchSipaEvents.mockResolvedValue([])
  h.derive.mockResolvedValue([])
})

describe("probeAccountResiduals — pending paylinks", () => {
  it("never reconciles; with no retired deployments it reads nothing else", async () => {
    h.latestChainSeconds.mockResolvedValue(1234)
    h.detect.mockResolvedValue({ current, historic: [] })
    await expect(probeAccountResiduals(wallet, account)).resolves.toBeNull()
    expect(h.reconcile).not.toHaveBeenCalled()
    expect(h.latestChainSeconds).not.toHaveBeenCalled()
    expect(h.probe).not.toHaveBeenCalled()
    expect(h.recordPending).not.toHaveBeenCalled()
  })

  it("hands a null clock to the probe when the tip is unreadable", async () => {
    h.latestChainSeconds.mockRejectedValue(new Error("node down"))
    h.detect.mockResolvedValue({ current, historic: [tuple] })
    h.probe.mockResolvedValue([lockedSummary])
    const result = await probeAccountResiduals(wallet, account)
    expect(h.probe.mock.calls[0]![0].nowSec).toBeNull()
    expect(result?.residuals).toEqual([lockedSummary])
  })

  it("hands chain time to the probe and records its locked rows without reconciling", async () => {
    h.latestChainSeconds.mockResolvedValue(1_700_000_000)
    h.detect.mockResolvedValue({ current, historic: [tuple] })
    h.probe.mockResolvedValue([lockedSummary])
    await probeAccountResiduals(wallet, account)
    expect(h.probe.mock.calls[0]![0].nowSec).toBe(1_700_000_000)
    expect(h.recordPending).toHaveBeenCalledWith([lockedRow])
    expect(h.reconcile).not.toHaveBeenCalled()
    expect(h.serviceDeps.at(-1)).toMatchObject({ checkSpent: undefined })
  })

  it("reconcilePendingPaylinks reconciles on chain time with the spent check and no probe", async () => {
    h.latestChainSeconds.mockResolvedValue(42)
    const checkSpent = vi.fn()
    await reconcilePendingPaylinks(wallet, checkSpent)
    expect(h.reconcile).toHaveBeenCalledWith(42)
    expect(h.serviceDeps.at(-1)).toMatchObject({ checkSpent })
    expect(h.detect).not.toHaveBeenCalled()
    expect(h.probe).not.toHaveBeenCalled()
  })

  it("reconcilePendingPaylinks skips reconcile when the tip is unreadable", async () => {
    h.latestChainSeconds.mockRejectedValue(new Error("node down"))
    await reconcilePendingPaylinks(wallet, vi.fn())
    expect(h.reconcile).not.toHaveBeenCalled()
  })
})

describe("probeAccountResiduals — historic SIPA derivation", () => {
  it("derives each retired deployment from its own tuple, never from a chain pointer", async () => {
    h.latestChainSeconds.mockResolvedValue(1_700_000_000)
    h.detect.mockResolvedValue({ current, historic: [tuple] })
    h.probe.mockResolvedValue([lockedSummary])
    await probeAccountResiduals(wallet, account)

    h.fetchSipaEvents.mockResolvedValue([
      { sharedSecretSalt: { toString: () => "0x05" }, resweepable: true, intentHash: "0x00" },
    ])
    // The probe hands the discovery seam a per-tuple `sources`; run it as the residual scan would.
    await h.probe.mock.calls[0]![0].sipaDiscovery.sources(tuple)

    // The events are the retired token's own, sent to this account.
    const [, token, recipient] = h.fetchSipaEvents.mock.calls[0]!
    expect(token.toString()).toBe(tuple.l2Token)
    expect(recipient.toString()).toBe("0xacct")
    const args = h.derive.mock.calls[0]![0]
    expect(args.tuple).toBe(tuple)
    expect(args.events).toEqual([{ messageSecret: "0x05", resweepable: true }])
    // The tuple names the generation. The derivation must have no way to reach past it for a live
    // factory read, which could answer for a different portal than these events were selected under.
    expect(args).not.toHaveProperty("readSipaImplementation")
  })
})
