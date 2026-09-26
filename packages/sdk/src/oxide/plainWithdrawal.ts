// Every wallet withdrawal settles into its deployment's PlainWithdrawalExecutor: the executor pays the
// relayer tip named in the user payload and forwards the rest to the payload's recipient.
import type { EthAddress } from "@aztec/foundation/eth-address"
import { OxidePortalAbi } from "@oxide/l1-contracts"
import type {
  Operation as TokenOperationCall,
  PlainWithdrawalOperation,
} from "@oxide/oxide-client/l2_operations.js"
import type { Address, PublicClient } from "viem"

import type { Operation } from "./l2_operations.js"

export type { PlainWithdrawalOperation }

export type WithdrawOperation = Extract<TokenOperationCall, { kind: "withdraw" }>

/** The portal state the relayer-tip check reads. */
export interface PortalWithdrawalState {
  /** `OxidePortal.FPC_FUNDING_CUT`. */
  fpcFundingCut: bigint
  /** A frozen portal takes no funding cut. */
  frozen: boolean
}

/** What a TEE batch needs to check its plain withdrawals and publish their user payloads. */
export interface PlainWithdrawalContext extends PortalWithdrawalState {
  executor: EthAddress
}

export async function readPortalWithdrawalState(
  publicClient: PublicClient,
  portal: Address,
): Promise<PortalWithdrawalState> {
  const [fpcFundingCut, frozen] = await Promise.all([
    publicClient.readContract({
      address: portal,
      abi: OxidePortalAbi,
      functionName: "FPC_FUNDING_CUT",
    }),
    publicClient.readContract({ address: portal, abi: OxidePortalAbi, functionName: "$frozen" }),
  ])
  return { fpcFundingCut: fpcFundingCut as bigint, frozen: frozen as boolean }
}

/** The withdrawals a batch declares: its withdraw operations and the withdrawals nested in its outer calls. */
export function declaredWithdrawals(operations: Operation[]): PlainWithdrawalOperation[] {
  return operations.flatMap((op) => {
    if (op.kind === "withdraw") return [op]
    if (op.kind === "outerCall") return op.withdrawals ?? []
    return []
  })
}
