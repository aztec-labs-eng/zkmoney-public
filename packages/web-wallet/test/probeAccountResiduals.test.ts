import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  resolverSender: `0x${"ab".repeat(32)}`,
  reconcile: vi.fn(),
  savingsDeposits: vi.fn(async () => [] as unknown[]),
  recordPending: vi.fn(),
  retire: vi.fn(),
  latestChainSeconds: vi.fn(),
  probe: vi.fn(),
  detect: vi.fn(),
  savingsTuple: vi.fn(),
  derive: vi.fn(),
  setupSipaDiscovery: vi.fn(),
  fetchSipaEvents: vi.fn(),
  frozenSourceSummary: vi.fn(),
  sourceChain: vi.fn(),
  isReadableSource: vi.fn(),
  otherSources: vi.fn(),
  readSipaDepositsConsumed: vi.fn(async (_node: unknown, _scope: unknown, _keys: unknown[]) => [
    false,
  ]),
  sourceFrozenEscrows: vi.fn(),
  sourceLinkRows: vi.fn(async () => [{ link: "row" }]),
  markRefundedSourceLinks: vi.fn(async () => {}),
  importOnce: vi.fn(async () => null),
  settled: vi.fn((_account: string, _source: string) => false),
  recordRead: vi.fn(),
  candidate: vi.fn((_account: string, _source: string): unknown => undefined),
  getBlock: vi.fn(),
  getItem: vi.fn(async (_key: string): Promise<string | null> => null),
  serviceDeps: [] as unknown[],
  storageId: "acct" as string | null,
  onSecretKey: () => {},
  deployment: vi.fn(),
  invalidate: vi.fn(),
  route: vi.fn(),
  config: {} as Record<string, unknown>,
}))

vi.mock("../src/platform/session", () => ({
  session: () => ({ activity: { rows: { get: () => [] } }, notifications: {} }),
}))
vi.mock("@obsidion/front-core", () => ({
  PendingPaylinkMigrationService: class {
    reconcile = h.reconcile
    recordPending = h.recordPending
    retire = h.retire
    constructor(deps: unknown) {
      h.serviceDeps.push(deps)
    }
  },
  PendingPaylinkMigrationStore: { get: () => ({}) },
  bootPriority: { whenReady: async () => {} },
  HISTORIC_ACTIVITY_IMPORTED_KEY: "imported",
  WithdrawalStorage: { get: () => ({ load: async () => {}, list: () => [] }) },
  deriveStealthKey: () => ({ publicKey: { x: 1n, y: 2n } }),
  deriveRefundableSipaSources: h.derive,
  deploymentScanRange: async () => ({ fromBlock: 1n, toBlock: 1n }),
  setupSipaDiscovery: h.setupSipaDiscovery,
  retiredDatabaseOf: (_version: string, db: unknown) => db,
}))
vi.mock("@obsidion/sdk", () => ({
  detectHistoricDeployments: h.detect,
  getBroadcasterArtifact: async () => ({}),
  fetchSipaEvents: h.fetchSipaEvents,
  fetchHistoricalSipaResolverOperators: async () => [{ l2Address: h.resolverSender }],
  resolverSelectionPolicy: () => ({ failOnAmbiguousMatch: true }),
  frozenSourceSummary: h.frozenSourceSummary,
  readSipaDepositsConsumed: h.readSipaDepositsConsumed,
  migrationRouteFor: h.route,
}))
vi.mock("../src/config/env", () => ({ getConfig: () => h.config }))
vi.mock("../src/config/oxideTuple", () => ({
  l1MulticallClient: () => ({
    getBlockNumber: async () => 1n,
    getBlock: h.getBlock,
    readContract: vi.fn(),
  }),
  getOtherManifestSources: h.otherSources,
  getOxideDeployment: h.deployment,
  invalidateOxideDeployment: h.invalidate,
}))
vi.mock("../src/features/savings/savingsGateway", () => ({
  getSavingsTuple: h.savingsTuple,
}))
vi.mock("../src/platform/auth/useAuthenticator", () => ({
  getAuthService: () => ({
    getSecretKey: async () => {
      h.onSecretKey()
      return "0x01"
    },
  }),
}))
vi.mock("../src/platform/storage/WebStorageAdapter", () => ({
  webStorage: { getItem: h.getItem },
}))
vi.mock("../src/features/migration/upgradeLock", () => ({
  retiredSourceSettled: h.settled,
  recordRetiredSourceRead: h.recordRead,
  retiredSourceCandidate: h.candidate,
}))
vi.mock("../src/features/migration/sourceSavingsDeposits", () => ({
  sourceSavingsDeposits: h.savingsDeposits,
}))
vi.mock("../src/platform/storage/activeStorage", () => ({ getActiveStorageId: () => h.storageId }))
vi.mock("../src/features/migration/historicTokenContext", () => ({
  sourceChain: h.sourceChain,
  isReadableSource: h.isReadableSource,
}))
vi.mock("../src/features/paylink/chainTime", () => ({ latestChainSeconds: h.latestChainSeconds }))
vi.mock("../src/features/token/oxideToken", () => ({ portalDomain: async () => ({}) }))
vi.mock("../src/features/migration/sourceFrozenEscrows", () => ({
  sourceFrozenEscrows: h.sourceFrozenEscrows,
  sourceLinkRows: h.sourceLinkRows,
  markRefundedSourceLinks: h.markRefundedSourceLinks,
}))
vi.mock("../src/features/migration/historicActivityImport", () => ({
  importHistoricActivityOnce: h.importOnce,
}))
vi.mock("../src/features/migration/historicResiduals", async (original) => ({
  ...(await original<typeof import("../src/features/migration/historicResiduals")>()),
  probeHistoricResiduals: h.probe,
  countPendingWithdrawals: () => 0,
}))

