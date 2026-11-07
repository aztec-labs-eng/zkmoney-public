import {
  decodeEventLog,
  erc20Abi,
  formatUnits,
  type Address,
  type Hash,
  type PublicClient,
  type TransactionReceipt,
} from "viem"
import { DEFAULT_DECIMALS, WALLET_TOKEN_SYMBOL, registrationFloor } from "@obsidion/core/constants"
import { WalletError, bestEffort } from "../engine/errors"
import { loadRecords } from "../engine/persistentStore"
import type { PendingRegistrationRecord, RegistrationTerms } from "../engine/registrationRecord"
import { latestRegistration, registrationAt, type RegistrationStore } from "../engine/registrations"
import { selectSipaDeposit, type SipaDeposit, type SipaDeposits } from "../engine/sipaDeposits"
import { sweepsInto } from "./depositTokenRoutes"
import { inRowUnits, readSipaBalance, readSipaHolding, type SipaFundingToken } from "./sipaFunding"

/**
 * A deposit whose committed fee cannot use the earned quote needs a refund first, then a restart.
 * `reached` is whether anything arrived at the address or was refunded from it: a live balance,
 * the funded stamp, the admission receipt or the confirmed refund. `seen` is the most the address
 * showed. The receipt does not survive a
 * sign-out; the balance and the refund do. `sweepFee` is the deployed relayer cut a committed fee
 * must clear for its sweep to land at all; a fee below it needs the refund whatever it covers.
 */
export function registrationNeedsRefund(
  record: PendingRegistrationRecord,
  terms: RegistrationTerms | null,
  reached: boolean,
  seen: bigint,
  sweepFee?: bigint,
): boolean {
  if (
    !reached ||
    record.sweptAt !== undefined ||
    record.sweepTxHash ||
    (record.phase !== "awaiting_deposit" && record.phase !== "funded")
  )
    return false
  const { fee } = record
  if (sweepFee !== undefined && BigInt(fee) < sweepFee) return true
  if (
    terms?.fee === fee &&
    terms.minDeposit !== undefined &&
    (record.fundedAt !== undefined ||
      record.phase === "funded" ||
      seen >= registrationFloor({ min: BigInt(terms.minDeposit), fee: BigInt(fee) }))
  )
    return false
  if (terms?.fee !== undefined && terms.fee !== fee) return true
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
  /** The most the address showed. */
  seen: bigint
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
): boolean {
  if (record === null) return false
  if (!evidence.depositAdmitted && terms?.earnedExpected !== true) return false
  const reached = evidence.depositAdmitted || evidence.refunded || evidence.reached === true
  return registrationNeedsRefund(record, terms, reached, evidence.seen, sweepFee)
}

export interface RegistrationRefund {
  /** What the refund moved off the address, read from its transaction. */
  amount: bigint
  txHash: Hash
}

/** What one account's refund recovery reads, writes and prices with. */
export interface RegistrationRecoveryDeps {
  registrations: Pick<RegistrationStore, "view" | "apply">
  sipaDeposits: Pick<SipaDeposits, "view" | "get" | "apply">
  /** Reads receipts and balances. */
  l1(): PublicClient
  /** Every token an address accepts, `fee` (the registration token) first. */
  fundingTokens(fee: SipaFundingToken): Promise<[SipaFundingToken, ...SipaFundingToken[]]>
  /** A token's decimals, for a refund that moved it. */
  decimalsOf(token: Address): Promise<number>
  /** What a refund must reach to buy entry. */
  admissionFloor(record: PendingRegistrationRecord): bigint
  /** The entry a verified refund carries onto the record, none when it buys none. */
  entryFor(
    record: PendingRegistrationRecord,
    refund: RegistrationRefund,
  ): PendingRegistrationRecord["refundedEntry"]
  /** Seeds the rail records this wallet's registrations miss. */
  heal(networkId: string): Promise<unknown>
}

type Recovery = RegistrationRecoveryDeps & { reconciling: Map<string, Promise<void>> }

