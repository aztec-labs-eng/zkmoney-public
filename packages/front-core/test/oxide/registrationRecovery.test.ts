// A registration's refund read off L1 receipts and balances, over the real stores.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { encodeAbiParameters, encodeEventTopics, erc20Abi, type Address, type Hex } from "viem"
import { openDatabase, type Database } from "../../src/engine/database"
import { memoryBackend } from "../../src/engine/memoryBackend"
import { encodeRecord, loadRecords } from "../../src/engine/persistentStore"
import type { PendingRegistrationRecord } from "../../src/engine/registrationRecord"
import { createRegistrations, latestRegistration } from "../../src/engine/registrations"
import { createSipaDeposits, type SipaDeposit } from "../../src/engine/sipaDeposits"
import {
  createRegistrationRecovery,
  registrationNeedsRefund,
} from "../../src/oxide/registrationRefunds"
import type { SipaFundingToken } from "../../src/oxide/sipaFunding"

const DAI = 10n ** 18n
const ACCOUNT = `0x${"11".repeat(20)}` as Address
const SIPA = `0x${"22".repeat(20)}` as Address
const TOKEN = `0x${"33".repeat(20)}` as Address
const TARGET = `0x${"44".repeat(20)}` as Address
const L2 = `0x${"55".repeat(32)}` as Hex
const HASH = `0x${"66".repeat(32)}` as Hex
const LATER = `0x${"88".repeat(32)}` as Hex
const MAINNET_DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F" as Address
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address
/** What a refund must reach to buy entry here. */
const FLOOR = 5n * DAI

const RECORD: PendingRegistrationRecord = {
  account: ACCOUNT,
  tag: "demo",
  nameHash: HASH,
  sipaAddress: SIPA,
  depositToken: TOKEN,
  l2Address: L2,
  l1ChainId: 11155111,
  fee: String(10n * DAI),
  beneficiary: TARGET,
  broadcast: false,
  phase: "awaiting_deposit",
  retries: 3,
  startTime: 1,
}
/** An earned registration quoted the standard schedule: what the earned price recovers from. */
const TERMS = {
  deadline: 0,
  fee: String(10n * DAI),
  minDeposit: String(5n * DAI),
  feeWaived: false,
  earnedExpected: true,
}
const SEEN = 5n * DAI
const RAIL: SipaDeposit = {
  sipaAddress: SIPA,
  phase: "broadcast",
  networkId: "0xnet",
  messageSecret: HASH,
  recoveryAddress: TARGET,
  recipientHash: HASH,
  recipientL2Address: L2,
  tokenAddress: TOKEN,
  tokenSymbol: "DAI",
  l1ChainId: 11155111,
  amount: "0",
  startTime: 1,
}

/** A transfer of `amount` of `token` from `from`, as a receipt log. */
const transfer = (amount: bigint, token: Address = TOKEN, from: Address = SIPA) => ({
  address: token,
  topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to: TARGET } }),
  data: encodeAbiParameters([{ type: "uint256" }], [amount]),
})
const moved = (...logs: ReturnType<typeof transfer>[]) => ({ status: "success", logs })

let db: Database
let stores: ReturnType<typeof open>
const balance = vi.fn()
const receipt = vi.fn()
const decimalsOf = vi.fn()
const heal = vi.fn()
let tokens: (fee: SipaFundingToken) => [SipaFundingToken, ...SipaFundingToken[]]

function open() {
  const backend = memoryBackend(
    new Map([
      [`acct/registrations/${SIPA.toLowerCase()}`, encodeRecord(RECORD)],
      [`acct/sipaDeposits/${SIPA.toLowerCase()}`, encodeRecord(RAIL)],
    ]),
  )
  db = openDatabase(backend)
  const sipaDeposits = createSipaDeposits({ db, account: true, now: () => Date.now() })
  const registrations = createRegistrations({
    db,
    legacy: db,
    deposits: sipaDeposits,
    account: true,
    now: () => Date.now(),
  })
  const recovery = createRegistrationRecovery({
    registrations,
    sipaDeposits,
    l1: () => ({ readContract: balance, getTransactionReceipt: receipt } as never),
    fundingTokens: async (fee) => tokens(fee),
    decimalsOf,
    admissionFloor: () => FLOOR,
    entryFor: (record, refund) =>
      refund.amount < FLOOR
        ? undefined
        : {
            sipaAddress: record.sipaAddress,
            recoveryTxHash: refund.txHash,
            amount: refund.amount.toString(),
          },
    heal,
  })
  return { sipaDeposits, registrations, recovery }
}

