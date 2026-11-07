// The manual registration sweep over its injected deployment, L1 reads, claim and channel.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { toFunctionSelector, type Address, type Hex } from "viem"
import { Fr } from "@aztec-labs/aztec.js/fields"
import {
  createPortalCapacityRegistry,
  createSipaProcessingObserver,
  type NameClaimRecord,
  type PortalCapacityKey,
  type SipaFundingToken,
} from "@obsidion/front-core"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  runRegistrationSweep,
  type RegistrationSweepDeps,
} from "../../../src/features/registration/registrationSweep"
import { SweepRefusedError } from "../../../src/features/sipa/sipaSweep"
import { closeSession, type Session } from "../../../src/session/session"
import { openTestSession } from "../../support/session"
import { seedDeviceKeys } from "../../support/page"
import {
  DAI,
  FAR_DEADLINE,
  earnedTerms,
  pendingRecord,
  seedRegistration,
  seedRegistrationRail,
  storedRegistration,
} from "../../support/registrationFixtures"
import { PAID, RANDOM, RANDOM_ASK } from "../../support/registrationPrices"
import { viewedSipaDeposit } from "../../support/sipaDeposits"

const OWNER = `0x${"11".repeat(20)}` as Address
const SIPA = `0x${"33".repeat(20)}` as Address
const TOKEN = `0x${"44".repeat(20)}` as Address
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address
const IMPL = `0x${"77".repeat(20)}` as Address
const PORTAL = `0x${"88".repeat(20)}` as Address
const TABLE = `0x${"99".repeat(20)}` as Address
const L2 = `0x${"55".repeat(32)}` as Hex
const HASH = `0x${"66".repeat(32)}` as Hex
const TX = `0x${"ab".repeat(32)}` as Hex
const SALT = `0x${"0c".repeat(32)}` as Hex
const ENV = {
  registry: OWNER,
  factory: OWNER,
  ensDomain: "zk.money",
  resolverOperator: OWNER,
  rollupVersion: 1n,
  l1ChainId: 11155111,
  feeToken: TOKEN,
  namePortalRecipient: L2,
  entryPoint: "0x4337084d9e255ff0702461cf8895ce9e3b5ff108" as Address,
}
const TUPLE = {
  sipaFactory: OWNER,
  forwardingTable: TABLE,
  portal: PORTAL,
  rollupVersion: "1",
  token: TOKEN,
} as OxideEnvTuple
const ORIGIN = {
  protocol: "account",
  sipaFactory: OWNER,
  implementation: IMPL,
  intentHash: HASH,
  rollupVersion: "1",
  resweepable: false,
  recoveryAccount: OWNER,
  recoveryCommitment: HASH,
  accountFactory: OWNER,
  forwardingTable: TABLE,
} as const
/** What the wallet's key derives for the record; `SALT` is the salt the address was seeded with. */
const DERIVATION = {
  sipaAddress: SIPA,
  sipaArgs: {
    implementation: IMPL,
    intentHash: HASH,
    recoveryCommitment: HASH,
    rollupVersion: 1n,
    resweepable: false,
    forwardingTable: TABLE,
  },
  origin: ORIGIN,
  recipient: L2,
  sharedSecretSalt: SALT,
  recipientCommitment: HASH,
  registrationData: "0x1234" as Hex,
  recordData: "0x1234" as Hex,
  registration: HASH,
  stealthScalar: 1n,
}
const DAI_ROW: SipaFundingToken = { address: TOKEN, symbol: "DAI", decimals: 18 }
const STABLES: [SipaFundingToken, ...SipaFundingToken[]] = [
  DAI_ROW,
  { address: USDC, symbol: "USDC", decimals: 6 },
]
/** The random-tag floor in USDC units, and the least USDC that clears it after the swap's loss. */
const USDC_FLOOR = (RANDOM.fee + RANDOM.min) / 10n ** 12n
const USDC_CLEARS = (USDC_FLOOR * 10_000n) / 9_900n + 1n

const record = pendingRecord({
  account: OWNER,
  sipaAddress: SIPA,
  l2Address: L2,
  nameHash: HASH,
  depositToken: TOKEN,
  fee: String(RANDOM.fee),
  r1Key: { qx: HASH, qy: HASH },
  credentialId: "Y3JlZC1pZC0wMDE",
})
const keys = {
  secretKey: new Fr(123n),
  account: { getAddress: () => ({ toString: () => L2 }), getAuthProvider: () => ({}) },
} as never
/** The record's claim, signed on `terms`. */
const claimOn = (terms?: NameClaimRecord["terms"]): NameClaimRecord => ({
  address: L2,
  handle: record.tag,
  nameHash: HASH,
  signature: `0x${"cc".repeat(65)}`,
  nonce: "1",
  deadline: FAR_DEADLINE,
  ...(terms ? { terms } : {}),
})