/** The account's refund recovery: reads a refund off the chain and settles its registration. */
export function createRegistrationRecovery(deps: RegistrationRecoveryDeps) {
  const c: Recovery = { ...deps, reconciling: new Map() }
  return {
    refunded: (record: PendingRegistrationRecord) => registrationRefunded(c, record),
    confirmed: (
      sipa: string,
      token: string,
      txHash: Hash,
      readReceipt: (hash: Hash) => Promise<TransactionReceipt>,
    ) => registrationRefundConfirmed(c, sipa, token, txHash, readReceipt),
    reconcile: (record: PendingRegistrationRecord) => reconcileRegistrationRefund(c, record),
    reopen: (record: PendingRegistrationRecord) => reopenRefundedDeposit(c, record),
    assertUnfunded: (record: PendingRegistrationRecord) => assertRegistrationUnfunded(c, record),
    prepare: (record: PendingRegistrationRecord, networkId: string) =>
      prepareRegistrationRefund(c, record, networkId),
    assertRefunded: (record: PendingRegistrationRecord) => assertRegistrationRefunded(c, record),
  }
}

export type RegistrationRecovery = ReturnType<typeof createRegistrationRecovery>

function loadedRegistrations(c: Recovery): readonly PendingRegistrationRecord[] {
  const { records, loaded, failed } = c.registrations.view.get()
  if (!loaded && !failed) throw new WalletError("wallet.notReady", "registrations not loaded")
  return records
}

/** The records a funds path routes on: unknown while they cannot be read, so the path holds. */
function knownRegistrations(c: Recovery): readonly PendingRegistrationRecord[] {
  if (c.registrations.view.get().failed)
    throw new WalletError("wallet.notReady", "registrations could not be read")
  return loadedRegistrations(c)
}

function assertCurrent(c: Recovery, record: PendingRegistrationRecord): void {
  const current = latestRegistration(knownRegistrations(c), record.account)
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
    throw new WalletError("refund.registrationChanged")
  }
}

function depositMatches(record: PendingRegistrationRecord, deposit: SipaDeposit): boolean {
  return deposit.recipientL2Address?.toLowerCase() === record.l2Address.toLowerCase()
}

/** Whether the registration accepts `token`: its sweep settles on the registration token's row. */
function acceptedToken(record: PendingRegistrationRecord, token: string | undefined): boolean {
  return token !== undefined && sweepsInto(record.l1ChainId, token, record.depositToken)
}

/** What the transaction moved out of the address, in registration-token units. */
async function refundedAmount(
  c: Recovery,
  receipt: TransactionReceipt,
  record: PendingRegistrationRecord,
): Promise<bigint> {
  let refunded = 0n
  if (receipt.status !== "success") return refunded
  const fee = registrationToken(record)
  for (const log of receipt.logs) {
    if (!acceptedToken(record, log.address)) continue
    let value: bigint
    try {
      const event = decodeEventLog({
        abi: erc20Abi,
        eventName: "Transfer",
        data: log.data,
        topics: log.topics,
      })
      if (event.args.from.toLowerCase() !== record.sipaAddress.toLowerCase()) continue
      value = event.args.value
    } catch {
      continue /* Not a Transfer. */
    }
    const sent = sameToken(fee, log.address)
      ? fee
      : { ...fee, address: log.address, decimals: await c.decimalsOf(log.address) }
    refunded += inRowUnits(value, sent, fee)
  }
  return refunded
}

/** The registration token, at the decimals the registration is priced in. */
function registrationToken(record: PendingRegistrationRecord): SipaFundingToken {
  return {
    address: record.depositToken as Address,
    symbol: WALLET_TOKEN_SYMBOL,
    decimals: DEFAULT_DECIMALS,
  }
}

const sameToken = (token: SipaFundingToken, address: string) =>
  token.address.toLowerCase() === address.toLowerCase()

/**
 * Every refund confirmed off an address, sized in registration-token units, as the address's record
 * holds them: the rail rewrites its own record's token, phase and recovery hash for whatever token
 * reaches the address next, and the refunds must outlive that.
 */
const refundsOf = (c: Recovery, record: PendingRegistrationRecord) =>
  registrationAt(loadedRegistrations(c), record.sipaAddress)?.refunds

function refundEvidence(c: Recovery, record: PendingRegistrationRecord): Hash[] {
  return refundsOf(c, record)?.txHashes ?? []
}

function unsizedRefunds(c: Recovery, record: PendingRegistrationRecord): Hash[] {
  const known = refundsOf(c, record)
  return known?.txHashes.filter((hash) => !(hash in (known.amounts ?? {}))) ?? []
}

function sizedRefunds(c: Recovery, record: PendingRegistrationRecord): Record<string, bigint> {
  return Object.fromEntries(
    Object.entries(refundsOf(c, record)?.amounts ?? {}).map(([hash, amount]) => [
      hash,
      BigInt(amount),
    ]),
  )
}

