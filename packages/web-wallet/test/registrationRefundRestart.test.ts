import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { walletStorage } from "../src/platform/storage/walletStorage"
import {
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  zeroAddress,
  type Address,
  type Hex,
  toFunctionSelector,
} from "viem"
import { Fr } from "@aztec/aztec.js/fields"
import {
  NameClaimStore,
  SIPADepositStore,
  composeWireNameHash,
  createPortalCapacityRegistry,
  createSipaProcessingObserver,
  type PendingRegistrationRecord,
  type PortalCapacityKey,
  type SipaProcessingObserver,
  type SipaProcessingState,
} from "@obsidion/front-core"
import { webStorage } from "../src/platform/storage/WebStorageAdapter"
import {
  freshPayloads,
  getBroadcastLedger,
  resetBroadcastsForTests,
} from "../src/features/broadcasts/broadcasts"
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
import { signOut } from "../src/features/identity/signOut"
import { ticketSignupRegistration } from "../src/features/paylink/ticketContinuation"
import {
  DAI,
  earnedTerms,
  nameClaim,
  resetRegistrationStores,
} from "./support/registrationFixtures"

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
  /** The pending-deposit observer; absent unless a test drives the capacity gate. */
  observer: { current: undefined as Pick<SipaProcessingObserver, "refreshForSweep"> | undefined },
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
vi.mock("../src/features/deposit/sipaProcessing", async (original) => ({
  ...(await original<object>()),
  sipaProcessingObserver: () => h.observer.current,
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
const { SweepRefusedError } = await import("../src/features/deposit/sipaSweep")
const OWNER = `0x${"11".repeat(20)}` as Address
const OLD = `0x${"22".repeat(20)}` as Address
const NEW = `0x${"33".repeat(20)}` as Address
const TOKEN = `0x${"44".repeat(20)}` as Address
const IMPL = `0x${"77".repeat(20)}` as Address
const PORTAL = `0x${"88".repeat(20)}` as Address
const L2 = `0x${"55".repeat(32)}` as Hex
const HASH = `0x${"66".repeat(32)}` as Hex
/** Answers the recovery's holding read: `balance` of the first token asked for. */
const held = (balance: bigint) => async () => balance
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
/** The earned 0.5 + 4.5 claim the restart is quoted. */
const claim = () => nameClaim({ signature: "0xaa", terms: earnedTerms() })
/** A claim on the standard 10 + 5 schedule, which the earned restart cannot use. */
const standardClaim = () =>
  nameClaim({
    terms: earnedTerms({ fee: String(10n * DAI), minDeposit: String(5n * DAI), reduced: false }),
  })
/** A refund receipt moving `amount` of the token off the old address. */
const transfer = (amount: bigint) => ({
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
const keys = {
  pubkeyHex: `0x${"11".repeat(64)}`,
  secretKey: new Fr(123n),
  account: { getAddress: () => ({ toString: () => L2 }), getAuthProvider: () => ({}) },
} as never
beforeEach(async () => {
  resetBroadcastsForTests()
  vi.clearAllMocks()
  localStorage.clear()
  resetRegistrationStores()
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
  await signInPending(1)
  recordDepositAdmission(old, 5n * DAI)
  h.sign.mockResolvedValue(claim())
  h.redeem.mockReset().mockResolvedValue({ status: "created" })
  h.registeredOwner.mockReset().mockResolvedValue(zeroAddress)
  h.heldName.mockReset().mockResolvedValue(`0x${"00".repeat(32)}`)
  h.cut.mockResolvedValue(0n)
  h.metadataRegistry.mockResolvedValue(OWNER)
  h.balance.mockResolvedValue(0n)
  h.receipt.mockResolvedValue(transfer(5n * DAI))
  h.derive.mockResolvedValue({
    sipaAddress: NEW,
    sipaArgs: {},
    recordData: "0x1234",
    registrationData: "0x1234",
    sharedSecretSalt: HASH,
    stealthScalar: 1n,
    origin: {
      protocol: "legacy-eoa",
      sipaFactory: OWNER,
      implementation: IMPL,
      intentHash: HASH,
      rollupVersion: "1",
      resweepable: false,
      recoveryAddress: OWNER,
    },
  })
  h.broadcast.mockRejectedValue(new Error("one-use registration broadcast already spent"))
  h.buildSweep.mockReturnValue({ to: OWNER, data: "0x1234" })
  h.send.mockResolvedValue(HASH)
  h.wait.mockResolvedValue(true)
})
/** Restarts the registration from `refunded`, the address whose deposit was recovered. */
const restart = (refunded = old) =>
  claimTag("demo", keys, h.config, {} as never, undefined, true, refunded)
/** Replaces `unfunded`, an address nothing reached, with one at the earned price. */
const replace = (unfunded = old) =>
  claimTag("demo", keys, h.config, {} as never, undefined, true, undefined, unfunded)
/** The restarted record, its broadcast settled, with 5 DAI at its address. */
const fundedReplacement = async () => {
  const result = await restart()
  if (result.kind !== "pending") throw new Error("expected new deposit")
  h.balance.mockResolvedValue(5n * DAI)
  return getPendingStore().get(OWNER)!
}
/** Drops the cached claim, so the next sweep asks the claim server again. */
const forgetClaim = async () => {
  NameClaimStore.resetForTests()
  NameClaimStore.get(webStorage)
  await NameClaimStore.get().remove(L2)
}
function signInPending(claimedAt: number) {
  return saveWalletIdentity({ address: L2, handle: "demo", pending: true, claimedAt })
}
/** Recovers the old address's deposit off the activity list, in a send that lands as `txHash`. */
const recoverOld = async (txHash: Hex) => {
  const { recoverSipaDeposit } = await import("../src/features/deposit/sipaRecovery")
  const rail = SIPADepositStore.get(webStorage)
  const run = async () => {
    await rail.upsert(OLD, { phase: "recovered", recoveryTxHash: txHash })
    return txHash
  }
  return recoverSipaDeposit(rail.get(OLD)!, {
    channel: { target: OWNER, sendTransaction: h.send, waitForReceipt: h.wait },
    chainId: 11155111,
    tokens: [{ address: TOKEN, symbol: "DAI", decimals: 18 }],
    readBalance: held(DAI / 5n),
    readEthBalance: async () => 0n,
    readReceipt: (hash) => h.receipt({ hash }),
    deployment: {} as never,
    store: rail,
    stealthKey: async () => ({} as never),
    run,
  })
}

describe("refund then restart the earned registration", () => {
  it("replaces the refunded commitment with 0.5 + 4.5 terms and retains access when broadcasting is spent", async () => {
    const result = await restart()
    expect(result.kind).toBe("pending")
    if (result.kind !== "pending") throw new Error("expected new deposit")
    expect(freshPayloads.has(NEW.toLowerCase())).toBe(false)
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
  describe("the capacity gate", () => {
    const blocked: SipaProcessingState = {
      reason: {
        kind: "capacity",
        requiredAtomic: 4n * DAI,
        availableAtomic: DAI,
        refill: { status: "unknown" },
        decimals: 18,
        observedAt: 1,
      },
      blocker: { kind: "capacity", observedAt: 1 },
    }
    const replacement = async () => {
      await restart()
      h.balance.mockResolvedValue(5n * DAI)
      return getPendingStore().get(OWNER)!
    }
    afterEach(() => {
      h.observer.current = undefined
    })

    it("re-reads the deposit's capacity and signs nothing while a blocker is confirmed", async () => {
      const refreshForSweep = vi.fn(async () => blocked)
      h.observer.current = { refreshForSweep }
      const record = await replacement()
      const sweep = manualRegistrationSweep(record, { keys })
      await expect(sweep).rejects.toBeInstanceOf(SweepRefusedError)
      await expect(sweep).rejects.toThrow(/stopped before signing/)
      expect(refreshForSweep).toHaveBeenCalledWith(
        NEW,
        expect.objectContaining({ intent: "registration", registrationFee: String(DAI / 2n) }),
      )
      expect(h.send).not.toHaveBeenCalled()
    })

    /** The production observer over the rail store, against a portal with 1 DAI left by default. */
    const exhausted = (availableAtomic = DAI) => {
      const readTerms = vi.fn(async () => ({
        portal: PORTAL,
        token: TOKEN,
        depositFee: DAI / 10n,
        fpcFundingCut: 0n,
      }))
      const read = vi.fn(async (key: PortalCapacityKey) => ({
        ...key,
        decimals: 18,
        blockNumber: 1n,
        blockTimestamp: BigInt(Math.floor(Date.now() / 1000)),
        rateAtomicPerSecond: 0n,
        globalLimitAtomic: 2_583n * DAI,
        availableAtomic,
      }))
      const registry = createPortalCapacityRegistry({
        read,
        visibility: { isVisible: () => true, onResume: () => () => {} },
        policy: { maxHeadAgeMs: Infinity },
      })
      h.observer.current = createSipaProcessingObserver({
        deposits: SIPADepositStore.get(webStorage),
        capacity: (key) => registry.store(key),
        readTerms,
        l1ChainId: 11155111,
      })
      return { readTerms, read }
    }

    const refusedBeforeSigning = async (
      record: PendingRegistrationRecord,
      { readTerms, read }: ReturnType<typeof exhausted>,
    ) => {
      const sweep = manualRegistrationSweep(record, { keys })
      await expect(sweep).rejects.toBeInstanceOf(SweepRefusedError)
      await expect(sweep).rejects.toThrow(/stopped before signing/)
      expect(readTerms).toHaveBeenCalledWith(IMPL)
      expect(read).toHaveBeenCalledWith(
        expect.objectContaining({ chainId: 11155111, portal: PORTAL, token: TOKEN }),
      )
      expect(h.buildSweep).not.toHaveBeenCalled()
      expect(h.send).not.toHaveBeenCalled()
    }

    describe("a stable deposit on mainnet", () => {
      const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address
      /** 5.06 USDC, which clears the 4.5 DAI floor after the swap's allowed loss. */
      const stable = async () => {
        const result = await restart()
        if (result.kind !== "pending") throw new Error("expected new deposit")
        h.config = { ...h.config, network: "mainnet" } as WebWalletConfig
        h.balance.mockImplementation(async ({ address }: { address: Address }) =>
          address === USDC ? 5_060_000n : 0n,
        )
        return getPendingStore().get(OWNER)!
      }

      it("checks capacity for the USDC the address holds, in USDC units", async () => {
        const refreshForSweep = vi.fn(async () => undefined)
        h.observer.current = { refreshForSweep }
        await expect(manualRegistrationSweep(await stable(), { keys })).resolves.toBe(HASH)
        expect(refreshForSweep).toHaveBeenCalledWith(
          NEW,
          expect.objectContaining({ amount: "5.06", tokenAddress: USDC, tokenDecimals: 6 }),
        )
      })

      it("lets the converted deposit through while any capacity is left", async () => {
        // Converted credit is unknown, so 1 DAI of room is not read as too little.
        exhausted()
        await expect(manualRegistrationSweep(await stable(), { keys })).resolves.toBe(HASH)
      })

      it("refuses the converted deposit before signing at zero capacity", async () => {
        const record = await stable()
        await refusedBeforeSigning(record, exhausted(0n))
      })
    })

    it("reads its own portal without a rail record and refuses before signing", async () => {
      const record = await replacement()
      expect(SIPADepositStore.get(webStorage).get(NEW)).toBeNull()
      await refusedBeforeSigning(record, exhausted())
    })

    /** The rail record the registration seeder writes, with `patch` over it. */
    const seedRail = (patch: { phase: "broadcast" | "resolved"; amount: string }) =>
      SIPADepositStore.get(webStorage).upsert(
        NEW,
        { phase: patch.phase, registrationFee: String(DAI / 2n) },
        {
          recipientL2Address: L2,
          messageSecret: HASH,
          recipientHash: HASH,
          recoveryAddress: OWNER,
          origin: {
            protocol: "legacy-eoa",
            sipaFactory: OWNER,
            implementation: IMPL,
            intentHash: HASH,
            rollupVersion: "1",
            resweepable: false,
            recoveryAddress: OWNER,
          },
          l1ChainId: 11155111,
          amount: patch.amount,
          tokenSymbol: "DAI",
          startTime: Date.now(),
          tokenAddress: TOKEN,
          tokenDecimals: 18,
          intent: "registration",
        },
      )

    it("reads its own portal while the rail record is still the unfunded placeholder", async () => {
      const record = await replacement()
      await seedRail({ phase: "broadcast", amount: "0" })
      await refusedBeforeSigning(record, exhausted())
      // The check reads live funding without writing it.
      expect(SIPADepositStore.get(webStorage).get(NEW)).toMatchObject({
        phase: "broadcast",
        amount: "0",
      })
    })

    it("reads its own portal for a resolved placeholder", async () => {
      const record = await replacement()
      await seedRail({ phase: "resolved", amount: "0" })
      await refusedBeforeSigning(record, exhausted())
      expect(SIPADepositStore.get(webStorage).get(NEW)?.phase).toBe("resolved")
    })

    it("measures a topped-up deposit at the balance it just read, not the smaller stored amount", async () => {
      const record = await replacement()
      // 1 DAI stored would fit the 1 DAI left after the 0.5 fee; the 5 DAI on chain does not.
      await seedRail({ phase: "broadcast", amount: "1" })
      await refusedBeforeSigning(record, exhausted())
      expect(SIPADepositStore.get(webStorage).get(NEW)?.amount).toBe("1")
    })

    it("names a capacity refusal decoded from the estimate", async () => {
      h.observer.current = { refreshForSweep: vi.fn(async () => undefined) }
      h.send.mockRejectedValueOnce(
        Object.assign(new Error("execution reverted"), {
          cause: { data: toFunctionSelector("Caps__GlobalLimitSurpassed()") },
        }),
      )
      const sweep = manualRegistrationSweep(await replacement(), { keys })
      await expect(sweep).rejects.toBeInstanceOf(SweepRefusedError)
      await expect(sweep).rejects.toThrow(
        /insufficient for this deposit, so the sweep did not go through/,
      )
    })

    it("after a reverted receipt, states a current blocker without calling it the cause", async () => {
      h.observer.current = {
        refreshForSweep: vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(blocked),
      }
      h.wait.mockResolvedValueOnce(false)
      const sweep = manualRegistrationSweep(await replacement(), { keys })
      await expect(sweep).rejects.toThrow(
        /could not determine why\. A relayer may have swept this deposit first, or the deposit is below the registration total\. Network capacity is currently insufficient for this deposit\.$/,
      )
      await expect(sweep).rejects.not.toBeInstanceOf(SweepRefusedError)
    })
  })

  it("restarts after a sign-out cleared the admission receipt and the refunded address holds nothing", async () => {
    await signOut()
    expect(hasDepositAdmission(old)).toBe(false)
    expect(hasWalletEntry()).toBe(false)
    await signInPending(2)
    expect(hasWalletEntry()).toBe(false)
    const result = await restart()
    expect(result.kind).toBe("pending")
    expect(getPendingStore().get(OWNER)?.sipaAddress).toBe(NEW)
    expect(hasWalletEntry()).toBe(true)
  })
  it("keeps wallet entry through a later sign-out: the replacement carries the verified refund", async () => {
    await restart()
    expect(getPendingStore().get(OWNER)?.refundedEntry).toEqual({
      sipaAddress: OLD,
      recoveryTxHash: HASH,
      amount: String(5n * DAI),
    })
    await signOut()
    expect(hasWalletEntry()).toBe(false)
    await signInPending(3)
    expect(hasWalletEntry()).toBe(true)
    expect(hasDepositAdmission(getPendingStore().get(OWNER)!)).toBe(false)
  })
  it("restarts from a refund whose receipt wait was interrupted before it confirmed", async () => {
    const rail = SIPADepositStore.get(webStorage)
    await rail.upsert(OLD, { phase: "recoverable", recoveryTxHash: HASH })
    await signOut()
    await signInPending(2)
    const result = await restart()
    expect(result.kind).toBe("pending")
    expect(rail.get(OLD)?.phase).toBe("recovered")
    expect(getPendingStore().get(OWNER)?.sipaAddress).toBe(NEW)
    expect(hasWalletEntry()).toBe(true)
  })
  it("keeps the verified refund on the replacement when the session dies after its checkpoint", async () => {
    h.metadataRegistry.mockRejectedValueOnce(new Error("rpc down"))
    await expect(restart()).rejects.toThrow("rpc down")
    const replacement = getPendingStore().get(OWNER)!
    expect(replacement.sipaAddress).toBe(NEW)
    expect(replacement.refundedEntry).toEqual({
      sipaAddress: OLD,
      recoveryTxHash: HASH,
      amount: String(5n * DAI),
    })
    await signOut()
    await signInPending(2)
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
    const unpriced = nameClaim()
    h.sign.mockResolvedValue(unpriced)
    const result = await claimTag("demo", keys, h.config, {} as never)
    expect(result.kind).toBe("pending")
    const terms = loadRegistrationTerms(OWNER, "demo")
    expect(terms?.deadline).toBe(Number(unpriced.deadline))
    // Absent is "no schedule named a kind", which is not the same as the standard one.
    expect(terms && "feeWaived" in terms).toBe(false)
  })
  it("keeps wallet entry when a funded registration is recovered from the activity list", async () => {
    await signOut()
    await signInPending(2)
    await getPendingStore().upsert(OWNER, { phase: "funded", fundedAt: 5, fundingTxHash: HASH })
    expect(hasDepositAdmission(old)).toBe(false)
    expect(hasWalletEntry()).toBe(true)
    await SIPADepositStore.get(webStorage).upsert(OLD, {
      phase: "recoverable",
      recoveryTxHash: undefined,
    })
    // The rest of the 15 DAI landed after the balance read; the receipt says what moved.
    h.receipt.mockResolvedValue(transfer(15n * DAI))
    await expect(recoverOld(HASH)).resolves.toBe(HASH)
    expect(getPendingStore().get(OWNER)).toMatchObject({
      sipaAddress: OLD,
      phase: "awaiting_deposit",
      refundedEntry: { sipaAddress: OLD, recoveryTxHash: HASH, amount: String(15n * DAI) },
    })
    expect(getPendingStore().get(OWNER)?.fundedAt).toBeUndefined()
    expect(hasWalletEntry()).toBe(true)
    await signOut()
    await signInPending(3)
    expect(hasWalletEntry()).toBe(true)
    const result = await restart(getPendingStore().get(OWNER)!)
    expect(result.kind).toBe("pending")
    expect(getPendingStore().get(OWNER)).toMatchObject({
      sipaAddress: NEW,
      refundedEntry: { sipaAddress: OLD },
    })
    expect(hasWalletEntry()).toBe(true)
  })
  it("keeps a funded registration's entry when the recovery's receipt cannot be read after it confirmed", async () => {
    await signOut()
    await signInPending(2)
    await getPendingStore().upsert(OWNER, { phase: "funded", fundedAt: 5, fundingTxHash: HASH })
    const rail = SIPADepositStore.get(webStorage)
    await rail.upsert(OLD, { phase: "recoverable", recoveryTxHash: undefined })
    h.receipt.mockRejectedValue(new Error("rpc down"))
    await expect(recoverOld(HASH)).resolves.toBe(HASH)
    expect(getPendingStore().get(OWNER)).toMatchObject({ phase: "funded", fundedAt: 5 })
    expect(hasWalletEntry()).toBe(true)
    await signOut()
    await signInPending(3)
    expect(hasWalletEntry()).toBe(true)
    // 0.2 DAI comes back and is recovered with a readable receipt while the 15 DAI one is not.
    const later = `0x${"99".repeat(32)}` as Hex
    h.receipt.mockImplementation(async ({ hash }: { hash: Hex }) => {
      if (hash === HASH) throw new Error("rpc down")
      return transfer(DAI / 5n)
    })
    await rail.upsert(OLD, { phase: "recoverable" })
    await expect(recoverOld(later)).resolves.toBe(later)
    expect(getPendingStore().get(OWNER)).toMatchObject({ phase: "funded", fundedAt: 5 })
    await reconcileRegistrationRefund(getPendingStore().get(OWNER)!, h.config)
    expect(getPendingStore().get(OWNER)).toMatchObject({ phase: "funded", fundedAt: 5 })
    await signOut()
    await signInPending(4)
    expect(hasWalletEntry()).toBe(true)
    h.receipt.mockResolvedValue(transfer(15n * DAI))
    await reconcileRegistrationRefund(getPendingStore().get(OWNER)!, h.config)
    // The 0.2 DAI sized while the stamp stood pools with the 15 DAI that bought entry.
    expect(getPendingStore().get(OWNER)).toMatchObject({
      phase: "awaiting_deposit",
      refundedEntry: {
        sipaAddress: OLD,
        recoveryTxHash: HASH,
        amount: String((152n * DAI) / 10n),
      },
    })
    await signOut()
    await signInPending(5)
    expect(hasWalletEntry()).toBe(true)
  })
  it("keeps wallet entry when the receipt that bought it is unreadable during the restart", async () => {
    const { registrationRefunded } = await import(
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
      if (hash === later) return transfer(DAI / 5n)
      if (failFirst) {
        failFirst = false
        throw new Error("rpc down")
      }
      return transfer(5n * DAI)
    })
    await expect(restart()).rejects.toThrow("could not be read")
    expect(getPendingStore().get(OWNER)?.sipaAddress).toBe(OLD)
    expect(hasWalletEntry()).toBe(true)
    const result = await restart()
    expect(result.kind).toBe("pending")
    expect(getPendingStore().get(OWNER)).toMatchObject({
      sipaAddress: NEW,
      refundedEntry: { sipaAddress: OLD, recoveryTxHash: HASH, amount: String(5n * DAI) },
    })
    await signOut()
    await signInPending(2)
    expect(hasWalletEntry()).toBe(true)
  })
  it("restarts on a refund below the earned total without buying wallet entry", async () => {
    await signOut()
    await signInPending(2)
    h.receipt.mockResolvedValue(transfer(DAI))
    const result = await restart()
    expect(result.kind).toBe("pending")
    const replacement = getPendingStore().get(OWNER)!
    expect(replacement.sipaAddress).toBe(NEW)
    expect(replacement.fee).toBe(String(DAI / 2n))
    expect(replacement.refundedEntry).toBeUndefined()
    expect(hasWalletEntry()).toBe(false)
  })
  it("replaces an unfunded old address at the earned price while it stays empty", async () => {
    const result = await replace()
    expect(result.kind).toBe("pending")
    if (result.kind !== "pending") throw new Error("expected new deposit")
    expect(freshPayloads.has(NEW.toLowerCase())).toBe(false)
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
    const result = await restart(legacy)
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
    expect(walletStorage.getItem("webwallet.registration.replaced")).toBe("[]")
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
    await expect(replace()).rejects.toThrow("rpc down")
    expect(getPendingStore().get(OWNER)?.sipaAddress).toBe(OLD)
    expect(JSON.parse(walletStorage.getItem("webwallet.registration.replaced")!)).toMatchObject([
      { sipaAddress: OLD, phase: "failed_terminal" },
    ])
  })
  it.each([
    ["replaced", () => replace(getPendingStore().get(OWNER)!), false],
    ["refunded", () => restart(getPendingStore().get(OWNER)!), true],
  ])(
    "leaves the broadcast to the relayer rail when the %s address never used it",
    async (_, run, refunded) => {
      await getPendingStore().upsert(OWNER, { broadcast: false })
      const result = await run()
      if (result.kind !== "pending") throw new Error("expected new deposit")
      // The sheet that shows the new address owes it, on the payload the session kept; the old
      // address is never owed.
      expect(getBroadcastLedger().get(NEW)).toBeNull()
      expect(freshPayloads.has(NEW.toLowerCase())).toBe(true)
      expect(freshPayloads.has(OLD.toLowerCase())).toBe(false)
      expect(getPendingStore().get(OWNER)).toMatchObject({
        sipaAddress: NEW,
        replaced: { sipaAddress: OLD, refunded, broadcastSpent: false },
      })
    },
  )
  it("inherits a spent broadcast through a chain of replacements", async () => {
    const spent = { sipaAddress: TOKEN, refunded: false, broadcastSpent: true }
    await getPendingStore().upsert(OWNER, { broadcast: false, replaced: spent })
    const result = await replace(getPendingStore().get(OWNER)!)
    if (result.kind !== "pending") throw new Error("expected new deposit")
    expect(h.broadcast).not.toHaveBeenCalled()
    expect(getPendingStore().get(OWNER)?.replaced).toEqual({ ...spent, sipaAddress: OLD })
  })
  it("keeps the replacement's quote and marker when a session dies past its checkpoint", async () => {
    h.metadataRegistry.mockRejectedValueOnce(new Error("rpc down"))
    await expect(replace()).rejects.toThrow("rpc down")
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
    await expect(replace()).rejects.toThrow("A deposit reached this address")
    expect(getPendingStore().get(OWNER)?.sipaAddress).toBe(OLD)
    expect(h.broadcast).not.toHaveBeenCalled()
  })
  it.each(["underfunded", "incompatible quote"])(
    "does not submit a manual sweep when %s",
    async (reason) => {
      const replacement = await fundedReplacement()
      if (reason === "underfunded") h.balance.mockResolvedValue(DAI)
      if (reason === "incompatible quote") {
        await forgetClaim()
        h.sign.mockResolvedValue(standardClaim())
      }
      await expect(manualRegistrationSweep(replacement, { keys })).rejects.toThrow(
        reason === "underfunded" ? "does not yet cover" : SWEEP_PRICE_COMMITTED,
      )
      expect(h.send).not.toHaveBeenCalled()
    },
  )
  it("treats a claim carrying no schedule as a quote to try again, not a committed price", async () => {
    const replacement = await fundedReplacement()
    await forgetClaim()
    h.sign.mockResolvedValue(nameClaim())
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
  it.each([
    ["the portal's cut lifts the floor above it", 5n * DAI, "does not yet cover"],
    ["the portal's cut is unread, so the floor is unknown", undefined, "Try again"],
  ])("signs nothing for a deposit while %s", async (_, cut, refusal) => {
    const replacement = await fundedReplacement()
    if (cut === undefined) h.cut.mockRejectedValue(new Error("rpc down"))
    else h.cut.mockResolvedValue(cut)
    await expect(manualRegistrationSweep(replacement, { keys })).rejects.toThrow(refusal)
    expect(h.send).not.toHaveBeenCalled()
  })
  // The SIPA swaps a stable into DAI at up to 1% loss before the controller floors it, so a stable
  // that only meets the floor at parity is held; one that clears it after the loss sweeps.
  it("sweeps the stable a mainnet deposit holds once it clears the floor after the swap", async () => {
    const replacement = await fundedReplacement()
    h.config = { ...h.config, network: "mainnet" } as WebWalletConfig
    const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
    let usdc = 5_000_000n
    h.balance.mockImplementation(async ({ address }: { address: Address }) =>
      address === USDC ? usdc : 0n,
    )
    await expect(manualRegistrationSweep(replacement, { keys })).rejects.toThrow(
      "does not yet cover",
    )
    expect(h.send).not.toHaveBeenCalled()
    usdc = 5_060_000n
    await expect(manualRegistrationSweep(replacement, { keys })).resolves.toBe(HASH)
    expect(h.buildSweep).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ manifest: expect.objectContaining({ token: USDC }) }),
    )
  })
  it("refuses the restart while the portal's cut is unread, rather than losing the refund's entry", async () => {
    h.cut.mockRejectedValue(new Error("rpc down"))

    await expect(restart()).rejects.toThrow("Try again")

    // Nothing was replaced, so the retry still has the refund to price an entry from.
    expect(getPendingStore().get(OWNER)?.sipaAddress).toBe(OLD)
    expect(h.broadcast).not.toHaveBeenCalled()

    h.cut.mockResolvedValue(0n)
    const result = await restart()
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
      if (reason === "standard quote") h.sign.mockResolvedValue(standardClaim())
      if (reason === "same address") h.derive.mockResolvedValue({ sipaAddress: OLD })
      await expect(restart()).rejects.toThrow(
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
    h.sign.mockResolvedValue(nameClaim({ terms: earnedTerms({ ticket: true }) }))
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
