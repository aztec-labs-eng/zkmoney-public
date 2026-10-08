import { beforeEach, describe, expect, it, vi } from "vitest"
import { encodeAbiParameters, encodeEventTopics, erc20Abi, type Address, type Hex } from "viem"
import {
  PendingRegistrationStore,
  SIPADepositStore,
  type PendingRegistrationRecord,
} from "@obsidion/front-core"
import type { WebWalletConfig } from "../src/config/env"
import { webStorage } from "../src/platform/storage/WebStorageAdapter"
import { walletStorage } from "../src/platform/storage/walletStorage"
import { getPendingStore } from "../src/features/onboarding/webRegistration"
import { hasDepositAdmission, recordDepositAdmission } from "../src/features/identity/admission"
import { saveRegistrationTerms } from "../src/features/onboarding/registrationTerms"
import {
  assertRegistrationRefunded,
  assertRegistrationUnfunded,
  prepareRegistrationRefund,
  reconcileRegistrationRefund,
  registrationNeedsRefund,
  registrationRefundConfirmed,
  registrationRefunded,
} from "../src/features/onboarding/registrationQuoteRecovery"

const h = vi.hoisted(() => ({
  balance: vi.fn(),
  receipt: vi.fn(),
  heal: vi.fn(),
  cut: vi.fn(),
  config: { l1ChainId: 11155111 } as { l1ChainId: number; network?: string },
}))
vi.mock("../src/config/env", async (original) => ({
  ...(await original<object>()),
  getConfig: () => h.config,
}))
vi.mock("../src/config/oxideTuple", async (original) => ({
  ...(await original<object>()),
  l1PublicClient: () => ({ readContract: h.balance, getTransactionReceipt: h.receipt }),
}))
vi.mock("../src/features/fees/fpcFundingCut", () => ({
  currentFpcFundingCut: h.cut,
  fpcFundingCut: h.cut,
}))
vi.mock("../src/features/onboarding/registrationDepositSeed", () => ({
  healRegistrationDeposits: h.heal,
}))
const account = `0x${"11".repeat(20)}` as Address
const sipa = `0x${"22".repeat(20)}` as Address
const token = `0x${"33".repeat(20)}` as Address
const target = `0x${"44".repeat(20)}` as Address
const l2 = `0x${"55".repeat(32)}` as Hex
const hash = `0x${"66".repeat(32)}` as Hex
const dai = 10n ** 18n
/** Staging's portal funding cut, which every minimum here outranks. */
const CUT = dai / 10n
const config = { l1ChainId: 11155111 } as WebWalletConfig
const record: PendingRegistrationRecord = {
  account,
  tag: "demo",
  nameHash: hash,
  sipaAddress: sipa,
  depositToken: token,
  l2Address: l2,
  l1ChainId: 11155111,
  fee: String(10n * dai),
  beneficiary: target,
  broadcast: false,
  phase: "awaiting_deposit",
  retries: 3,
  startTime: 1,
}
/** A campaign registration quoted the standard schedule: the state the earned price recovers from. */
const terms = {
  account,
  tag: "demo",
  deadline: 0,
  fee: String(10n * dai),
  minDeposit: String(5n * dai),
  feeWaived: false,
  earnedExpected: true,
  depositAmount: String(5n * dai),
}
const transfer = {
  address: token,
  topics: encodeEventTopics({
    abi: erc20Abi,
    eventName: "Transfer",
    args: { from: sipa, to: target },
  }),
  data: encodeAbiParameters([{ type: "uint256" }], [5n * dai]),
}
const rail = () => SIPADepositStore.get(webStorage)
const readReceipt = (wanted: Hex) => h.receipt({ hash: wanted })
/** A recovery receipt moving `amount` of the registration token off the address. */
const moved = (amount: bigint) => async () =>
  ({
    status: "success",
    logs: [{ ...transfer, data: encodeAbiParameters([{ type: "uint256" }], [amount]) }],
  } as never)
