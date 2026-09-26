/**
 * Dev demo: the withdrawal finalization's calldata, which a real run derives from the Aztec node
 * and an enclave signature over the burn checkpoint. The demo has neither, so this stands in at the
 * one seam that needs them — everything after it (the injected wallet, the delayed receipt, the
 * record patch) is the app's own path over the fake L1.
 *
 * Only the target is honest — the portal, where a real self-finalize submits its
 * `OxidePortal.withdraw` call. The calldata is shape-plausible rather than decodable: the fake L1
 * accepts any transaction, and nothing reads it back.
 */
import { encodeFunctionData, keccak256, type Address, type Hex } from "viem"
import type { FinalizationBuilder } from "../features/withdraw/selfFinalize"

const WITHDRAW_ABI = [
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [{ name: "withdrawalId", type: "bytes32" }],
    outputs: [],
  },
] as const

/** A finalization call for the burn that touches neither a node nor the enclave. */
export function demoFinalizationBuilder(portal: Address): FinalizationBuilder {
  return async (burnTxHash: Hex) => {
    // Derived from the burn, as the real id is, so a burn always finalizes to the same id.
    const withdrawalId = keccak256(burnTxHash)
    return {
      to: portal,
      data: encodeFunctionData({ abi: WITHDRAW_ABI, args: [withdrawalId] }),
      withdrawalId,
    }
  }
}
