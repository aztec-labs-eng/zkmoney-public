import { formatUnits } from "viem"
import {
  selectSipaDeposit,
  sipaSweepsReceived,
  useStore,
  type BridgeInRecord,
  bridgeInReturned,
} from "@obsidion/front-core"
import { tokenFigure } from "../../../ui/format"
import { coinFigure } from "../../../ui/coinDecimals"
import { Link } from "react-router-dom"
import { fmt, fmtNodes } from "../../../lib/fmt"
import { useSession } from "../../../session/session"
import { ChainIcon } from "../../../ui/ChainIcon/ChainIcon"
import daiIcon from "../../../assets/deposit/dai.svg"
import { OriginTokenIcon } from "../../../ui/CoinIcon/CoinIcon"
import type { DepositTokenOption } from "../../sipa/loadDepositFacts"
import { bridgeCredit } from "../bridgeChains"
import { bridgeInPhase } from "../bridgeInView"
import sendCopy from "../sendFromWallet.copy"
import copy from "./BridgeInStatus.copy"
import {
  RING_TOKEN_SIZE,
  RingStage,
  ringStageSheet,
  type RingStageBlock,
} from "../../../ui/flow/RingStage/RingStage"

/** The status sheet's spacing, for the card that shows it. */
export const bridgeInStatusSheet = ringStageSheet

/**
 * A sent bridge-in: bridging, arriving once filled on L1, arrived once its deposit address's sweeps
 * are claimed, or failed. The session's tracker, or the caller for a payment, follows the record.
 */
export function BridgeInStatus({
  record,
  coins,
  chainName,
  arriving,
  payee,
  fillMinutes,
  depositMinutes,
  onTryAgain,
  onClose,
}: {
  record: BridgeInRecord
  /** The offered coins, for the origin and landing icons. */
  coins: readonly DepositTokenOption[]
  chainName: string
  /** What reaches the private balance, where the deposit fee is known. */
  arriving?: string
  /** The tag a request payment goes to; the copy then names them, not the private balance. */
  payee?: string
  /** The quote's fill time; unknown, the time is left out. */
  fillMinutes?: number
  /** Minutes the Ethereum deposit takes after the fill. */
  depositMinutes?: number
  onTryAgain: () => void
  onClose: () => void
}) {
  const landed = useStore(useSession().sipaDeposits.view, (set) =>
    sipaSweepsReceived(selectSipaDeposit(set, record.recipient)),
  )
  const phase = bridgeInPhase(record, landed)
  const amount = coinFigure(BigInt(record.inputAmount), record.inputDecimals, record.symbol)
  // Named as the coin it credits; the amount stays the landing's.
  const credit = bridgeCredit(
    coins,
    coins.find((c) => c.symbol === record.outputSymbol),
  )
  const figure = tokenFigure(
    formatUnits(BigInt(record.outputAmount), record.outputDecimals),
    credit?.coin.symbol ?? record.outputSymbol,
  )
  const landing =
    arriving ?? (credit?.approx ? fmt(sendCopy.arrived.approx, { amount: figure }) : figure)

  // A refund of another token than the one sent names both.
  const returned = bridgeInReturned(record)
  const failedLine = fmt(
    record.status === "failed"
      ? copy.failed.notSent
      : record.status === "refunded"
      ? returned.other
        ? copy.failed.refundedAs
        : copy.failed.refunded
      : returned.other
      ? copy.failed.expiredAs
      : copy.failed.expired,
    {
      amount,
      returned: coinFigure(returned.amount, returned.decimals, returned.symbol),
      chain: chainName,
    },
  )
  const blocks: RingStageBlock[] = [
    {
      key: "bridging",
      chip: {
        text:
          fillMinutes === undefined
            ? copy.bridging.chip
            : fmt(sendCopy.chipAbout, { chip: copy.bridging.chip, minutes: fillMinutes }),
        tone: "live",
      },
      title: payee
        ? fmt(copy.paying.title, { payee })
        : fmt(copy.bridging.title, { coin: record.symbol }),
      line: payee
        ? fmt(copy.paying.line, { amount, chain: chainName, payee })
        : fmt(copy.bridging.line, { amount, chain: chainName }),
      note: fmt(sendCopy.confirming, { network: chainName }),
      noteTone: "pending",
    },
    {
      key: "arriving",
      chip: {
        text:
          depositMinutes === undefined
            ? sendCopy.arriving.chip
            : fmt(sendCopy.chipAbout, { chip: sendCopy.arriving.chip, minutes: depositMinutes }),
        tone: "live",
      },
      title: payee ? fmt(sendCopy.paying.status, { payee }) : sendCopy.arriving.title,
      line: fmt(copy.arriving.line, { amount, landing }),
      note: payee ? fmt(sendCopy.paying.note, { payee }) : sendCopy.arriving.note,
      button: { label: sendCopy.arrived.close, onClick: onClose },
    },
    {
      key: "arrived",
      chip: { text: sendCopy.arrived.chip, tone: "done" },
      title: fmt(sendCopy.arrived.landedLine, { amount: landing }),
      line: sendCopy.arrived.line,
      // Linked only while shown; a hidden block only reserves space.
      note: fmtNodes(sendCopy.arrived.note, {
        activity:
          phase === "arrived" ? (
            <Link to="/activity" onClick={onClose}>
              {sendCopy.arrived.activity}
            </Link>
          ) : (
            sendCopy.arrived.activity
          ),
      }),
      button: { label: sendCopy.arrived.done, onClick: onClose },
    },
    {
      key: "failed",
      title: sendCopy.failed.title,
      line: failedLine,
      button: { label: sendCopy.failed.retry, onClick: onTryAgain },
    },
  ]

  return (
    <RingStage
      active={phase}
      ring={phase}
      front={<OriginTokenIcon symbol={record.symbol} coins={coins} size={RING_TOKEN_SIZE} />}
      back={<ChainIcon chainId={record.originChainId} name={chainName} size={RING_TOKEN_SIZE} />}
      landing={
        <img
          src={credit?.coin.icon ?? daiIcon}
          alt=""
          width={RING_TOKEN_SIZE}
          height={RING_TOKEN_SIZE}
        />
      }
      blocks={blocks}
    />
  )
}
