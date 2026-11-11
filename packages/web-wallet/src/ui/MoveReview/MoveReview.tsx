import { Fragment, type ReactNode } from "react"
import { fmt } from "../../lib/fmt"
import { DepositFact } from "../screens/DepositFact"
import copy from "./MoveReview.copy"
import styles from "./MoveReview.module.css"

/** Where the move goes, hop by hop, and how long it takes to land where known. */
export interface MoveRoute {
  hops: readonly (string | MoveHop)[]
  arrivesInMinutes?: number
}

/** Hops joined by a regular-weight arrow, inside a bold value. */
export function Hops({ hops }: { hops: readonly (string | MoveHop)[] }) {
  return hops.map((hop, i) => {
    const { label, icon } = typeof hop === "string" ? { label: hop, icon: undefined } : hop
    return (
      <Fragment key={i}>
        {i > 0 && <span className={styles.arrow}> {copy.arrow} </span>}
        {icon}
        {label}
      </Fragment>
    )
  })
}

/** One hop of a route: a coin or a chain, with its icon. */
export interface MoveHop {
  label: string
  icon?: ReactNode
}

/** The figures a move into or out of the private balance is confirmed from. */
export function MoveReview({
  to,
  toDetail,
  token,
  send,
  receive,
  gas,
  speed,
  feeLabel,
  fee,
  feeInfo,
  totalLabel = copy.total,
  total,
  network,
  note,
}: {
  to: ReactNode
  toDetail?: ReactNode
  token: ReactNode
  send: string
  /** What lands. */
  receive?: string
  /** A share that lands as ETH. */
  gas?: string
  speed?: ReactNode
  feeLabel: string
  fee: string
  /** An info button beside the fee's label. */
  feeInfo?: ReactNode
  totalLabel?: string
  total: string
  network: MoveRoute
  note?: ReactNode
}) {
  return (
    <>
      <div className="ww-sheet__facts">
        <div className={`ww-sheet__fact${toDetail ? " ww-fresh__fact--tall" : ""}`}>
          <span>{copy.to}</span>
          <b className="ww-fresh__to">
            {toDetail ? <span>{to}</span> : to}
            {toDetail && <small>{toDetail}</small>}
          </b>
        </div>
        <DepositFact label={copy.token}>
          <b>{token}</b>
        </DepositFact>
        <DepositFact label={copy.send}>
          <b>{send}</b>
        </DepositFact>
        {receive && (
          <DepositFact label={copy.receive}>
            <b>{receive}</b>
          </DepositFact>
        )}
        {gas && (
          <DepositFact label={copy.gas}>
            <b>{gas}</b>
          </DepositFact>
        )}
        <div className="ww-sheet__fact">
          <span>
            {feeLabel}
            {feeInfo}
          </span>
          <b>{fee}</b>
        </div>
        {speed}
        <hr className="ww-divider" />
        <DepositFact label={totalLabel}>
          <b>{total}</b>
        </DepositFact>
      </div>
      <div className="ww-deposit__input ww-sheet__fact">
        <span>{copy.network}</span>
        <b className={styles.route}>
          <span>
            <Hops hops={network.hops} />
          </span>
          {network.arrivesInMinutes !== undefined && (
            <small>{fmt(copy.arrives, { minutes: network.arrivesInMinutes })}</small>
          )}
        </b>
      </div>
      {note && <p className="ww-sheet__note">{note}</p>}
    </>
  )
}
