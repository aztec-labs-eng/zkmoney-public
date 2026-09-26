import { useEffect, useSyncExternalStore } from "react"
import {
  decodeEventLog,
  erc20Abi,
  formatUnits,
  type Address,
  type Hash,
  type TransactionReceipt,
} from "viem"
import { DEFAULT_DECIMALS, WALLET_TOKEN_SYMBOL, registrationFloor } from "@obsidion/core/constants"
import {
  SIPADepositStore,
  type PendingRegistrationRecord,
  type SIPADepositRecord,
} from "@obsidion/front-core"
import { getConfig, type WebWalletConfig } from "../../config/env"
import { l1PublicClient } from "../../config/oxideTuple"
import { currentFpcFundingCut } from "../fees/fpcFundingCut"
import { admissionFloor, forgetDepositAdmission, refundedEntry } from "../identity/admission"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { healRegistrationDeposits } from "./registrationDepositSeed"
import type { RegistrationTerms } from "./registrationTerms"
import { getPendingStore, registrationRecordForSipa } from "./webRegistration"

/**
 * A deposit whose committed fee cannot use the earned quote needs a refund first, then a restart.
 * `reached` is whether anything arrived at the address or was refunded from it: a live balance,
 * the funded stamp, the admission receipt or the confirmed refund. The receipt does not survive a
 * sign-out; the balance and the refund do. `sweepFee` is the deployed relayer cut a committed fee
 * must clear for its sweep to land at all; a fee below it needs the refund whatever it covers.
 * `fpcFundingCut` prices the schedule's floor; without it the floor decides nothing, and only a
 * fee that fails on its own calls for the refund.
 */
export function registrationNeedsRefund(
  record: PendingRegistrationRecord,
  terms: RegistrationTerms | null,
  reached: boolean,
  sweepFee?: bigint,
  fpcFundingCut?: bigint,
): boolean {
  if (
    !reached ||
    record.sweptAt !== undefined ||
    record.sweepTxHash ||
    (record.phase !== "awaiting_deposit" && record.phase !== "funded")
  )
    return false
  const fee = record.fee ?? terms?.fee
  if (fee === undefined) return true
  if (sweepFee !== undefined && BigInt(fee) < sweepFee) return true
  const priced = terms?.fee === fee && terms.minDeposit !== undefined && fpcFundingCut !== undefined
  const floor = priced
    ? registrationFloor({ min: BigInt(terms.minDeposit!), fee: BigInt(fee) }, fpcFundingCut!)
    : undefined
  if (
    terms?.fee === fee &&
    terms.minDeposit !== undefined &&
    (record.fundedAt !== undefined ||
      record.phase === "funded" ||
      (floor !== undefined && BigInt(terms.depositAmount ?? "0") >= floor))
  )
    return false
  if (terms?.fee !== undefined && terms.fee !== fee) return true
  // Without the cut the floor is unpriced, so a deposit that may already cover it is undecided, not
  // a refund. Only a record already funded, whose covering branch above has had its say, is judged
  // on the committed fee alone.
  if (fpcFundingCut === undefined && record.fundedAt === undefined && record.phase !== "funded")
    return false
  // The fee is committed into the address. An earned tag quoted the standard fee can only take the
  // earned price from a new address. A record with no schedule recorded names no price to disagree
  // with, so only a signed standard one calls for the refund.
  return terms?.earnedExpected === true && terms.fee !== undefined && terms.feeWaived !== true
}

/** What a Home surface knows about the address, beyond the record: the session's admission
 * receipt, a confirmed refund, and any other sign something reached it (a live balance, the funded
 * stamp). */
export interface RegistrationReachEvidence {
  depositAdmitted: boolean
  refunded: boolean
  reached?: boolean
}

/**
 * Whether a Home surface routes the record to recovery instead of pricing its deposit: an earned
 * registration whose committed quote cannot use the earned price, at an address something reached.
 * Only an earned registration has a cheaper price to restart at; a paid deposit is watched, never
 * refunded. The receipt itself marks the registration earned: it is only ever written for one.
 */
export function registrationRecoveryNeeded(
  record: PendingRegistrationRecord | null,
  terms: RegistrationTerms | null,
  evidence: RegistrationReachEvidence,
  sweepFee?: bigint,
  fpcFundingCut?: bigint,
): boolean {
  if (record === null) return false
  if (!evidence.depositAdmitted && terms?.earnedExpected !== true) return false
  const reached = evidence.depositAdmitted || evidence.refunded || evidence.reached === true
  return registrationNeedsRefund(record, terms, reached, sweepFee, fpcFundingCut)
}