let own: Session
const held = new Map<string, bigint>()
const send = vi.fn()
const wait = vi.fn()
const claim = vi.fn()
const schedule = vi.fn()
const cap = vi.fn()
const derive = vi.fn()
let tokens: [SipaFundingToken, ...SipaFundingToken[]]
let capacity: RegistrationSweepDeps["capacity"]

const deps = (): RegistrationSweepDeps => ({
  env: ENV,
  tuple: TUPLE,
  client: {
    readContract: async ({ address }: { address: string }) => held.get(address.toLowerCase()) ?? 0n,
    getCode: async () => undefined,
  } as never,
  reader: {
    readAccountMetadataRegistry: async () => OWNER,
    getUserOpHash: async () => HASH,
    readR1InstallGas: async () => ({
      verification: 50_000n,
      callBase: 85_000n,
      callPerWord: 30_000n,
    }),
    // The account has no code yet, so consent signs with the bootstrap key.
    getCode: async () => undefined,
  } as never,
  derive,
  claim,
  schedule,
  cap,
  tokens: async () => tokens,
  capacity: (live) => capacity(live),
  channel: async () => ({ target: OWNER, sendTransaction: send, waitForReceipt: wait }),
  registrations: own.registrations,
  sipaDeposits: own.sipaDeposits,
})
const sweep = () => runRegistrationSweep(deps(), record, { keys })
const hold = (token: Address, amount: bigint) => held.set(token.toLowerCase(), amount)
/** What the address showed the rail, as the seeder wrote it. */
const seedRail = (patch: {
  phase: "broadcast" | "resolved"
  amount: string
  messageSecret?: Hex
}) =>
  seedRegistrationRail(record, patch, {
    registrationFee: record.fee,
    origin: ORIGIN,
    tokenDecimals: 18,
    messageSecret: patch.messageSecret ?? HASH,
  })
/** The deposits' processing observer over a portal with `availableAtomic` of room. */
function portalWithRoom(availableAtomic: bigint) {
  const registry = createPortalCapacityRegistry({
    read: async (key: PortalCapacityKey) => ({
      ...key,
      decimals: 18,
      blockNumber: 1n,
      blockTimestamp: BigInt(Math.floor(Date.now() / 1000)),
      rateAtomicPerSecond: 0n,
      globalLimitAtomic: 2_583n * DAI,
      availableAtomic,
      txAmountCapAtomic: 10_000n * DAI,
    }),
    visibility: { isVisible: () => true, onResume: () => () => {} },
    policy: { maxHeadAgeMs: Infinity },
  })
  const observer = createSipaProcessingObserver({
    deposits: own.sipaDeposits.view,
    capacity: (key) => registry.store(key),
    readTerms: async () => ({
      portal: PORTAL,
      token: TOKEN,
      depositFee: DAI / 10n,
      txAmountCap: 10_000n * DAI,
    }),
    l1ChainId: 11155111,
  })
  capacity = (live) => observer.refreshForSweep(SIPA, live)
}
const signedNothing = () => expect(send).not.toHaveBeenCalled()

beforeEach(async () => {
  vi.clearAllMocks()
  held.clear()
  localStorage.clear()
  await seedDeviceKeys({ storageId: "a1" })
  own = openTestSession()
  await own.registrations.ready
  await seedRegistration(record)
  tokens = [DAI_ROW]
  capacity = async () => undefined
  hold(TOKEN, RANDOM_ASK)
  derive.mockResolvedValue(DERIVATION)
  claim.mockResolvedValue(claimOn(earnedTerms()))
  schedule.mockResolvedValue({ fee: RANDOM.fee, min: RANDOM.min })
  cap.mockResolvedValue(10_000n * DAI)
  send.mockResolvedValue(TX)
  wait.mockResolvedValue(true)
})
afterEach(closeSession)