/** Lays `patch` over the record saved at `key`, past the transition, as a fixture. */
async function force<R>(key: string, read: () => Promise<R | undefined>, patch: Partial<R>) {
  const held = await read()
  await db.write(async (w) => w.put(key, encodeRecord({ ...held, ...patch })))
}
const rail = async (patch: Partial<SipaDeposit>) => {
  await force(`acct/sipaDeposits/${SIPA.toLowerCase()}`, () => stores.sipaDeposits.get(SIPA), patch)
  await loadRecords(stores.sipaDeposits.view)
}
const registration = async (patch: Partial<PendingRegistrationRecord>) => {
  await force(
    `acct/registrations/${SIPA.toLowerCase()}`,
    () => stores.registrations.get(SIPA),
    patch,
  )
  await loadRecords(stores.registrations.view)
}
const live = () => latestRegistration(stores.registrations.view.get().records, ACCOUNT)
const railNow = () => stores.sipaDeposits.view.get().records[0]
const readReceipt = (hash: Hex) => receipt({ hash })
const markRefunded = (hash: Hex = HASH) => rail({ phase: "recovered", recoveryTxHash: hash })

beforeEach(async () => {
  vi.clearAllMocks()
  tokens = (fee) => [fee]
  balance.mockResolvedValue(0n)
  receipt.mockResolvedValue(moved(transfer(5n * DAI)))
  decimalsOf.mockResolvedValue(6)
  stores = open()
  await loadRecords(stores.registrations.view)
  await loadRecords(stores.sipaDeposits.view)
})

describe("registrationNeedsRefund", () => {
  it("offers recovery for a deposit at an address the earned quote cannot use", () => {
    expect(registrationNeedsRefund(RECORD, TERMS, true, SEEN)).toBe(true)
    const earned = { ...TERMS, fee: String(DAI / 2n), minDeposit: String((45n * DAI) / 10n) }
    expect(registrationNeedsRefund(RECORD, earned, true, SEEN)).toBe(true)
    expect(registrationNeedsRefund(RECORD, TERMS, false, SEEN)).toBe(false)
    expect(registrationNeedsRefund({ ...RECORD, phase: "confirmed" }, TERMS, true, SEEN)).toBe(
      false,
    )
    // A deposit clearing this schedule's floor completes at the price it committed to.
    expect(registrationNeedsRefund(RECORD, TERMS, true, 15n * DAI)).toBe(false)
    expect(registrationNeedsRefund({ ...RECORD, fee: earned.fee }, earned, true, SEEN)).toBe(false)
  })

  it("calls for a refund on the committed fee alone", () => {
    // A fee under the relayer's sweep cut, and one the terms disagree with, both stand on their own.
    expect(registrationNeedsRefund(RECORD, TERMS, true, SEEN, 20n * DAI)).toBe(true)
    expect(registrationNeedsRefund(RECORD, { ...TERMS, fee: String(3n * DAI) }, true, SEEN)).toBe(
      true,
    )
    // With no minimum to price a floor, the committed fee decides it.
    const unpriced = { ...TERMS, minDeposit: undefined }
    expect(registrationNeedsRefund({ ...RECORD, phase: "funded" }, unpriced, true, SEEN)).toBe(true)
    expect(registrationNeedsRefund(RECORD, unpriced, true, SEEN)).toBe(true)
    // A legacy fee below the deployed sweep floor needs the refund however well the deposit covers.
    const legacy = { ...RECORD, fee: "0" }
    const legacyTerms = { ...TERMS, fee: "0", feeWaived: true }
    expect(registrationNeedsRefund(legacy, legacyTerms, true, SEEN)).toBe(false)
    expect(registrationNeedsRefund(legacy, legacyTerms, true, SEEN, DAI / 2n)).toBe(true)
    expect(
      registrationNeedsRefund({ ...legacy, fundedAt: 1 }, legacyTerms, true, SEEN, DAI / 2n),
    ).toBe(true)
  })

  it("never flags a registration nobody promised the earned price", () => {
    const fee = String(5n * DAI)
    const standard = { deadline: 0, fee, minDeposit: String(10n * DAI), feeWaived: false }
    expect(registrationNeedsRefund({ ...RECORD, fee }, standard, true, SEEN, DAI / 10n)).toBe(false)
  })
})

