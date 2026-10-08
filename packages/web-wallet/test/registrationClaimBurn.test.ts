/**
 * The withdrawal record a registration-funding claim keeps for its SIPA burn: seeded before the
 * batch signs, mined after it, failed or dropped when the batch does not go out, and armed on the
 * chain watcher. An ordinary claim keeps none.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"
import { PendingRegistrationStore, WithdrawalStorage } from "@obsidion/front-core"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import { provingProgress, ProvingStage } from "@obsidion/proving-progress"
import { TxStatus } from "@aztec/stdlib/tx"
import { webStorage } from "../src/platform/storage/WebStorageAdapter"
import { saveRegistrationTerms } from "../src/features/onboarding/registrationTerms"
import { testWalletDbs } from "./support/fakeWalletDb"

const dai = (n: number) => BigInt(Math.round(n * 100)) * 10n ** 16n
const CUT = dai(0.1)
/** Below the field modulus, as a real L2 tx hash is. */
const HASH = `0x${"11".repeat(32)}`
const h = vi.hoisted(() => ({
  fundingCut: vi.fn(async () => 100_000_000_000_000_000n),
  portalState: vi.fn(async () => ({ fpcFundingCut: 100_000_000_000_000_000n, frozen: false })),
  claimSdk: vi.fn(async (..._args: unknown[]) => "0x" + "11".repeat(32)),
  getTxReceipt: vi.fn(async () => ({ status: "success", blockNumber: 42 })),
  watch: vi.fn(async (_record: unknown) => {}),
  portal: { address: `0x${"11".repeat(20)}` },
}))
vi.mock("@obsidion/sdk", async (original) => ({
  ...(await original<typeof import("@obsidion/sdk")>()),
  readFpcFundingCut: h.fundingCut,
  readPortalWithdrawalState: h.portalState,
  PaylinkService: class {
    claimSponsoredPaylink = h.claimSdk
  },
  decodePaylinkInline: () => ({
    paylinkType: "paylink_direct",
    secret: { toString: () => "secret", toBuffer: () => new Uint8Array(32) },
  }),
  paylinkVoucherUses: async () => 1,
}))
vi.mock("../src/config/env", async (original) => ({
  ...(await original<typeof import("../src/config/env")>()),
  getConfig: () => ({ network: "sandbox" }),
}))
vi.mock("../src/config/oxideTuple", async (original) => ({
  ...(await original<typeof import("../src/config/oxideTuple")>()),
  getOxideTuple: async () => ({ portal: h.portal.address }),
  l1PublicClient: () => ({}),
}))
vi.mock("@obsidion/front-core", async (original) => ({
  ...(await original<typeof import("@obsidion/front-core")>()),
  readPaylinkNote: async () => ({ amount: 3n * 10n ** 18n }),
  TxLifecycleService: {
    getInstance: () => ({
      startTrackingTx: async () => "claim-row",
      recordPreSubmitPaylinkRow: async () => {},
      patchTxHashForQueue: async () => {},
      completeTransaction: () => {},
      failTransaction: () => {},
    }),
  },
}))
vi.mock("../src/features/onboarding/claimSponsorship", () => ({
  claimSponsorRail: async () => ({ sponsor: { railId: 2, fpcAddress: {}, fpcArtifact: {} } }),
  claimSponsorContext: async () => ({ railId: 1, fpcAddress: {}, fpcArtifact: {} }),
  noteSubscribed: () => {},
}))
vi.mock("../src/features/fees/fpcRefuel", () => ({ maybeRefuelFpc: () => {} }))
vi.mock("../src/lib/analytics", async (original) => ({
  ...(await original<typeof import("../src/lib/analytics")>()),
  paylinkPh: async () => "fixture",
  firePaylinkEvent: () => {},
}))
// The store is real; the deployment wiring and the watcher boot need a manifest this suite has not.
vi.mock("../src/features/withdraw/withdrawGateway", async (original) => ({
  ...(await original<typeof import("../src/features/withdraw/withdrawGateway")>()),
  currentDeployment: async () => undefined,
  publishedBurn: async () => undefined,
  ensureWithdrawalTracker: async () => ({ watch: h.watch }),
}))
/** Read once at module load, so it is set before anything imports the analytics module. */
const API = "http://api.test"
vi.stubEnv("VITE_ZKMONEY_API_URL", API)

