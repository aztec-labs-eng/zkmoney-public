/**
 * The detail sheet's view of a deposit this wallet just broadcast, before the SIPA sync loop has a
 * record of it. It carries the figures the user was charged and upgrades field by field as
 * discovery, the sweep and the claim land in the store. Discovery of a pooled address writes a
 * placeholder record, stamped from the manifest token before anything was sent there, so the merge
 * keeps the charged figures over a placeholder's and takes every other field the store holds.
 */
import { quotedDepositFee } from "@obsidion/core/constants"
import type { SIPADepositRecord } from "@obsidion/front-core"
import type { SentDeposit } from "./DepositFromWalletModal"
import type { DepositDisplayFacts } from "./loadDepositFacts"

/**
 * Display-only stand-in for the record event discovery has not created yet. It carries the quoted
 * total and the portal's share of it, so `depositAmounts` reproduces what the user was charged.
 */
export function pendingDepositRecord(
  sent: SentDeposit,
  l1ChainId: number,
  facts: DepositDisplayFacts,
): SIPADepositRecord {
  return {
    sipaAddress: sent.address,
    phase: "funding",
    amount: sent.amount,
    fee: quotedDepositFee(facts.sweepFeeAtomic, facts.fpcFundingCutAtomic).toString(),
    fpcFundingCut: facts.fpcFundingCutAtomic.toString(),
    tokenSymbol: sent.tokenSymbol,
    l1ChainId,
    startTime: Date.now(),
    fundingTxHash: sent.txHash,
    walletName: sent.walletName,
    walletAddress: sent.walletAddress,
    // Note fields are unknown until discovery; this view never reaches the store.
    recipientL2Address: "",
    messageSecret: "",
    recipientHash: "",
    recoveryAddress: "",
  }
}

/** What a placeholder only guesses at. A USDC transfer must not come back reading as a DAI one. */
const PLACEHOLDER_FIELDS = ["amount", "tokenSymbol", "tokenDecimals", "tokenAddress", "phase"]

/** The phases a zero-amount record can be in before anything was sent to the address: resolution
 *  seeds one the moment it derives the address, and pooled discovery writes the other. */
const PLACEHOLDER_PHASES = ["resolved", "broadcast"]

/** Fields the store actually knows. A placeholder carries a zero amount in a phase that precedes
 *  any transfer. A zero amount in any other phase is settled, a recovered deposit among them, and
 *  keeps its own fields. */
function knownFields(stored: SIPADepositRecord): Partial<SIPADepositRecord> {
  const placeholder = PLACEHOLDER_PHASES.includes(stored.phase) && Number(stored.amount) === 0
  const entries = Object.entries(stored).filter(([key, value]) => {
    if (value === undefined || value === null || value === "") return false
    return !(placeholder && PLACEHOLDER_FIELDS.includes(key))
  })
  return Object.fromEntries(entries) as Partial<SIPADepositRecord>
}

/** The charged figures under whatever the store has learned since. Undefined while the quote is
 *  still loading and the store holds nothing for the address. */
export function sentDepositRecord(
  sent: SentDeposit,
  stored: SIPADepositRecord | undefined,
  l1ChainId: number,
  facts?: DepositDisplayFacts,
): SIPADepositRecord | undefined {
  if (!facts) return stored
  const pending = pendingDepositRecord(sent, l1ChainId, facts)
  return stored ? { ...pending, ...knownFields(stored) } : pending
}
