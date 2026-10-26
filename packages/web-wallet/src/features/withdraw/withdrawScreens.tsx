/** The withdrawal's screens (Figma "Migration" page, LobEQ1bmcPDw0ahexKy1iI: W2 to W8 and F1). */
import { useState, type ReactNode } from "react"
import type { Hex } from "viem"
import { Icon, PrimaryGradientButton } from "@obsidion/web-ds"
import doneBadge from "../../assets/cutover/done-badge.png"
import { l1TxUrl } from "../../ui/detailRows"
import { shortL1Addr, usdAtomicFloor } from "../../ui/format"
import { cutoverAccount } from "../cutover/account"
import {
  upgradingCopy,
  withdrawChoiceCopy as choiceCopy,
  withdrawDoneCopy as doneCopy,
  withdrawingCopy as copy,
} from "../cutover/cutoverCopy"
import { SLOW_AFTER_MS, useElapsed } from "../cutover/elapsed"
import { ProgressScreen } from "../cutover/ProgressScreen"
import {
  Badge,
  CutoverPage,
  Eyebrow,
  Fact,
  Lead,
  TextButton,
  Title,
  type Step,
} from "../cutover/parts"
import type { L1ExitStage } from "../deposit/sipaRecovery"
import type { ZkMoneyExitStage } from "./zkMoneyExit"

export type WithdrawRoute = "zk-money" | "wallet"

function Option(props: {
  selected: boolean
  disabled?: boolean
  title: string
  body: string
  value: string
  active?: boolean
  testId: string
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.selected}
      aria-disabled={props.disabled || undefined}
      disabled={props.disabled}
      className="zkm-btn-reset ww-cutover__option"
      data-testid={props.testId}
      onClick={props.onSelect}
    >
      <span className="ww-cutover__radio" aria-hidden />
      <span className="ww-cutover__option-text">
        <b>{props.title}</b>
        <span>{props.body}</span>
        <small data-tone={props.active ? "active" : undefined}>{props.value}</small>
      </span>
    </button>
  )
}

