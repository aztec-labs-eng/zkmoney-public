// @vitest-environment node
/**
 * The migration spends on a retired deployment, so its sponsor leg must name that deployment. A
 * leg built against the live deployment selects the live ClaimFPC, whose gate reads a registry
 * that holds nothing for the historic account. The tab runs the exit half only: it publishes the
 * arrival, then burns through the shared `runBurn`, and the burn lands on a withdrawal record,
 * stamped at submit, with nothing after it waiting here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { WithdrawalStorage } from "@obsidion/front-core"
import { ProvingStage, provingProgress } from "@obsidion/proving-progress"

const h = vi.hoisted(() => ({
  broadcastResolvedSipa: vi.fn(async () => {}),
  publish: vi.fn(async () => {}),
  claimSponsorContext: vi.fn(),
  historicTokenContext: vi.fn(),
  fetchSipaResolverOperators: vi.fn(),
  selectManifestResolverOperator: vi.fn(),
  prepareExit: vi.fn(),
  burn: vi.fn(),
  migrate: vi.fn(),
  settle: vi.fn(),
  migrationDeps: vi.fn(),
  leaveToChain: vi.fn(),
  fee: vi.fn(),
}))

vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  fetchSipaResolverOperators: h.fetchSipaResolverOperators,
  selectManifestResolverOperator: h.selectManifestResolverOperator,
  resolverSelectionPolicy: () => ({}),
  SipaSelfResolver: class {},
  IntraRollupMigrationService: class {
    constructor(deps: unknown) {
      h.migrationDeps(deps)
    }
    prepareExit = h.prepareExit
    burn = h.burn
    migrate = h.migrate
    settle = h.settle
  },
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  deriveStealthKey: () => ({ scalar: 1n }),
  deriveBootstrapKey: () => ({ address: "0x" + "11".repeat(20) }),
}))
vi.mock("../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/env")>()),
  getConfig: () => ({ network: "sandbox", l1ChainId: 31337 }),
}))
vi.mock("../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/oxideTuple")>()),
  // No withdrawal wiring: `runBurn` arms no tracker, which has its own tests.
  getOxideTuple: async () => ({ portal: "0xportal" }),
  l1PublicClient: () => ({
    readContract: async () => "0x" + "22".repeat(20),
    getBlockNumber: async () => 1_000n,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
      timestamp: BigInt(blockNumber) * 12n,
    }),
  }),
}))
vi.mock("../src/platform/auth/useAuthenticator", () => ({
  getAuthService: () => ({ getSecretKey: async () => "0xmsk" }),
}))
vi.mock("../src/features/migration/historicTokenContext", () => ({
  historicTokenContext: h.historicTokenContext,
}))
vi.mock("../src/features/onboarding/claimSponsorship", () => ({
  claimSponsorContext: h.claimSponsorContext,
}))
vi.mock("../src/features/deposit/sipaGateway", () => ({
  getSipaDepositGateway: () => ({ broadcastResolvedSipa: h.broadcastResolvedSipa }),
}))
vi.mock("../src/features/migration/migrationFee", () => ({ loadMigrationFee: h.fee }))
vi.mock("../src/features/migration/migrationArrival", () => ({
  publishMigrationArrival: h.publish,
}))
// The operation record has its own tests; here it only has to run the flow.
vi.mock("../src/features/operations/operations", async (importOriginal) => ({
  isFlowCancelled: (await importOriginal<typeof import("../src/features/operations/operations")>())
    .isFlowCancelled,
  runOperation: (input: { operationId: string }, run: (op: unknown) => Promise<unknown>) =>
    run({ operationId: input.operationId, leaveToChain: h.leaveToChain, describe() {} }),
}))

const memory = new Map<string, string>()
const store = WithdrawalStorage.get({
  getItem: async (k: string) => memory.get(k) ?? null,
  setItem: async (k: string, v: string) => void memory.set(k, v),
  removeItem: async (k: string) => void memory.delete(k),
  clear: async () => memory.clear(),
} as never)
vi.mock("../src/features/withdraw/withdrawGateway", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/withdraw/withdrawGateway")>()),
  currentDeployment: async (t: { portal: string }) => ({ portal: t.portal }),
}))

import { runIntraRollupMigration } from "../src/features/migration/runIntraRollupMigration"
import { RAIL_REGISTERED } from "../src/features/onboarding/rails"

const tuple = (version: string, l2Token: string) => ({
  version,
  l2Token,
  deployedAt: new Date(900 * 12 * 1000).toISOString(),
  portal: `0xportal${version}`,
  accountMetadataRegistry: "0xamr",
  pool: "0xpool",
  sipaFactory: "0xfactory",
  accountFactory: "0x" + "33".repeat(20),
  resolverGatewayUrl: "https://resolver.test",
  rollupVersion: "7",
})
const HISTORIC = tuple("v6", `0x${"01".repeat(32)}`)
const CURRENT = tuple("v7", `0x${"02".repeat(32)}`)

const SIPA = `0x${"5a".repeat(20)}`
const BURN = `0x${"b0".repeat(32)}`
const account = {
  makeSpendMetadataResolver: async () => vi.fn(),
  makeDepositSpendMetadataResolver: async () => vi.fn(),
}
const run = (current = CURRENT) =>
  runIntraRollupMigration({
    wallet: { node: { getTxReceipt: async () => ({ status: "pending" }) } },
    account,
    contractService: {},
    toTokenService: { fetchTokenInformation: async () => ({ symbol: "DAI" }) },
    historic: HISTORIC,
    current,
    summary: "$85.00 to the new version",
  } as never)
const MINED = { burnTxHash: BURN, burnBlockNumber: 7, grossAmount: 85n * 10n ** 18n }

describe("runIntraRollupMigration", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await store.clearAll()
    h.historicTokenContext.mockResolvedValue({
      tokenService: { getBalance: async () => 85n * 10n ** 18n },
      teeSigner: {},
    })
    h.fetchSipaResolverOperators.mockResolvedValue([])
    h.selectManifestResolverOperator.mockReturnValue({ resolverPublicKey: "0xpub" })
    h.claimSponsorContext.mockResolvedValue({ fpcAddress: {} })
    h.fee.mockResolvedValue({ relayerTip: "1", fpcFundingCut: "2", arrivalFee: "3" })
    // As the sdk does: the caller's publish runs before `prepareExit` returns.
    h.prepareExit.mockImplementation(
      async (args: { broadcastSipa?: (sipa: unknown) => Promise<void> }) => {
        const resolved = { sipaAddress: SIPA, resolution: { day: 1, nonce: 3 } }
        await args.broadcastSipa?.(resolved)
        return { amount: 85n * 10n ** 18n, day: 1, resolved }
      },
    )
  })

  // A burn goes out only to an address the relayer already knows.
  it("publishes the arrival inside the migration, then seeds the record and burns", async () => {
    const order: string[] = []
    h.publish.mockImplementation(async () => {
      order.push("publish")
      expect(store.list()).toEqual([])
    })
    h.burn.mockImplementation(async () => {
      order.push("burn")
      expect(store.list()[0]).toMatchObject({
        intent: "migration",
        recipient: SIPA,
        recipientAlias: "Your balance on the new version",
      })
      return MINED
    })
    await run()
    expect(order).toEqual(["publish", "burn"])
    expect(h.publish).toHaveBeenCalledWith(
      expect.anything(),
      { sipaAddress: SIPA, resolution: { day: 1, nonce: 3 } },
      "$85.00 to the new version",
      expect.stringMatching(/^migration_/),
    )
  })

  // The rows price what the new balance receives off the record.
  it("stamps the fees on the record, and burns without them when they cannot be read", async () => {
    h.burn.mockResolvedValue(MINED)
    expect(await run()).toMatchObject({ fpcFundingCut: "2", arrivalFee: "3" })
    await store.clearAll()
    h.fee.mockRejectedValueOnce(new Error("rpc down"))
    const record = await run()
    expect(record.phase).toBe("l2_mined")
    expect(record.arrivalFee).toBeUndefined()
  })

  it("burns nothing and seeds no record when the publish is refused or fails", async () => {
    for (const error of ["derived deposit address changed", "Tx dropped"]) {
      h.publish.mockRejectedValueOnce(new Error(error))
      await expect(run()).rejects.toThrow(error)
      expect(h.burn).not.toHaveBeenCalled()
      expect(store.list()).toEqual([])
    }
  })

  // The SIPA is keyed by the manifest's rollup version, so a thin manifest fails by name before
  // the service (the flow's only node consumer) is built and before any record exists.
  it("fails before the service is built when the manifest names no rollupVersion", async () => {
    await expect(run({ ...CURRENT, rollupVersion: "" })).rejects.toThrow(/lacks rollupVersion/)
    expect(h.migrationDeps).not.toHaveBeenCalled()
    expect(h.prepareExit).not.toHaveBeenCalled()
    expect(h.publish).not.toHaveBeenCalled()
    expect(h.burn).not.toHaveBeenCalled()
    expect(store.list()).toEqual([])
  })

  it("seeds nothing when the exit could not be prepared", async () => {
    h.prepareExit.mockRejectedValueOnce(new Error("fee floor moved"))
    await expect(run()).rejects.toThrow("fee floor moved")
    expect(store.list()).toEqual([])
    expect(h.burn).not.toHaveBeenCalled()
  })

  it("sponsors the burn on the deployment the funds live on", async () => {
    h.burn.mockImplementation(
      async (_prepared: unknown, args: { sponsor: () => Promise<unknown> }) => {
        await args.sponsor()
        return MINED
      },
    )
    await run()

    expect(h.migrationDeps).toHaveBeenCalledWith(expect.objectContaining({ from: HISTORIC }))
    expect(h.claimSponsorContext).toHaveBeenCalledWith(expect.anything(), RAIL_REGISTERED, {
      tuple: HISTORIC,
    })
  })

  it("puts the burn on a withdrawal record, stamped at submit, and waits for nothing after it", async () => {
    let atSubmit: unknown
    h.burn.mockImplementation(async (_prepared: unknown, args: { operationId: string }) => {
      expect(store.list()[0]).toMatchObject({ phase: "submitting", recipient: SIPA })
      provingProgress.emitStageStart(ProvingStage.Mining, args.operationId, BURN)
      await new Promise((r) => setTimeout(r, 0))
      atSubmit = store.list()[0]?.l2TxHash
      return MINED
    })

    const record = await run()

    expect(atSubmit).toBe(BURN)
    expect(record).toMatchObject({
      phase: "l2_mined",
      l2TxHash: BURN,
      deployment: { portal: HISTORIC.portal },
    })
    expect(h.leaveToChain).not.toHaveBeenCalled()
    expect(h.settle).not.toHaveBeenCalled()
    expect(h.migrate).not.toHaveBeenCalled()
  })

  it("leaves a burn that reached the node to the chain", async () => {
    h.burn.mockImplementation(async (_prepared: unknown, args: { operationId: string }) => {
      provingProgress.emitStageStart(ProvingStage.Mining, args.operationId, BURN)
      throw new Error("fetch failed")
    })
    const record = await run()
    expect(record).toMatchObject({ phase: "submitting", l2TxHash: BURN })
    expect(record.error).toBeUndefined()
    expect(h.leaveToChain).toHaveBeenCalledWith(BURN)
  })

  it("drops the seed when the passkey prompt is closed", async () => {
    h.burn.mockRejectedValue(new Error("Cancelled"))
    await expect(run()).rejects.toThrow("Cancelled")
    expect(store.list()).toEqual([])
  })

  it("fails the record when the burn never reached the node", async () => {
    h.burn.mockRejectedValue(new Error("Passkey assertion returned no credential"))
    await expect(run()).rejects.toThrow(/Passkey/)
    expect(store.list()[0]?.phase).toBe("failed")
  })
})
