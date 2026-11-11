import type { ReactNode } from "react"
import { GradientText, PrimaryGradientButton } from "@obsidion/web-ds"
import { fmt } from "../../../lib/fmt"
import flowStyles from "../../../ui/flow/flow.module.css"
import { Hops, MoveReview, type MoveHop, type MoveRoute } from "../../../ui/MoveReview/MoveReview"
import { WalletCallout } from "../WalletCallout/WalletCallout"
import copy from "./DepositReview.copy"

export interface DepositReviewProps {
  /** The coin over the title. */
  icon: ReactNode
  title: string
  /** The wallet it sends from. */
  from: string
  to: string
  toDetail?: string
  /** The coin, then what it lands as where that differs. */
  /** The coin sent, then what it lands as where that differs, each with its icon. */
  token: readonly MoveHop[]
  /** What the wallet is asked to transfer, in its coin. */
  send: string
  /** What lands, in its coin. */
  receive: string
  feeUsd: string
  /** An info button beside the fee, showing what it is made of. */
  feeInfo?: ReactNode
  /** `send` in dollars. */
  totalUsd: string
  network: MoveRoute
  /** What the wallet is being asked to do now. */
  callout?: string
  /** Route notes over the button. */
  notices?: ReactNode
  button: {
    title: string
    loading: boolean
    disabled?: boolean
    onClick: () => void
    testId?: string
  }
}

/** The step a deposit from a wallet is confirmed on, from Ethereum or bridged in. */
export function DepositReview(props: DepositReviewProps) {
  const { button } = props
  return (
    <>
      <div className="ww-deposit-sheet__head ww-deposit-sheet__head--tight">
        {props.icon}
        <GradientText size={24} weight={700} className={flowStyles.headTitle}>
          {props.title}
        </GradientText>
        <p className="ww-deposit-sheet__sub--sm">{props.from}</p>
      </div>
      <MoveReview
        to={props.to}
        toDetail={props.toDetail}
        token={
          <>
            <Hops hops={props.token} />
          </>
        }
        send={props.send}
        receive={fmt(copy.receive, { amount: props.receive })}
        feeLabel={copy.fee}
        fee={props.feeUsd}
        feeInfo={props.feeInfo}
        total={props.totalUsd}
        network={props.network}
      />
      {props.callout && <WalletCallout text={props.callout} />}
      {props.notices}
      <PrimaryGradientButton
        title={button.title}
        testId={button.testId}
        isLoading={button.loading}
        isDisabled={button.disabled}
        onClick={button.onClick}
        className="ww-deposit-sheet__cta"
      />
    </>
  )
}