async function markRefunded() {
  await rail().upsert(sipa, { phase: "recovered", recoveryTxHash: hash })
}
beforeEach(async () => {
  vi.clearAllMocks()
  localStorage.clear()
  h.config = { l1ChainId: 11155111 }
  ;(PendingRegistrationStore as unknown as { instance: unknown }).instance = null
  ;(SIPADepositStore as unknown as { instance: unknown }).instance = null
  await getPendingStore().load()
  await getPendingStore().upsert(account, {}, record)
  await rail().load()
  await rail().upsert(
    sipa,
    { phase: "broadcast" },
    {
      messageSecret: hash,
      recoveryAddress: target,
      recipientHash: hash,
      recipientL2Address: l2,
      tokenAddress: token,
      tokenSymbol: "DAI",
      l1ChainId: 11155111,
      amount: "0",
      startTime: 1,
    },
  )
  h.balance.mockResolvedValue(0n)
  h.receipt.mockResolvedValue({ status: "success", logs: [transfer] })
  h.cut.mockResolvedValue(CUT)
})
describe("earned registration refund", () => {
  it("offers recovery for a 5 DAI receipt at the 15 DAI address, including incompatible refreshed metadata", () => {
    expect(registrationNeedsRefund(record, terms, true, undefined, CUT)).toBe(true)
    expect(
      registrationNeedsRefund(
        record,
        { ...terms, fee: String(dai / 2n), minDeposit: String((45n * dai) / 10n) },
        true,
        undefined,
        CUT,
      ),
    ).toBe(true)
    expect(registrationNeedsRefund(record, terms, false, undefined, CUT)).toBe(false)
    expect(
      registrationNeedsRefund({ ...record, phase: "confirmed" }, terms, true, undefined, CUT),
    ).toBe(false)
    // A deposit already clearing this schedule's floor completes at the price it committed to.
    expect(
      registrationNeedsRefund(
        record,
        { ...terms, depositAmount: String(15n * dai) },
        true,
        undefined,
        CUT,
      ),
    ).toBe(false)
    expect(
      registrationNeedsRefund(
        { ...record, fee: String(dai / 2n) },
        { ...terms, fee: String(dai / 2n), minDeposit: String((45n * dai) / 10n) },
        true,
        undefined,
        CUT,
      ),
    ).toBe(false)
  })

  it("never calls for a refund on an address already priced at the earned fee", () => {
    const earned = {
      ...terms,
      fee: String(dai / 2n),
      minDeposit: String((45n * dai) / 10n),
      feeWaived: true,
    }
    const earnedRecord = { ...record, fee: earned.fee }
    // A short deposit here is topped up, whatever the cut makes of the floor.
    expect(registrationNeedsRefund(earnedRecord, earned, true, undefined, 5n * dai)).toBe(false)
    expect(registrationNeedsRefund(earnedRecord, earned, true, undefined, CUT)).toBe(false)
    expect(registrationNeedsRefund(earnedRecord, earned, true)).toBe(false)
  })
  it("prepares the original deposit and displays its live amount without replacing the registration", async () => {
    h.balance.mockResolvedValue(5n * dai)
    expect(await prepareRegistrationRefund(record, config)).toMatchObject({
      sipaAddress: sipa,
      amount: "5",
    })
    expect(getPendingStore().get(account)).toMatchObject(record)
    expect(h.heal).toHaveBeenCalledWith(config)
  })
  it("requires recovery before a new address can be requested", async () => {
    await expect(assertRegistrationRefunded(record, config)).rejects.toThrow("Recover the original")
    expect(h.receipt).not.toHaveBeenCalled()
  })
  it("accepts a confirmed token refund with no money left at the old address and reports its amount", async () => {
    await markRefunded()
    await expect(assertRegistrationRefunded(record, config)).resolves.toEqual({
      amount: 5n * dai,
      txHash: hash,
    })
    expect(getPendingStore().get(account)).toMatchObject(record)
  })
  it("offers the restart from the persisted refund alone, with no admission receipt", async () => {
    expect(registrationRefunded(record)).toBe(false)
    expect(
      registrationNeedsRefund(record, terms, registrationRefunded(record), undefined, CUT),
    ).toBe(false)
    await markRefunded()
    expect(registrationRefunded(record)).toBe(true)
    expect(
      registrationNeedsRefund(record, terms, registrationRefunded(record), undefined, CUT),
    ).toBe(true)
  })

  it("names no refund while the portal's cut is still unread", () => {
    // The floor the deposit is judged against is priced from the cut, so an unfunded record is
    // undecided until it lands: offering a recovery here would take back a wallet that qualifies.
    expect(registrationNeedsRefund(record, terms, true)).toBe(false)
    expect(registrationNeedsRefund(record, terms, true, undefined, CUT)).toBe(true)
    // What fails on the fee alone needs no cut: a fee under the relayer's sweep cut, and one the
    // terms disagree with, both stand on their own.
    expect(registrationNeedsRefund(record, terms, true, 20n * dai)).toBe(true)
    expect(registrationNeedsRefund(record, { ...terms, fee: String(3n * dai) }, true)).toBe(true)
    // A funded record has already had the covering branch's say; the committed fee decides it.
    const unpriced = { ...terms, minDeposit: undefined }
    expect(registrationNeedsRefund({ ...record, phase: "funded" }, unpriced, true)).toBe(true)
    expect(registrationNeedsRefund(record, unpriced, true)).toBe(false)
  })
  it("keeps the confirmed refund once the rail rewrites the address for another token", async () => {
    await markRefunded()
    expect(registrationRefunded(record)).toBe(true)
    const other = `0x${"77".repeat(32)}` as Hex
    h.receipt.mockImplementation(async ({ hash: wanted }: { hash: Hex }) => ({
      status: "success",
      logs: wanted === hash ? [transfer] : [],
    }))
    await rail().upsert(sipa, {
      phase: "recoverable",
      tokenAddress: target,
      tokenSymbol: "USDC",
      recoveryTxHash: other,
    })
    expect(registrationRefunded(record)).toBe(true)
    await expect(assertRegistrationRefunded(record, config)).resolves.toEqual({
      amount: 5n * dai,
      txHash: hash,
    })
    expect(h.receipt).toHaveBeenCalledWith({ hash })
    h.balance.mockResolvedValue(5n * dai)
    expect(await prepareRegistrationRefund(record, config)).toMatchObject({
      tokenAddress: token,
      tokenSymbol: "DAI",
      amount: "5",
    })
  })
  it("keeps a refund confirmed off any surface through a later recovery of another token", async () => {
    // Nothing of the registration was mounted for either recovery: the rail's record ends up
    // naming the second token and hash only.
    await registrationRefundConfirmed(sipa, token, 11155111, hash, readReceipt)
    expect(registrationRefunded(record)).toBe(true)
    const other = `0x${"77".repeat(32)}` as Hex
    await registrationRefundConfirmed(sipa, target, 11155111, other, readReceipt)
    await rail().upsert(sipa, {
      phase: "recovered",
      tokenAddress: target,
      tokenSymbol: "USDC",
      recoveryTxHash: other,
    })
    h.receipt.mockImplementation(async ({ hash: wanted }: { hash: Hex }) => ({
      status: "success",
      logs: wanted === hash ? [transfer] : [],
    }))
    expect(registrationRefunded(record)).toBe(true)
    await expect(assertRegistrationRefunded(record, config)).resolves.toEqual({
      amount: 5n * dai,
      txHash: hash,
    })
  })
  it("takes the funded stamp off a registration whose token was recovered", async () => {
    await getPendingStore().upsert(account, { phase: "funded", fundedAt: 5, fundingTxHash: hash })
    await registrationRefundConfirmed(
      sipa,
      target,
      11155111,
      `0x${"77".repeat(32)}` as Hex,
      readReceipt,
    )
    expect(getPendingStore().get(account)).toMatchObject({ phase: "funded", fundedAt: 5 })
    await registrationRefundConfirmed(sipa, token, 1, hash, readReceipt)
    expect(getPendingStore().get(account)).toMatchObject({ phase: "funded", fundedAt: 5 })
    expect(getPendingStore().get(account)?.refundedEntry).toBeUndefined()
    await registrationRefundConfirmed(sipa, token, 11155111, hash, readReceipt)
    const live = getPendingStore().get(account)!
    expect(live.phase).toBe("awaiting_deposit")
    expect(live.fundedAt).toBeUndefined()
    expect(live.fundingTxHash).toBeUndefined()
    expect(live.refundedEntry).toEqual({
      sipaAddress: sipa,
      recoveryTxHash: hash,
      amount: String(5n * dai),
    })
    expect(registrationRefunded(record)).toBe(true)
  })
  it("takes the deposit receipt with the refund it settles, entry staying on the record", async () => {
    const earned = {
      ...terms,
      fee: String(dai / 2n),
      minDeposit: String((9n * dai) / 2n),
      feeWaived: true,
    }
    await getPendingStore().upsert(account, { fee: earned.fee })
    recordDepositAdmission(record, 5n * dai)
    await registrationRefundConfirmed(sipa, token, 11155111, hash, readReceipt)
    expect(hasDepositAdmission(record)).toBe(false)
    expect(getPendingStore().get(account)?.refundedEntry).toBeDefined()
    expect(registrationNeedsRefund(getPendingStore().get(account)!, earned, true)).toBe(false)
  })
  it("keeps the entry a refund of the earned total bought on the refunded record", async () => {
    const small = `0x${"77".repeat(32)}` as Hex
    await registrationRefundConfirmed(sipa, token, 11155111, small, moved(dai / 5n))
    expect(getPendingStore().get(account)?.refundedEntry).toBeUndefined()
    await registrationRefundConfirmed(sipa, token, 11155111, hash, moved(5n * dai))
    expect(getPendingStore().get(account)).toMatchObject({
      phase: "awaiting_deposit",
      refundedEntry: { sipaAddress: sipa, recoveryTxHash: hash, amount: String(5n * dai) },
    })
  })
  it("counts a top-up that landed after the balance read: the receipt says what moved", async () => {
    await getPendingStore().upsert(account, { phase: "funded", fundedAt: 5 })
    await registrationRefundConfirmed(sipa, token, 11155111, hash, moved(15n * dai))
    expect(getPendingStore().get(account)).toMatchObject({
      phase: "awaiting_deposit",
      refundedEntry: { sipaAddress: sipa, recoveryTxHash: hash, amount: String(15n * dai) },
    })
    expect(getPendingStore().get(account)?.fundedAt).toBeUndefined()
  })
  it("leaves a funded record and its entry alone while the receipt cannot be read, and settles it on reconciliation", async () => {
    const unread = async () => {
      throw new Error("rpc down")
    }
    await getPendingStore().upsert(account, { phase: "funded", fundedAt: 5, fundingTxHash: hash })
    await registrationRefundConfirmed(sipa, token, 11155111, hash, unread)
    expect(getPendingStore().get(account)).toMatchObject({ phase: "funded", fundedAt: 5 })
    expect(getPendingStore().get(account)?.refundedEntry).toBeUndefined()
    expect(registrationRefunded(record)).toBe(true)
    h.receipt.mockRejectedValueOnce(new Error("rpc down"))
    await reconcileRegistrationRefund(record, config)
    expect(getPendingStore().get(account)).toMatchObject({ phase: "funded", fundedAt: 5 })
    h.receipt.mockImplementation(moved(15n * dai))
    await reconcileRegistrationRefund(record, config)
    expect(getPendingStore().get(account)).toMatchObject({
      phase: "awaiting_deposit",
      refundedEntry: { sipaAddress: sipa, recoveryTxHash: hash, amount: String(15n * dai) },
    })
    expect(getPendingStore().get(account)?.fundedAt).toBeUndefined()
    await reconcileRegistrationRefund(record, config)
    expect(h.receipt).toHaveBeenCalledTimes(2)
    expect(h.balance).not.toHaveBeenCalled()
  })
  it("keeps a funded record's stamp while a refund read before the qualifying one buys no entry", async () => {
    const unread = async () => {
      throw new Error("rpc down")
    }
    const small = `0x${"77".repeat(32)}` as Hex
    await getPendingStore().upsert(account, { phase: "funded", fundedAt: 5 })
    await registrationRefundConfirmed(sipa, token, 11155111, hash, unread)
    await registrationRefundConfirmed(sipa, token, 11155111, small, moved(dai / 5n))
    expect(getPendingStore().get(account)).toMatchObject({ phase: "funded", fundedAt: 5 })
    expect(getPendingStore().get(account)?.refundedEntry).toBeUndefined()
    h.receipt.mockRejectedValue(new Error("rpc down"))
    await reconcileRegistrationRefund(record, config)
    expect(getPendingStore().get(account)).toMatchObject({ phase: "funded", fundedAt: 5 })
    h.receipt.mockImplementation(moved(15n * dai))
    await reconcileRegistrationRefund(record, config)
    // The small refund read first pools with the qualifying one: the deposit came back in parts.
    expect(getPendingStore().get(account)).toMatchObject({
      phase: "awaiting_deposit",
      refundedEntry: {
        sipaAddress: sipa,
        recoveryTxHash: hash,
        amount: String((152n * dai) / 10n),
      },
    })
    // Both unsized at once: the readable smaller one settles nothing either.
    for (const key of walletStorage.keys()) walletStorage.removeItem(key)
    await getPendingStore().upsert(account, {
      phase: "funded",
      fundedAt: 5,
      refundedEntry: undefined,
    })
    await registrationRefundConfirmed(sipa, token, 11155111, hash, unread)
    await registrationRefundConfirmed(sipa, token, 11155111, small, unread)
    h.receipt.mockImplementation(async ({ hash: wanted }: { hash: Hex }) => {
      if (wanted === hash) throw new Error("rpc down")
      return moved(dai / 5n)()
    })
    await reconcileRegistrationRefund(record, config)
    expect(getPendingStore().get(account)).toMatchObject({ phase: "funded", fundedAt: 5 })
    h.receipt.mockImplementation(moved(15n * dai))
    await reconcileRegistrationRefund(record, config)
    // The small refund read first pools with the qualifying one: the deposit came back in parts.
    expect(getPendingStore().get(account)).toMatchObject({
      phase: "awaiting_deposit",
      refundedEntry: {
        sipaAddress: sipa,
        recoveryTxHash: hash,
        amount: String((152n * dai) / 10n),
      },
    })
  })
  it("leaves a funded record and its wallet access alone while the portal's cut cannot be read", async () => {
    await getPendingStore().upsert(account, { phase: "funded", fundedAt: 5 })
    recordDepositAdmission(record, 5n * dai)
    h.cut.mockRejectedValue(new Error("rpc down"))

    await registrationRefundConfirmed(sipa, token, 11155111, hash, readReceipt)

    // The entry the refund buys is priced against the cut, so settling here would clear the stamp
    // and the receipt while crediting nothing.
    expect(getPendingStore().get(account)).toMatchObject({ phase: "funded", fundedAt: 5 })
    expect(getPendingStore().get(account)?.refundedEntry).toBeUndefined()
    expect(hasDepositAdmission(record)).toBe(true)

    h.cut.mockResolvedValue(CUT)
    await reconcileRegistrationRefund(record, config)
    expect(getPendingStore().get(account)).toMatchObject({
      phase: "awaiting_deposit",
      refundedEntry: { sipaAddress: sipa, recoveryTxHash: hash, amount: String(5n * dai) },
    })
    expect(hasDepositAdmission(record)).toBe(false)
  })
  it("settles a funded record off the refund the rail reports for it", async () => {
    await getPendingStore().upsert(account, { phase: "funded", fundedAt: 5 })
    await markRefunded()
    expect(registrationRefunded(record)).toBe(true)
    await reconcileRegistrationRefund(record, config)
    expect(h.receipt).toHaveBeenCalledWith({ hash })
    expect(getPendingStore().get(account)).toMatchObject({
      phase: "awaiting_deposit",
      refundedEntry: { sipaAddress: sipa, recoveryTxHash: hash, amount: String(5n * dai) },
    })
    await reconcileRegistrationRefund(record, config)
    expect(h.receipt).toHaveBeenCalledTimes(1)
  })
  it("offers recovery again when registration-token funds return to a refunded address", async () => {
    await markRefunded()
    expect(registrationRefunded(record)).toBe(true)
    await rail().upsert(sipa, { phase: "recoverable" })
    expect(registrationRefunded(record)).toBe(false)
    h.balance.mockResolvedValue(dai / 5n)
    await expect(assertRegistrationRefunded(record, config)).rejects.toThrow("Recover the original")
    const again = `0x${"88".repeat(32)}` as Hex
    await rail().upsert(sipa, { phase: "recovered", recoveryTxHash: again })
    h.balance.mockResolvedValue(0n)
    expect(registrationRefunded(record)).toBe(true)
    await expect(assertRegistrationRefunded(record, config)).resolves.toEqual({
      amount: 5n * dai,
      txHash: again,
    })
  })
  it("keeps the entry a refund bought when a later, smaller refund follows", async () => {
    await markRefunded()
    expect(registrationRefunded(record)).toBe(true)
    const later = `0x${"88".repeat(32)}` as Hex
    h.receipt.mockImplementation(async ({ hash: wanted }: { hash: Hex }) => ({
      status: "success",
      logs: [
        wanted === later
          ? { ...transfer, data: encodeAbiParameters([{ type: "uint256" }], [dai / 5n]) }
          : transfer,
      ],
    }))
    await rail().upsert(sipa, { phase: "recoverable" })
    await rail().upsert(sipa, { phase: "recovered", recoveryTxHash: later })
    expect(registrationRefunded(record)).toBe(true)
    await expect(assertRegistrationRefunded(record, config)).resolves.toEqual({
      amount: 5n * dai,
      txHash: hash,
    })
  })
  it("restarts on a later qualifying refund when an older receipt is no longer served", async () => {
    await markRefunded()
    expect(registrationRefunded(record)).toBe(true)
    const later = `0x${"88".repeat(32)}` as Hex
    h.receipt.mockImplementation(async ({ hash: wanted }: { hash: Hex }) => {
      if (wanted === hash) throw new Error("Transaction receipt with hash could not be found")
      return { status: "success", logs: [transfer] }
    })
    await rail().upsert(sipa, { phase: "recoverable" })
    await rail().upsert(sipa, { phase: "recovered", recoveryTxHash: later })
    await expect(assertRegistrationRefunded(record, config)).resolves.toEqual({
      amount: 5n * dai,
      txHash: later,
    })
  })
  it("waits for a receipt it could not read when the readable refunds do not buy entry", async () => {
    await markRefunded()
    expect(registrationRefunded(record)).toBe(true)
    await reconcileRegistrationRefund(record, config)
    const later = `0x${"88".repeat(32)}` as Hex
    let failFirst = true
    h.receipt.mockImplementation(async ({ hash: wanted }: { hash: Hex }) => {
      if (wanted === later)
        return {
          status: "success",
          logs: [{ ...transfer, data: encodeAbiParameters([{ type: "uint256" }], [dai / 5n]) }],
        }
      if (failFirst) {
        failFirst = false
        throw new Error("rpc down")
      }
      return { status: "success", logs: [transfer] }
    })
    await rail().upsert(sipa, { phase: "recoverable" })
    await rail().upsert(sipa, { phase: "recovered", recoveryTxHash: later })
    await expect(assertRegistrationRefunded(record, config)).rejects.toThrow("could not be read")
    await expect(assertRegistrationRefunded(record, config)).resolves.toEqual({
      amount: 5n * dai,
      txHash: hash,
    })
  })
  it("goes ahead past an unread receipt on a refund that clears the floor entry is priced at", async () => {
    // The signed floor, not the ask, is what a refund had to reach to buy entry: a refund between
    // the two qualifies on its own, so an unread receipt cannot hold the restart.
    saveRegistrationTerms({
      account,
      tag: "demo",
      deadline: 0,
      fee: String(dai / 2n),
      minDeposit: String((44n * dai) / 10n),
      feeWaived: true,
      earnedExpected: true,
    })
    const later = `0x${"88".repeat(32)}` as Hex
    h.receipt.mockImplementation(async ({ hash: wanted }: { hash: Hex }) => {
      if (wanted === later) throw new Error("rpc down")
      return {
        status: "success",
        logs: [
          { ...transfer, data: encodeAbiParameters([{ type: "uint256" }], [(495n * dai) / 100n]) },
        ],
      }
    })
    await markRefunded()
    expect(registrationRefunded(record)).toBe(true)
    await rail().upsert(sipa, { phase: "recoverable" })
    await rail().upsert(sipa, { phase: "recovered", recoveryTxHash: later })
    await expect(assertRegistrationRefunded(record, config)).resolves.toEqual({
      amount: (495n * dai) / 100n,
      txHash: hash,
    })
  })

  it("attributes a confirmed hash the rail holds under another token's name", async () => {
    await rail().upsert(sipa, {
      phase: "recovered",
      recoveryTxHash: hash,
      tokenAddress: target,
      tokenSymbol: "USDC",
    })
    expect(registrationRefunded(record)).toBe(false)
    await reconcileRegistrationRefund(record, config)
    expect(h.receipt).toHaveBeenCalledWith({ hash })
    expect(registrationRefunded(record)).toBe(true)
    h.receipt.mockResolvedValue({ status: "success", logs: [] })
    await rail().upsert(sipa, { phase: "recovered", recoveryTxHash: `0x${"99".repeat(32)}` as Hex })
    await reconcileRegistrationRefund(record, config)
    expect(registrationRefunded(record)).toBe(true)
  })
  it.each(["l2Address", "depositToken", "l1ChainId"])(
    "does not read another registration's recovered deposit as this one's: %s",
    async (field) => {
      await markRefunded()
      expect(registrationRefunded({ ...record, [field]: field === "l1ChainId" ? 1 : target })).toBe(
        false,
      )
    },
  )
  it.each(["reverted", "no transfer", "wrong token", "wrong source", "funds remain"])(
    "stops restart when %s",
    async (kind) => {
      await markRefunded()
      if (kind === "reverted") h.receipt.mockResolvedValue({ status: "reverted", logs: [transfer] })
      if (kind === "no transfer") h.receipt.mockResolvedValue({ status: "success", logs: [] })
      if (kind === "wrong token")
        h.receipt.mockResolvedValue({ status: "success", logs: [{ ...transfer, address: target }] })
      if (kind === "wrong source")
        h.receipt.mockResolvedValue({
          status: "success",
          logs: [
            {
              ...transfer,
              topics: encodeEventTopics({
                abi: erc20Abi,
                eventName: "Transfer",
                args: { from: target, to: sipa },
              }),
            },
          ],
        })
      if (kind === "funds remain") h.balance.mockResolvedValue(1n)
      await expect(assertRegistrationRefunded(record, config)).rejects.toThrow(
        "refund is not complete",
      )
      expect(getPendingStore().get(account)?.sipaAddress).toBe(sipa)
    },
  )
  it("refuses the wrong chain or a record changed while confirmation was read", async () => {
    await markRefunded()
    await expect(assertRegistrationRefunded(record, { ...config, l1ChainId: 1 })).rejects.toThrow(
      "network",
    )
    h.receipt.mockImplementation(async () => {
      await getPendingStore().upsert(account, { sipaAddress: target })
      return { status: "success", logs: [transfer] }
    })
    await expect(assertRegistrationRefunded(record, config)).rejects.toThrow("registration changed")
  })
})