const { claimSponsoredLink, RegistrationFundingError } = await import(
  "../src/features/paylink/sponsoredPaylink"
)
const { getWithdrawalStore } = await import("../src/features/withdraw/withdrawGateway")
const { getOperationStore } = await import("../src/features/operations/operations")

const account = `0x${"aa".repeat(20)}`
const l2Address = `0x${"bb".repeat(32)}` as const
const sipaAddress = `0x${"cc".repeat(20)}` as const
const deps = {
  account: { getAddress: () => ({ toString: () => l2Address }) },
  wallet: { node: { getTxReceipt: h.getTxReceipt } },
  contractService: {},
  tokenService: {
    fetchTokenInformation: async () => ({
      symbol: "DAI",
      name: "DAI",
      decimals: 18,
      address: `0x${"aa".repeat(32)}`,
    }),
  },
} as never
const pending = PendingRegistrationStore.get(webStorage)
/** Fee 0.5, no minimum, both cuts 0.1: SIPA target 0.61, burn 0.81, plus the committed tip. */
const BURN = dai(0.81)
const TIP = dai(1)

const terms = (overrides: Partial<Parameters<typeof saveRegistrationTerms>[0]> = {}) =>
  saveRegistrationTerms({
    account,
    tag: "alice",
    deadline: 4102444800,
    fee: String(dai(0.5)),
    minDeposit: "0",
    feeWaived: true,
    paylinkFunded: true,
    paylinkId: "id:link",
    ...overrides,
  })
const fund = () =>
  claimSponsoredLink(deps, "fixture", undefined, undefined, { fundRegistration: true })
const withdrawals = () => getWithdrawalStore().list()
const sdkOptions = () =>
  h.claimSdk.mock.calls[0]?.[2] as {
    operationId: string
    voucher?: { railId: number; withdraw?: Record<string, unknown> }
  }

let portals = 0
beforeEach(async () => {
  localStorage.clear()
  ;(WithdrawalStorage as unknown as { instance: unknown }).instance = null
  await pending.load()
  vi.clearAllMocks()
  h.fundingCut.mockResolvedValue(CUT)
  h.claimSdk.mockResolvedValue(HASH)
  h.getTxReceipt.mockResolvedValue({ status: "success", blockNumber: 42 })
  // A fresh portal per test: the cut reader caches one read per deployment.
  h.portal.address = `0x${String(++portals).padStart(40, "0")}`
  await pending.upsert(
    account,
    { broadcast: true },
    {
      tag: "alice",
      nameHash: `0x${"dd".repeat(32)}`,
      l2Address,
      l1ChainId: 31337,
      sipaAddress,
      depositToken: `0x${"ee".repeat(20)}`,
      broadcast: true,
      phase: "awaiting_deposit",
      retries: 0,
      startTime: Date.now(),
    },
  )
  terms()
})

