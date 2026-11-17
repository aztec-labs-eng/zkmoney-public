import type { SipaDeposit } from "./sipaDeposits"

/** A plain deposit, which a bridge may have funded. */
export const mayBeBridgedIn = (record: Pick<SipaDeposit, "intent" | "direct">) =>
  !record.intent && !record.direct

/**
 * Whether a deposit's funding still waits to be read for a bridge fill. Never where the profile
 * reads no fills (`readsFills`): nothing would ever read it.
 */
export const fundingUnread = (
  record: Pick<SipaDeposit, "intent" | "direct" | "funding">,
  readsFills: boolean,
) => readsFills && mayBeBridgedIn(record) && !record.funding

/**
 * Who sent a deposit's funds on L1. Unknown while its funding is unread, and for a bridge's fill,
 * whose transfer a relayer sent: its bridge-in names the depositor.
 */
export const depositFunder = (
  record: Pick<
    SipaDeposit,
    "intent" | "direct" | "funding" | "fundingFromAddress" | "walletAddress"
  >,
  readsFills: boolean,
): string | undefined =>
  fundingUnread(record, readsFills) || record.funding === "bridge"
    ? undefined
    : record.fundingFromAddress ?? record.walletAddress