describe("a committed fee below the deployed sweep floor", () => {
  const legacy = { ...record, fee: "0" }
  const legacyTerms = { ...terms, fee: "0", minDeposit: String(5n * dai), feeWaived: true }
  it("needs the refund however well the deposit covers its own quote", () => {
    expect(registrationNeedsRefund(legacy, legacyTerms, true)).toBe(false)
    expect(registrationNeedsRefund(legacy, legacyTerms, true, dai / 2n)).toBe(true)
    expect(
      registrationNeedsRefund(
        { ...legacy, phase: "funded", fundedAt: 1 },
        legacyTerms,
        true,
        dai / 2n,
      ),
    ).toBe(true)
  })
  it("is not a fee that meets the floor", () => {
    const priced = { ...record, fee: String(dai / 2n) }
    const pricedTerms = {
      ...terms,
      fee: String(dai / 2n),
      minDeposit: String((45n * dai) / 10n),
      feeWaived: true,
    }
    expect(registrationNeedsRefund(priced, pricedTerms, true, dai / 2n)).toBe(false)
  })
})

describe("a registration nobody promised the earned price", () => {
  // A standard registration is never measured against the earned price.
  const fee = String(5n * dai)
  const standard = { ...record, fee }
  const standardTerms = {
    account,
    tag: "demo",
    deadline: 0,
    fee,
    minDeposit: String(10n * dai),
    feeWaived: false,
  }
  it("is not flagged for a refund at the standard fee", () => {
    expect(registrationNeedsRefund(standard, standardTerms, true, dai / 10n, CUT)).toBe(false)
  })
  it("still needs one when its fee cannot pay the deployed sweep", () => {
    expect(registrationNeedsRefund(standard, standardTerms, true, 10n * dai, CUT)).toBe(true)
  })
  it("still needs one when the re-issued quote prices a different fee", () => {
    expect(
      registrationNeedsRefund(standard, { ...standardTerms, fee: String(3n * dai) }, true),
    ).toBe(true)
  })
})