function assertCurrent(record: PendingRegistrationRecord, config: WebWalletConfig): void {
  const current = getPendingStore().get(record.account)
  if (config.l1ChainId !== record.l1ChainId)
    throw new Error("Switch to the registration network first.")
  if (
    !current ||
    current.sipaAddress !== record.sipaAddress ||
    current.nameHash !== record.nameHash ||
    current.l2Address !== record.l2Address ||
    current.fee !== record.fee ||
    current.depositToken !== record.depositToken ||
    current.beneficiary !== record.beneficiary ||
    current.sweptAt !== undefined ||
    current.sweepTxHash ||
    (current.phase !== "awaiting_deposit" && current.phase !== "funded")
  ) {
    throw new Error("This registration changed. Reopen its status before continuing.")
  }
}

function depositMatches(record: PendingRegistrationRecord, deposit: SIPADepositRecord): boolean {
  return (
    deposit.l1ChainId === record.l1ChainId &&
    deposit.recipientL2Address?.toLowerCase() === record.l2Address.toLowerCase()
  )
}

/** What the transaction moved out of the address in the registration token. */
function refundedAmount(receipt: TransactionReceipt, record: PendingRegistrationRecord): bigint {
  let refunded = 0n
  if (receipt.status !== "success") return refunded
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== record.depositToken.toLowerCase()) continue
    try {
      const event = decodeEventLog({
        abi: erc20Abi,
        eventName: "Transfer",
        data: log.data,
        topics: log.topics,
      })
      if (event.args.from.toLowerCase() === record.sipaAddress.toLowerCase())
        refunded += event.args.value
    } catch {
      /* Not a Transfer. */
    }
  }
  return refunded
}

interface RefundEvidence {
  token: string
  l1ChainId: number
  /** Oldest first. */
  txHashes: Hash[]
  /** Remembered before their receipts were read: what they moved, and with it the registration
   *  record's settlement, is still owed. */
  unsized?: Hash[]
}

const REFUNDS_KEY = "webwallet.registration.refunds"
const refundListeners = new Set<() => void>()

/**
 * Every refund confirmed off an address in the registration token, apart from the rail's record:
 * the rail rewrites that record's token, phase and recovery hash for whatever token reaches the
 * address next, and the refunds must outlive that.
 */
function loadRefunds(): Record<string, RefundEvidence> {
  try {
    return JSON.parse(localStorage.getItem(REFUNDS_KEY) ?? "{}") as Record<string, RefundEvidence>
  } catch {
    return {}
  }
}

function evidenceFor(record: PendingRegistrationRecord): RefundEvidence | undefined {
  const evidence = loadRefunds()[record.sipaAddress.toLowerCase()]
  return evidence !== undefined &&
    evidence.l1ChainId === record.l1ChainId &&
    evidence.token.toLowerCase() === record.depositToken.toLowerCase()
    ? evidence
    : undefined
}

function refundEvidence(record: PendingRegistrationRecord): Hash[] {
  return evidenceFor(record)?.txHashes ?? []
}

function unsizedRefunds(record: PendingRegistrationRecord): Hash[] {
  return evidenceFor(record)?.unsized ?? []
}

/** A sized refund has settled the registration record off its receipt; an unsized one still owes that. */
function rememberRefund(
  record: PendingRegistrationRecord,
  txHash: Hash,
  sized: boolean,
  notify = true,
): void {
  const known = evidenceFor(record)
  const txHashes = known?.txHashes ?? []
  const unsized = known?.unsized ?? []
  const isNew = !txHashes.includes(txHash)
  const nextUnsized = sized
    ? unsized.filter((hash) => hash !== txHash)
    : isNew
    ? [...unsized, txHash]
    : unsized
  if (!isNew && nextUnsized.length === unsized.length) return
  const refunds = loadRefunds()
  refunds[record.sipaAddress.toLowerCase()] = {
    token: record.depositToken,
    l1ChainId: record.l1ChainId,
    txHashes: isNew ? [...txHashes, txHash] : txHashes,
    ...(nextUnsized.length > 0 ? { unsized: nextUnsized } : {}),
  }
  localStorage.setItem(REFUNDS_KEY, JSON.stringify(refunds))
  if (notify) refundListeners.forEach((fn) => fn())
}