describe("a registration-funding claim's burn record", () => {
  it("is seeded before the batch signs and marked mined after it, armed on the watcher", async () => {
    await terms({ proverTip: TIP.toString() })
    let seeded: ReturnType<typeof withdrawals> = []
    h.claimSdk.mockImplementation(async () => {
      seeded = withdrawals()
      return HASH
    })
    expect(await fund()).toBe(HASH)
    expect(seeded).toHaveLength(1)
    expect(seeded[0]).toMatchObject({
      phase: "submitting",
      operationId: sdkOptions().operationId,
      recipient: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC",
      source: "paylink",
      intent: "registration",
      amount: "1.81",
      rawAmount: (BURN + TIP).toString(),
      relayerTip: WITHDRAW_RELAYER_TIP.toString(),
      proverTip: TIP.toString(),
      fpcFundingCut: CUT.toString(),
      tokenSymbol: "DAI",
    })
    expect(seeded[0]?.l2TxHash).toBeUndefined()
    // The batch takes the burn alone, priced exactly as the record was written, and settles it on
    // the live portal; the sdk adds its release broadcast.
    const withdraw = sdkOptions().voucher?.withdraw
    expect(Object.keys(withdraw ?? {}).sort()).toEqual([
      "amount",
      "l1Recipient",
      "proverTip",
      "withdrawal",
    ])
    expect(withdraw?.amount).toBe(BURN + TIP)
    expect(withdraw?.proverTip).toBe(TIP)
    expect(withdraw?.withdrawal).toEqual({
      tuple: { portal: h.portal.address },
      portal: { fpcFundingCut: CUT, frozen: false },
    })
    expect(h.portalState).toHaveBeenCalledWith(expect.anything(), h.portal.address)
    expect(String(withdraw?.l1Recipient).toLowerCase()).toBe(sipaAddress)

    const [mined] = withdrawals()
    expect(mined).toMatchObject({ phase: "l2_mined", l2TxHash: HASH, blockNumber: 42 })
    expect(h.watch).toHaveBeenCalledWith(expect.objectContaining({ l2TxHash: HASH }))
    expect(withdrawals()).toHaveLength(1)
  })

  it("burns no prover tip when the review committed none, and learns the device's burn time", async () => {
    h.claimSdk.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5))
      return HASH
    })
    expect(await fund()).toBe(HASH)
    await new Promise((r) => setTimeout(r))
    const [record] = withdrawals()
    expect(record?.rawAmount).toBe(BURN.toString())
    expect(record?.proverTip).toBeUndefined()
    expect(sdkOptions().voucher?.withdraw?.proverTip).toBe(0n)
    const durations = JSON.parse((await webStorage.getItem("burnDurations")) ?? "[]") as number[]
    expect(durations).toHaveLength(1)
  })

  it("tells the activation surfaces the funding is on its way, with the link's stash gone", async () => {
    const { ticketActivation } = await import("../src/features/paylink/ticketContinuation")
    const { loadRegistrationTerms } = await import("../src/features/onboarding/registrationTerms")
    expect(await fund()).toBe(HASH)
    // Home clears the stash as the claim settles; the record, not the stash, says the burn is out.
    sessionStorage.clear()
    const record = pending.current(l2Address)!
    const terms = loadRegistrationTerms(account, "alice")
    expect(ticketActivation(record, terms, withdrawals())).toEqual({ state: "submitted" })
    expect(ticketActivation(record, terms, [])).toEqual({ state: "missing_link" })
  })

  it("is nothing for an ordinary claim", async () => {
    expect(await claimSponsoredLink(deps, "fixture")).toBe(HASH)
    expect(withdrawals()).toHaveLength(0)
    expect(sdkOptions().voucher?.withdraw).toBeUndefined()
    expect(h.watch).not.toHaveBeenCalled()
  })

  it("is refused, with nothing seeded, while the terms lapsed or the address is unpublished", async () => {
    terms({ deadline: Math.floor(Date.now() / 1000) - 60 })
    await expect(fund()).rejects.toMatchObject({ reason: "expired" })
    terms()
    await pending.upsert(account, { broadcast: false })
    await expect(fund()).rejects.toBeInstanceOf(RegistrationFundingError)
    expect(withdrawals()).toHaveLength(0)
    expect(h.claimSdk).not.toHaveBeenCalled()
  })

  it("fails the record with the send's error, and drops it on a cancel", async () => {
    h.claimSdk.mockRejectedValueOnce(new Error("Simulation failed"))
    await expect(fund()).rejects.toThrow("Simulation failed")
    expect(withdrawals()).toHaveLength(1)
    expect(withdrawals()[0]).toMatchObject({ phase: "failed", error: "Simulation failed" })
    expect(h.watch).not.toHaveBeenCalled()

    h.claimSdk.mockRejectedValueOnce(new Error("Cancelled"))
    await expect(fund()).rejects.toThrow("Cancelled")
    expect(withdrawals()).toHaveLength(1)
  })

  it("keeps a broadcast burn at its hash when the receipt wait fails, and reports the claim by it", async () => {
    h.claimSdk.mockImplementation(async (_params, _sponsor, options) => {
      const { operationId } = options as { operationId: string }
      provingProgress.emitStageStart(ProvingStage.Mining, operationId, HASH)
      throw new Error("Receipt timed out")
    })
    h.getTxReceipt.mockRejectedValue(new Error("node away"))
    await expect(fund()).rejects.toMatchObject({ name: "TxInFlightError", txHash: HASH })
    expect(withdrawals()[0]).toMatchObject({ phase: "submitting", l2TxHash: HASH })
    expect(withdrawals()[0]?.error).toBeUndefined()
    expect(h.watch).toHaveBeenCalled()
    // Both stamps saved, so the claim's operation is left to the chain.
    expect(getOperationStore().get(sdkOptions().operationId)).toMatchObject({
      state: "sent",
      txHash: HASH,
    })
  })

  it("keeps the claim tab-bound when the burn's hash stamp did not persist", async () => {
    testWalletDbs().onApply = (_version, ops) => {
      if (
        ops.some(
          ([key, value]) => key.includes("@obsidion/withdrawals/records") && value?.includes(HASH),
        )
      ) {
        throw new Error("quota")
      }
    }
    h.claimSdk.mockImplementation(async (_params, _sponsor, options) => {
      const { operationId } = options as { operationId: string }
      provingProgress.emitStageStart(ProvingStage.Mining, operationId, HASH)
      await new Promise((r) => setTimeout(r, 0))
      expect(getOperationStore().get(operationId)?.state).toBe("local")
      return HASH
    })
    expect(await fund()).toBe(HASH)
  })

  /**
   * The batch that spends the link is signed with the passkey the signup just made, so it counts
   * as signup rather than as an ordinary approval. The signature happens inside the SDK claim,
   * which is where this drives it from.
   */
  describe("the flow its signature is reported under", () => {
    let fetchSpy: MockInstance<typeof fetch>
    let signInsideClaim: () => Promise<void>

    beforeEach(async () => {
      fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true } as Response)
      const { passkeyTelemetry } = await import("../src/lib/passkeyTelemetry")
      const { bindAnalyticsConsent } = await import("../src/lib/analytics")
      const { makeWebauthnSignFn } = await import("../src/platform/auth/webauthnSigning")
      const { FakePasskeyCeremony } = await import("./support/fakePasskeyCeremony")
      // Consent is on, so anything that lands on the consent-gated path is visible rather than dropped.
      bindAnalyticsConsent(() => true)
      const inner = new FakePasskeyCeremony({ onRequest: passkeyTelemetry.requestHook })
      const created = await inner.create({
        rpId: "localhost",
        rpName: "test",
        userName: "@alice",
        prfFirstSalt: new Uint8Array(32),
      })
      const sign = makeWebauthnSignFn(
        passkeyTelemetry.wrap(inner),
        "localhost",
        created.credentialId,
        created.pubkey,
      )
      signInsideClaim = async () => void (await sign(Buffer.alloc(32, 7)))
    })

    afterEach(() => {
      fetchSpy.mockRestore()
    })

    /** Every passkey result posted so far, as [platform, flow]. */
    const reported = () =>
      fetchSpy.mock.calls
        .map(([, init]) => JSON.parse(String(init?.body)))
        .filter((body) => body.event === "passkey_ceremony")
        .map((body) => [body.platform, body.props.flow])

    it("is signup for a registration-funding claim, and the default for an ordinary one", async () => {
      h.claimSdk.mockImplementation(async () => {
        await signInsideClaim()
        return HASH
      })
      await fund()
      await claimSponsoredLink(deps, "fixture")

      expect(reported()).toEqual([
        ["web-signup", "onboarding"],
        ["web", "other"],
      ])
    })

    it("is let go when the claim throws, so a later signature is not still signup", async () => {
      h.claimSdk.mockImplementationOnce(async () => {
        await signInsideClaim()
        throw new Error("Node rejected the batch")
      })
      await expect(fund()).rejects.toThrow("Node rejected the batch")
      await signInsideClaim()

      expect(reported()).toEqual([
        ["web-signup", "onboarding"],
        ["web", "other"],
      ])
    })
  })

  it("fails the record when the node reports the broadcast dropped", async () => {
    h.claimSdk.mockImplementation(async (_params, _sponsor, options) => {
      const { operationId } = options as { operationId: string }
      provingProgress.emitStageStart(ProvingStage.Mining, operationId, HASH)
      throw new Error("Node rejected the batch")
    })
    h.getTxReceipt.mockResolvedValue({ status: TxStatus.DROPPED } as never)
    await expect(fund()).rejects.toThrow("Node rejected the batch")
    expect(withdrawals()[0]).toMatchObject({ phase: "failed", error: "Node rejected the batch" })
  })
})