describe("a refund submitted in an earlier session", () => {
  const stamped = () => rail().upsert(sipa, { phase: "recoverable", recoveryTxHash: hash })
  it("settles once its receipt confirms, without a second submission", async () => {
    await stamped()
    expect(registrationRefunded(record)).toBe(false)
    await reconcileRegistrationRefund(record, config)
    expect(h.receipt).toHaveBeenCalledWith({ hash })
    expect(rail().get(sipa)).toMatchObject({ phase: "recovered", recoveryTxHash: hash })
    expect(registrationRefunded(record)).toBe(true)
  })
  it("settles on a later pass when the balance read failed after the receipt was remembered", async () => {
    await stamped()
    h.balance.mockRejectedValueOnce(new Error("rpc down"))
    await reconcileRegistrationRefund(record, config)
    expect(rail().get(sipa)?.phase).toBe("recoverable")
    expect(registrationRefunded(record)).toBe(false)
    await reconcileRegistrationRefund(record, config)
    expect(h.receipt).toHaveBeenCalledTimes(1)
    expect(rail().get(sipa)).toMatchObject({ phase: "recovered", recoveryTxHash: hash })
    expect(registrationRefunded(record)).toBe(true)
  })
  it("is settled by the restart check itself", async () => {
    await stamped()
    await expect(assertRegistrationRefunded(record, config)).resolves.toEqual({
      amount: 5n * dai,
      txHash: hash,
    })
    expect(rail().get(sipa)?.phase).toBe("recovered")
  })
  it("is unstamped when it reverted, so the address can be recovered again", async () => {
    await stamped()
    h.receipt.mockResolvedValue({ status: "reverted", logs: [] })
    await reconcileRegistrationRefund(record, config)
    expect(rail().get(sipa)).toMatchObject({ phase: "recoverable" })
    expect(rail().get(sipa)?.recoveryTxHash).toBeUndefined()
    h.balance.mockResolvedValue(5n * dai)
    await expect(prepareRegistrationRefund(record, config)).resolves.toMatchObject({ amount: "5" })
  })
  it("never settles a deposit a later sweep took past its recovery stamp", async () => {
    await markRefunded()
    expect(registrationRefunded(record)).toBe(true)
    await rail().upsert(sipa, { phase: "pendingClaim", sweepTxHash: `0x${"88".repeat(32)}` })
    await reconcileRegistrationRefund(record, config)
    expect(rail().get(sipa)?.phase).toBe("pendingClaim")
  })
  it("is left alone while its receipt is still unknown", async () => {
    await stamped()
    h.receipt.mockRejectedValue(new Error("not found"))
    await reconcileRegistrationRefund(record, config)
    expect(rail().get(sipa)).toMatchObject({ phase: "recoverable", recoveryTxHash: hash })
    await expect(assertRegistrationRefunded(record, config)).rejects.toThrow("Recover the original")
  })
})

