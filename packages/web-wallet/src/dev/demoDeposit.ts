/**
 * Dev demo: the deposit screen's address without the derivation behind it. A demo session has no
 * wallet to prove with and no broadcaster to publish to, so a fixture stands in for a pooled
 * address and the Show / Copy / Deposit affordances become reviewable.
 */
import type { Address } from "viem"
import type { DepositAddress } from "../features/deposit/sipaGateway"
import { DEMO_HANDLE } from "./demoFixtures"

/** SIPA-shaped, and deliberately none of the seeded deposits' addresses. */
const DEMO_DEPOSIT_SIPA = "0x51a0de905170000000000000000000000000d0e5" as Address

export function demoDepositAddress(tag = DEMO_HANDLE): DepositAddress {
  return { address: DEMO_DEPOSIT_SIPA, name: `${tag}.zk.money` }
}