describe("a refund confirmed off any surface", () => {
  it("is kept through a later recovery of another token, and only an accepted token's counts", async () => {
    const { recovery } = stores
    // Another token recovered off the address is not the registration's refund.
    await recovery.confirmed(SIPA, TARGET, LATER, readReceipt)
    expect(recovery.refunded(RECORD)).toBe(false)
    await recovery.confirmed(SIPA, TOKEN, HASH, readReceipt)
    expect(recovery.refunded(RECORD)).toBe(true)
    await rail({ phase: "recovered", tokenAddress: TARGET, recoveryTxHash: LATER })
    receipt.mockImplementation(async ({ hash }) =>
      moved(...(hash === HASH ? [transfer(5n * DAI)] : [])),
    )
    expect(recovery.refunded(RECORD)).toBe(true)
    await expect(recovery.assertRefunded(RECORD)).resolves.toEqual({
      amount: 5n * DAI,
      txHash: HASH,
    })
  })

  it("settles a funded record into the entry its refund bought", async () => {
    await registration({ phase: "funded", fundedAt: 5, fundingTxHash: HASH })
    await stores.recovery.confirmed(SIPA, TOKEN, HASH, readReceipt)
    expect(live()).toMatchObject({
      phase: "awaiting_deposit",
      refundedEntry: { sipaAddress: SIPA, recoveryTxHash: HASH, amount: String(5n * DAI) },
    })
    expect(live()?.fundedAt).toBeUndefined()
  })

  it("buys no entry below the floor", async () => {
    receipt.mockResolvedValue(moved(transfer(FLOOR - 1n)))
    await stores.recovery.confirmed(SIPA, TOKEN, HASH, readReceipt)
    expect(live()?.refundedEntry).toBeUndefined()
    expect(live()?.refunds?.amounts).toEqual({ [HASH]: String(FLOOR - 1n) })
  })

  it("leaves a funded record alone while its receipt is unread, and reconciliation settles it", async () => {
    await registration({ phase: "funded", fundedAt: 5, fundingTxHash: HASH })
    await stores.recovery.confirmed(SIPA, TOKEN, HASH, async () => {
      throw new Error("rpc down")
    })
    expect(live()).toMatchObject({ phase: "funded", fundedAt: 5 })
    expect(live()?.refundedEntry).toBeUndefined()
    expect(stores.recovery.refunded(RECORD)).toBe(true)
    receipt.mockRejectedValueOnce(new Error("rpc down"))
    await stores.recovery.reconcile(RECORD)
    expect(live()).toMatchObject({ phase: "funded", fundedAt: 5 })
    receipt.mockResolvedValue(moved(transfer(15n * DAI)))
    await stores.recovery.reconcile(RECORD)
    expect(live()).toMatchObject({
      phase: "awaiting_deposit",
      refundedEntry: { sipaAddress: SIPA, recoveryTxHash: HASH, amount: String(15n * DAI) },
    })
    await stores.recovery.reconcile(RECORD)
    expect(receipt).toHaveBeenCalledTimes(2)
    expect(balance).not.toHaveBeenCalled()
  })
})