describe("the rail's record under another token's name", () => {
  const usdc = { tokenAddress: target, tokenSymbol: "USDC", tokenDecimals: 6 }
  it.each(["recoverable", "sweeping"] as const)(
    "keeps its %s phase for the token that reached the address after the refund",
    async (phase) => {
      await markRefunded()
      expect(registrationRefunded(record)).toBe(true)
      await reconcileRegistrationRefund(record, config)
      h.receipt.mockClear()
      await rail().upsert(sipa, { phase, ...usdc })
      await reconcileRegistrationRefund(record, config)
      expect(rail().get(sipa)).toMatchObject({ phase, recoveryTxHash: hash, tokenAddress: target })
      expect(h.receipt).not.toHaveBeenCalled()
      expect(h.balance).not.toHaveBeenCalled()
      expect(registrationRefunded(record)).toBe(true)
      await expect(assertRegistrationRefunded(record, config)).resolves.toEqual({
        amount: 5n * dai,
        txHash: hash,
      })
      expect(rail().get(sipa)?.phase).toBe(phase)
    },
  )
  it("learns the refund its unread hash moved without settling the record", async () => {
    await rail().upsert(sipa, { phase: "recoverable", recoveryTxHash: hash, ...usdc })
    expect(registrationRefunded(record)).toBe(false)
    await reconcileRegistrationRefund(record, config)
    expect(h.receipt).toHaveBeenCalledWith({ hash })
    expect(h.balance).not.toHaveBeenCalled()
    expect(rail().get(sipa)).toMatchObject({
      phase: "recoverable",
      recoveryTxHash: hash,
      tokenAddress: target,
    })
    expect(registrationRefunded(record)).toBe(true)
  })
})