const { migrationFeatureListed, probeAccountResiduals, reconcilePendingPaylinks } = await import(
  "../src/features/migration/probeAccountResiduals"
)
const { ManifestUnavailableError } = await import("../src/features/migration/freezeWatch")

const wallet = { node: {}, pxe: {} } as never
const account = {
  getAddress: () => ({ toString: () => "0xacct" }),
  makeDepositSpendMetadataResolver: async () => async () => ({ masterNullifierHidingKey: 1 }),
} as never
const tuple = {
  portal: "0xhistoric",
  l2Token: `0x${"0c".repeat(32)}`,
  accountMetadataRegistry: "registry",
  depositSIPAImplementation: "0xdef",
  forwardingTable: "table",
}
const current = { portal: "0xcurrent", l2Token: "0xtok2", timestamp: "2026-08-14T10:00:00.000Z" }
const lockedRow = { txHash: "0xRow", untilClaimable: 1_800_000_000 }
const lockedSummary = {
  tuple,
  balance: 0n,
  sweptDeposits: 0,
  inTransitDeposits: 0,
  waitingDeposits: 0,
  paylinkEscrows: 0,
  lockedPaylinks: [lockedRow],
  paylinkCandidates: [lockedRow],
  frozenLinks: [],
  hasResiduals: true,
}

beforeEach(() => {
  vi.clearAllMocks()
  h.config = { oxideProfile: {}, network: "sandbox", l1ChainId: 1, assets: [] }
  h.reconcile.mockResolvedValue([])
  h.recordPending.mockResolvedValue(undefined)
  h.setupSipaDiscovery.mockResolvedValue({ broadcaster: "0xbroadcaster" })
  h.fetchSipaEvents.mockResolvedValue([])
  h.derive.mockResolvedValue([])
  h.sourceChain.mockImplementation(async (active) => ({ kind: "pxe", ...active }))
  h.isReadableSource.mockResolvedValue(true)
  h.otherSources.mockResolvedValue([])
  h.savingsTuple.mockResolvedValue(undefined)
  h.deployment.mockResolvedValue({ deployment: { features: [], bridges: [] } })
  h.route.mockReturnValue(undefined)
  h.settled.mockReturnValue(false)
  h.getItem.mockResolvedValue(null)
  h.candidate.mockReturnValue(undefined)
  h.getBlock.mockImplementation(async (args: { blockTag?: string; blockNumber?: bigint }) =>
    args.blockTag === "finalized"
      ? { number: 6n, hash: "0xfinal" }
      : args.blockNumber !== undefined
      ? { number: args.blockNumber, hash: "0xcandidate" }
      : { number: 9n, hash: "0xtip" },
  )
})

