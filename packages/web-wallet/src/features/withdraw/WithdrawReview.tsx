import type { ReactNode } from "react"
import { formatUnits, type Address } from "viem"
import { tokenAmount } from "../../ui/format"
import { DepositFact } from "../../ui/screens/DepositFact"
import type { SwapEstimate } from "./withdrawQuote"
import { withdrawalReceiveAsset, type WithdrawalReceiveAsset } from "./withdrawAssets"
import ethIcon from "../../assets/deposit/ethereum.webp"

/** What a priced swap route pays out. */
export const estimateText = (estimate: SwapEstimate | undefined, symbol: string) =>
  estimate ? `${tokenAmount(formatUnits(estimate.amountOut, estimate.decimals))} ${symbol}` : "…"

/** The figures a withdrawal sheet confirms from. */
export function WithdrawReview({
  recipient,
  walletName,
  asset,
  send,
  gas,
  fee,
  total,
  speed,
}: {
  recipient: Address
  walletName?: string
  asset: WithdrawalReceiveAsset
  send: string
  /** The fresh flow's gas share, which lands as ETH. */
  gas?: string
  fee: string
  total: string
  /** The speed choice, where the sheet offers one. */
  speed?: ReactNode
}) {
  const token = withdrawalReceiveAsset(asset)
  return (
    <>
      <div className="ww-sheet__facts">
        <div className={`ww-sheet__fact${walletName ? " ww-fresh__fact--tall" : ""}`}>
          <span>To</span>
          <b className="ww-fresh__to">
            {walletName && <span>{walletName}</span>}
            <small>{recipient}</small>
          </b>
        </div>
        <DepositFact label="Token">
          <b>
            <img src={token.icon} alt="" width={16} height={16} />
            {token.symbol}
          </b>
        </DepositFact>
        <DepositFact label="Send">
          <b>{send}</b>
        </DepositFact>
        {gas && (
          <DepositFact label="Arrives as gas">
            <b>{gas}</b>
          </DepositFact>
        )}
        {speed}
        <DepositFact label="Withdrawal fee">
          <b>{fee}</b>
        </DepositFact>
        <hr className="ww-divider" />
        <DepositFact label="Sending total">
          <b>{total}</b>
        </DepositFact>
      </div>
      <div className="ww-deposit__input ww-sheet__fact">
        <span>Network</span>
        <b style={{ fontSize: 14 }}>
          <img src={ethIcon} alt="" width={16} height={16} />
          Ethereum · 1 withdrawal
        </b>
      </div>
      <p className="ww-sheet__note">
        Releasing to Ethereum can take up to 40 minutes. Once signed, the withdrawal runs in the
        background and the bell tracks it.
      </p>
    </>
  )
}