describe("replacing an address nothing reached", () => {
  it("allows it while the address is empty and unfunded", async () => {
    await expect(assertRegistrationUnfunded(record, config)).resolves.toBeUndefined()
  })
  it("refuses once a deposit reached the address", async () => {
    h.balance.mockResolvedValue(1n)
    await expect(assertRegistrationUnfunded(record, config)).rejects.toThrow("A deposit reached")
    await getPendingStore().upsert(account, { fundedAt: 1 })
    h.balance.mockResolvedValue(0n)
    await expect(assertRegistrationUnfunded({ ...record, fundedAt: 1 }, config)).rejects.toThrow(
      "A deposit reached",
    )
  })
})

describe("a mainnet address funded in a swapped stable", () => {
  const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address
  const mainnet = { ...config, network: "mainnet" } as WebWalletConfig
  const usdcTransfer = {
    ...transfer,
    address: USDC,
    data: encodeAbiParameters([{ type: "uint256" }], [5_000_000n]),
  }
  it("pools a deposit refunded one token at a time toward the entry it earned", async () => {
    h.config = mainnet
    const second = `0x${"99".repeat(32)}` as Hex
    const daiPart = { ...transfer, data: encodeAbiParameters([{ type: "uint256" }], [3n * dai]) }
    const usdcPart = {
      ...usdcTransfer,
      data: encodeAbiParameters([{ type: "uint256" }], [3_000_000n]),
    }
    await getPendingStore().upsert(account, { phase: "funded", fundedAt: 5 })
    await registrationRefundConfirmed(
      sipa,
      token,
      11155111,
      hash,
      async () => ({ status: "success", logs: [daiPart] } as never),
    )
    // 3 DAI alone buys no entry; the stamp stays for the stable still at the address.
    expect(getPendingStore().get(account)).toMatchObject({ phase: "funded", fundedAt: 5 })
    await registrationRefundConfirmed(
      sipa,
      USDC,
      11155111,
      second,
      async () => ({ status: "success", logs: [usdcPart] } as never),
    )
    expect(getPendingStore().get(account)).toMatchObject({
      phase: "awaiting_deposit",
      refundedEntry: { sipaAddress: sipa, recoveryTxHash: second, amount: String(6n * dai) },
    })
    h.balance.mockResolvedValue(0n)
    h.receipt.mockImplementation(async ({ hash: wanted }: { hash: Hex }) => ({
      status: "success",
      logs: [wanted === second ? usdcPart : daiPart],
    }))
    await expect(assertRegistrationRefunded(record, mainnet)).resolves.toEqual({
      amount: 6n * dai,
      txHash: second,
    })
    // The pool stands only on receipts read now: one reorganized into a smaller transfer shrinks
    // it, one reorganized into a failure drops it to the largest single refund, and one that
    // cannot be read holds the restart.
    h.receipt.mockImplementation(async ({ hash: wanted }: { hash: Hex }) => ({
      status: "success",
      logs: [
        wanted === second
          ? usdcPart
          : { ...transfer, data: encodeAbiParameters([{ type: "uint256" }], [dai]) },
      ],
    }))
    await expect(assertRegistrationRefunded(record, mainnet)).resolves.toEqual({
      amount: 4n * dai,
      txHash: second,
    })
    h.receipt.mockImplementation(async ({ hash: wanted }: { hash: Hex }) =>
      wanted === second
        ? { status: "success", logs: [usdcPart] }
        : { status: "reverted", logs: [] },
    )
    await expect(assertRegistrationRefunded(record, mainnet)).resolves.toEqual({
      amount: 3n * dai,
      txHash: second,
    })
    h.receipt.mockImplementation(async ({ hash: wanted }: { hash: Hex }) => {
      if (wanted === second) return { status: "success", logs: [usdcPart] }
      throw new Error("not served")
    })
    await expect(assertRegistrationRefunded(record, mainnet)).rejects.toThrow("could not be read")
  })
  it("sizes a refund remembered without an amount, so it pools with the next", async () => {
    h.config = mainnet
    const second = `0x${"99".repeat(32)}` as Hex
    const daiPart = { ...transfer, data: encodeAbiParameters([{ type: "uint256" }], [3n * dai]) }
    const usdcPart = {
      ...usdcTransfer,
      data: encodeAbiParameters([{ type: "uint256" }], [3_000_000n]),
    }
    await getPendingStore().upsert(account, { phase: "funded", fundedAt: 5 })
    walletStorage.setItem(
      "webwallet.registration.refunds",
      JSON.stringify({ [sipa]: { token, l1ChainId: 11155111, txHashes: [hash] } }),
    )
    await rail().upsert(sipa, { phase: "recoverable", recoveryTxHash: hash })
    h.receipt.mockImplementation(async () => ({ status: "success", logs: [daiPart] }))
    await reconcileRegistrationRefund(record, mainnet)
    expect(getPendingStore().get(account)).toMatchObject({ phase: "funded", fundedAt: 5 })
    await registrationRefundConfirmed(
      sipa,
      USDC,
      11155111,
      second,
      async () => ({ status: "success", logs: [usdcPart] } as never),
    )
    expect(getPendingStore().get(account)).toMatchObject({
      phase: "awaiting_deposit",
      refundedEntry: { sipaAddress: sipa, recoveryTxHash: second, amount: String(6n * dai) },
    })
  })
  it("refunds the stable that holds the funds and counts it in registration-token units", async () => {
    h.config = mainnet
    h.balance.mockImplementation(async ({ address }: { address: string }) =>
      address.toLowerCase() === USDC.toLowerCase() ? 5_000_000n : 0n,
    )
    expect(await prepareRegistrationRefund(record, mainnet)).toMatchObject({
      tokenAddress: USDC,
      tokenSymbol: "USDC",
      tokenDecimals: 6,
      amount: "5",
    })
    await registrationRefundConfirmed(
      sipa,
      USDC,
      11155111,
      hash,
      async () => ({ status: "success", logs: [usdcTransfer] } as never),
    )
    expect(registrationRefunded(record)).toBe(true)
    h.balance.mockResolvedValue(0n)
    h.receipt.mockResolvedValue({ status: "success", logs: [usdcTransfer] })
    await expect(assertRegistrationRefunded(record, mainnet)).resolves.toEqual({
      amount: 5n * dai,
      txHash: hash,
    })
  })
})
