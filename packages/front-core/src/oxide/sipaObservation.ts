/**
 * One L1 observation of every tracked SIPA, whatever its flavor: the portal deposits its sweeps made,
 * what left it and what funded it, and what it holds now. A fixed number of requests per window,
 * however many SIPAs. See docs/bridge/sipa-pipeline.md.
 */

import type { Address, Hex, PublicClient } from "viem"
import {
  readPortalDeposits,
  readSipaBalancesMany,
  readTokenTransfers,
  type PortalDeposit,
  type TokenTransfer,
} from "@obsidion/sdk"
import { logger } from "src/utils/logger"

/** One SIPA address to observe. */
export interface SipaSubject {
  address: Address
  /** What its sweeps deposit to: the record's `recipientHash`. */
  commitment: Hex
  /** The first block to read for it. */
  fromBlock: bigint
  /** Whether to read what funded it. */
  inflows: boolean
}

/** A sweep of one SIPA, with its claim inputs. */
export interface ObservedSweep {
  index: bigint
  /** The amount credited on L2. */
  amount: bigint
  /** The L1→L2 message hash. */
  messageKey: Hex
  blockNumber: bigint
  txHash: Hex
}

export interface SipaObserved {
  sweeps: ObservedSweep[]
  /** Every transfer out of the SIPA: sweep legs and recoveries. */
  outflows: TokenTransfer[]
  /** Transfers out in a transaction with no sweep of this SIPA. */
  recoveries: TokenTransfer[]
  /** Transfers into the SIPA; undefined when not read. */
  inflows?: TokenTransfer[]
  /** Balances keyed by lowercased token, ETH under the zero address; undefined when the read failed. */
  balances?: Map<string, bigint>
}

/**
 * Observes `subjects` through `head`. Subjects that share a commitment are read from the earliest of
 * their starts, so a deposit to that commitment always meets the outflow that names its SIPA. Each
 * window is read on its own: a subject whose window failed is missing from the result, and the rest
 * are observed.
 */
export async function observeSipas(
  publicClient: PublicClient,
  params: {
    portal: Address
    tokens: readonly Address[]
    subjects: readonly SipaSubject[]
    head: bigint
  },
): Promise<{
  observed: Map<string, SipaObserved>
  /** Deposits to a tracked commitment that no tracked SIPA sent: their SIPAs are not tracked yet. */
  strays: PortalDeposit[]
}> {
  const { portal, tokens, head } = params
  const subjects = dedupe(params.subjects)
  const startOf = new Map<string, bigint>()
  for (const s of subjects) {
    const key = s.commitment.toLowerCase()
    const known = startOf.get(key)
    if (known === undefined || s.fromBlock < known) startOf.set(key, s.fromBlock)
  }
  const windows = new Map<bigint, SipaSubject[]>()
  for (const s of subjects) {
    const from = startOf.get(s.commitment.toLowerCase())!
    windows.set(from, [...(windows.get(from) ?? []), s])
  }

  const [settled, balances] = await Promise.all([
    Promise.allSettled(
      [...windows].map(async ([from, group]) => {
        const addresses = group.map((s) => s.address)
        const [deposits, outflows, inflows] = await Promise.all([
          readPortalDeposits(
            publicClient,
            portal,
            group.map((s) => s.commitment),
            from,
            head,
          ),
          readTokenTransfers(publicClient, tokens, "from", addresses, from, head),
          readTokenTransfers(
            publicClient,
            tokens,
            "to",
            group.filter((s) => s.inflows).map((s) => s.address),
            from,
            head,
          ),
        ])
        return { group, deposits, outflows, inflows }
      }),
    ),
    readSipaBalancesMany(
      publicClient,
      subjects.map((s) => s.address),
      tokens,
    ).catch((err: unknown) => {
      logger.warn("[sipaObservation] holdings read failed:", err)
      return undefined
    }),
  ])

  const reads = settled.flatMap((read, i) => {
    if (read.status === "fulfilled") return [read.value]
    logger.warn(`[sipaObservation] window from ${[...windows.keys()][i]} failed:`, read.reason)
    return []
  })
  const out = new Map<string, SipaObserved>()
  for (const s of reads.flatMap((read) => read.group)) {
    const key = s.address.toLowerCase()
    out.set(key, {
      sweeps: [],
      outflows: [],
      recoveries: [],
      ...(s.inflows ? { inflows: [] } : {}),
      balances: balances?.get(key),
    })
  }
  const deposits = new Map<string, PortalDeposit>()
  for (const read of reads) {
    for (const deposit of read.deposits)
      deposits.set(`${deposit.txHash}:${deposit.logIndex}`, deposit)
    for (const flow of read.outflows) out.get(flow.from.toLowerCase())?.outflows.push(flow)
    for (const flow of read.inflows) out.get(flow.to.toLowerCase())?.inflows?.push(flow)
  }

  const byCommitment = new Map<string, SipaSubject[]>()
  for (const s of reads.flatMap((read) => read.group)) {
    const key = s.commitment.toLowerCase()
    byCommitment.set(key, [...(byCommitment.get(key) ?? []), s])
  }
  const strays: PortalDeposit[] = []
  for (const deposit of [...deposits.values()].sort(byPosition)) {
    const owner = ownerOf(deposit, byCommitment.get(deposit.recipientCommitment) ?? [], out)
    if (!owner) {
      strays.push(deposit)
      continue
    }
    out.get(owner)!.sweeps.push({
      index: deposit.index,
      amount: deposit.amount,
      messageKey: deposit.key,
      blockNumber: deposit.blockNumber,
      txHash: deposit.txHash,
    })
  }
  for (const observed of out.values()) {
    const swept = new Set(observed.sweeps.map((s) => s.txHash.toLowerCase()))
    observed.recoveries = observed.outflows.filter((flow) => !swept.has(flow.txHash.toLowerCase()))
  }
  return { observed: out, strays }
}

/**
 * The tracked SIPA a deposit swept: the one with that commitment that sent tokens in the deposit's
 * transaction, as every sweep does. Commitment alone is not enough: addresses that share a salt,
 * such as one name's registrations at two fees, share it.
 */
function ownerOf(
  deposit: PortalDeposit,
  candidates: readonly SipaSubject[],
  observed: Map<string, SipaObserved>,
): string | undefined {
  const tx = deposit.txHash.toLowerCase()
  return candidates
    .map((s) => s.address.toLowerCase())
    .find((key) => observed.get(key)?.outflows.some((flow) => flow.txHash.toLowerCase() === tx))
}

function dedupe(subjects: readonly SipaSubject[]): SipaSubject[] {
  const byAddress = new Map<string, SipaSubject>()
  for (const s of subjects) {
    const key = s.address.toLowerCase()
    const known = byAddress.get(key)
    byAddress.set(
      key,
      known
        ? {
            ...known,
            fromBlock: s.fromBlock < known.fromBlock ? s.fromBlock : known.fromBlock,
            inflows: known.inflows || s.inflows,
          }
        : s,
    )
  }
  return [...byAddress.values()]
}

const byPosition = (a: PortalDeposit, b: PortalDeposit) =>
  a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1
