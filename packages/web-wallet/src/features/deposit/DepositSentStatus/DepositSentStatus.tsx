import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import { depositAmounts, type SipaDeposit } from "@obsidion/front-core"
import type { SIPADepositPhase } from "@obsidion/core/types"
import { fmt, fmtNodes } from "../../../lib/fmt"
import { shortL1Addr, tokenFigure } from "../../../ui/format"
import { ChainIcon } from "../../../ui/ChainIcon/ChainIcon"
import {
  RING_TOKEN_SIZE,
  RingStage,
  ringStageSheet,
  type RingPhase,
  type RingStageBlock,
} from "../../../ui/flow/RingStage/RingStage"
import { CoinIcon, OriginTokenIcon } from "../../../ui/CoinIcon/CoinIcon"
import {
  settlementDecimals,
  settlementSymbol,
  type DepositTokens,
} from "../../sipa/loadDepositFacts"
import sendCopy from "../sendFromWallet.copy"
import copy from "./DepositSentStatus.copy"

/** For the sheet that shows the status. */
export const depositSentStatusSheet = ringStageSheet

const RING: Record<SIPADepositPhase, RingPhase> = {
  resolved: "bridging",
  funding: "bridging",
  funded: "arriving",
  broadcast: "arriving",
  sweeping: "arriving",
  pendingClaim: "arriving",
  claimed: "arrived",
  failed: "failed",
  recoverable: "failed",
  recovered: "failed",
}

/** What a sent deposit's blocks read, worked out from its record. */
export interface SentDepositView {
  phase: SIPADepositPhase
  coin: string
  /** The figure that left the wallet. */
  sent: string
  /** What the private funds receive: estimated while on its way. */
  landing: string
  /** What the private funds received. */
  arrived: string
  wallet: string
  network: string
  payee?: string
  minutes?: number
}

/** The ring phase and block a sent deposit's phase shows, and every block the stage stacks. */
export function sentDepositStage(
  view: SentDepositView,
  onClose: () => void,
): { ring: RingPhase; active: string; blocks: RingStageBlock[] } {
  const { coin, sent: amount, network, payee } = view
  const ring = RING[view.phase]
  // Linked only while shown; a hidden block only reserves space.
  const activity = (shown: boolean) =>
    fmtNodes(sendCopy.arrived.note, {
      activity: shown ? (
        <Link to="/activity" onClick={onClose}>
          {sendCopy.arrived.activity}
        </Link>
      ) : (
        sendCopy.arrived.activity
      ),
    })
  const close = { label: sendCopy.arrived.close, onClick: onClose }
  const blocks: RingStageBlock[] = [
    {
      key: "sending",
      title: fmt(copy.sending.title, { coin }),
      line: payee
        ? fmt(copy.sending.payeeLine, { amount, wallet: view.wallet, payee })
        : fmt(copy.sending.line, { amount, wallet: view.wallet }),
      note: fmt(sendCopy.confirming, { network }),
      noteTone: "pending",
    },
    {
      key: "arriving",
      chip: {
        text:
          view.minutes === undefined
            ? sendCopy.arriving.chip
            : fmt(sendCopy.chipAbout, { chip: sendCopy.arriving.chip, minutes: view.minutes }),
        tone: "live",
      },
      title: payee ? fmt(sendCopy.paying.status, { payee }) : sendCopy.arriving.title,
      line: fmt(copy.arriving.line, { amount, landing: view.landing }),
      note: payee ? fmt(sendCopy.paying.note, { payee }) : sendCopy.arriving.note,
      button: close,
    },
    {
      key: "arrived",
      chip: { text: sendCopy.arrived.chip, tone: "done" },
      title: fmt(sendCopy.arrived.landedLine, { amount: view.arrived }),
      line: sendCopy.arrived.line,
      note: activity(ring === "arrived"),
      button: { label: sendCopy.arrived.done, onClick: onClose },
    },
    {
      key: "failed",
      title: copy.failed.title,
      line: fmt(copy.failed.line, { amount }),
      note: activity(ring === "failed"),
      button: close,
    },
  ]
  return { ring, active: ring === "bridging" ? "sending" : ring, blocks }
}

/** The figures and names a record's blocks read. */
function sentDepositView(
  record: SipaDeposit,
  tokens: DepositTokens,
  network: string,
): Omit<SentDepositView, "payee" | "minutes"> {
  const amounts = depositAmounts(record, settlementDecimals(tokens, record.tokenAddress))
  const coin = record.fundingTokenSymbol ?? record.tokenSymbol
  const settlement = settledIn(record, tokens)
  const sent = tokenFigure(amounts.grossDisplay, coin)
  const net = tokenFigure(amounts.netDisplay, settlement)
  const wallet = record.walletAddress
    ? fmt(sendCopy.from, {
        wallet: record.walletName ?? sendCopy.walletFallback,
        address: shortL1Addr(record.walletAddress),
      })
    : record.walletName ?? copy.yourWallet
  return {
    phase: record.phase,
    coin,
    sent,
    // A swap's rate is only known once it runs.
    landing: !amounts.feeKnown
      ? sent
      : coin === settlement
      ? net
      : fmt(sendCopy.arrived.approx, { amount: net }),
    arrived: amounts.feeKnown ? net : sent,
    wallet,
    network,
  }
}

const settledIn = (record: SipaDeposit, tokens: DepositTokens) =>
  settlementSymbol(tokens, record.tokenAddress, record.tokenSymbol)

/** What the private funds received from `record`: the gross figure while the fee is unknown. */
export function depositArrivedFigure(record: SipaDeposit, tokens: DepositTokens): string {
  return sentDepositView(record, tokens, "").arrived
}

/**
 * A deposit this wallet sent on Ethereum, from the broadcast until it is in the private funds, or
 * failed. A deposit that needs recovery shows its detail instead.
 */
export function DepositSentStatus({
  record,
  tokens,
  l1ChainId,
  l1ChainName,
  payee,
  minutes,
  onClose,
}: {
  record: SipaDeposit
  tokens: DepositTokens
  l1ChainId: number
  l1ChainName: string
  /** The tag a request payment goes to; the copy then names them, not the private funds. */
  payee?: string
  /** How long the sweep and claim take, where known. */
  minutes?: number
  onClose: () => void
}) {
  const view = { ...sentDepositView(record, tokens, l1ChainName), payee, minutes }
  const { ring, active, blocks } = sentDepositStage(view, onClose)
  const settled = settledIn(record, tokens)
  const settlement = tokens.options.find((t) => t.symbol === settled)
  const coinIcon = (symbol: string): ReactNode => (
    <OriginTokenIcon symbol={symbol} coins={tokens.offered} size={RING_TOKEN_SIZE} />
  )
  return (
    <RingStage
      testId="deposit-sent-status"
      active={active}
      ring={ring}
      front={coinIcon(view.coin)}
      back={<ChainIcon chainId={l1ChainId} name={l1ChainName} size={RING_TOKEN_SIZE} />}
      landing={
        settlement ? <CoinIcon token={settlement} size={RING_TOKEN_SIZE} /> : coinIcon(settled)
      }
      blocks={blocks}
    />
  )
}