/**
 * The live record of a refunded address is funded no longer, and holds the entry a refund of the
 * earned total bought as `refundedEntry`, so the wallet stays open before any restart. The funded
 * stamp is that entry until a marker replaces it: a refund that buys none leaves it alone while
 * another, still unsized, may.
 *
 * False when the refund is still owed an answer, which keeps it unsized for the next reconcile.
 */
async function settleRefundedRegistration(
  record: PendingRegistrationRecord,
  txHash: Hash,
  amount: bigint,
): Promise<boolean> {
  const live = getPendingStore().get(record.account)
  if (
    live?.sipaAddress.toLowerCase() !== record.sipaAddress.toLowerCase() ||
    live.sweptAt !== undefined ||
    live.sweepTxHash
  )
    return true
  const funded = live.fundedAt !== undefined || live.phase === "funded"
  // The entry this refund buys is priced against the cut. Settling on an unread one would clear the
  // funded stamp and the admission receipt while crediting no entry, closing a wallet the refund
  // left open; the record is left alone instead and the next reconcile decides.
  const fpcCut = await currentFpcFundingCut().catch(() => undefined)
  if (fpcCut === undefined) return false
  const entry = refundedEntry(live, { amount, txHash }, fpcCut)
  if (!funded && !entry) return true
  if (funded && !entry && unsizedRefunds(record).some((hash) => hash !== txHash)) return true
  await getPendingStore()
    .upsert(record.account, {
      ...(funded
        ? { fundedAt: undefined, fundingTxHash: undefined, phase: "awaiting_deposit" }
        : {}),
      ...(entry ? { refundedEntry: entry } : {}),
    })
    .catch(() => {})
  // The receipt vouched for funds the refund just moved; entry now rides on the record.
  forgetDepositAdmission(live)
  return true
}

function assertDeposit(
  record: PendingRegistrationRecord,
  deposit: SIPADepositRecord | null,
): asserts deposit is SIPADepositRecord {
  if (!deposit || !depositMatches(record, deposit)) {
    throw new Error(
      "The original deposit details are not available yet. Unlock this wallet and try again.",
    )
  }
}

/** The rail's record, while it speaks for the registration token. */
function railRecord(record: PendingRegistrationRecord): SIPADepositRecord | null {
  const deposit = SIPADepositStore.get(webStorage).get(record.sipaAddress as Address)
  return deposit !== null &&
    depositMatches(record, deposit) &&
    deposit.tokenAddress?.toLowerCase() === record.depositToken.toLowerCase()
    ? deposit
    : null
}

/**
 * The record's deposit was recovered in a confirmed L1 transaction and nothing came back since:
 * funds the rail sees at the address again want another recovery, whatever was refunded before.
 * A refund is remembered the first time the rail's record shows it.
 */
export function registrationRefunded(record: PendingRegistrationRecord): boolean {
  const deposit = railRecord(record)
  if (deposit?.phase === "recoverable" || deposit?.phase === "sweeping") return false
  if (deposit?.phase === "recovered" && deposit.recoveryTxHash) {
    rememberRefund(record, deposit.recoveryTxHash, false, false)
    return true
  }
  return refundEvidence(record).length > 0
}

/**
 * A recovery confirmed off `sipa` from any surface, the activity list included. One that moved a
 * registration's token is remembered as its refund and settles the registration's record. Its
 * receipt sizes it: funds landing after the recovery was submitted went with it. A receipt that
 * cannot be read leaves the record as it is, entry included, and the refund unsized for a later
 * reconciliation to settle.
 */
export async function registrationRefundConfirmed(
  sipa: string,
  token: string,
  l1ChainId: number,
  txHash: Hash,
  readReceipt: (hash: Hash) => Promise<TransactionReceipt>,
): Promise<void> {
  const record = registrationRecordForSipa(sipa)
  if (
    !record ||
    record.l1ChainId !== l1ChainId ||
    record.depositToken.toLowerCase() !== token.toLowerCase()
  )
    return
  rememberRefund(record, txHash, false)
  const receipt = await readReceipt(txHash).catch(() => undefined)
  if (!receipt) return
  const amount = refundedAmount(receipt, record)
  if (amount > 0n && !(await settleRefundedRegistration(record, txHash, amount))) return
  rememberRefund(record, txHash, true)
}

