import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  zeroAddress,
  type Address,
  type Hex,
} from "viem"
import { Fr } from "@aztec/aztec.js/fields"
import {
  NameClaimStore,
  PendingRegistrationStore,
  SIPADepositStore,
  composeWireNameHash,
  type PendingRegistrationRecord,
} from "@obsidion/front-core"
import { webStorage } from "../src/platform/storage/WebStorageAdapter"
import type { WebWalletConfig } from "../src/config/env"
import {
  getPendingStore,
  registrationRecordForSipa,
} from "../src/features/onboarding/webRegistration"
import {
  loadRegistrationTerms,
  saveRegistrationTerms,
} from "../src/features/onboarding/registrationTerms"
import { canManualRegistrationSweep } from "../src/features/onboarding/registrationSweep"
import { reconcileRegistrationRefund } from "../src/features/onboarding/registrationQuoteRecovery"
import {
  recordDepositAdmission,
  hasWalletEntry,
  hasDepositAdmission,
} from "../src/features/identity/admission"
import { saveWalletIdentity } from "../src/features/identity/walletIdentity"
import { signOutNow } from "../src/features/identity/signOut"
import { ticketSignupRegistration } from "../src/features/paylink/ticketContinuation"

const h = vi.hoisted(() => ({
  sign: vi.fn(),
  redeem: vi.fn(),
  registeredOwner: vi.fn(),
  heldName: vi.fn(),
  derive: vi.fn(),
  buildSweep: vi.fn(),
  send: vi.fn(),
  wait: vi.fn(),
  broadcast: vi.fn(),
  balance: vi.fn(),
  receipt: vi.fn(),
  metadataRegistry: vi.fn(),
  cut: vi.fn(),
  /** The controller's immutable schedule, counted: the sweep reads it exactly once. */
  schedule: vi.fn(async () => ({ fee: 10n * DAI, min: 5n * DAI })),
  config: {} as WebWalletConfig,
}))
vi.mock("@obsidion/front-core", async (original) => ({
  ...(await original<object>()),
  AccountServiceClient: class {
    signDomain = h.sign
  },
  createRegistrationSipaDeriver: () => h.derive,
  buildRegistrationSelfSweepCall: h.buildSweep,
  resolveStoredCredentialId: async () => "cred-demo",
  createOxideL1Reader: () => ({
    predictAccountAddress: async () => OWNER,
    readUserAddress: h.registeredOwner,
    readNameOf: h.heldName,
    readAccountMetadataRegistry: h.metadataRegistry,
    getUserOpHash: async () => `0x${"77".repeat(32)}`,
    // The account has no code yet, so consent signs with the bootstrap key.
    getCode: async () => undefined,
  }),
}))
vi.mock("../src/features/onboarding/goldenTicket", () => ({
  redeemGoldenTicketForLink: h.redeem,
}))
// Fake fragments never decode; the checkpoint only needs a stable identity for one.
vi.mock("../src/features/paylink/linkIdentity", () => ({
  linkIdentity: (fragment: string) => `id:${fragment}`,
}))
vi.mock("@obsidion/sdk", async (original) => ({
  ...(await original<object>()),
  ContractService: { getInstance: () => ({}) },
}))
vi.mock("../src/platform/auth/useAuthenticator", () => ({ peekAuthService: () => undefined }))
// The sandbox portal's cut. The earned quote is refused without one, so every restart here needs it.
vi.mock("../src/features/fees/fpcFundingCut", () => ({
  fpcFundingCut: () => h.cut(),
  currentFpcFundingCut: () => h.cut(),
}))
vi.mock("../src/config/env", async (original) => ({
  ...(await original<object>()),
  getConfig: () => h.config,
}))
vi.mock("../src/config/oxideTuple", async (original) => ({
  ...(await original<object>()),
  oxideEnvFor: async () => ({ tuple: {}, env: ENV, publicClient: { readContract: h.balance } }),
  l1PublicClient: () => ({ readContract: h.balance, getTransactionReceipt: h.receipt }),
}))
vi.mock("../src/features/onboarding/registrationTerms", async (original) => ({
  ...(await original<object>()),
  resolveBeneficiary: async () => OWNER,
  readRegistrationSchedule: h.schedule,
}))
vi.mock("../src/features/onboarding/registrationDepositSeed", () => ({
  makeRegistrationDepositSeeder: () => vi.fn().mockResolvedValue(undefined),
  healRegistrationDeposits: vi.fn(),
}))
vi.mock("../src/features/onboarding/webRegistrationBroadcast", () => ({
  createWebRegistrationBroadcaster: () => h.broadcast,
}))
vi.mock("../src/features/deposit/sipaRecovery", async (original) => ({
  ...(await original<object>()),
  injectedWalletChannel: async () => ({
    target: OWNER,
    sendTransaction: h.send,
    waitForReceipt: h.wait,
  }),
}))
vi.mock("../src/features/deposit/sipaSweep", async (original) => ({
  ...(await original<object>()),
  readSipaDeployed: async () => false,
  sweepManifestFrom: () => ({ sipaFactory: OWNER, token: TOKEN }),
}))
const { manualRegistrationSweep, SWEEP_PRICE_COMMITTED, SWEEP_QUOTE_UNUSABLE } = await import(
  "../src/features/onboarding/registrationSweep"
)
const { claimTag } = await import("../src/features/onboarding/oxideOnboarding")
const OWNER = `0x${"11".repeat(20)}` as Address
const OLD = `0x${"22".repeat(20)}` as Address
const NEW = `0x${"33".repeat(20)}` as Address
const TOKEN = `0x${"44".repeat(20)}` as Address
const L2 = `0x${"55".repeat(32)}` as Hex
const HASH = `0x${"66".repeat(32)}` as Hex
const DAI = 10n ** 18n
const ENV = {
  registry: OWNER,
  factory: OWNER,
  ensDomain: "zk.money",
  resolverOperator: OWNER,
  rollupVersion: 1n,
  l1ChainId: 11155111,
  feeToken: TOKEN,
  namePortalRecipient: L2,
  entryPoint: "0x4337084d9e255ff0702461cf8895ce9e3b5ff108",
}
const old: PendingRegistrationRecord = {
  account: OWNER,
  tag: "demo",
  nameHash: HASH,
  l2Address: L2,
  l1ChainId: 11155111,
  sipaAddress: OLD,
  fee: String(10n * DAI),
  beneficiary: OWNER,
  depositToken: TOKEN,
  broadcast: true,
  phase: "awaiting_deposit",
  retries: 3,
  startTime: 1,
}
const claim = () => ({
  nonce: "1",
  deadline: "9999999999",
  signature: "0xaa" as Hex,
  terms: {
    reduced: true,
    fee: String(DAI / 2n),
    minDeposit: String((45n * DAI) / 10n),
    nonce: "1",
    deadline: "9999999999",
    signature: "0xbb" as Hex,
  },
})
const keys = {
  pubkeyHex: `0x${"11".repeat(64)}`,
  secretKey: new Fr(123n),
  account: { getAddress: () => ({ toString: () => L2 }), getAuthProvider: () => ({}) },
} as never
beforeEach(async () => {
  vi.clearAllMocks()
  localStorage.clear()
  ;(PendingRegistrationStore as unknown as { instance: unknown }).instance = null
  ;(SIPADepositStore as unknown as { instance: unknown }).instance = null
  NameClaimStore.resetForTests()
  NameClaimStore.get(webStorage)
  h.config = {
    l1RpcUrl: "http://127.0.0.1:8545",
    l1ChainId: 11155111,
    network: "testnet",
    admissionGate: true,
    rpId: "localhost",
  } as WebWalletConfig
  await getPendingStore().load()
  await getPendingStore().upsert(OWNER, {}, old)
  const rail = SIPADepositStore.get(webStorage)
  await rail.load()
  await rail.upsert(
    OLD,
    { phase: "recovered" },
    {
      recipientL2Address: L2,
      tokenAddress: TOKEN,
      tokenSymbol: "DAI",
      l1ChainId: 11155111,
      messageSecret: HASH,
      recoveryAddress: OWNER,
      recipientHash: HASH,
      amount: "5",
      recoveryTxHash: HASH,
      startTime: 1,
    },
  )
  await saveWalletIdentity({ address: L2, handle: "demo", pending: true, claimedAt: 1 })
  recordDepositAdmission(old, 5n * DAI)
  h.sign.mockResolvedValue(claim())
  h.redeem.mockReset().mockResolvedValue({ status: "created" })
  h.registeredOwner.mockReset().mockResolvedValue(zeroAddress)
  h.heldName.mockReset().mockResolvedValue(`0x${"00".repeat(32)}`)
  h.cut.mockResolvedValue(0n)
  h.metadataRegistry.mockResolvedValue(OWNER)
  h.balance.mockResolvedValue(0n)
  h.receipt.mockResolvedValue({
    status: "success",
    logs: [
      {
        address: TOKEN,
        topics: encodeEventTopics({
          abi: erc20Abi,
          eventName: "Transfer",
          args: { from: OLD, to: OWNER },
        }),
        data: encodeAbiParameters([{ type: "uint256" }], [5n * DAI]),
      },
    ],
  })
  h.derive.mockResolvedValue({
    sipaAddress: NEW,
    sipaArgs: {},
    recordData: "0x1234",
    registrationData: "0x1234",
    sharedSecretSalt: HASH,
    stealthScalar: 1n,
  })
  h.broadcast.mockRejectedValue(new Error("one-use registration broadcast already spent"))
  h.buildSweep.mockReturnValue({ to: OWNER, data: "0x1234" })
  h.send.mockResolvedValue(HASH)
  h.wait.mockResolvedValue(true)
})
describe("refund then restart the earned registration", () => {
  it("replaces the refunded commitment with 0.5 + 4.5 terms and retains access when broadcasting is spent", async () => {
    const result = await claimTag("demo", keys, h.config, {} as never, undefined, true, old)
    expect(result.kind).toBe("pending")
    if (result.kind !== "pending") throw new Error("expected new deposit")
    expect(result.broadcastDone).toBeUndefined()
    expect(h.broadcast).not.toHaveBeenCalled()
    const replacement = getPendingStore().get(OWNER)!
    expect(replacement).toMatchObject({
      sipaAddress: NEW,
      fee: String(DAI / 2n),
      phase: "awaiting_deposit",
      broadcast: false,
      replaced: { sipaAddress: OLD, refunded: true, broadcastSpent: true },
    })
    expect(hasWalletEntry()).toBe(true)
    expect(hasDepositAdmission(replacement)).toBe(false)
    expect((await NameClaimStore.get().get(L2))?.terms?.fee).toBe(String(DAI / 2n))
    h.balance.mockResolvedValue(5n * DAI)
    await expect(manualRegistrationSweep(replacement, { keys })).resolves.toBe(HASH)
    expect(h.buildSweep).toHaveBeenCalledWith(
      expect.objectContaining({
        sipaAddress: NEW,
        signedTerms: expect.objectContaining({ fee: DAI / 2n, minDeposit: (45n * DAI) / 10n }),
      }),
      expect.anything(),
    )
    expect(h.send).toHaveBeenCalledWith(OWNER, "0x1234")
    expect(getPendingStore().get(OWNER)?.sweepTxHash).toBe(HASH)
  })
  it("restarts after a sign-out cleared the admission receipt and the refunded address holds nothing", async () => {
    signOutNow()
    expect(hasDepositAdmission(old)).toBe(false)
    expect(hasWalletEntry()).toBe(false)
    await saveWalletIdentity({ address: L2, handle: "demo", pending: true, claimedAt: 2 })
    expect(hasWalletEntry()).toBe(false)
    const result = await claimTag("demo", keys, h.config, {} as never, undefined, true, old)
    expect(result.kind).toBe("pending")
    expect(getPendingStore().get(OWNER)?.sipaAddress).toBe(NEW)
    expect(hasWalletEntry()).toBe(true)
  })
  it("keeps wallet entry through a later sign-out: the replacement carries the verified refund", async () => {
    await claimTag("demo", keys, h.config, {} as never, undefined, true, old)
    expect(getPendingStore().get(OWNER)?.refundedEntry).toEqual({
      sipaAddress: OLD,
      recoveryTxHash: HASH,
      amount: String(5n * DAI),
    })
    signOutNow()
    expect(hasWalletEntry()).toBe(false)
    await saveWalletIdentity({ address: L2, handle: "demo", pending: true, claimedAt: 3 })
    expect(hasWalletEntry()).toBe(true)
    expect(hasDepositAdmission(getPendingStore().get(OWNER)!)).toBe(false)
  })
  it("restarts from a refund whose receipt wait was interrupted before it confirmed", async () => {
    const rail = SIPADepositStore.get(webStorage)
    await rail.upsert(OLD, { phase: "recoverable", recoveryTxHash: HASH })
    signOutNow()
    await saveWalletIdentity({ address: L2, handle: "demo", pending: true, claimedAt: 2 })
    const result = await claimTag("demo", keys, h.config, {} as never, undefined, true, old)
    expect(result.kind).toBe("pending")
    expect(rail.get(OLD)?.phase).toBe("recovered")
    expect(getPendingStore().get(OWNER)?.sipaAddress).toBe(NEW)
    expect(hasWalletEntry()).toBe(true)
  })
  it("keeps the verified refund on the replacement when the session dies after its checkpoint", async () => {
    h.metadataRegistry.mockRejectedValueOnce(new Error("rpc down"))
    await expect(
      claimTag("demo", keys, h.config, {} as never, undefined, true, old),
    ).rejects.toThrow("rpc down")
    const replacement = getPendingStore().get(OWNER)!
    expect(replacement.sipaAddress).toBe(NEW)
    expect(replacement.refundedEntry).toEqual({
      sipaAddress: OLD,
      recoveryTxHash: HASH,
      amount: String(5n * DAI),
    })
    signOutNow()
    await saveWalletIdentity({ address: L2, handle: "demo", pending: true, claimedAt: 2 })
    expect(hasWalletEntry()).toBe(true)
    // The record no longer names the refunded address, so the plain earned claim resumes it.
    const result = await claimTag("demo", keys, h.config, {} as never, undefined, true)
    expect(result.kind).toBe("pending")
    expect(getPendingStore().get(OWNER)).toMatchObject({
      sipaAddress: NEW,
      refundedEntry: { sipaAddress: OLD },
    })
    expect(hasWalletEntry()).toBe(true)
  })
  it("stamps no waiver for a claim that signed no schedule", async () => {
    const { terms: _signed, ...unpriced } = claim()
    h.sign.mockResolvedValue(unpriced)
    const result = await claimTag("demo", keys, h.config, {} as never)
    expect(result.kind).toBe("pending")
    const terms = loadRegistrationTerms(OWNER, "demo")
    expect(terms?.deadline).toBe(Number(unpriced.deadline))
    // Absent is "no schedule named a kind", which is not the same as the standard one.
    expect(terms && "feeWaived" in terms).toBe(false)
  })
  it("keeps wallet entry when a funded registration is recovered from the activity list", async () => {
    const { recoverSipaDeposit } = await import("../src/features/deposit/sipaRecovery")
    signOutNow()
    await saveWalletIdentity({ address: L2, handle: "demo", pending: true, claimedAt: 2 })
    await getPendingStore().upsert(OWNER, { phase: "funded", fundedAt: 5, fundingTxHash: HASH })
    expect(hasDepositAdmission(old)).toBe(false)
    expect(hasWalletEntry()).toBe(true)
    const rail = SIPADepositStore.get(webStorage)
    await rail.upsert(OLD, { phase: "recoverable", recoveryTxHash: undefined })
    const run = vi.fn(async () => {
      await rail.upsert(OLD, { phase: "recovered", recoveryTxHash: HASH })
      return HASH
    })
    // The rest of the 15 DAI landed after the balance read; the receipt says what moved.
    h.receipt.mockResolvedValue({
      status: "success",
      logs: [
        {
          address: TOKEN,
          topics: encodeEventTopics({
            abi: erc20Abi,
            eventName: "Transfer",
            args: { from: OLD, to: OWNER },
          }),
          data: encodeAbiParameters([{ type: "uint256" }], [15n * DAI]),
        },
      ],
    })
    await expect(
      recoverSipaDeposit(rail.get(OLD)!, {
        channel: { target: OWNER, sendTransaction: h.send, waitForReceipt: h.wait },
        chainId: 11155111,
        token: TOKEN,
        readBalance: async () => DAI / 5n,
        readReceipt: (hash) => h.receipt({ hash }),
        deployment: {} as never,
        store: rail,
        stealthKey: async () => ({} as never),
        run,
      }),
    ).resolves.toBe(HASH)
    expect(getPendingStore().get(OWNER)).toMatchObject({
      sipaAddress: OLD,
      phase: "awaiting_deposit",
      refundedEntry: { sipaAddress: OLD, recoveryTxHash: HASH, amount: String(15n * DAI) },
    })
    expect(getPendingStore().get(OWNER)?.fundedAt).toBeUndefined()
    expect(hasWalletEntry()).toBe(true)
    signOutNow()
    await saveWalletIdentity({ address: L2, handle: "demo", pending: true, claimedAt: 3 })
    expect(hasWalletEntry()).toBe(true)
    const refunded = getPendingStore().get(OWNER)!
    const result = await claimTag("demo", keys, h.config, {} as never, undefined, true, refunded)
    expect(result.kind).toBe("pending")
    expect(getPendingStore().get(OWNER)).toMatchObject({
      sipaAddress: NEW,
      refundedEntry: { sipaAddress: OLD },
    })
    expect(hasWalletEntry()).toBe(true)
  })
  it("keeps a funded registration's entry when the recovery's receipt cannot be read after it confirmed", async () => {
    const { recoverSipaDeposit } = await import("../src/features/deposit/sipaRecovery")
    const { reconcileRegistrationRefund } = await import(
      "../src/features/onboarding/registrationQuoteRecovery"
    )
    signOutNow()
    await saveWalletIdentity({ address: L2, handle: "demo", pending: true, claimedAt: 2 })
    await getPendingStore().upsert(OWNER, { phase: "funded", fundedAt: 5, fundingTxHash: HASH })
    const rail = SIPADepositStore.get(webStorage)
    await rail.upsert(OLD, { phase: "recoverable", recoveryTxHash: undefined })
    h.receipt.mockRejectedValue(new Error("rpc down"))
    await expect(
      recoverSipaDeposit(rail.get(OLD)!, {
        channel: { target: OWNER, sendTransaction: h.send, waitForReceipt: h.wait },
        chainId: 11155111,
        token: TOKEN,
        readBalance: async () => DAI / 5n,
        readReceipt: (hash) => h.receipt({ hash }),
        deployment: {} as never,
        store: rail,
        stealthKey: async () => ({} as never),
        run: vi.fn(async () => {
          await rail.upsert(OLD, { phase: "recovered", recoveryTxHash: HASH })
          return HASH
        }),
      }),
    ).resolves.toBe(HASH)
    expect(getPendingStore().get(OWNER)).toMatchObject({ phase: "funded", fundedAt: 5 })
    expect(hasWalletEntry()).toBe(true)
    signOutNow()
    await saveWalletIdentity({ address: L2, handle: "demo", pending: true, claimedAt: 3 })
    expect(hasWalletEntry()).toBe(true)
    // 0.2 DAI comes back and is recovered with a readable receipt while the 15 DAI one is not.
    const refundOf = (amount: bigint) => ({
      status: "success",
      logs: [
        {
          address: TOKEN,
          topics: encodeEventTopics({
            abi: erc20Abi,
            eventName: "Transfer",
            args: { from: OLD, to: OWNER },
          }),
          data: encodeAbiParameters([{ type: "uint256" }], [amount]),
        },
      ],
    })
    const later = `0x${"99".repeat(32)}` as Hex
    h.receipt.mockImplementation(async ({ hash }: { hash: Hex }) => {
      if (hash === HASH) throw new Error("rpc down")
      return refundOf(DAI / 5n)
    })
    await rail.upsert(OLD, { phase: "recoverable" })
    await expect(
      recoverSipaDeposit(rail.get(OLD)!, {
        channel: { target: OWNER, sendTransaction: h.send, waitForReceipt: h.wait },
        chainId: 11155111,
        token: TOKEN,
        readBalance: async () => DAI / 5n,
        readReceipt: (hash) => h.receipt({ hash }),
        deployment: {} as never,
        store: rail,
        stealthKey: async () => ({} as never),
        run: vi.fn(async () => {
          await rail.upsert(OLD, { phase: "recovered", recoveryTxHash: later })
          return later
        }),
      }),
    ).resolves.toBe(later)
    expect(getPendingStore().get(OWNER)).toMatchObject({ phase: "funded", fundedAt: 5 })
    await reconcileRegistrationRefund(getPendingStore().get(OWNER)!, h.config)
    expect(getPendingStore().get(OWNER)).toMatchObject({ phase: "funded", fundedAt: 5 })
    signOutNow()
    await saveWalletIdentity({ address: L2, handle: "demo", pending: true, claimedAt: 4 })
    expect(hasWalletEntry()).toBe(true)
    h.receipt.mockResolvedValue(refundOf(15n * DAI))
    await reconcileRegistrationRefund(getPendingStore().get(OWNER)!, h.config)
    expect(getPendingStore().get(OWNER)).toMatchObject({
      phase: "awaiting_deposit",
      refundedEntry: { sipaAddress: OLD, recoveryTxHash: HASH, amount: String(15n * DAI) },
    })
    signOutNow()
    await saveWalletIdentity({ address: L2, handle: "demo", pending: true, claimedAt: 5 })
    expect(hasWalletEntry()).toBe(true)
  })
  it("keeps wallet entry when the receipt that bought it is unreadable during the restart", async () => {
    const { reconcileRegistrationRefund, registrationRefunded } = await import(
      "../src/features/onboarding/registrationQuoteRecovery"
    )
    const later = `0x${"99".repeat(32)}` as Hex
    expect(registrationRefunded(old)).toBe(true)
    await reconcileRegistrationRefund(old, h.config)
    const rail = SIPADepositStore.get(webStorage)
    await rail.upsert(OLD, { phase: "recoverable" })
    await rail.upsert(OLD, { phase: "recovered", recoveryTxHash: later })
    expect(registrationRefunded(old)).toBe(true)
    let failFirst = true
    h.receipt.mockImplementation(async ({ hash }: { hash: Hex }) => {
      if (hash === later)
        return {
          status: "success",
          logs: [
            {
              address: TOKEN,
              topics: encodeEventTopics({
                abi: erc20Abi,
                eventName: "Transfer",
                args: { from: OLD, to: OWNER },
              }),
              data: encodeAbiParameters([{ type: "uint256" }], [DAI / 5n]),
            },
          ],
        }
      if (failFirst) {
        failFirst = false
        throw new Error("rpc down")
      }
      return {
        status: "success",
        logs: [
          {
            address: TOKEN,
            topics: encodeEventTopics({
              abi: erc20Abi,
              eventName: "Transfer",
              args: { from: OLD, to: OWNER },
            }),
            data: encodeAbiParameters([{ type: "uint256" }], [5n * DAI]),
          },
        ],
      }
    })
    await expect(
      claimTag("demo", keys, h.config, {} as never, undefined, true, old),
    ).rejects.toThrow("could not be read")
    expect(getPendingStore().get(OWNER)?.sipaAddress).toBe(OLD)
    expect(hasWalletEntry()).toBe(true)
    const result = await claimTag("demo", keys, h.config, {} as never, undefined, true, old)
    expect(result.kind).toBe("pending")
    expect(getPendingStore().get(OWNER)).toMatchObject({
      sipaAddress: NEW,
      refundedEntry: { sipaAddress: OLD, recoveryTxHash: HASH, amount: String(5n * DAI) },
    })
    signOutNow()
    await saveWalletIdentity({ address: L2, handle: "demo", pending: true, claimedAt: 2 })
    expect(hasWalletEntry()).toBe(true)
  })
  it("restarts on a refund below the earned total without buying wallet entry", async () => {
    signOutNow()
    await saveWalletIdentity({ address: L2, handle: "demo", pending: true, claimedAt: 2 })
    h.receipt.mockResolvedValue({
      status: "success",
      logs: [
        {
          address: TOKEN,
          topics: encodeEventTopics({
            abi: erc20Abi,
            eventName: "Transfer",
            args: { from: OLD, to: OWNER },
          }),
          data: encodeAbiParameters([{ type: "uint256" }], [DAI]),
        },
      ],
    })
    const result = await claimTag("demo", keys, h.config, {} as never, undefined, true, old)
    expect(result.kind).toBe("pending")
    const replacement = getPendingStore().get(OWNER)!
    expect(replacement.sipaAddress).toBe(NEW)
    expect(replacement.fee).toBe(String(DAI / 2n))
    expect(replacement.refundedEntry).toBeUndefined()
    expect(hasWalletEntry()).toBe(false)
  })
  it("replaces an unfunded old address at the earned price while it stays empty", async () => {
    const result = await claimTag(
      "demo",
      keys,
      h.config,
      {} as never,
      undefined,
      true,
      undefined,
      old,
    )
    expect(result.kind).toBe("pending")
    if (result.kind !== "pending") throw new Error("expected new deposit")
    expect(result.broadcastDone).toBeUndefined()
    expect(h.broadcast).not.toHaveBeenCalled()
    const replacement = getPendingStore().get(OWNER)!
    expect(replacement.sipaAddress).toBe(NEW)
    expect(replacement.fee).toBe(String(DAI / 2n))
    expect(replacement.refundedEntry).toBeUndefined()
    // The old address was broadcast: the rail's one use is gone, so only a manual sweep finishes.
    expect(replacement.replaced).toEqual({
      sipaAddress: OLD,
      refunded: false,
      broadcastSpent: true,
    })
    // The old record stays behind, closed, so a deposit reaching it later can still be recovered.
    const archived = registrationRecordForSipa(OLD)!
    expect(archived).toMatchObject({
      tag: "demo",
      fee: String(10n * DAI),
      phase: "failed_terminal",
    })
    expect(canManualRegistrationSweep(archived)).toBe(false)
    expect(registrationRecordForSipa(NEW)?.sipaAddress).toBe(NEW)
    expect((await NameClaimStore.get().get(L2))?.terms?.fee).toBe(String(DAI / 2n))
    h.balance.mockResolvedValue(5n * DAI)
    await expect(manualRegistrationSweep(replacement, { keys })).resolves.toBe(HASH)
    expect(h.buildSweep).toHaveBeenCalledWith(
      expect.objectContaining({ sipaAddress: NEW }),
      expect.anything(),
    )
  })
  it("re-enters the refunded record when the corrected quote only lowered the minimum", async () => {
    // A legacy earned quote (0.5 + 5) refunded at 5: the fee, and so the address, stay.
    await getPendingStore().upsert(OWNER, {
      fee: String(DAI / 2n),
      nameHash: composeWireNameHash("demo", ENV.ensDomain),
      r1Key: { qx: HASH, qy: HASH },
      credentialId: "cred",
    })
    saveRegistrationTerms({
      account: OWNER,
      tag: "demo",
      deadline: 1,
      fee: String(DAI / 2n),
      minDeposit: String(5n * DAI),
      feeWaived: true,
    })
    h.derive.mockResolvedValue({
      sipaAddress: OLD,
      sipaArgs: {},
      recordData: "0x1234",
      registrationData: "0x1234",
      sharedSecretSalt: HASH,
      stealthScalar: 1n,
    })
    const legacy = getPendingStore().get(OWNER)!
    recordDepositAdmission(legacy, 5n * DAI)
    expect(hasDepositAdmission(legacy)).toBe(true)
    const result = await claimTag("demo", keys, h.config, {} as never, undefined, true, legacy)
    expect(result.kind).toBe("pending")
    expect(h.broadcast).not.toHaveBeenCalled()
    expect(getPendingStore().get(OWNER)).toMatchObject({
      sipaAddress: OLD,
      fee: String(DAI / 2n),
      phase: "awaiting_deposit",
      refundedEntry: { sipaAddress: OLD, amount: String(5n * DAI) },
    })
    expect(getPendingStore().get(OWNER)?.replaced).toBeUndefined()
    // The receipt vouched for the refunded deposit: the resumed registration must ask for a new one.
    expect(hasDepositAdmission(getPendingStore().get(OWNER)!)).toBe(false)
    expect(registrationRecordForSipa(OLD)?.phase).toBe("awaiting_deposit")
    expect(localStorage.getItem("webwallet.registration.replaced")).toBe("[]")
    expect(loadRegistrationTerms(OWNER, "demo")).toMatchObject({
      fee: String(DAI / 2n),
      minDeposit: String((45n * DAI) / 10n),
      feeWaived: true,
      earnedExpected: true,
    })
    expect(hasWalletEntry()).toBe(true)
    // The rail starts the address over: the old recovery is evidence, not the new deposit's state.
    const rail = SIPADepositStore.get(webStorage)
    expect(rail.get(OLD)).toMatchObject({ phase: "broadcast", amount: "0" })
    expect(rail.get(OLD)?.recoveryTxHash).toBeUndefined()
    h.balance.mockResolvedValue(5n * DAI)
    await expect(manualRegistrationSweep(getPendingStore().get(OWNER)!, { keys })).resolves.toBe(
      HASH,
    )
    expect(h.buildSweep).toHaveBeenCalledWith(
      expect.objectContaining({ sipaAddress: OLD }),
      expect.anything(),
    )
    // The swept deposit keeps its progress through a reconciliation of the historical refund.
    h.balance.mockResolvedValue(0n)
    await reconcileRegistrationRefund(getPendingStore().get(OWNER)!, h.config)
    expect(rail.get(OLD)).toMatchObject({ phase: "sweeping", sweepTxHash: HASH })
  })
  it("archives the old record before the quote, so a refusal before the derivation keeps it", async () => {
    h.sign.mockRejectedValueOnce(new Error("rpc down"))
    await expect(
      claimTag("demo", keys, h.config, {} as never, undefined, true, undefined, old),
    ).rejects.toThrow("rpc down")
    expect(getPendingStore().get(OWNER)?.sipaAddress).toBe(OLD)
    expect(JSON.parse(localStorage.getItem("webwallet.registration.replaced")!)).toMatchObject([
      { sipaAddress: OLD, phase: "failed_terminal" },
    ])
  })
  it("leaves the broadcast to the relayer rail when the replaced address never used it", async () => {
    await getPendingStore().upsert(OWNER, { broadcast: false })
    const unbroadcast = getPendingStore().get(OWNER)!
    const result = await claimTag(
      "demo",
      keys,
      h.config,
      {} as never,
      undefined,
      true,
      undefined,
      unbroadcast,
    )
    if (result.kind !== "pending") throw new Error("expected new deposit")
    // A deferred broadcast proves only once the screen starts it.
    void result.startBroadcast?.()
    await result.broadcastDone
    expect(h.broadcast).toHaveBeenCalledTimes(1)
    expect(getPendingStore().get(OWNER)).toMatchObject({
      sipaAddress: NEW,
      replaced: { sipaAddress: OLD, refunded: false, broadcastSpent: false },
    })
  })
  it("leaves the broadcast to the relayer rail when the refunded address never used it", async () => {
    await getPendingStore().upsert(OWNER, { broadcast: false })
    const result = await claimTag(
      "demo",
      keys,
      h.config,
      {} as never,
      undefined,
      true,
      getPendingStore().get(OWNER)!,
    )
    if (result.kind !== "pending") throw new Error("expected new deposit")
    // A deferred broadcast proves only once the screen starts it.
    void result.startBroadcast?.()
    await result.broadcastDone
    expect(h.broadcast).toHaveBeenCalledTimes(1)
    expect(getPendingStore().get(OWNER)).toMatchObject({
      sipaAddress: NEW,
      replaced: { sipaAddress: OLD, refunded: true, broadcastSpent: false },
    })
    expect(hasWalletEntry()).toBe(true)
  })
  it("inherits a spent broadcast through a chain of replacements", async () => {
    const spent = { sipaAddress: TOKEN, refunded: false, broadcastSpent: true }
    await getPendingStore().upsert(OWNER, { broadcast: false, replaced: spent })
    const result = await claimTag(
      "demo",
      keys,
      h.config,
      {} as never,
      undefined,
      true,
      undefined,
      getPendingStore().get(OWNER)!,
    )
    if (result.kind !== "pending") throw new Error("expected new deposit")
    expect(h.broadcast).not.toHaveBeenCalled()
    expect(getPendingStore().get(OWNER)?.replaced).toEqual({ ...spent, sipaAddress: OLD })
  })
  it("keeps the replacement's quote and marker when a session dies past its checkpoint", async () => {
    h.metadataRegistry.mockRejectedValueOnce(new Error("rpc down"))
    await expect(
      claimTag("demo", keys, h.config, {} as never, undefined, true, undefined, old),
    ).rejects.toThrow("rpc down")
    expect(getPendingStore().get(OWNER)).toMatchObject({
      sipaAddress: NEW,
      fee: String(DAI / 2n),
      replaced: { sipaAddress: OLD, refunded: false, broadcastSpent: true },
    })
    expect(loadRegistrationTerms(OWNER, "demo")).toMatchObject({
      fee: String(DAI / 2n),
      minDeposit: String((45n * DAI) / 10n),
      feeWaived: true,
      earnedExpected: true,
    })
    expect(registrationRecordForSipa(OLD)?.phase).toBe("failed_terminal")
  })
  it("aborts the replace and keeps the old record when a deposit reaches it during the quote fetch", async () => {
    // Empty when the screen checked, funded by the time the checkpoint would overwrite it.
    h.balance.mockResolvedValue(5n * DAI)
    await expect(
      claimTag("demo", keys, h.config, {} as never, undefined, true, undefined, old),
    ).rejects.toThrow("A deposit reached this address")
    expect(getPendingStore().get(OWNER)?.sipaAddress).toBe(OLD)
    expect(h.broadcast).not.toHaveBeenCalled()
  })
  it.each(["underfunded", "incompatible quote"])(
    "does not submit a manual sweep when %s",
    async (reason) => {
      const result = await claimTag("demo", keys, h.config, {} as never, undefined, true, old)
      if (result.kind !== "pending") throw new Error("expected new deposit")
      await result.broadcastDone
      const replacement = getPendingStore().get(OWNER)!
      h.balance.mockResolvedValue(reason === "underfunded" ? DAI : 5n * DAI)
      if (reason === "incompatible quote") {
        NameClaimStore.resetForTests()
        NameClaimStore.get(webStorage)
        await NameClaimStore.get().remove(L2)
        h.sign.mockResolvedValue({
          ...claim(),
          terms: {
            ...claim().terms,
            fee: String(10n * DAI),
            minDeposit: String(5n * DAI),
            reduced: false,
          },
        })
      }
      await expect(manualRegistrationSweep(replacement, { keys })).rejects.toThrow(
        reason === "underfunded" ? "does not yet cover" : SWEEP_PRICE_COMMITTED,
      )
      expect(h.send).not.toHaveBeenCalled()
    },
  )
  it("treats a claim carrying no schedule as a quote to try again, not a committed price", async () => {
    const result = await claimTag("demo", keys, h.config, {} as never, undefined, true, old)
    if (result.kind !== "pending") throw new Error("expected new deposit")
    await result.broadcastDone
    const replacement = getPendingStore().get(OWNER)!
    h.balance.mockResolvedValue(5n * DAI)
    NameClaimStore.resetForTests()
    NameClaimStore.get(webStorage)
    await NameClaimStore.get().remove(L2)
    const { terms: _signed, ...unpriced } = claim()
    h.sign.mockResolvedValue(unpriced)
    h.schedule.mockClear()
    // The deployment's own fee is not this address's; a re-signed claim may yet price it.
    await expect(manualRegistrationSweep(replacement, { keys })).rejects.toThrow(
      SWEEP_QUOTE_UNUSABLE,
    )
    // One read prices both the claim decision and the check it feeds.
    expect(h.schedule).toHaveBeenCalledTimes(1)
    expect(h.send).not.toHaveBeenCalled()
    // The schedule the earlier claim signed is still what prices this registration.
    expect(loadRegistrationTerms(OWNER, "demo")).toMatchObject({
      fee: String(DAI / 2n),
      feeWaived: true,
    })
  })
  // The sweep credits an opening balance over the portal's cut, so a deposit that clears fee plus
  // minimum can still fall short of the floor the sweep enforces.
  it("holds a deposit the portal's cut lifts the floor above", async () => {
    const result = await claimTag("demo", keys, h.config, {} as never, undefined, true, old)
    if (result.kind !== "pending") throw new Error("expected new deposit")
    await result.broadcastDone
    const replacement = getPendingStore().get(OWNER)!
    h.balance.mockResolvedValue(5n * DAI)
    h.cut.mockResolvedValue(5n * DAI)
    await expect(manualRegistrationSweep(replacement, { keys })).rejects.toThrow(
      "does not yet cover",
    )
    expect(h.send).not.toHaveBeenCalled()
  })
  it("signs nothing while the portal's cut is unread, since the floor is unknown", async () => {
    const result = await claimTag("demo", keys, h.config, {} as never, undefined, true, old)
    if (result.kind !== "pending") throw new Error("expected new deposit")
    await result.broadcastDone
    const replacement = getPendingStore().get(OWNER)!
    h.balance.mockResolvedValue(5n * DAI)
    h.cut.mockRejectedValue(new Error("rpc down"))
    await expect(manualRegistrationSweep(replacement, { keys })).rejects.toThrow("Try again")
    expect(h.send).not.toHaveBeenCalled()
  })
  it("refuses the restart while the portal's cut is unread, rather than losing the refund's entry", async () => {
    h.cut.mockRejectedValue(new Error("rpc down"))

    await expect(
      claimTag("demo", keys, h.config, {} as never, undefined, true, old),
    ).rejects.toThrow("Try again")

    // Nothing was replaced, so the retry still has the refund to price an entry from.
    expect(getPendingStore().get(OWNER)?.sipaAddress).toBe(OLD)
    expect(h.broadcast).not.toHaveBeenCalled()

    h.cut.mockResolvedValue(0n)
    const result = await claimTag("demo", keys, h.config, {} as never, undefined, true, old)
    expect(result.kind).toBe("pending")
    expect(getPendingStore().get(OWNER)?.refundedEntry).toEqual({
      sipaAddress: OLD,
      recoveryTxHash: HASH,
      amount: String(5n * DAI),
    })
  })
  it.each(["not refunded", "standard quote", "same address"])(
    "preserves the old record when %s",
    async (reason) => {
      if (reason === "not refunded") h.balance.mockResolvedValue(5n * DAI)
      if (reason === "standard quote")
        h.sign.mockResolvedValue({
          ...claim(),
          terms: {
            ...claim().terms,
            fee: String(10n * DAI),
            minDeposit: String(5n * DAI),
            reduced: false,
          },
        })
      if (reason === "same address") h.derive.mockResolvedValue({ sipaAddress: OLD })
      await expect(
        claimTag("demo", keys, h.config, {} as never, undefined, true, old),
      ).rejects.toThrow(
        reason === "not refunded"
          ? "refund is not complete"
          : reason === "standard quote"
          ? "earned tag price has not been confirmed"
          : "did not produce a new address",
      )
      expect(getPendingStore().get(OWNER)?.sipaAddress).toBe(OLD)
      expect(h.broadcast).not.toHaveBeenCalled()
    },
  )
})