describe("runRegistrationSweep", () => {
  it("sweeps a funded address and stamps the record and the rail with the sweep", async () => {
    await seedRail({ phase: "resolved", amount: "5" })
    await expect(sweep()).resolves.toBe(TX)
    expect(await storedRegistration(SIPA)).toMatchObject({ sweepTxHash: TX })
    expect(viewedSipaDeposit(SIPA)).toMatchObject({ sweepTxHash: TX })
  })

  it("stops before signing when the claim derives another address, and sweeps from the seeded salt", async () => {
    // The wallet's key now derives another address; only the seeded salt lands on this one.
    derive.mockImplementation(async ({ sharedSecretSalt }: { sharedSecretSalt?: Hex }) =>
      sharedSecretSalt === SALT ? DERIVATION : { ...DERIVATION, sipaAddress: OWNER },
    )
    await expect(sweep()).rejects.toMatchObject({ code: "registration.sweepAddressMismatch" })
    signedNothing()
    await seedRail({ phase: "resolved", amount: "5", messageSecret: SALT })
    await expect(sweep()).resolves.toBe(TX)
  })

  it("refuses an address that holds nothing", async () => {
    hold(TOKEN, 0n)
    await expect(sweep()).rejects.toMatchObject({ code: "deposit.alreadySwept" })
    signedNothing()
  })

  it("signs nothing at an address priced at another fee", async () => {
    claim.mockResolvedValue(
      claimOn(earnedTerms({ fee: String(PAID.fee), minDeposit: String(PAID.min) })),
    )
    await expect(sweep()).rejects.toMatchObject({ code: "registration.priceCommitted" })
    signedNothing()
  })

  it("asks again for a claim that signed no schedule, priced by one schedule read", async () => {
    claim.mockResolvedValue(claimOn())
    schedule.mockResolvedValue({ fee: PAID.fee, min: PAID.min })
    await expect(sweep()).rejects.toMatchObject({ code: "registration.quoteUnusable" })
    expect(schedule).toHaveBeenCalledTimes(1)
    signedNothing()
    // The deployment's own schedule prices a terms-less claim when it names the committed fee.
    schedule.mockResolvedValue({ fee: RANDOM.fee, min: RANDOM.min })
    await expect(sweep()).resolves.toBe(TX)
  })

  it("signs nothing while the portal's cap is unread", async () => {
    cap.mockRejectedValue(new Error("rpc down"))
    await expect(sweep()).rejects.toMatchObject({ code: "registration.capUnread" })
    signedNothing()
  })

  it("sweeps the stable a mainnet deposit holds only once it clears the floor after the swap", async () => {
    tokens = STABLES
    hold(TOKEN, 0n)
    hold(USDC, USDC_FLOOR)
    await expect(sweep()).rejects.toMatchObject({ code: "registration.depositShort" })
    signedNothing()
    hold(USDC, USDC_CLEARS)
    await expect(sweep()).resolves.toBe(TX)
  })
})

describe("the capacity gate", () => {
  const refusedBeforeSigning = async () => {
    await expect(sweep()).rejects.toBeInstanceOf(SweepRefusedError)
    signedNothing()
  }

  it("lets a converted stable deposit through while any capacity is left", async () => {
    // Converted credit is unknown, so 1 DAI of room is not read as too little.
    tokens = STABLES
    hold(TOKEN, 0n)
    hold(USDC, USDC_CLEARS)
    portalWithRoom(DAI)
    await expect(sweep()).resolves.toBe(TX)
  })

  it("refuses a converted stable deposit before signing at zero capacity", async () => {
    tokens = STABLES
    hold(TOKEN, 0n)
    hold(USDC, USDC_CLEARS)
    portalWithRoom(0n)
    await refusedBeforeSigning()
  })

  it("measures a topped-up deposit at the balance it just read, not the smaller stored amount", async () => {
    // 1 DAI stored fits the 1 DAI of room after the fee; the 5 DAI on chain does not.
    await seedRail({ phase: "broadcast", amount: "1" })
    hold(TOKEN, 5n * DAI)
    portalWithRoom(DAI)
    await refusedBeforeSigning()
    expect(viewedSipaDeposit(SIPA)?.amount).toBe("1")
  })

  it("names a capacity refusal decoded from the estimate", async () => {
    send.mockRejectedValueOnce(
      Object.assign(new Error("execution reverted"), {
        cause: { data: toFunctionSelector("Caps__GlobalLimitSurpassed()") },
      }),
    )
    await expect(sweep()).rejects.toBeInstanceOf(SweepRefusedError)
    expect((await storedRegistration(SIPA))?.sweepTxHash).toBeUndefined()
  })

  it("stamps nothing for a sweep whose receipt reverted", async () => {
    wait.mockResolvedValueOnce(false)
    const sweeping = sweep()
    await expect(sweeping).rejects.toMatchObject({
      code: "registration.sweepReverted",
      data: { hash: TX },
    })
    await expect(sweeping).rejects.not.toBeInstanceOf(SweepRefusedError)
    expect((await storedRegistration(SIPA))?.sweepTxHash).toBeUndefined()
  })
})