const reconciling = new Map<string, Promise<void>>()

/**
 * Settle a refund whose receipt wait did not finish: the hash is stamped at submission, the
 * `recovered` phase only on confirmation, and only while the address holds nothing, since funds
 * can reach it again after the refund. A receipt is read once per hash; a reverted one is
 * unstamped so the address can be recovered again. The balance read is the registration token's,
 * so it settles the rail's record only while that record names the token. Under another token's
 * name the record keeps its phase: its hash is read only to learn whether it moved the
 * registration token. Refunds remembered unsized are sized here too, and settle the
 * registration's record.
 */
export function reconcileRegistrationRefund(
  record: PendingRegistrationRecord,
  config: WebWalletConfig,
): Promise<void> {
  const store = SIPADepositStore.get(webStorage)
  const deposit = store.get(record.sipaAddress as Address)
  if (!deposit || !depositMatches(record, deposit) || config.l1ChainId !== record.l1ChainId)
    return Promise.resolve()
  const hash = deposit.recoveryTxHash
  const unsized = unsizedRefunds(record)
  const settled = deposit.phase === "recovered"
  const named = deposit.tokenAddress?.toLowerCase() === record.depositToken.toLowerCase()
  const remembered = hash !== undefined && refundEvidence(record).includes(hash)
  // A settled record in the registration token vouches for its hash without a receipt.
  const unread = hash !== undefined && !remembered && !(settled && named)
  const unsettled = hash !== undefined && !settled && named && recovering(deposit)
  if (!unread && !unsettled && unsized.length === 0) return Promise.resolve()
  const key = `${deposit.sipaAddress.toLowerCase()}:${hash ?? ""}`
  let inflight = reconciling.get(key)
  if (!inflight) {
    const client = l1PublicClient(config)
    inflight = (async () => {
      for (const owed of unsized) {
        const receipt = await client.getTransactionReceipt({ hash: owed }).catch(() => undefined)
        if (!receipt) continue
        const amount = refundedAmount(receipt, record)
        if (amount > 0n && !(await settleRefundedRegistration(record, owed, amount))) continue
        rememberRefund(record, owed, true)
      }
      if (unread && hash !== undefined) {
        const receipt = await client.getTransactionReceipt({ hash })
        if (receipt.status !== "success") {
          if (!settled)
            await store.upsert(deposit.sipaAddress, {
              phase: deposit.phase,
              recoveryTxHash: undefined,
            })
          return
        }
        const amount = refundedAmount(receipt, record)
        if (amount > 0n && (await settleRefundedRegistration(record, hash, amount))) {
          rememberRefund(record, hash, true)
        }
      }
      if (!unsettled || hash === undefined) return
      const balance = await client.readContract({
        address: record.depositToken,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [record.sipaAddress as Address],
      })
      const latest = store.get(deposit.sipaAddress)
      if (balance === 0n && latest && recovering(latest) && latest.recoveryTxHash === hash)
        await store.upsert(deposit.sipaAddress, { phase: "recovered", recoveryTxHash: hash })
    })()
      .catch(() => undefined)
      .finally(() => reconciling.delete(key))
    reconciling.set(key, inflight)
  }
  return inflight
}

/** A stamped recovery is this deposit's until a sweep of the address lands or is claimed. */
function recovering(deposit: SIPADepositRecord): boolean {
  return !deposit.sweepTxHash && deposit.phase !== "pendingClaim" && deposit.phase !== "claimed"
}

/**
 * A refunded address the registration re-enters starts a new deposit cycle on the rail. The
 * recovery stays as refund evidence; a settled record would never be scanned for the new deposit.
 */
export async function reopenRefundedDeposit(record: PendingRegistrationRecord): Promise<void> {
  const store = SIPADepositStore.get(webStorage)
  await store.load()
  const deposit = store.get(record.sipaAddress as Address)
  if (deposit?.phase !== "recovered") return
  await store.upsert(deposit.sipaAddress, {
    phase: "broadcast",
    amount: "0",
    recoveryTxHash: undefined,
    endTime: undefined,
  })
}

