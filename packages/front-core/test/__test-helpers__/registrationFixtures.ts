import type { Address, Hex } from "viem"

import type { SIPADepositRecord } from "../../src/core/services/deposits/SIPADepositStore"
import type { FundingBurn, PendingRegistrationRecord } from "../../src/core/services/registration"

const ACCOUNT: Address = "0x00000000000000000000000000000000000000aa"
const SIPA: Address = "0x00000000000000000000000000000000000000c3"
const NAME_HASH: Hex = `0x${"77".repeat(32)}`
const L2: Hex = `0x${"cd".repeat(32)}`

/** The one registration the fixtures below describe. */
export const REG = {
  account: ACCOUNT,
  sipaAddress: SIPA,
  nameHash: NAME_HASH,
  l2Address: L2,
  tag: "alice",
  l1ChainId: 11155111,
}

export function pendingRegistration(
  over: Partial<PendingRegistrationRecord> = {},
): PendingRegistrationRecord {
  return {
    ...REG,
    depositToken: `0x${"bb".repeat(20)}`,
    broadcast: true,
    phase: "awaiting_deposit",
    retries: 0,
    startTime: 1_700_000_000_000,
    ...over,
  }
}

/** The registration's rail deposit, as discovered and not yet swept. */
export function sipaDeposit(over: Partial<SIPADepositRecord> = {}): SIPADepositRecord {
  return {
    sipaAddress: SIPA,
    recipientL2Address: L2,
    messageSecret: `0x${"01".repeat(32)}`,
    recipientHash: `0x${"02".repeat(32)}`,
    recoveryAddress: ACCOUNT,
    l1ChainId: REG.l1ChainId,
    amount: "5",
    tokenSymbol: "USDC",
    phase: "broadcast",
    startTime: 1_700_000_000_000,
    intent: "registration",
    ...over,
  }
}

/** A withdrawal burn to the registration's address, still on its way. */
export function fundingBurn(over: Partial<FundingBurn> = {}): FundingBurn {
  return { recipient: SIPA, phase: "finalizing_l1", ...over }
}