describe("probeAccountResiduals — frozen sources", () => {
  it("includes the deposits of Savings moves in the frozen source check", async () => {
    h.latestChainSeconds.mockResolvedValue(1234)
    h.detect.mockResolvedValue({ current, historic: [tuple], destinations: new Map() })
    h.probe.mockResolvedValue([])
    const deposit = { messageKey: "sky-deposit", amount: "40000000000000000000" }
    h.savingsDeposits.mockResolvedValueOnce([deposit])
    h.frozenSourceSummary.mockImplementationOnce(async ({ depositDescriptors }) => ({
      notes: 0n,
      deposits: (await depositDescriptors()).length,
    }))
    await probeAccountResiduals(wallet, account)
    await expect(h.probe.mock.calls[0]![0].frozenSource(tuple, async () => [])).resolves.toEqual({
      notes: 0n,
      deposits: 1,
    })
  })

  it.each([
    ["an incomplete scan, so an empty result never reads as drained", { incomplete: true }],
    ["a scan whose only finding is an unverified Savings move", { unverifiedMoves: 1 }],
  ])("keeps %s", async (_case, over) => {
    h.latestChainSeconds.mockResolvedValue(1234)
    h.detect.mockResolvedValue({ current, historic: [tuple], destinations: new Map() })
    const summary = {
      ...lockedSummary,
      lockedPaylinks: [],
      paylinkCandidates: [],
      incomplete: false,
      hasResiduals: false,
      ...over,
    }
    h.probe.mockResolvedValue([summary])
    const result = await probeAccountResiduals(wallet, account)
    expect(result?.residuals).toEqual([summary])
  })

  it("reads a frozen source's refundable notes, deposits and links through the account", async () => {
    h.latestChainSeconds.mockResolvedValue(1234)
    h.detect.mockResolvedValue({ current, historic: [tuple], destinations: new Map() })
    h.probe.mockResolvedValue([])
    h.frozenSourceSummary.mockResolvedValue({ notes: 9n, deposits: 1 })
    await probeAccountResiduals(wallet, account)
    const depositDescriptors = async () => []
    await expect(
      h.probe.mock.calls[0]![0].frozenSource(tuple, depositDescriptors),
    ).resolves.toEqual({ notes: 9n, deposits: 1 })
    expect(h.frozenSourceSummary).toHaveBeenCalledWith(
      expect.objectContaining({ wallet, account, tuple, depositDescriptors: expect.any(Function) }),
    )
    await h.frozenSourceSummary.mock.calls[0]![0].escrows()
    expect(h.sourceLinkRows).toHaveBeenCalledWith({ tuple, current, storageId: "acct" })
    expect(h.sourceFrozenEscrows).toHaveBeenCalledWith({
      chain: { kind: "pxe", wallet, account },
      tuple,
      masterSecret: "0x01",
      rows: [{ link: "row" }],
    })
  })

  it("skips a probe whose account changed while it read the manifest", async () => {
    h.latestChainSeconds.mockResolvedValue(1234)
    h.detect.mockImplementation(async () => {
      h.storageId = "other"
      return { current, historic: [tuple], destinations: new Map() }
    })
    try {
      expect(await probeAccountResiduals(wallet, account)).toBeNull()
      expect(h.probe).not.toHaveBeenCalled()
    } finally {
      h.detect.mockReset()
      h.storageId = "acct"
    }
  })

  it("skips a probe whose account changed while its key was read", async () => {
    h.latestChainSeconds.mockResolvedValue(1234)
    h.detect.mockResolvedValue({ current, historic: [tuple], destinations: new Map() })
    h.onSecretKey = () => {
      h.storageId = "other"
    }
    try {
      expect(await probeAccountResiduals(wallet, account)).toBeNull()
      expect(h.probe).not.toHaveBeenCalled()
    } finally {
      h.onSecretKey = () => {}
      h.storageId = "acct"
    }
  })

  it("writes nothing when the account changes during the scan", async () => {
    h.latestChainSeconds.mockResolvedValue(1234)
    h.detect.mockResolvedValue({ current, historic: [tuple], destinations: new Map() })
    h.probe.mockImplementation(async () => {
      h.storageId = "other"
      return [{ tuple, frozenLinks: [{ txHash: "0xa" }], paylinkCandidates: [{ txHash: "0xb" }] }]
    })
    try {
      expect(await probeAccountResiduals(wallet, account)).toBeNull()
      expect(h.recordPending).not.toHaveBeenCalled()
      expect(h.retire).not.toHaveBeenCalled()
    } finally {
      h.probe.mockReset()
      h.storageId = "acct"
    }
  })

  it("skips the probe without an active account, whose link rows it could not read", async () => {
    h.detect.mockResolvedValue({ current, historic: [tuple], destinations: new Map() })
    h.storageId = null
    try {
      expect(await probeAccountResiduals(wallet, account)).toBeNull()
      expect(h.probe).not.toHaveBeenCalled()
    } finally {
      h.storageId = "acct"
    }
  })

  it("retires the pending reclaims of frozen sources' links", async () => {
    h.latestChainSeconds.mockResolvedValue(1234)
    h.detect.mockResolvedValue({ current, historic: [tuple], destinations: new Map() })
    const summary = (frozenLinks: { txHash?: string }[]) => ({
      tuple,
      frozenLinks,
      paylinkCandidates: [],
      hasResiduals: false,
      incomplete: false,
    })
    h.probe.mockResolvedValue([summary([{ txHash: "0xa" }, {}]), summary([{ txHash: "0xb" }])])
    await probeAccountResiduals(wallet, account)
    expect(h.retire).toHaveBeenCalledWith(["0xa", "0xb"])
  })

  it("keeps the reclaim of a legacy link a live source also claims", async () => {
    h.latestChainSeconds.mockResolvedValue(1234)
    h.detect.mockResolvedValue({ current, historic: [tuple], destinations: new Map() })
    const legacy = { txHash: "0xa" }
    h.probe.mockResolvedValue([
      { tuple, frozenLinks: [legacy, { txHash: "0xb" }], paylinkCandidates: [] },
      { tuple, frozenLinks: [], paylinkCandidates: [legacy] },
    ])
    await probeAccountResiduals(wallet, account)
    expect(h.recordPending).toHaveBeenCalledWith([legacy])
    expect(h.retire).toHaveBeenCalledWith(["0xb"])
  })

  it("reads deposits on another rollup through that rollup's wallet", async () => {
    const source = { wallet: { node: {}, pxe: {} }, account }
    h.sourceChain.mockResolvedValue({ kind: "pxe", ...source })
    h.latestChainSeconds.mockResolvedValue(1234)
    h.detect.mockResolvedValue({ current, historic: [tuple], destinations: new Map() })
    h.probe.mockResolvedValue([])
    await probeAccountResiduals(wallet, account)
    const { sipaDiscovery } = h.probe.mock.calls[0]![0]
    await sipaDiscovery.sources(tuple)
    expect(h.setupSipaDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({ pxe: source.wallet.pxe, node: source.wallet.node }),
    )
    expect(h.fetchSipaEvents.mock.calls[0]![0]).toBe(source.wallet)
    const deposit = { messageKey: "0x" + "05".repeat(32), amount: 1n, messageLeafIndex: 0n }
    await sipaDiscovery.consumed({ ...tuple, rollupVersion: "2" }, [deposit])
    expect(h.readSipaDepositsConsumed.mock.calls[0]![0]).toBe(source.wallet.node)
    expect(h.readSipaDepositsConsumed.mock.calls[0]![2]).toEqual([deposit.messageKey])
  })
})