export function useRegistrationRefunded(record: PendingRegistrationRecord | null): boolean {
  const store = SIPADepositStore.get(webStorage)
  useEffect(() => {
    if (record === null) return
    void store
      .load()
      .then(() => reconcileRegistrationRefund(record, getConfig()))
      .catch((err) => console.warn("registration refund reconcile failed", err))
  }, [store, record])
  return useSyncExternalStore(
    (notify) => {
      const off = store.onListChanged(notify)
      refundListeners.add(notify)
      return () => {
        off()
        refundListeners.delete(notify)
      }
    },
    () => record !== null && registrationRefunded(record),
  )
}

export interface RegistrationRefund {
  /** What the refund moved off the address, read from its transaction. */
  amount: bigint
  txHash: Hash
}

/** An address the earned quote cannot use may be replaced outright only while nothing reached it. */
export async function assertRegistrationUnfunded(
  record: PendingRegistrationRecord,
  config: WebWalletConfig,
): Promise<void> {
  assertCurrent(record, config)
  const reached = "A deposit reached this address. Recover it before requesting a new address."
  if (record.phase !== "awaiting_deposit" || record.fundedAt !== undefined) throw new Error(reached)
  const balance = await l1PublicClient(config).readContract({
    address: record.depositToken,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [record.sipaAddress as Address],
  })
  if (balance !== 0n) throw new Error(reached)
  assertCurrent(record, config)
}

/** Reconstruct the original recovery inputs; never derive them from a replacement quote. */
export async function prepareRegistrationRefund(
  record: PendingRegistrationRecord,
  config: WebWalletConfig,
): Promise<SIPADepositRecord> {
  assertCurrent(record, config)
  await healRegistrationDeposits(config)
  const store = SIPADepositStore.get(webStorage)
  await store.load()
  const deposit = store.get(record.sipaAddress as Address)
  assertDeposit(record, deposit)
  const balance = await l1PublicClient(config).readContract({
    address: record.depositToken,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [record.sipaAddress as Address],
  })
  if (balance === 0n)
    throw new Error("No funds remain at this address. Check its recovery or registration status.")
  assertCurrent(record, config)
  // The rail's record names whatever token reached the address last; the refund moves the
  // registration token.
  return {
    ...deposit,
    amount: formatUnits(balance, DEFAULT_DECIMALS),
    tokenAddress: record.depositToken as Address,
    tokenSymbol: WALLET_TOKEN_SYMBOL,
    tokenDecimals: DEFAULT_DECIMALS,
  }
}

/**
 * Only a confirmed token refund and an empty old address allow a new registration address. The
 * refund reported is the largest confirmed off the address: the entry it bought is not revoked by
 * a later, smaller refund of funds that came back.
 */
export async function assertRegistrationRefunded(
  record: PendingRegistrationRecord,
  config: WebWalletConfig,
): Promise<RegistrationRefund> {
  assertCurrent(record, config)
  const store = SIPADepositStore.get(webStorage)
  await store.load()
  await reconcileRegistrationRefund(record, config)
  const hashes = registrationRefunded(record) ? refundEvidence(record) : []
  if (hashes.length === 0) {
    assertDeposit(record, store.get(record.sipaAddress as Address))
    throw new Error("Recover the original deposit before requesting a new address.")
  }
  const client = l1PublicClient(config)
  // A receipt the chain no longer serves (a refund reorganized away) counts for nothing; the
  // others still do.
  const [receipts, balance] = await Promise.all([
    Promise.allSettled(hashes.map((hash) => client.getTransactionReceipt({ hash }))),
    client.readContract({
      address: record.depositToken,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [record.sipaAddress as Address],
    }),
  ])
  let largest: RegistrationRefund | undefined
  let unread = false
  receipts.forEach((receipt, i) => {
    if (receipt.status !== "fulfilled") {
      unread = true
      return
    }
    const amount = refundedAmount(receipt.value, record)
    if (amount > 0n && (largest === undefined || amount >= largest.amount))
      largest = { amount, txHash: hashes[i] }
  })
  if (balance !== 0n || (largest === undefined && !unread))
    throw new Error(
      "The original refund is not complete. Check it before requesting a new address.",
    )
  // An unread receipt may be the refund that bought entry; a restart on the rest alone would
  // drop it, so only evidence that qualifies by itself goes ahead without it.
  const entryFloor = admissionFloor(record, await currentFpcFundingCut().catch(() => undefined))
  if (largest === undefined || (unread && largest.amount < entryFloor))
    throw new Error("A refund receipt could not be read. Try again.")
  assertCurrent(record, config)
  return largest
}