/** A refund sized by `amount` has settled the registration record off its receipt; one without still owes that. */
async function rememberRefund(
  c: Recovery,
  record: PendingRegistrationRecord,
  txHash: Hash,
  amount?: bigint,
): Promise<void> {
  const known = refundsOf(c, record)
  const isNew = !known?.txHashes.includes(txHash)
  const sizes = amount !== undefined && !(txHash in (known?.amounts ?? {}))
  if (!isNew && !sizes) return
  await c.registrations.apply(record.sipaAddress, {
    type: "refunded",
    txHash,
    ...(amount !== undefined ? { amount: amount.toString() } : {}),
  })
}

/**
 * The live record of a refunded address is funded no longer, and holds the entry a refund of the
 * earned total bought as `refundedEntry`, so the wallet stays open before any restart. A deposit
 * held in more than one token comes back one recovery per token: while the funded stamp stands the
 * sized refunds pool toward the entry the deposit as a whole earned, and a refund that buys none
 * leaves the stamp alone for the rest.
 */
async function settleRefundedRegistration(
  c: Recovery,
  record: PendingRegistrationRecord,
  txHash: Hash,
  amount: bigint,
): Promise<void> {
  const live = latestRegistration(knownRegistrations(c), record.account)
  if (
    live?.sipaAddress.toLowerCase() !== record.sipaAddress.toLowerCase() ||
    live.sweptAt !== undefined ||
    live.sweepTxHash
  )
    return
  const funded = live.fundedAt !== undefined || live.phase === "funded"
  const pooled = funded
    ? Object.entries(sizedRefunds(c, record)).reduce(
        (sum, [hash, prior]) => (hash === txHash ? sum : sum + prior),
        amount,
      )
    : amount
  const entry = c.entryFor(live, { amount: pooled, txHash })
  if (!entry) return
  await c.registrations.apply(record.sipaAddress, {
    type: "refunded",
    txHash,
    amount: amount.toString(),
    entry,
  })
}

function assertDeposit(
  record: PendingRegistrationRecord,
  deposit: SipaDeposit | null,
): asserts deposit is SipaDeposit {
  if (!deposit || !depositMatches(record, deposit)) {
    throw new WalletError("refund.depositUnavailable")
  }
}

const depositOf = (c: Recovery, sipa: string): SipaDeposit | null =>
  selectSipaDeposit(c.sipaDeposits.view.get(), sipa) ?? null

/** The rail's record, while it speaks for a token the registration accepts. */
function railRecord(c: Recovery, record: PendingRegistrationRecord): SipaDeposit | null {
  const deposit = depositOf(c, record.sipaAddress)
  return deposit !== null &&
    depositMatches(record, deposit) &&
    acceptedToken(record, deposit.tokenAddress)
    ? deposit
    : null
}

/**
 * The record's deposit was recovered in a confirmed L1 transaction and nothing came back since:
 * funds the rail sees at the address again want another recovery, whatever was refunded before.
 * Reconciliation remembers the refund the rail's record shows.
 */
function registrationRefunded(c: Recovery, record: PendingRegistrationRecord): boolean {
  const deposit = railRecord(c, record)
  if (deposit?.phase === "recoverable" || deposit?.phase === "sweeping") return false
  if (deposit?.phase === "recovered" && deposit.recoveryTxHash) return true
  return refundEvidence(c, record).length > 0
}

/**
 * A recovery confirmed off `sipa` from any surface, the activity list included. One that moved a
 * registration's token is remembered as its refund and settles the registration's record. Its
 * receipt sizes it: funds landing after the recovery was submitted went with it. A receipt that
 * cannot be read leaves the record as it is, entry included, and the refund unsized for a later
 * reconciliation to settle.
 */
async function registrationRefundConfirmed(
  c: Recovery,
  sipa: string,
  token: string,
  txHash: Hash,
  readReceipt: (hash: Hash) => Promise<TransactionReceipt>,
): Promise<void> {
  const record = registrationAt(knownRegistrations(c), sipa)
  if (!record || !acceptedToken(record, token)) return
  await rememberRefund(c, record, txHash)
  const receipt = await bestEffort("refund.unchecked", readReceipt(txHash))
  if (!receipt) return
  const amount = await refundedAmount(c, receipt, record)
  if (amount > 0n) await settleRefundedRegistration(c, record, txHash, amount)
  await rememberRefund(c, record, txHash, amount)
}