describe("assertRefunded", () => {
  it("asks for another recovery when funds return to a refunded address", async () => {
    await markRefunded()
    expect(stores.recovery.refunded(RECORD)).toBe(true)
    await rail({ phase: "recoverable" })
    expect(stores.recovery.refunded(RECORD)).toBe(false)
    balance.mockResolvedValue(DAI / 5n)
    await expect(stores.recovery.assertRefunded(RECORD)).rejects.toMatchObject({
      code: "refund.notRecovered",
    })
    await markRefunded(LATER)
    balance.mockResolvedValue(0n)
    await expect(stores.recovery.assertRefunded(RECORD)).resolves.toEqual({
      amount: 5n * DAI,
      txHash: LATER,
    })
  })

  it("restarts from a refund whose receipt wait ended before it confirmed", async () => {
    await rail({ phase: "recoverable", recoveryTxHash: HASH })
    await expect(stores.recovery.assertRefunded(RECORD)).resolves.toEqual({
      amount: 5n * DAI,
      txHash: HASH,
    })
    expect(railNow()).toMatchObject({ phase: "recovered", recoveryTxHash: HASH })
  })

  it("goes past an unread receipt on a refund that clears the floor alone", async () => {
    receipt.mockImplementation(async ({ hash }) => {
      if (hash === LATER) throw new Error("rpc down")
      return moved(transfer(FLOOR))
    })
    await markRefunded()
    await stores.recovery.reconcile(RECORD)
    await rail({ phase: "recoverable" })
    await markRefunded(LATER)
    await expect(stores.recovery.assertRefunded(RECORD)).resolves.toEqual({
      amount: FLOOR,
      txHash: HASH,
    })
  })

  it("goes past a reconcile that could not read a receipt, on the receipts it reads itself", async () => {
    await markRefunded()
    await stores.recovery.reconcile(RECORD)
    await rail({ phase: "recovered", recoveryTxHash: LATER, tokenAddress: TARGET })
    receipt.mockImplementation(async ({ hash }) => {
      if (hash === LATER) throw new Error("rpc down")
      return moved(transfer(5n * DAI))
    })
    await expect(stores.recovery.assertRefunded(RECORD)).resolves.toEqual({
      amount: 5n * DAI,
      txHash: HASH,
    })
  })

  it("holds the restart on an unread receipt that may be the one that bought entry", async () => {
    await markRefunded()
    await stores.recovery.reconcile(RECORD)
    await rail({ phase: "recoverable" })
    await markRefunded(LATER)
    let failFirst = true
    receipt.mockImplementation(async ({ hash }) => {
      if (hash === LATER) return moved(transfer(DAI / 5n))
      if (failFirst) {
        failFirst = false
        throw new Error("rpc down")
      }
      return moved(transfer(15n * DAI))
    })
    await expect(stores.recovery.assertRefunded(RECORD)).rejects.toMatchObject({
      code: "refund.receiptUnread",
    })
    await expect(stores.recovery.assertRefunded(RECORD)).resolves.toEqual({
      amount: 15n * DAI,
      txHash: HASH,
    })
  })

  it.each(["l2Address", "depositToken"] as const)(
    "never reads another registration's recovered deposit as this one's: %s",
    async (field) => {
      await markRefunded()
      expect(stores.recovery.refunded({ ...RECORD, [field]: TARGET })).toBe(false)
    },
  )

  it.each([
    ["reverted", { status: "reverted", logs: [transfer(5n * DAI)] }],
    ["no transfer", moved()],
    ["wrong token", moved(transfer(5n * DAI, TARGET))],
    ["wrong source", moved(transfer(5n * DAI, TOKEN, TARGET))],
  ])("refuses the restart when the refund %s", async (_, read) => {
    await markRefunded()
    receipt.mockResolvedValue(read)
    await expect(stores.recovery.assertRefunded(RECORD)).rejects.toMatchObject({
      code: "refund.incomplete",
    })
    expect(live()?.sipaAddress).toBe(SIPA)
  })

  it("writes nothing when read, and reconciliation remembers the refund the rail shows", async () => {
    await markRefunded()
    expect(stores.recovery.refunded(RECORD)).toBe(true)
    // A write the read started would have landed by the next task.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(live()?.refunds).toBeUndefined()
    await stores.recovery.reconcile(RECORD)
    expect(live()?.refunds?.txHashes).toEqual([HASH])
  })

  it("refuses a record changed while the confirmation was read", async () => {
    await markRefunded()
    receipt.mockImplementation(async () => {
      await registration({ fee: "1" })
      return moved(transfer(5n * DAI))
    })
    await expect(stores.recovery.assertRefunded(RECORD)).rejects.toMatchObject({
      code: "refund.registrationChanged",
    })
  })

  it("refuses to replace an address once a deposit reached it", async () => {
    balance.mockResolvedValue(1n)
    await expect(stores.recovery.assertUnfunded(RECORD)).rejects.toMatchObject({
      code: "refund.depositReached",
    })
    balance.mockResolvedValue(0n)
    await expect(stores.recovery.assertUnfunded(RECORD)).resolves.toBeUndefined()
    await registration({ fundedAt: 1 })
    await expect(stores.recovery.assertUnfunded({ ...RECORD, fundedAt: 1 })).rejects.toMatchObject({
      code: "refund.depositReached",
    })
  })
})