describe("probeAccountResiduals — another Aztec generation", () => {
  const session = {
    address: "0xv5acct",
    frozenSummary: vi.fn(),
    sipaSources: vi.fn(),
  }

  beforeEach(() => {
    h.latestChainSeconds.mockResolvedValue(1234)
    h.probe.mockResolvedValue([])
    h.sourceChain.mockResolvedValue({ kind: "generation", session })
  })

  it("finds the Savings migration destination without profile assets", async () => {
    const savings = { ...current, portal: "0xsavings" }
    h.savingsTuple.mockResolvedValue(savings)
    const v5 = { ...tuple, portal: "0xv5susds" }
    h.detect.mockResolvedValue({
      current,
      historic: [],
      destinations: new Map([["0xv5susds", savings]]),
    })
    const found = await probeAccountResiduals(wallet, account)
    expect(h.detect.mock.calls[0]![0].products).toEqual([savings])
    expect(found!.destinations.get(v5.portal)).toEqual({ tuple: savings, symbol: "sUSDS" })
  })

  it("detects the deployments another generation's manifest publishes", async () => {
    const other = { ...tuple, portal: "0xv5portal" }
    h.otherSources.mockResolvedValue([other])
    h.detect.mockResolvedValue({ current, historic: [], destinations: new Map() })
    await probeAccountResiduals(wallet, account)
    expect(h.detect.mock.calls[0]![0].otherSources).toEqual([other])
  })

  it("fails, rather than reads no history, when another generation's manifest can't be read", async () => {
    h.otherSources.mockRejectedValue(new Error("timed out"))
    await expect(probeAccountResiduals(wallet, account)).rejects.toBeInstanceOf(
      ManifestUnavailableError,
    )
    expect(h.detect).not.toHaveBeenCalled()
  })

  it("fails, rather than reads no history, when boot could not read a previous generation's profile", async () => {
    // Boot leaves the unread generation out of the config's source rollups, so another
    // generation's manifests resolve to none, as they do for an account with no history.
    h.config = {
      ...h.config,
      sourceRollupIssues: [
        {
          profileUrl: "https://config.example/profiles/v5/0.44.0.json",
          code: "UNREACHABLE",
          message: "profile fetch failed: no complete response within 15000ms",
        },
      ],
    }
    await expect(probeAccountResiduals(wallet, account)).rejects.toBeInstanceOf(
      ManifestUnavailableError,
    )
    expect(h.detect).not.toHaveBeenCalled()
  })

  it("reports a live source of another generation as awaiting its freeze, with its balance", async () => {
    h.detect.mockResolvedValue({ current, historic: [tuple], destinations: new Map() })
    h.isReadableSource.mockResolvedValue(false)
    const balance = vi.fn(async () => "7")
    h.sourceChain.mockResolvedValue({ kind: "generation", session: { ...session, balance } })
    const found = await probeAccountResiduals(wallet, account)
    expect(found).toMatchObject({ historic: [] })
    expect(found?.residuals).toEqual([
      expect.objectContaining({ tuple, balance: 7n, awaitingFreeze: true, frozen: false }),
    ])
    expect(balance).toHaveBeenCalledWith({ tuple })
  })

  it("keeps a live source whose balance cannot be read, as incomplete", async () => {
    h.detect.mockResolvedValue({ current, historic: [tuple], destinations: new Map() })
    h.isReadableSource.mockResolvedValue(false)
    const balance = vi.fn(async () => {
      throw new Error("node down")
    })
    h.sourceChain.mockResolvedValue({ kind: "generation", session: { ...session, balance } })
    const found = await probeAccountResiduals(wallet, account)
    expect(found?.residuals).toEqual([
      expect.objectContaining({ balance: 0n, awaitingFreeze: true, incomplete: true }),
    ])
  })

  describe("a frozen source of another generation", () => {
    const frozen = { ...lockedSummary, frozen: true, balance: 5n, incomplete: false }
    beforeEach(() => {
      h.detect.mockResolvedValue({ current, historic: [tuple], destinations: new Map() })
      h.sourceChain.mockResolvedValue({ kind: "generation", session })
      h.probe.mockResolvedValue([frozen])
    })

    it("waits for its destination's migration feature while the manifest lists none", async () => {
      const found = await probeAccountResiduals(wallet, account)
      expect(found?.residuals).toEqual([expect.objectContaining({ awaitingFeature: true })])
      expect(h.route).toHaveBeenCalledWith(
        { features: [], bridges: [] },
        tuple.portal,
        current.portal,
        undefined,
      )
    })

    it("waits too when the feature it finds is unusable", async () => {
      h.route.mockImplementation(() => {
        throw new Error("More than one migration feature serves the portal")
      })
      const found = await probeAccountResiduals(wallet, account)
      expect(found?.residuals).toEqual([expect.objectContaining({ awaitingFeature: true })])
    })

    it("is ready once the manifest lists a usable feature", async () => {
      h.route.mockReturnValue({ executor: "0xexec" })
      const found = await probeAccountResiduals(wallet, account)
      expect(found?.residuals[0]?.awaitingFeature).toBeUndefined()
    })

    it("waits on a frozen source read through this generation's PXE too", async () => {
      h.sourceChain.mockImplementation(async (active) => ({ kind: "pxe", ...active }))
      const found = await probeAccountResiduals(wallet, account)
      expect(found?.residuals).toEqual([expect.objectContaining({ awaitingFeature: true })])
      h.route.mockReturnValue({ executor: "0xexec" })
      const ready = await probeAccountResiduals(wallet, account)
      expect(ready?.residuals[0]?.awaitingFeature).toBeUndefined()
    })

    it("fails, rather than reads a source as waiting, when the manifest can't be read", async () => {
      h.deployment.mockRejectedValue(new Error("fetch failed"))
      await expect(probeAccountResiduals(wallet, account)).rejects.toBeInstanceOf(
        ManifestUnavailableError,
      )
      expect(h.recordPending).not.toHaveBeenCalled()
    })
  })

  it("reads a frozen source's refundable funds through the generation's session", async () => {
    h.detect.mockResolvedValue({ current, historic: [tuple], destinations: new Map() })
    session.frozenSummary.mockResolvedValue({
      notes: "9",
      links: "5",
      deposits: 1,
      waiting: 2,
      waitingAmount: "7",
    })
    await probeAccountResiduals(wallet, account)
    const depositDescriptors = async () => []
    await expect(
      h.probe.mock.calls[0]![0].frozenSource(tuple, depositDescriptors),
    ).resolves.toEqual({ notes: 9n, links: 5n, deposits: 1, waiting: 2, waitingAmount: 7n })
    expect(session.frozenSummary).toHaveBeenCalledWith({
      tuple,
      depositDescriptors: expect.any(Function),
      paylinkRows: expect.any(Function),
    })
    // The account's link rows, read for the account the probe started with.
    await expect(session.frozenSummary.mock.calls[0]![0].paylinkRows()).resolves.toEqual([
      { link: "row" },
    ])
    expect(h.sourceLinkRows).toHaveBeenCalledWith({ tuple, current, storageId: "acct" })
    expect(h.frozenSourceSummary).not.toHaveBeenCalled()
  })

  it("checks a frozen source's links for L1 refunds once both imports are in", async () => {
    h.detect.mockResolvedValue({ current, historic: [tuple], destinations: new Map() })
    const order: string[] = []
    h.importOnce.mockImplementation(async (from?: unknown) => {
      order.push(from ? "replay" : "browser")
      return null
    })
    h.markRefundedSourceLinks.mockImplementation(async () => {
      order.push("mark")
    })
    await probeAccountResiduals(wallet, account)
    await vi.waitFor(() => expect(h.markRefundedSourceLinks).toHaveBeenCalled())
    expect(h.markRefundedSourceLinks).toHaveBeenCalledWith({
      session,
      tuple,
      current,
      storageId: "acct",
    })
    expect(order).toEqual(["replay", "browser", "mark"])
  })

  it("still checks the links when the history replay fails", async () => {
    h.detect.mockResolvedValue({ current, historic: [tuple], destinations: new Map() })
    h.importOnce.mockImplementation(async (from?: unknown) => {
      if (from) throw new Error("short read")
      return null
    })
    await probeAccountResiduals(wallet, account)
    await vi.waitFor(() => expect(h.markRefundedSourceLinks).toHaveBeenCalled())
  })

  describe("a source on another rollup", () => {
    const v5 = { ...tuple, rollupVersion: "5" }
    const empty = {
      ...lockedSummary,
      tuple: v5,
      frozen: true,
      lockedPaylinks: [],
      paylinkCandidates: [],
      incomplete: false,
      hasResiduals: false,
    }
    const replayKey = `imported/0xv5rollup/${v5.l2Token}`
    beforeEach(() => {
      h.importOnce.mockImplementation(async () => null)
      h.detect.mockResolvedValue({ current, historic: [v5], destinations: new Map() })
      h.sourceChain.mockResolvedValue({
        kind: "generation",
        session: { ...session, rollupAddress: "0xv5rollup" },
      })
    })

    it("is not read once settled, so nothing of its rollup loads", async () => {
      h.settled.mockReturnValue(true)
      const found = await probeAccountResiduals(wallet, account)
      expect(h.settled).toHaveBeenCalledWith("0xacct", v5.portal)
      expect(h.isReadableSource).not.toHaveBeenCalled()
      expect(h.sourceChain).not.toHaveBeenCalled()
      expect(h.probe).not.toHaveBeenCalled()
      expect(found).toMatchObject({ historic: [], residuals: [] })
    })

    it("is read on this rollup whatever its marker says", async () => {
      h.settled.mockReturnValue(true)
      h.detect.mockResolvedValue({ current, historic: [tuple], destinations: new Map() })
      await probeAccountResiduals(wallet, account)
      expect(h.settled).not.toHaveBeenCalled()
      expect(h.probe.mock.calls[0]![0].historic).toEqual([tuple])
    })

    it("settles once a complete read finds it frozen and empty, with its history in", async () => {
      h.probe.mockResolvedValue([empty])
      h.getItem.mockImplementation(async (key) =>
        key === replayKey || key === "imported" ? "{}" : null,
      )
      await probeAccountResiduals(wallet, account)
      await vi.waitFor(() =>
        expect(h.recordRead).toHaveBeenCalledWith("0xacct", v5.portal, {
          empty: true,
          tip: { number: 9n, hash: "0xtip" },
          priorFinal: false,
        }),
      )
    })

    it.each([
      ["final and still on chain", { number: 5n, hash: "0xcandidate" }, true],
      ["dropped by a reorg", { number: 5n, hash: "0xreorged" }, false],
      ["not final yet", { number: 7n, hash: "0xcandidate" }, false],
    ])(
      "settles on an empty read only when the earlier read's block is %s",
      async (_case, candidate, priorFinal) => {
        h.probe.mockResolvedValue([empty])
        h.candidate.mockReturnValue(candidate)
        h.getItem.mockResolvedValue("{}")
        await probeAccountResiduals(wallet, account)
        await vi.waitFor(() =>
          expect(h.recordRead).toHaveBeenCalledWith("0xacct", v5.portal, {
            empty: true,
            tip: { number: 9n, hash: "0xtip" },
            priorFinal,
          }),
        )
      },
    )

    it("takes the tip that closes the read after the source's pass, not before its reads", async () => {
      const order: string[] = []
      h.probe.mockResolvedValue([empty])
      h.getItem.mockResolvedValue("{}")
      h.markRefundedSourceLinks.mockImplementation(async () => void order.push("links"))
      const read = h.getBlock.getMockImplementation()!
      h.getBlock.mockImplementation(async (args) => {
        if (args.blockTag === "latest") order.push("tip")
        return read(args)
      })
      await probeAccountResiduals(wallet, account)
      await vi.waitFor(() => expect(h.recordRead).toHaveBeenCalled())
      expect(order).toEqual(["links", "tip"])
    })

    it("does not settle while this browser's databases are not imported", async () => {
      h.probe.mockResolvedValue([empty])
      h.getItem.mockImplementation(async (key) => (key === replayKey ? "{}" : null))
      await probeAccountResiduals(wallet, account)
      await vi.waitFor(() => expect(h.getItem).toHaveBeenCalledWith("imported"))
      await new Promise((resolve) => setTimeout(resolve))
      expect(h.recordRead).not.toHaveBeenCalled()
    })

    it("rebuilds its history with every source of its rollup, a settled one too", async () => {
      const savings = { ...current, portal: "0xsavings" }
      const v5Savings = { ...v5, portal: "0xv5susds", l2Token: `0x${"0d".repeat(32)}` }
      h.savingsTuple.mockResolvedValue(savings)
      h.detect.mockResolvedValue({
        current,
        historic: [v5, v5Savings],
        destinations: new Map([["0xv5susds", savings]]),
      })
      h.settled.mockImplementation((_account, source) => source === v5Savings.portal)
      const history = vi.fn(async (_scan: { deployments: unknown[] }) => ({}))
      h.sourceChain.mockResolvedValue({
        kind: "generation",
        session: { ...session, rollupAddress: "0xv5rollup", history },
      })
      h.importOnce.mockImplementation(async (from?: { read(): Promise<unknown> }) => {
        await from?.read()
        return null
      })
      await probeAccountResiduals(wallet, account)
      await vi.waitFor(() => expect(history).toHaveBeenCalled())
      expect(history.mock.calls[0]![0]).toMatchObject({ deployments: [v5, v5Savings] })
    })

    it("does not settle while its history replay is missing", async () => {
      h.probe.mockResolvedValue([empty])
      await probeAccountResiduals(wallet, account)
      await vi.waitFor(() => expect(h.getItem).toHaveBeenCalledWith(replayKey))
      await new Promise((resolve) => setTimeout(resolve))
      expect(h.recordRead).not.toHaveBeenCalled()
    })

    it.each([
      ["an incomplete read", { incomplete: true }],
      ["a live portal", { frozen: false }],
    ])("records nothing after %s", async (_case, over) => {
      h.probe.mockResolvedValue([{ ...empty, ...over }])
      h.getItem.mockResolvedValue("{}")
      await probeAccountResiduals(wallet, account)
      await vi.waitFor(() => expect(h.markRefundedSourceLinks).toHaveBeenCalled())
      await new Promise((resolve) => setTimeout(resolve))
      expect(h.recordRead).not.toHaveBeenCalled()
    })

    it.each([
      ["funds left", { balance: 1n, hasResiduals: true }],
      ["an unverified Savings move", { unverifiedMoves: 1 }],
    ])("starts its settling over after %s", async (_case, over) => {
      h.probe.mockResolvedValue([{ ...empty, ...over }])
      h.getItem.mockResolvedValue("{}")
      await probeAccountResiduals(wallet, account)
      expect(h.recordRead).toHaveBeenCalledWith("0xacct", v5.portal, { empty: false })
      expect(h.recordRead).toHaveBeenCalledTimes(1)
    })
  })

  it("takes the source's SIPAs from the generation, which derives them by its own rules", async () => {
    h.detect.mockResolvedValue({ current, historic: [tuple], destinations: new Map() })
    const source = { sipaAddress: "0xsipa", recipientL2Address: "0xv5acct", messageSecret: "0x05" }
    session.sipaSources.mockResolvedValue([source])
    await probeAccountResiduals(wallet, account)
    await expect(h.probe.mock.calls[0]![0].sipaDiscovery.sources(tuple)).resolves.toEqual([
      { ...source, origin: "sipa-event" },
    ])
    expect(session.sipaSources).toHaveBeenCalledWith(
      expect.objectContaining({
        tuple,
        resolverL2Addresses: [h.resolverSender],
        stealthPublicKey: { x: "1", y: "2" },
      }),
    )
    expect(h.setupSipaDiscovery).not.toHaveBeenCalled()
    expect(h.derive).not.toHaveBeenCalled()
  })
})

