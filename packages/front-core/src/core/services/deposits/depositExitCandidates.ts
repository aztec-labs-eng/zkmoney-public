/**
 * Migration-time deposit-exit enumeration: persisted SIPA records + L1 logs → realm-ready hex
 * candidate descriptors for the frozen v4 exit runtime (the `getDepositCandidates` seam). Strings
 * only — the realm re-mints from hex. Always migration-mode: locally-claimed indexes are
 * candidates (local claim state can lie at freeze), and any L1/inbox read failure throws
 * `DepositExitError("transient")` — a partial view must never look complete. Records missing their
 * message secret, and sweeps whose L1 message key reads back null, surface as residuals, never
 * silent skips. No secret material is ever logged or placed in error messages.
 */
import type { Address, Hex, PublicClient } from "viem"
import { DepositExitError, readDepositMessageKey, readSweepEvents } from "@obsidion/sdk"
import type { SIPADepositRecord } from "./SIPADepositStore"
import { enumerateRefundableDeposits, type RefundDepositL1Reads } from "./refundableDeposits"

/** Hex/decimal-string descriptor crossing the frozen-realm seam. */
export interface DepositExitCandidate {
  sipaAddress: string
  /** Fr hex — spendable secret; never log. */
  messageSecret: string
  /** Fr hex — spendable secret; never log. */
  messageKey: string
  /** Decimal string. */
  messageLeafIndex: string
  /** The sweep's NET amount from the L1 log, decimal string. */
  amount: string
  /** Fr hex per level, anchored on the sweep's L1 block. */
  inboxSiblingPath: string[]
}

/** A record that cannot become a candidate; surfaced for UX, not dropped. */
export interface DepositExitResidual {
  sipaAddress: string
  reason: "missing-message-secret" | "message-key-unreadable"
}

export interface DepositExitEnumeration {
  candidates: DepositExitCandidate[]
  residuals: DepositExitResidual[]
}

/** Production `RefundDepositL1Reads` over a viem client + the relevant portal (sdk log readers). */
export function createDepositExitL1Reads(
  publicClient: PublicClient,
  portal: Address,
  range?: { fromBlock: bigint; toBlock: bigint },
): RefundDepositL1Reads<{ toString(): string }> {
  return {
    readSweepEvents: (sipaAddress) =>
      readSweepEvents(publicClient, sipaAddress as Address, range?.fromBlock, range?.toBlock),
    readDepositMessageKey: (sweepTxHash, inboxIndex) =>
      readDepositMessageKey(publicClient, portal, sweepTxHash as Hex, inboxIndex),
  }
}

export async function enumerateDepositExitCandidates(args: {
  records: readonly SIPADepositRecord[]
  recipientL2Address: string
  l1Reads: RefundDepositL1Reads<{ toString(): string }>
  /** Inbox sibling-path source (production: `buildInboxSiblingPathHex` over the frozen Inbox). */
  buildSiblingPath: (messageLeafIndex: bigint, anchorBlock?: bigint) => Promise<string[]>
}): Promise<DepositExitEnumeration> {
  const recipient = args.recipientL2Address.toLowerCase()
  // No local-phase gate: candidate enumeration ignores phase in migration mode, so residuals must
  // too — otherwise a record with a stale phase and no secret lands in neither list.
  const residuals: DepositExitResidual[] = args.records
    .filter((r) => r.recipientL2Address.toLowerCase() === recipient && !r.messageSecret)
    .map((r) => ({ sipaAddress: r.sipaAddress, reason: "missing-message-secret" as const }))

  try {
    const unreadable = new Set<string>()
    const refundable = await enumerateRefundableDeposits({
      records: args.records,
      l1Reads: args.l1Reads,
      recipientL2Address: args.recipientL2Address,
      includeLocallyClaimed: true,
      readErrorsThrow: true,
      onUnreadableMessageKey: (sipaAddress) => unreadable.add(sipaAddress),
    })
    for (const sipaAddress of unreadable) {
      residuals.push({ sipaAddress, reason: "message-key-unreadable" })
    }
    const candidates: DepositExitCandidate[] = []
    for (const dep of refundable) {
      candidates.push({
        sipaAddress: dep.sipaAddress,
        messageSecret: dep.messageSecret,
        messageKey: dep.messageKey.toString(),
        messageLeafIndex: dep.messageLeafIndex.toString(),
        amount: dep.amount.toString(),
        inboxSiblingPath: await args.buildSiblingPath(dep.messageLeafIndex, dep.sweepBlockNumber),
      })
    }
    return { candidates, residuals }
  } catch (err) {
    throw err instanceof DepositExitError ? err : new DepositExitError("transient", { cause: err })
  }
}
