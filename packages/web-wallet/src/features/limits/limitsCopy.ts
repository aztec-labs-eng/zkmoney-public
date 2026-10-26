/** Every line the About limits sheet shows, including the lines other screens add to it. */

export const SHEET_TITLE = "About limits"
export const CHECK_AGAIN = "Check again"
export const UNAVAILABLE = "Unavailable"
export const MORE_INFO = "See more information about limits"

// Maximum per transaction

export const LIMIT_TITLE = "Maximum per transaction"
export const LIMIT_ROW = { send: "Per send", deposit: "Per deposit", withdrawal: "Per withdrawal" }

export const LIMIT_NOTE = "No daily limit or total balance limit."

export const MAX_SEND_ROW = { send: "Maximum send amount", received: "Maximum received" }
export const CHECKING = "Checking…"

export const swapCreditNote = (symbol: string, into: string) =>
  `${symbol} is swapped to ${into} at the market rate, so the ${into} credited can differ.`

// Shared deposit capacity

export const CAPACITY_TITLE = "Shared deposit capacity"
export const CAPACITY_CHECKING = "Checking capacity…"
export const CAPACITY_UNAVAILABLE = "Capacity could not be checked."
export const CAPACITY_FRESH = "Capacity up to date"
export const CAPACITY_STALE = "Capacity out of date"
export const CAPACITY_UNSUPPORTED = "Capacity can't be checked on this network."

export const CAPACITY_ROW = {
  available: "Available",
  total: "Total capacity",
  rate: "Refill rate",
  checked: "Last checked",
}

export const NO_REFILL = "No automatic refill"
export const rateUnderCent = (symbol: string) => `Less than 0.01 ${symbol} per minute`
export const ratePerMinute = (amount: string) => `${amount} per minute`

export const CAPACITY_DISCLOSURE =
  "Capacity is shared by everyone and refills continuously. It does not reset at midnight."
export const NO_REFILL_DISCLOSURE =
  "Capacity is shared by everyone. No automatic refill is configured. It does not reset at midnight."
export const WITHDRAWALS_NOTE = "Withdrawals do not restore deposit capacity."
export const CAPACITY_NOT_RESERVED_NOTE =
  "Sending doesn't reserve capacity. If it runs out first, processing waits and your funds stay at the deposit address."
export const ADDRESS_RECHECK_NOTE =
  "Anyone with this address can still send to it, and the wallet can't stop that transfer. A saved address or QR code doesn't keep this capacity check, so check again before each transfer."

export const swapCapacityNote = (settlement: string, symbol: string) =>
  `Maximum send amount for current capacity unavailable: the ${settlement} credited from ${symbol} is set by the swap.`

// Sponsored transactions

export const SPONSORSHIP_TITLE = "Sponsored transactions"

export const ALLOWANCE_SCOPE =
  "zk.money pays the network fee for sends, payment links, withdrawals and deposit addresses."

export const SPONSORSHIP_STATUS = {
  loading: "Checking sponsored transactions…",
  unavailable: "Sponsored transactions could not be checked.",
  unsupported: "Sponsored transaction details are not available for this deployment.",
  noAccount: "Sponsored transactions come with a zk.money account.",
  renewalUnknown: "Renewal status unknown",
  spent: "No sponsored transactions left",
}

export const usesLeft = (uses: number) =>
  `${uses} sponsored ${uses === 1 ? "transaction" : "transactions"} left`

export const SPONSORSHIP_ROW = {
  firstAllowance: "First allowance",
  allowance: "Allowance",
  usedByYou: "Used by your transactions",
  usedByAddresses: "Used by deposit addresses",
  renews: "Renews",
}

export const RENEWS_VALUE = { unknown: "Unknown", no: "No", whenUsedUp: "When used up" }
export const renewsAfterUsedUp = (period: string) => `${period} after being used up`

export const RENEWAL_UNKNOWN_NOTE =
  "We can't confirm renewal yet. Your next eligible transaction may start a new allowance."
