import { formatUnits, type Address } from "viem"
import type { SIPADepositRecord, SIPASweep } from "./SIPADepositStore"

/** One deposit an address credited: the record as it reads for one token, and that token when split out. */
export interface SipaCredit {
  record: SIPADepositRecord
  /** The credited token this view isolates; absent on the record's own view. */
  token?: Address
}

const key = (address: string | undefined) => address?.toLowerCase() ?? ""

/**
 * The deposits a SIPA record stands for. A SIPA accepts every row's token and sweeps each through
 * its own row, so funds sent in two tokens are two deposits: the record reads as its latest, and
 * each other token its sweeps credited reads as a claimed deposit of its own latest sweep.
 */
export function sipaCredits(record: SIPADepositRecord): SipaCredit[] {
  const own = key(record.rowToken ?? record.tokenAddress)
  const latest = new Map<string, SIPASweep>()
  for (const sweep of record.sweeps ?? []) {
    const token = key(sweep.tokenAddress ?? record.tokenAddress)
    if (token && token !== own) latest.set(token, sweep)
  }
  return [
    { record },
    ...[...latest.values()].map((sweep) => ({
      token: sweep.tokenAddress!,
      record: creditOf(record, sweep),
    })),
  ]
}

function creditOf(record: SIPADepositRecord, sweep: SIPASweep): SIPADepositRecord {
  const token = key(sweep.tokenAddress)
  const sweeps = (record.sweeps ?? []).filter((s) => key(s.tokenAddress) === token)
  const decimals = sweep.tokenDecimals ?? record.tokenDecimals ?? 18
  return {
    ...record,
    phase: "claimed",
    amount: formatUnits(BigInt(sweep.netAmount), decimals),
    netAmount: sweep.netAmount,
    fee: sweep.fee,
    tokenAddress: sweep.tokenAddress,
    rowToken: undefined,
    tokenSymbol: sweep.tokenSymbol ?? record.tokenSymbol,
    tokenDecimals: decimals,
    fundingTokenSymbol: sweep.fundingTokenSymbol ?? sweep.tokenSymbol,
    inboxIndex: sweep.inboxIndex,
    sweepTxHash: sweep.sweepTxHash,
    claimedInboxIndexes: sweeps.map((s) => s.inboxIndex),
    sweeps,
    claimTxHash: undefined,
    ...(sweep.settledAt === undefined ? {} : { endTime: sweep.settledAt }),
  }
}