describe("ticket redemption after registration preflight", () => {
  const ticket = {
    fragment: "ticket-link",
    schedule: { fee: "500000000000000000", minDeposit: "0" },
  }
  const register = () =>
    claimTag("demo", keys, h.config, {} as never, undefined, false, undefined, undefined, ticket)

  it("does not redeem when the account already owns another tag", async () => {
    h.heldName.mockResolvedValue(HASH)
    await expect(register()).rejects.toThrow("this passkey already claimed another tag")
    expect(h.redeem).not.toHaveBeenCalled()
    expect(h.sign).not.toHaveBeenCalled()
    expect(h.derive).not.toHaveBeenCalled()
  })

  it("does not redeem when the requested tag already belongs to another account", async () => {
    h.registeredOwner.mockResolvedValue(NEW)
    await expect(register()).rejects.toThrow("@demo is already taken")
    expect(h.redeem).not.toHaveBeenCalled()
    expect(h.sign).not.toHaveBeenCalled()
  })

  it("does not redeem again when this account already registered the requested tag", async () => {
    h.registeredOwner.mockResolvedValue(OWNER)
    await expect(register()).resolves.toMatchObject({ kind: "custody", confirmed: true })
    expect(h.redeem).not.toHaveBeenCalled()
    expect(h.sign).not.toHaveBeenCalled()
  })

  it("leaves the ticket untouched when the account's registered name cannot be read", async () => {
    h.heldName.mockRejectedValue(new Error("L1 unavailable"))
    await expect(register()).rejects.toThrow("L1 unavailable")
    expect(h.redeem).not.toHaveBeenCalled()
    expect(h.sign).not.toHaveBeenCalled()
  })

  it("redeems after checking the account and before requesting its fee quote", async () => {
    h.redeem.mockImplementation(async () => {
      expect(h.registeredOwner).toHaveBeenCalledTimes(1)
      expect(h.heldName).toHaveBeenCalledTimes(1)
      expect(h.sign).not.toHaveBeenCalled()
      return { status: "created" }
    })
    await expect(register()).resolves.toMatchObject({ kind: "pending" })
    expect(h.redeem).toHaveBeenCalledTimes(1)
    expect(h.sign).toHaveBeenCalledTimes(1)
  })

  it("does not request paid terms when redemption fails", async () => {
    h.redeem.mockRejectedValueOnce(new Error("ticket_spent"))
    await expect(register()).rejects.toThrow("ticket_spent")
    expect(h.sign).not.toHaveBeenCalled()
    expect(h.derive).not.toHaveBeenCalled()
  })

  it("preserves the paused-ticket outcome so the wizard can explain the paid quote", async () => {
    h.redeem.mockResolvedValue({ status: "unavailable" })
    await expect(register()).resolves.toMatchObject({ kind: "pending", ticketUnavailable: true })
    expect(h.sign).toHaveBeenCalledTimes(1)
  })

  /** The tab dies right after the checkpoint: the consent read that follows it never answers. */
  const closeTabAfterCheckpoint = () =>
    h.metadataRegistry.mockRejectedValueOnce(new Error("tab closed after the checkpoint"))

  it("keeps the link on the checkpoint, so a reopen resumes without another proof or claim", async () => {
    h.sign.mockResolvedValue({ ...claim(), terms: { ...claim().terms, ticket: true } })
    closeTabAfterCheckpoint()
    await expect(register()).rejects.toThrow("tab closed after the checkpoint")
    expect(h.redeem).toHaveBeenCalledTimes(1)
    expect(h.sign).toHaveBeenCalledTimes(1)
    expect(getPendingStore().get(OWNER)).toMatchObject({
      sipaAddress: NEW,
      phase: "awaiting_deposit",
    })
    expect(loadRegistrationTerms(OWNER, "demo")).toMatchObject({
      feeWaived: true,
      paylinkFunded: true,
      paylinkId: "id:ticket-link",
    })
    // What the reopened wizard resumes by, pinned to the account the ticket bound.
    expect(ticketSignupRegistration("ticket-link", L2)?.account).toBe(OWNER)
    expect(ticketSignupRegistration("ticket-link", `0x${"99".repeat(32)}`)).toBeNull()
  })

  it("binds no link to a checkpoint whose quote does not honour the ticket", async () => {
    h.redeem.mockResolvedValue({ status: "unavailable" })
    closeTabAfterCheckpoint()
    await expect(register()).rejects.toThrow("tab closed after the checkpoint")
    expect(getPendingStore().get(OWNER)).toMatchObject({ sipaAddress: NEW })
    expect(loadRegistrationTerms(OWNER, "demo")).not.toHaveProperty("paylinkId")
    expect(ticketSignupRegistration("ticket-link", L2)).toBeNull()
  })
})