describe("a refund submitted in an earlier session", () => {
  const stamped = () => rail({ phase: "recoverable", recoveryTxHash: HASH })

  it("is not looked for on a record with nothing to reconcile", async () => {
    await stores.recovery.reconcile(RECORD)
    expect(receipt).not.toHaveBeenCalled()
    expect(balance).not.toHaveBeenCalled()
  })

  it("settles on a later pass when the balance read failed after the receipt was remembered", async () => {
    await stamped()
    balance.mockRejectedValueOnce(new Error("rpc down"))
    await expect(stores.recovery.reconcile(RECORD)).rejects.toThrow()
    expect(railNow().phase).toBe("recoverable")
    expect(stores.recovery.refunded(RECORD)).toBe(false)
    await stores.recovery.reconcile(RECORD)
    expect(receipt).toHaveBeenCalledTimes(1)
    expect(railNow()).toMatchObject({ phase: "recovered", recoveryTxHash: HASH })
    expect(stores.recovery.refunded(RECORD)).toBe(true)
  })

  it("is unstamped when it reverted, so the address can be recovered again", async () => {
    await stamped()
    receipt.mockResolvedValue({ status: "reverted", logs: [] })
    await stores.recovery.reconcile(RECORD)
    expect(railNow()).toMatchObject({ phase: "recoverable" })
    expect(railNow().recoveryTxHash).toBeUndefined()
    balance.mockResolvedValue(5n * DAI)
    await expect(stores.recovery.prepare(RECORD, "0xnet")).resolves.toMatchObject({ amount: "5" })
    expect(heal).toHaveBeenCalledWith("0xnet")
  })

  it("never settles a deposit a later sweep took past its recovery stamp", async () => {
    await markRefunded()
    await rail({ phase: "pendingClaim", sweepTxHash: LATER })
    await stores.recovery.reconcile(RECORD)
    expect(railNow().phase).toBe("pendingClaim")
  })

  it("learns what an unread hash moved under another token's name, without settling the rail", async () => {
    const usdc = { tokenAddress: TARGET, tokenSymbol: "USDC", tokenDecimals: 6 }
    await rail({ phase: "recoverable", recoveryTxHash: HASH, ...usdc })
    expect(stores.recovery.refunded(RECORD)).toBe(false)
    await stores.recovery.reconcile(RECORD)
    expect(balance).not.toHaveBeenCalled()
    expect(railNow()).toMatchObject({ phase: "recoverable", recoveryTxHash: HASH, ...usdc })
    expect(stores.recovery.refunded(RECORD)).toBe(true)
  })
})