/** W2, and E3 when the zk.money fee is more than the balance. */
export function WithdrawChoice(props: {
  /** Everything that leaves, once read. */
  total?: bigint
  /** The zk.money route's fee, from the amount; undefined while not read. */
  zkMoneyFee?: bigint
  /** Its fee could not be read. */
  zkMoneyFeeFailed: boolean
  /** What the zk.money route moves before its fee, which can be less than `total`. */
  zkMoneyMoving?: bigint
  /** The wallet route's gas, in USD; undefined while not read. */
  walletFee?: bigint
  route: WithdrawRoute
  onRoute: (route: WithdrawRoute) => void
  onBack: () => void
  /** The network has no proven checkpoint yet: the zk.money route opens about `until`. */
  waiting?: { until: string }
  /** Called with the route shown, which a low balance or a wait makes the wallet's. */
  onContinue: (route: WithdrawRoute) => void
  onUpgrade: () => void
  overlay?: ReactNode
}) {
  const usd = (amount?: bigint) => (amount === undefined ? "…" : usdAtomicFloor(amount))
  const balance = usd(props.total)
  const fee = usd(props.zkMoneyFee)
  const walletFee = props.walletFee === undefined ? "gas" : `~${usd(props.walletFee)}`
  const low =
    props.total !== undefined && props.zkMoneyFee !== undefined && props.zkMoneyFee >= props.total
  const { waiting } = props
  const route = low || waiting ? "wallet" : props.route
  return (
    <>
      <CutoverPage
        account={cutoverAccount()}
        onBack={props.onBack}
        testId="cutover-withdraw-choice"
        footer={
          <div className="ww-cutover__actions">
            <PrimaryGradientButton
              title={choiceCopy.continue}
              testId="cutover-continue"
              onClick={() => props.onContinue(route)}
            />
            <TextButton
              disabled={!!waiting}
              testId="cutover-upgrade-instead"
              onClick={props.onUpgrade}
            >
              {choiceCopy.upgrade}
            </TextButton>
          </div>
        }
      >
        <div className="ww-cutover__intro">
          <Badge icon="logout" />
          <Eyebrow>{choiceCopy.eyebrow}</Eyebrow>
          <Title>{choiceCopy.title}</Title>
          <Lead>{low ? choiceCopy.lowBody(balance, fee) : choiceCopy.body}</Lead>
        </div>
        <div role="radiogroup" aria-label={choiceCopy.title} className="ww-cutover__actions">
          <Option
            testId="cutover-route-zk-money"
            selected={route === "zk-money"}
            disabled={low || !!waiting}
            title={choiceCopy.zkMoney.title}
            body={
              waiting
                ? choiceCopy.zkMoney.waitingBody(waiting.until)
                : low
                ? choiceCopy.zkMoney.lowBody(fee)
                : choiceCopy.zkMoney.body(fee)
            }
            value={
              waiting
                ? choiceCopy.zkMoney.waiting
                : low
                ? choiceCopy.zkMoney.low(fee, balance)
                : props.zkMoneyFeeFailed
                ? choiceCopy.zkMoney.feeFailed
                : choiceCopy.zkMoney.value(
                    props.zkMoneyMoving === undefined || props.zkMoneyFee === undefined
                      ? "…"
                      : usdAtomicFloor(props.zkMoneyMoving - props.zkMoneyFee),
                  )
            }
            active
            onSelect={() => props.onRoute("zk-money")}
          />
          <Option
            testId="cutover-route-wallet"
            selected={route === "wallet"}
            title={choiceCopy.wallet.title}
            body={
              low
                ? choiceCopy.wallet.lowBody(walletFee, balance)
                : choiceCopy.wallet.body(walletFee)
            }
            value={choiceCopy.wallet.value(balance)}
            active={low || !!waiting}
            onSelect={() => props.onRoute("wallet")}
          />
        </div>
        {waiting ? (
          <Fact>{choiceCopy.free}</Fact>
        ) : (
          !low && (
            <p className="ww-cutover__why">
              <Icon name="info-circle" size={12} />
              <span>{choiceCopy.why}</span>
            </p>
          )
        )}
      </CutoverPage>
      {props.overlay}
    </>
  )
}

/** W6 and W7: the zk.money route proves here, then relayers send it. */
export function ZkProgress(props: { stage: ZkMoneyExitStage; to: string; total: bigint }) {
  const to = shortL1Addr(props.to)
  const sending = props.stage === "sending"
  const elapsed = useElapsed(sending)
  const slow = elapsed !== undefined && elapsed > SLOW_AFTER_MS
  const steps: Step[] = [
    {
      title: copy.proof,
      state: sending ? "done" : "active",
      status: sending ? upgradingCopy.done : upgradingCopy.inProgress(2),
    },
    {
      title: copy.sendTo(to),
      state: sending ? "active" : "pending",
      status: slow
        ? upgradingCopy.stillConfirming(Math.round(elapsed / 60_000))
        : sending
        ? upgradingCopy.inProgress(2)
        : undefined,
    },
    { title: copy.confirmed, state: "pending" },
  ]
  return (
    <ProgressScreen
      account={cutoverAccount()}
      testId="cutover-withdrawing"
      percent={sending ? 38 : 1}
      caption={slow ? upgradingCopy.longerRing : sending ? upgradingCopy.left(2) : copy.withdrawing}
      title={copy.title}
      body={slow ? upgradingCopy.longerBody : sending ? copy.onItsWay(to) : copy.body}
      banner={
        slow
          ? { tone: "warn", ...upgradingCopy.longer }
          : sending
          ? { tone: "ok", ...upgradingCopy.safe }
          : { tone: "warn", ...copy.keepOpen }
      }
      header={{ label: copy.withdrawing, value: usdAtomicFloor(props.total) }}
      steps={steps}
      footer={sending ? upgradingCopy.sentFooter : upgradingCopy.footer}
      notify={sending}
    />
  )
}

