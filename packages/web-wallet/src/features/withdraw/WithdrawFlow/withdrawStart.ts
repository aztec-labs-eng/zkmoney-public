/** Where the withdraw landing and its flow open, in place of their first step. */
import type { Address } from "viem"
import type { ReadonlyStore } from "@obsidion/front-core"
import type { WithdrawFlowEntry } from "../../../session/routeStates"
import type { WithdrawalSpeed } from "../WithdrawalSpeedPicker"
import type { WithdrawStage } from "../withdrawGateway"
import type { WithdrawalReceiveAsset } from "../withdrawAssets"
import type { WithdrawStep } from "../withdrawQuoteView"
import type { WithdrawSent } from "./withdrawTransition"

export interface WithdrawStart {
  /** The flow is open with this entry. */
  entry?: WithdrawFlowEntry
  history?: WithdrawStep[]
  /** The network and coin picker over the step. */
  picker?: boolean
  query?: string
  name?: string
  chosen?: { recipient: Address; name?: string }
  chainId?: number
  coin?: WithdrawalReceiveAsset
  amount?: string
  maxed?: boolean
  /** The field `amount` was typed in; From when unset. */
  side?: "from" | "to"
  gasAtomic?: bigint
  speed?: WithdrawalSpeed
  /** The review's fee changed since it was entered. */
  feeChanged?: boolean
  stage?: WithdrawStage
  /** Whether the passkey prompt is up, in place of a live burn's hand-off. */
  signing?: ReadonlyStore<boolean>
  /** Its record, when it has one, is `withdrawals`'. */
  sent?: WithdrawSent
}