/**
 * Settle a refund whose receipt wait did not finish: the hash is stamped at submission, the
 * `recovered` phase only on confirmation, and only while the address holds nothing, since funds
 * can reach it again after the refund. A receipt is read once per hash; a reverted one is
 * unstamped so the address can be recovered again. The balance read spans every token the
 * registration accepts, so the rail's record settles while it names one of them. Under any other
 * token's name the record keeps its phase: its hash is read only for what it moved in an accepted
 * token. Refunds remembered unsized are sized here too, and settle the registration's record.
 */
function reconcileRegistrationRefund(
  c: Recovery,
  record: PendingRegistrationRecord,
): Promise<void> {
  const store = c.sipaDeposits
  const deposit = depositOf(c, record.sipaAddress)
  if (!deposit || !depositMatches(record, deposit)) return Promise.resolve()
  const hash = deposit.recoveryTxHash
  const settled = deposit.phase === "recovered"
  const named = acceptedToken(record, deposit.tokenAddress)
  const remembered = hash !== undefined && refundEvidence(c, record).includes(hash)
  // The refund the rail's record shows joins the evidence before the evidence is read.
  if (settled && named && hash !== undefined && !remembered)
    return rememberRefund(c, record, hash).then(() => reconcileRegistrationRefund(c, record))
  const unsized = unsizedRefunds(c, record)
  // A settled record in an accepted token vouches for its hash without a receipt.
  const unread = hash !== undefined && !remembered && !(settled && named)
  const unsettled = hash !== undefined && !settled && named && recovering(deposit)
  if (!unread && !unsettled && unsized.length === 0) return Promise.resolve()
  const key = `${deposit.sipaAddress.toLowerCase()}:${hash ?? ""}`
  let inflight = c.reconciling.get(key)
  if (!inflight) {
    const client = c.l1()
    inflight = (async () => {
      for (const owed of unsized) {
        const receipt = await bestEffort(
          "refund.unchecked",
          client.getTransactionReceipt({ hash: owed }),
        )
        if (!receipt) continue
        const amount = await refundedAmount(c, receipt, record)
        if (amount > 0n) await settleRefundedRegistration(c, record, owed, amount)
        await rememberRefund(c, record, owed, amount)
      }
      if (unread && hash !== undefined) {
        const receipt = await client.getTransactionReceipt({ hash })
        if (receipt.status !== "success") {
          await store.apply(deposit.sipaAddress, { type: "recoveryReverted", txHash: hash })
          return
        }
        const amount = await refundedAmount(c, receipt, record)
        if (amount > 0n) {
          await settleRefundedRegistration(c, record, hash, amount)
          await rememberRefund(c, record, hash, amount)
        }
      }
      if (!unsettled || hash === undefined) return
      const balance = await readSipaBalance(
        client,
        record.sipaAddress as Address,
        await c.fundingTokens(registrationToken(record)),
      )
      const latest = await store.get(deposit.sipaAddress)
      if (balance === 0n && latest && recovering(latest) && latest.recoveryTxHash === hash)
        await store.apply(deposit.sipaAddress, {
          type: "recoverySent",
          txHash: hash,
          confirmed: true,
        })
    })().finally(() => c.reconciling.delete(key))
    c.reconciling.set(key, inflight)
  }
  return inflight
}

/** A stamped recovery is this deposit's until a sweep of the address lands or is claimed. */
function recovering(deposit: SipaDeposit): boolean {
  return !deposit.sweepTxHash && deposit.phase !== "pendingClaim" && deposit.phase !== "claimed"
}

/**
 * A refunded address the registration re-enters starts a new deposit cycle on the rail. The
 * recovery stays as refund evidence; a settled record would never be scanned for the new deposit.
 */
async function reopenRefundedDeposit(c: Recovery, record: PendingRegistrationRecord) {
  await c.sipaDeposits.apply(record.sipaAddress, { type: "reentered" })
}

/** An address the earned quote cannot use may be replaced outright only while nothing reached it. */
async function assertRegistrationUnfunded(
  c: Recovery,
  record: PendingRegistrationRecord,
): Promise<void> {
  assertCurrent(c, record)
  if (record.phase !== "awaiting_deposit" || record.fundedAt !== undefined)
    throw new WalletError("refund.depositReached")
  const balance = await readSipaBalance(
    c.l1(),
    record.sipaAddress as Address,
    await c.fundingTokens(registrationToken(record)),
  )
  if (balance !== 0n) throw new WalletError("refund.depositReached")
  assertCurrent(c, record)
}