describe("a mainnet address funded in a swapped stable", () => {
  const record = { ...RECORD, depositToken: MAINNET_DAI, l1ChainId: 1 }
  // Each part alone is short of the floor that buys entry; together they clear it.
  const part = (FLOOR * 3n) / 5n
  const daiPart = transfer(part, MAINNET_DAI)
  const usdcPart = transfer(part / 10n ** 12n, USDC)
  beforeEach(async () => {
    tokens = (fee) => [fee, { address: USDC, symbol: "USDC", decimals: 6 }]
    await registration({ depositToken: MAINNET_DAI, l1ChainId: 1 })
    await rail({ tokenAddress: MAINNET_DAI, l1ChainId: 1 })
  })

  it("pools a deposit refunded one token at a time toward the entry it earned", async () => {
    await registration({ phase: "funded", fundedAt: 5 })
    await stores.recovery.confirmed(SIPA, MAINNET_DAI, HASH, async () => moved(daiPart) as never)
    // The DAI part alone buys no entry; the stamp stays for the stable still at the address.
    expect(live()).toMatchObject({ phase: "funded", fundedAt: 5 })
    await stores.recovery.confirmed(SIPA, USDC, LATER, async () => moved(usdcPart) as never)
    expect(live()).toMatchObject({
      phase: "awaiting_deposit",
      refundedEntry: { sipaAddress: SIPA, recoveryTxHash: LATER, amount: String(2n * part) },
    })
    const reads = (dai: object) =>
      receipt.mockImplementation(async ({ hash }) => (hash === LATER ? moved(usdcPart) : dai))
    reads(moved(daiPart))
    await expect(stores.recovery.assertRefunded(record)).resolves.toEqual({
      amount: 2n * part,
      txHash: LATER,
    })
    // The pool stands only on receipts read now: a smaller transfer shrinks it, a failure drops it
    // to the largest single refund, and an unread receipt holds the restart.
    reads(moved(transfer(part / 3n, MAINNET_DAI)))
    await expect(stores.recovery.assertRefunded(record)).resolves.toEqual({
      amount: part + part / 3n,
      txHash: LATER,
    })
    reads({ status: "reverted", logs: [] })
    await expect(stores.recovery.assertRefunded(record)).resolves.toEqual({
      amount: part,
      txHash: LATER,
    })
    receipt.mockImplementation(async ({ hash }) => {
      if (hash === LATER) return moved(usdcPart)
      throw new Error("not served")
    })
    await expect(stores.recovery.assertRefunded(record)).rejects.toMatchObject({
      code: "refund.receiptUnread",
    })
  })

  it("sizes a refund remembered without an amount, so it pools with the next", async () => {
    await registration({ phase: "funded", fundedAt: 5, refunds: { txHashes: [HASH] } })
    await rail({ phase: "recoverable", recoveryTxHash: HASH })
    receipt.mockResolvedValue(moved(daiPart))
    await stores.recovery.reconcile(record)
    expect(live()).toMatchObject({ phase: "funded", fundedAt: 5 })
    await stores.recovery.confirmed(SIPA, USDC, LATER, async () => moved(usdcPart) as never)
    expect(live()).toMatchObject({
      phase: "awaiting_deposit",
      refundedEntry: { sipaAddress: SIPA, recoveryTxHash: LATER, amount: String(2n * part) },
    })
  })

  it("refunds the stable that holds the funds and counts it in registration-token units", async () => {
    const usdc = transfer(5_000_000n, USDC)
    balance.mockImplementation(async ({ address }) =>
      address.toLowerCase() === USDC.toLowerCase() ? 5_000_000n : 0n,
    )
    await expect(stores.recovery.prepare(record, "0xnet")).resolves.toMatchObject({
      tokenAddress: USDC,
      tokenDecimals: 6,
      amount: "5",
    })
    await stores.recovery.confirmed(SIPA, USDC, HASH, async () => moved(usdc) as never)
    expect(stores.recovery.refunded(record)).toBe(true)
    balance.mockResolvedValue(0n)
    receipt.mockResolvedValue(moved(usdc))
    await expect(stores.recovery.assertRefunded(record)).resolves.toEqual({
      amount: 5n * DAI,
      txHash: HASH,
    })
  })
})
