import type { Address } from "viem"

/** Where the withdraw flow opens. */
export interface WithdrawFlowEntry {
  recipient?: Address
  name?: string
  /** The recipient is the saved ether.fi Cash contact. */
  etherfi?: boolean
  /** A bridge chain to start on, with its first token. */
  startChainId?: number
  /** Opens on the amount, `recipient` already chosen. */
  atAmount?: boolean
  /** With `atAmount`, the network and coin picker opens over the amount first. */
  pick?: boolean
  /** Opens on the ether.fi Cash address in place of the address step. */
  start?: "etherfi"
}

/** The route state a navigation to `/withdraw` carries to open the flow at once. */
export interface WithdrawLocationState {
  withdraw: WithdrawFlowEntry
}