describe("probeAccountResiduals — pending paylinks", () => {
  it("retains the current deployment for metadata-only detection without probing absent sources", async () => {
    h.latestChainSeconds.mockResolvedValue(1234)
    h.detect.mockResolvedValue({ current, historic: [], destinations: new Map() })
    await expect(probeAccountResiduals(wallet, account)).resolves.toEqual({
      current,
      historic: [],
      destinations: new Map(),
      residuals: [],
      pendingWithdrawals: 0,
      chainTimeUnknown: false,
    })
    expect(h.reconcile).not.toHaveBeenCalled()
    expect(h.latestChainSeconds).not.toHaveBeenCalled()
    expect(h.probe).not.toHaveBeenCalled()
    expect(h.recordPending).not.toHaveBeenCalled()
  })

  it("hands a null clock to the probe when the tip is unreadable", async () => {
    h.latestChainSeconds.mockRejectedValue(new Error("node down"))
    h.detect.mockResolvedValue({ current, historic: [tuple], destinations: new Map() })
    h.probe.mockResolvedValue([lockedSummary])
    const result = await probeAccountResiduals(wallet, account)
    expect(h.probe.mock.calls[0]![0].nowSec).toBeNull()
    expect(result?.chainTimeUnknown).toBe(true)
    expect(result?.residuals).toEqual([lockedSummary])
  })

  it("hands chain time to the probe and records its locked rows without reconciling", async () => {
    h.latestChainSeconds.mockResolvedValue(1_700_000_000)
    h.detect.mockResolvedValue({ current, historic: [tuple], destinations: new Map() })
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
    h.detect.mockResolvedValue({ current, historic: [tuple], destinations: new Map() })
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
    expect(args.events).toEqual([{ messageSecret: "0x05", resweepable: true, intentHash: "0x00" }])
    // The tuple names the generation. The derivation must have no way to reach past it for a live
    // factory read, which could answer for a different portal than these events were selected under.
    expect(args).not.toHaveProperty("readSipaImplementation")
  })

  it("registers the deployment's ClaimFPC, which tags the broadcasts it sponsored", async () => {
    const fpc = `0x${"0f".repeat(32)}`
    h.latestChainSeconds.mockResolvedValue(1234)
    h.detect.mockResolvedValue({
      current,
      historic: [{ ...tuple, fpcBeneficiary: fpc }],
      destinations: new Map(),
    })
    h.probe.mockResolvedValue([])
    await probeAccountResiduals(wallet, account)
    await h.probe.mock.calls[0]![0].sipaDiscovery.sources({ ...tuple, fpcBeneficiary: fpc })
    expect(h.setupSipaDiscovery.mock.calls[0]![0].sponsorFpc.toString()).toBe(fpc)
  })
})

describe("migrationFeatureListed", () => {
  const source = { ...tuple, portal: "0xv5portal" } as never
  const destination = { ...current, operationExecutor: "0xexec" } as never

  it("reads the manifest again, and only it, for a route of a waiting source", async () => {
    h.deployment.mockResolvedValue({ deployment: { features: [], bridges: [] } })
    h.route.mockReturnValue(undefined)
    expect(await migrationFeatureListed([{ source, destination }])).toBe(false)
    expect(h.invalidate).toHaveBeenCalledTimes(1)
    expect(h.route).toHaveBeenCalledWith(
      { features: [], bridges: [] },
      "0xv5portal",
      "0xcurrent",
      "0xexec",
    )
    h.route.mockReturnValue({ executor: "0xexec" })
    expect(await migrationFeatureListed([{ source, destination }])).toBe(true)
    expect(h.probe).not.toHaveBeenCalled()
  })

  it("throws when the manifest can't be read", async () => {
    h.deployment.mockRejectedValue(new Error("fetch failed"))
    await expect(migrationFeatureListed([{ source, destination }])).rejects.toThrow("fetch failed")
  })
})
