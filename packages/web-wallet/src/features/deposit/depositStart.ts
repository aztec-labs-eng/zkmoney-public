/** Where the deposit screen and its sheets open, in place of their first step. */
import type { DepositFlowStep, DepositIntent } from "./DepositFlow/DepositFlow"
import type { SentDeposit } from "./DepositFromWalletModal/DepositFromWalletModal"
import type { FundNote } from "./DepositFromWalletModal/fundFromWalletTransition"
import type { CarriedAmount } from "./DepositScreen/depositScreenTransition"
import type { DepositStage } from "./sipaAddresses"
import type { LimitsTopic } from "../limits/aboutLimitsView"
import type { SavedL1Wallet } from "../../session/savedL1Wallets"

/** Where the send-from-wallet sheet opens. */
export interface FundStart {
  phase: "form" | "ready" | "switching" | "depositing"
  stage?: DepositStage
  /** Why the last send stopped before any transfer. */
  note?: FundNote
  /** The review's fee changed since it was entered. */
  feeChanged?: boolean
}

/** Where the bridge-in sheet opens. */
export interface BridgeInStart {
  step: "amount" | "progress" | "status"
  /** The wallet is asked to approve the bridge call. */
  sending?: boolean
  /** The bridge-in the status step shows: its `bridgeIns` record. */
  sent?: string
}

export interface DepositStart {
  /** The deposit modal is open for `intent`, from a saved wallet when set. */
  entry?: { intent?: DepositIntent; saved?: SavedL1Wallet }
  /** The modal's steps, the last one showing. */
  steps?: DepositFlowStep[]
  /** The network and coin the modal starts on. */
  origin?: { chainId: number; symbol: string }
  /** The address sheet is open at this phase; `creating` and `capped` hold the address back. */
  address?: "creating" | "capped" | "ready" | "waiting" | "read-error" | "spotted"
  /** What the address sheet spotted, base units of the coin. */
  funded?: bigint
  aboutLimits?: LimitsTopic
  amount?: CarriedAmount
  fund?: FundStart
  /** The sent deposit whose status shows; its record is `sipaDeposits`'. */
  sent?: SentDeposit
  bridge?: BridgeInStart
  /** The saved wallet the modal opened from is not the connected account. */
  switching?: boolean
}
