/**
 * The Savings source's move flow up to the burn: a move out connects its co-signer then, and tries
 * again after a failed connect; a move whose fees rose since its review stops before burning.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { SavingsMoveStorage, type SavingsQuote } from "@obsidion/front-core"
import { InMemoryStorageAdapter } from "./support/memoryStorage"

const h = vi.hoisted(() => ({
  signerLoad: vi.fn(),
  signerOpts: vi.fn(),
  loadTuple: vi.fn(),
  settle: vi.fn(),
  portals: vi.fn(),
  quote: vi.fn(),
  setTeeSigner: vi.fn(),
  runBurn: vi.fn(),
}))
const moves = new SavingsMoveStorage(new InMemoryStorageAdapter())
const TUPLE = {
  portal: `0x${"71".repeat(20)}`,
  token: `0x${"da".repeat(20)}`,
  l2Token: `0x${"2b".repeat(32)}`,
  l2Broadcaster: `0x${"2c".repeat(32)}`,
}

vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  TokenService: {
    create: async () => ({
      getBalance: async () => 10n ** 30n,
      setTeeSigner: h.setTeeSigner,
      fetchTokenInformation: async () => ({ symbol: "sUSDS" }),
    }),
  },
  registerBroadcaster: async () => ({}),
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  createOxideTeeSignerSource: (opts: unknown) => {
    h.signerOpts(opts)
    return { load: h.signerLoad }
  },
  quoteSavingsMove: h.quote,
  loadOxideManifestTuple: h.loadTuple,
  settleSavingsMoves: h.settle,
  readSkyFactoryPortals: h.portals,
  readSavingsVault: async () => `0x${"cc".repeat(20)}`,
  resolveSkyFactory: async () => ({}),
  buildSavingsMove: async () => ({
    escrow: `0x${"ee".repeat(20)}`,
    nonce: `0x${"01".repeat(32)}`,
    recipientCommitment: `0x${"02".repeat(32)}`,
    skyMove: {},
    escrowOptions: {},
  }),
}))
vi.mock("../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/env")>()),
  getConfig: () => ({
    network: "sandbox",
    l1ChainId: 31337,
    enclaveUrl: "/svc/enclave",
    savingsEnclaveUrl: "/svc/enclave-sky",
    oxideProfile: { manifestUrl: "http://manifest.test/sandbox.json" },
  }),
}))
vi.mock("../src/config/oxideTuple", () => ({
  getOxideTuple: async () => TUPLE,
  getAssetTuple: () => Promise.resolve(TUPLE),
  getPortalTuple: (_config: unknown, portal: string) => h.loadTuple({ portal }),
  ASSET_TUPLE_TIMEOUT_MS: 20_000,
  l1PublicClient: () => ({ getBlockNumber: async () => 100n }),
}))
vi.mock("../src/features/fees/fpcFundingCut", () => ({ fpcFundingCut: async () => 0n }))
vi.mock("../src/features/limits/withdrawalLimit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/limits/withdrawalLimit")>()),
  assertWithinWithdrawalLimit: () => {},
}))
vi.mock("../src/features/onboarding/claimSponsorship", () => ({
  claimSponsorContext: async () => ({}),
}))
vi.mock("../src/features/operations/operations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/operations/operations")>()),
  runOperation: (_meta: unknown, run: (op: unknown) => unknown) => run({ operationId: "op-1" }),
}))
vi.mock("../src/features/withdraw/withdrawGateway", () => ({
  getWithdrawalStore: () => ({ get: () => undefined, load: async () => {}, list: () => [] }),
  noteSponsoredMine: () => {},
  ownSwapRecoverer: async () => ({ secret: {}, account: {} }),
  runBurn: h.runBurn,
  withdrawalOptions: async () => ({}),
}))
vi.mock("../src/platform/auth/useAuthenticator", () => ({
  getAuthService: () => ({ getSecretKey: async () => ({}) }),
}))
vi.mock("../src/features/savings/savingsMoveStore", () => ({ getSavingsMoveStore: () => moves }))

const { createSavingsSource, savingsFinalizeDeployment } = await import(
  "../src/features/savings/savingsGateway"
)
const { SavingsQuoteChangedError } = await import("../src/features/savings/quoteChanged")

const quoteOf = (net: bigint): SavingsQuote => ({
  direction: "in",
  amount: 100n,
  value: 100n,
  releaseTip: 1n,
  sourceCut: 0n,
  escrowTip: 1n,
  arrivalCut: 0n,
  escrowFunding: 1n,
  net,
  fee: 100n - net,
})
const source = () =>
  createSavingsSource(
    {
      wallet: {},
      account: { getAddress: () => ({}) },
      contractService: {},
      tokenService: {
        getBalance: async () => 10n ** 30n,
        fetchTokenInformation: async () => ({ symbol: "DAI" }),
      },
    } as never,
    TUPLE as never,
  )

beforeEach(async () => {
  await moves.load()
  for (const fn of Object.values(h)) fn.mockReset()
  h.runBurn.mockResolvedValue({
    record: { localId: "w1", startTime: 1 },
    result: undefined,
  })
})

describe("createSavingsSource move", () => {
  it("connects the Savings co-signer before a move out, and tries again after a failed connect", async () => {
    const signer = { id: "tee" }
    h.signerLoad.mockRejectedValueOnce(new Error("TEE not registered")).mockResolvedValue(signer)
    h.quote.mockResolvedValue(quoteOf(90n))
    const savings = source()
    await savings.read().catch(() => {})
    expect(h.signerLoad).not.toHaveBeenCalled()
    await expect(savings.move("out", 100n, () => {})).rejects.toThrow("TEE not registered")
    expect(h.runBurn).not.toHaveBeenCalled()
    await savings.move("out", 100n, () => {})
    expect(h.setTeeSigner).toHaveBeenCalledWith(signer)
    expect(h.runBurn).toHaveBeenCalledTimes(1)
  })

  it("stops a move whose fees rose since its review, with the new quote, and burns at the reviewed fees", async () => {
    const savings = source()
    h.quote.mockResolvedValue(quoteOf(90n))
    await savings.quote("in", 100n)
    h.quote.mockResolvedValue(quoteOf(80n))
    const refused = savings.move("in", 100n, () => {})
    await expect(refused).rejects.toBeInstanceOf(SavingsQuoteChangedError)
    await expect(refused).rejects.toMatchObject({ quote: { net: 80n } })
    expect(h.runBurn).not.toHaveBeenCalled()
    // The refused move's quote is now the one reviewed: confirming it again burns.
    await savings.move("in", 100n, () => {})
    expect(h.runBurn).toHaveBeenCalledTimes(1)
  })

  it("refuses a move out over the network's maximum per burn before anything is signed", async () => {
    const { TX_AMOUNT_CAP } = await import("@obsidion/sdk")
    h.signerLoad.mockResolvedValue({})
    h.quote.mockResolvedValue(quoteOf(90n))
    await expect(source().move("out", TX_AMOUNT_CAP + 1n, () => {})).rejects.toThrow(
      "over the network's maximum per withdrawal",
    )
    expect(h.runBurn).not.toHaveBeenCalled()
  })

  it("names a move's dollar value on its burn, for the bell to show instead of a share count", async () => {
    h.signerLoad.mockResolvedValue({})
    h.quote.mockResolvedValue({ ...quoteOf(90n), value: 105n })
    await source().move("out", 100n, () => {})
    expect(h.runBurn.mock.calls[0][0].record.skyMove).toMatchObject({ value: "105" })
  })

  it("connects the Savings co-signer to Savings' own enclave, never Main's", async () => {
    h.signerLoad.mockResolvedValue({})
    h.quote.mockResolvedValue(quoteOf(90n))
    await source().move("out", 100n, () => {})
    const opts = h.signerOpts.mock.calls[0][0] as { transformEnclaveUrl: (url: string) => string }
    expect(opts.transformEnclaveUrl("http://localhost:5072/rpc")).toBe("/svc/enclave-sky/rpc")
  })

  it("finalizes an older move on the Savings deployment its burn was made on, else the current one", async () => {
    const old = { ...TUPLE, portal: `0x${"0d".repeat(20)}`, l2Token: `0x${"0e".repeat(32)}` }
    h.loadTuple.mockResolvedValue(old)
    h.signerLoad.mockResolvedValue({ id: "tee" })
    const older = await savingsFinalizeDeployment({ node: {} } as never, {
      deployment: { portal: old.portal as `0x${string}`, l2Token: old.l2Token },
    })
    expect(h.loadTuple).toHaveBeenCalledWith(expect.objectContaining({ portal: old.portal }))
    expect(older.tuple).toBe(old)
    const signerFor = h.signerOpts.mock.calls.at(-1)![0] as { getTuple: () => unknown }
    expect(signerFor.getTuple()).toBe(old)
    h.loadTuple.mockClear()
    const current = await savingsFinalizeDeployment({ node: {} } as never, {})
    expect(current.tuple).toBe(TUPLE)
    expect(h.loadTuple).not.toHaveBeenCalled()
  })

  it("settles an older move on the deployment its factory deposits into, and a current one on the current", async () => {
    const OLD = `0x${"0b".repeat(20)}`
    const older = { ...TUPLE, portal: OLD, l2Token: `0x${"0c".repeat(32)}` }
    h.loadTuple.mockResolvedValue(older)
    h.portals.mockImplementation(async (_client: unknown, factory: string) =>
      factory === "0xold"
        ? { daiPortal: TUPLE.portal, sUsdsPortal: OLD }
        : { daiPortal: TUPLE.portal, sUsdsPortal: TUPLE.portal },
    )
    await source().settle()
    const { destinationFor } = h.settle.mock.calls[0][1] as {
      destinationFor: (move: object) => Promise<{ portal: string }>
    }
    const old = await destinationFor({ direction: "in", factory: "0xold" })
    expect(old.portal).toBe(OLD)
    expect(h.loadTuple).toHaveBeenCalledWith(expect.objectContaining({ portal: OLD }))
    // The factory's portals are read once for the page; the tuple comes from the shared portal cache.
    await destinationFor({ direction: "in", factory: "0xold" })
    expect(h.portals).toHaveBeenCalledTimes(1)
    h.loadTuple.mockClear()
    const current = await destinationFor({ direction: "in", factory: "0xnew" })
    expect(current.portal).toBe(TUPLE.portal)
    expect(h.loadTuple).not.toHaveBeenCalled()
  })

  it("gives up on a stalled factory read so the pass can end, and reads again on the next pass", async () => {
    vi.useFakeTimers()
    try {
      h.portals.mockReturnValueOnce(new Promise(() => {}))
      await source().settle()
      const { destinationFor } = h.settle.mock.calls.at(-1)![1] as {
        destinationFor: (move: object) => Promise<{ portal: string }>
      }
      const stalled = destinationFor({ direction: "in", factory: "0xstall" })
      const settled = expect(stalled).rejects.toThrow("timed out")
      await vi.advanceTimersByTimeAsync(20_000)
      await settled
      h.portals.mockResolvedValueOnce({ daiPortal: TUPLE.portal, sUsdsPortal: TUPLE.portal })
      await expect(destinationFor({ direction: "in", factory: "0xstall" })).resolves.toMatchObject({
        portal: TUPLE.portal,
      })
      expect(h.portals).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