/** Reconstruct the original recovery inputs; never derive them from a replacement quote. */
async function prepareRegistrationRefund(
  c: Recovery,
  record: PendingRegistrationRecord,
  networkId: string,
): Promise<SipaDeposit> {
  assertCurrent(c, record)
  await c.heal(networkId)
  const deposit = (await c.sipaDeposits.get(record.sipaAddress)) ?? null
  assertDeposit(record, deposit)
  const { token, status } = await readSipaHolding(
    c.l1(),
    record.sipaAddress as Address,
    await c.fundingTokens(registrationToken(record)),
  )
  if (status.balance === 0n) throw new WalletError("refund.nothingHeld")
  assertCurrent(c, record)
  // The rail's record names whatever token reached the address last; the refund moves the token
  // that holds the funds.
  return {
    ...deposit,
    amount: formatUnits(status.balance, token.decimals),
    tokenAddress: token.address,
    tokenSymbol: token.symbol,
    tokenDecimals: token.decimals,
  }
}

/**
 * Only a confirmed token refund and an empty old address allow a new registration address. The
 * refund reported is the largest confirmed off the address: the entry it bought is not revoked by
 * a later, smaller refund of funds that came back.
 */
async function assertRegistrationRefunded(
  c: Recovery,
  record: PendingRegistrationRecord,
): Promise<RegistrationRefund> {
  assertCurrent(c, record)
  await loadRecords(c.sipaDeposits.view)
  // The receipts are read again below.
  await bestEffort("refund.unchecked", reconcileRegistrationRefund(c, record))
  const refunded = registrationRefunded(c, record)
  // The refund the rail's record shows is part of the evidence before it is read.
  const shown = railRecord(c, record)
  if (refunded && shown?.phase === "recovered" && shown.recoveryTxHash)
    await rememberRefund(c, record, shown.recoveryTxHash)
  const hashes = refunded ? refundEvidence(c, record) : []
  if (hashes.length === 0) {
    assertDeposit(record, depositOf(c, record.sipaAddress))
    throw new WalletError("refund.notRecovered")
  }
  const client = c.l1()
  // A receipt the chain no longer serves (a refund reorganized away) counts for nothing; the
  // others still do.
  const [receipts, balance] = await Promise.all([
    Promise.allSettled(hashes.map((hash) => client.getTransactionReceipt({ hash }))),
    readSipaBalance(
      client,
      record.sipaAddress as Address,
      await c.fundingTokens(registrationToken(record)),
    ),
  ])
  const sizes = await Promise.all(
    receipts.map((receipt) =>
      receipt.status === "fulfilled" ? refundedAmount(c, receipt.value, record) : undefined,
    ),
  )
  let largest: RegistrationRefund | undefined
  let unread = false
  sizes.forEach((amount, i) => {
    if (amount === undefined) {
      unread = true
      return
    }
    if (amount > 0n && (largest === undefined || amount >= largest.amount))
      largest = { amount, txHash: hashes[i] }
  })
  // Refunds pooled on the record while it was funded outrank any one receipt, on the evidence read
  // here alone: every refund the pool counted must still read as a successful transfer, and the
  // pool credits no more than those receipts return now.
  const pooled = latestRegistration(knownRegistrations(c), record.account)?.refundedEntry
  const sizeOf = (hash: string) => sizes[hashes.indexOf(hash as Hash)] ?? 0n
  const counted = Object.keys(sizedRefunds(c, record))
  if (pooled && sizeOf(pooled.recoveryTxHash) > 0n && counted.every((hash) => sizeOf(hash) > 0n)) {
    const returned = counted.reduce((sum, hash) => sum + sizeOf(hash), 0n)
    const amount = returned < BigInt(pooled.amount) ? returned : BigInt(pooled.amount)
    if (amount > (largest?.amount ?? 0n))
      largest = { amount, txHash: pooled.recoveryTxHash as Hash }
  }
  if (balance !== 0n || (largest === undefined && !unread))
    throw new WalletError("refund.incomplete")
  // An unread receipt may be the refund that bought entry; a restart on the rest alone would
  // drop it, so only evidence that qualifies by itself goes ahead without it.
  if (largest === undefined || (unread && largest.amount < c.admissionFloor(record)))
    throw new WalletError("refund.receiptUnread")
  assertCurrent(c, record)
  return largest
}