/** F1: the own-wallet route proves here, then the user approves each refund in their wallet. */
export function WalletProgress(props: {
  /** Undefined while the proof runs. */
  stage?: L1ExitStage
  /** "your browser" in the desktop app, else the wallet's name. */
  approveIn: string
  total: bigint
  /** What earlier refunds of this run sent. */
  sent?: bigint
}) {
  const approving = props.stage === "signing" || props.stage === "awaiting-browser"
  const confirming = props.stage === "confirming"
  const proving = !props.stage
  const steps: Step[] = [
    {
      title: copy.proof,
      state: proving ? "active" : "done",
      status: proving ? upgradingCopy.inProgress(2) : upgradingCopy.done,
    },
    {
      title: copy.approveIn(props.approveIn),
      state: approving ? "active" : confirming ? "done" : "pending",
      status: approving ? copy.waitingYou : confirming ? upgradingCopy.done : undefined,
    },
    { title: copy.confirmed, state: confirming ? "active" : "pending" },
  ]
  const body = copy.approveBody(props.approveIn)
  return (
    <ProgressScreen
      account={cutoverAccount()}
      testId="cutover-wallet-withdrawing"
      percent={proving ? 20 : approving ? 38 : 72}
      caption={approving ? copy.waitingYou : proving ? copy.withdrawing : upgradingCopy.left(2)}
      title={copy.title}
      body={props.sent ? `${body}. ${copy.sentSoFar(usdAtomicFloor(props.sent))}` : body}
      // Another refund can follow this one, and it needs the app open.
      banner={
        approving
          ? { tone: "warn", title: copy.waiting.title, body: copy.waiting.body(props.approveIn) }
          : { tone: "warn", ...copy.keepOpen }
      }
      header={{ label: copy.withdrawing, value: usdAtomicFloor(props.total) }}
      steps={steps}
      footer={copy.approveFooter}
    />
  )
}

/** W8 and F1 Done. */
export function WithdrawDone(props: {
  amount: bigint
  /** What the old versions still hold, which a later withdrawal sends. */
  left: bigint
  /** The wallet's name, if the user connected one. */
  wallet: string | null
  to: string
  hashes: Hex[]
  onClose: () => void
}) {
  const [shown] = useState(cutoverAccount)
  const where = props.wallet ? `${props.wallet} (${shortL1Addr(props.to)})` : shortL1Addr(props.to)
  const open = (hash: Hex) => window.open(l1TxUrl(hash), "_blank", "noopener")
  return (
    <CutoverPage account={shown} testId="cutover-withdraw-done" center>
      <span className="ww-cutover__hero" aria-hidden>
        <img src={doneBadge} alt="" />
      </span>
      <div className="ww-cutover__intro">
        <Title>{doneCopy.title}</Title>
        <Lead>{doneCopy.body(usdAtomicFloor(props.amount), where, shown?.tag)}</Lead>
        {props.left > 0n && <Lead>{doneCopy.left(usdAtomicFloor(props.left))}</Lead>}
      </div>
      <div className="ww-cutover__actions">
        {props.hashes.length === 1 ? (
          <PrimaryGradientButton
            title={doneCopy.view}
            testId="cutover-view-tx"
            onClick={() => open(props.hashes[0]!)}
          />
        ) : (
          props.hashes.map((hash, i) => (
            <TextButton key={hash} testId="cutover-view-tx" onClick={() => open(hash)}>
              {doneCopy.viewEach(i + 1)}
            </TextButton>
          ))
        )}
        <TextButton testId="cutover-back" onClick={props.onClose}>
          {doneCopy.back}
        </TextButton>
      </div>
    </CutoverPage>
  )
}
