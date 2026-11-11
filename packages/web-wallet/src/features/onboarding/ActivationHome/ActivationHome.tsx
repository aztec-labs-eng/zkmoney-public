import { bestEffort, WalletError } from "@obsidion/core/errors"
import { useState, type ReactNode } from "react"
import type { InviteNotice } from "../../registration/TagAvailabilityNotes/TagAvailabilityNotes"
import { formatUnits } from "viem"
import { depositOwed, useStore, NO_SERVICE, serviceStatus } from "@obsidion/front-core"
import { GradientHeroCard, GradientSpinner, Icon, TopNavIconButton } from "@obsidion/web-ds"
import { tokenDecimalsForNetwork } from "@obsidion/core/constants"
import { fireOnboardingEvent } from "../../../lib/analytics"
import pastUserArt from "../../../assets/onboarding/past-user-banner.webp"
import pastUserVerifiedArt from "../../../assets/onboarding/past-user-banner-verified.webp"
import { usdFigure, shortL1Addr } from "../../../ui/format"
import {
  ACTIVATION_STEP_COUNT,
  activationStepNumber,
  activationSteps,
  activationStepsLeft,
  type ActivationStep,
} from "../activationSteps"
import { PAY_PRICE } from "../../deposit/ChooseNameSheet/ChooseNameSheet"
import { chooseOwnName } from "../../registration/chooseOwnName"
import { claimChosenName } from "../oxideOnboarding"
import { OwnTagSheet } from "../OwnTagSheet/OwnTagSheet"
import { usePastUserCheck } from "../../registration/pastUser"
import { useRegistrationAsk } from "../../registration/RegistrationAskLine/RegistrationAskLine"
import { formatDepositDue, formatDepositSeen } from "../../registration/depositAmounts"
import { askedTotal, registrationOffer } from "../../registration/registrationAsk"
import { useRegistrationTerms } from "../../registration/registrationTerms"
import {
  useOpenRegistration,
  useRegistrationTagConfirmed,
} from "../../registration/openRegistration"
import { SecureNameNoticeCard } from "../SecureNameNoticeCard/SecureNameNoticeCard"
import { VerifyPastUserModal } from "../../registration/VerifyPastUserModal/VerifyPastUserModal"
import { DepositScreen } from "../../deposit/DepositScreen/DepositScreen"
import { useSession } from "../../../session/session"
import { fmt } from "../../../lib/fmt"
import copy from "./ActivationHome.copy"

// A drawn tag is free, so its deposit is the earned-tag total.
const RANDOM_TAG_DEPOSIT = usdFigure(formatUnits(askedTotal("earned_tag"), 18))
const PAID_TAG_DEPOSIT = usdFigure(formatUnits(askedTotal("standard"), 18))
const TITLES: Record<ActivationStep["id"], string> = copy.titles
const tagPitch = (steps: ActivationStep[]) =>
  activationStepsLeft(steps) === 1 ? copy.tagPitchOne : copy.tagPitch
const PASSKEY_PITCH = copy.passkeyPitch
const depositPitch = (amount: string) => fmt(copy.depositPitch, { amount })

/**
 * The welcome card: done steps and the ones after it as rows, the current step as `current`.
 * `detail` is each row's second line.
 */
function ActivationSteps(props: {
  testId: string
  tag: string
  /** Beside the tag while it can still change. */
  tagActions?: ReactNode
  /** Replaces the lede under the tag. */
  subtitle?: string
  steps: ActivationStep[]
  detail: Record<ActivationStep["id"], string>
  /** Shown beside a row. */
  beside?: Partial<Record<ActivationStep["id"], ReactNode>>
  current: ReactNode
  children?: ReactNode
  onBack?: () => void
}) {
  const at = props.steps.findIndex((step) => !step.done)
  return (
    <section className="ww-activation" data-testid={props.testId}>
      {props.onBack && (
        <span className="ww-activation__back">
          <TopNavIconButton icon="chevron-left" ariaLabel={copy.back} onClick={props.onBack} />
        </span>
      )}
      <header className="ww-activation__head">
        <div className="ww-activation__title">
          <h2 className="ww-activation__welcome">
            {copy.welcome}
            <br />
            <span key={props.tag} className="ww-tag-swap">
              {fmt(copy.tag, { tag: props.tag })}
            </span>
          </h2>
          {props.tagActions}
        </div>
        <p className="ww-activation__lede">{props.subtitle ?? tagPitch(props.steps)}</p>
      </header>
      <div className="ww-activation__list">
        {props.steps.map((step, i) =>
          i === at ? (
            <div key={step.id}>{props.current}</div>
          ) : (
            <WithPastUser key={step.id} banner={props.beside?.[step.id]}>
              <div className="ww-activation__step" data-step-done={step.done}>
                <Icon
                  name="check-circle"
                  size={24}
                  color={step.done ? "var(--accent-green)" : "var(--text-secondary)"}
                />
                <span>
                  <b>{TITLES[step.id]}</b>
                  <span>{props.detail[step.id]}</span>
                </span>
              </div>
            </WithPastUser>
          ),
        )}
      </div>
      {props.children}
    </section>
  )
}

function StepHero(props: {
  step: ActivationStep["id"]
  title: string
  body: ReactNode
  cta: ReactNode
}) {
  return (
    <div className="ww-activation__hero">
      <GradientHeroCard
        avatar={
          <span className="ww-activation__eyebrow">
            {fmt(copy.stepOf, {
              step: activationStepNumber(props.step),
              count: ACTIVATION_STEP_COUNT,
            })}
          </span>
        }
        title={props.title}
        subtitle={props.body}
        footer={props.cta}
      />
    </div>
  )
}

/** Shuffle and own-tag chips beside the drawn tag. */
function TagActions(props: {
  tag: string
  free: boolean
  onChooseOwn: () => void
  /** Absent once a re-roll would forfeit a past user's spent grant. */
  onReroll?: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const reroll = props.onReroll
  return (
    <span className="ww-activation__tag-actions">
      {reroll && (
        <button
          type="button"
          className="zkm-btn-reset ww-activation__chip"
          data-testid="activation-reroll-tag"
          aria-label={fmt(copy.rerollLabel, { tag: props.tag })}
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void reroll().finally(() => setBusy(false))
          }}
        >
          <Icon name="refresh" size={12} />
          {copy.reroll}
        </button>
      )}
      <button
        type="button"
        className="zkm-btn-reset ww-activation__chip"
        data-testid="activation-choose-own"
        onClick={props.onChooseOwn}
      >
        {props.free ? copy.chooseOwnFree : fmt(copy.chooseOwnPaid, { price: PAY_PRICE })}
      </button>
    </span>
  )
}

function PasskeyHero(props: { onCreate: () => void }) {
  return (
    <StepHero
      step="passkey"
      title={TITLES.passkey}
      body={PASSKEY_PITCH}
      cta={
        <button
          type="button"
          className="zkm-btn-reset ww-activation__cta"
          data-testid="activation-create-passkey"
          onClick={props.onCreate}
        >
          {copy.addPasskey}
          <Icon name="key" size={14} />
        </button>
      }
    />
  )
}

/** The past-user offer beside a step: Verify until the old wallet checks out, then a welcome back. */
function PastUserBanner(props: { verified: boolean }) {
  const { pastUser } = useSession()
  const { step, error } = usePastUserCheck().state
  const checking = (step === "sign" || step === "check") && !error
  return (
    // The whole card verifies; the button's click bubbles up and keeps it keyboard reachable.
    <div
      className="ww-past-user"
      data-verified={props.verified || undefined}
      onClick={props.verified ? undefined : () => pastUser.setOpen(true)}
    >
      <img
        className="ww-past-user__art"
        src={props.verified ? pastUserVerifiedArt : pastUserArt}
        alt=""
      />
      <b>{props.verified ? copy.pastUser.verifiedTitle : copy.pastUser.title}</b>
      <span>{props.verified ? copy.pastUser.verifiedBody : copy.pastUser.body}</span>
      {!props.verified && (
        <button
          type="button"
          className="zkm-btn-reset zkm-pressable ww-past-user__verify"
          data-testid="past-user-verify"
        >
          {checking ? copy.pastUser.checking : copy.pastUser.verify}
          {checking ? <GradientSpinner size={12} /> : <Icon name="wallet" size={14} />}
        </button>
      )}
    </div>
  )
}

/** A step with the past-user banner beside it. */
function WithPastUser(props: { banner: ReactNode; children: ReactNode }) {
  return (
    <div className="ww-activation__pair">
      {props.children}
      {props.banner}
    </div>
  )
}

/** Home before any account: the drawn tag in the header, then the passkey named after it. */
export function ActivationDraft(props: {
  /** The tag the claim server drew. */
  drawn: string
  /** The tag picked; the passkey step is next. */
  chosen?: string
  /** Why the last pick was refused, shown over the choice it reopens. */
  notice?: InviteNotice
  onKeep: () => void
  onChooseOwn: () => void
  onCreate: () => void
  onReroll: () => Promise<void>
  /** Drops the drawn tag and returns to the landing. */
  onBack: () => void
}) {
  const { pastUser } = useSession()
  const verifying = useStore(pastUser.state, (s) => s.open)
  // Verified and not yet spent: the own tag is free.
  const verified = useStore(pastUser.state, (s) => s.verified)
  const free = verified !== undefined && verified.tag === undefined
  // A chosen name is paid unless it is the drawn one kept, or this past user's proof earned it.
  const earned =
    free ||
    props.chosen === props.drawn ||
    (verified !== undefined && verified.tag === props.chosen)
  // A past user's free pick spent their proof: a re-roll would lose it for good.
  const pastUserPick = props.chosen !== undefined && verified?.tag === props.chosen
  const tag = props.chosen ?? props.drawn
  const steps = activationSteps({ account: false, deposited: false })
  // Every choice stays open until the passkey exists: a cancelled ceremony leaves them all here.
  return (
    <ActivationSteps
      testId="activation-draft"
      tag={tag}
      onBack={props.onBack}
      tagActions={
        <TagActions
          tag={tag}
          free={free}
          onChooseOwn={props.onChooseOwn}
          onReroll={pastUserPick ? undefined : props.onReroll}
        />
      }
      steps={steps}
      detail={{
        passkey: PASSKEY_PITCH,
        deposit: depositPitch(props.chosen && !earned ? PAID_TAG_DEPOSIT : RANDOM_TAG_DEPOSIT),
      }}
      current={
        <>
          {props.notice?.kind === "error" && (
            <p className="ww-invite__error" role="alert">
              {props.notice.message}
            </p>
          )}
          <WithPastUser banner={<PastUserBanner verified={verified !== undefined} />}>
            <PasskeyHero
              onCreate={() => {
                if (!props.chosen) props.onKeep()
                props.onCreate()
              }}
            />
          </WithPastUser>
        </>
      }
    >
      {verifying && (
        <VerifyPastUserModal
          claim={claimChosenName}
          onChoose={props.onChooseOwn}
          onKeepRandom={props.onKeep}
        />
      )}
    </ActivationSteps>
  )
}

/** Home's lead while the account is unfunded: the passkey done and the deposit at hand. */
export function ActivationHome() {
  const open = useOpenRegistration()
  const confirmed = useRegistrationTagConfirmed(open?.record ?? null)
  const ask = useRegistrationAsk()
  const terms = useRegistrationTerms(open?.record?.account, open?.record?.tag)
  const session = useSession()
  const verified = useStore(session.pastUser.state, (s) => s.verified)
  const verifying = useStore(session.pastUser.state, (s) => s.open)
  const free = usePastUserCheck().state.step === "confirmed"
  const unlocked = useStore(session.account ?? NO_SERVICE, serviceStatus) === "ready"
  const walletBuilt = useStore(session.wallet, serviceStatus) === "ready"
  const [own, setOwn] = useState(false)
  const [depositing, setDepositing] = useState(false)
  // Unknown while the withdrawals load: Home waits rather than ask for a deposit already funded.
  if (!open || open.stage === undefined || open.stage === "failed") return null
  const { record } = open
  const { route } = record
  const pastUser = route === "past_user"
  const verifiedAccount = verified?.tag === record.tag ? verified.account : undefined
  const decimals = tokenDecimalsForNetwork(session.page.config.network)
  // A paid tag waiting on activation: a past-user pass makes it free.
  const paidPending = route === "paid" && !confirmed
  const steps = activationSteps({
    account: true,
    deposited: !depositOwed(open.stage),
    ticket: registrationOffer(terms).funding === "paylink",
  })
  // Whole dollars read as "$5", as the deposit screen's ask does.
  const total =
    ask?.total === undefined
      ? RANDOM_TAG_DEPOSIT
      : formatDepositDue(ask.total, decimals).replace(/\.00$/, "")

  return (
    <ActivationSteps
      testId="activation-home"
      tag={record.tag}
      subtitle={
        pastUser
          ? fmt(copy.pastUserSubtitle, {
              verified: verifiedAccount
                ? fmt(copy.pastUserVerified, { address: shortL1Addr(verifiedAccount) })
                : "",
            })
          : undefined
      }
      steps={steps}
      detail={{
        passkey: PASSKEY_PITCH,
        deposit: depositPitch(total),
      }}
      beside={{
        passkey: pastUser ? (
          <PastUserBanner verified />
        ) : paidPending ? (
          <PastUserBanner verified={false} />
        ) : null,
      }}
      current={
        <SecureNameNoticeCard
          ask={(note) => (
            <StepHero
              step="deposit"
              title={TITLES.deposit}
              body={
                <>
                  {ask?.total !== undefined && ask.remaining !== undefined
                    ? fmt(copy.depositProgress, {
                        seen: formatDepositSeen(ask.seen, decimals),
                        total,
                        remaining: formatDepositDue(ask.remaining, decimals),
                      })
                    : depositPitch(total)}
                  {note && <span className="ww-activation__note">{note}</span>}
                </>
              }
              cta={
                <button
                  type="button"
                  className="zkm-btn-reset ww-activation__cta"
                  data-testid="activation-deposit"
                  onClick={() => {
                    if (!confirmed) void bestEffort("unknown", session.confirmTag(record))
                    setDepositing(true)
                  }}
                >
                  {fmt(copy.deposit, {
                    amount:
                      ask?.total !== undefined && ask.remaining !== undefined
                        ? formatDepositDue(ask.remaining, decimals).replace(/\.00$/, "")
                        : total,
                  })}
                  <Icon name="arrow-right" size={14} />
                </button>
              }
            />
          )}
        />
      }
    >
      {depositing && (
        <DepositScreen claimName={claimChosenName} onClose={() => setDepositing(false)} />
      )}
      {verifying && (
        <VerifyPastUserModal
          tag={paidPending ? record.tag : undefined}
          claim={claimChosenName}
          onChoose={() => setOwn(true)}
        />
      )}
      {own && !verifying && (
        <OwnTagSheet
          free={free}
          current={record.tag}
          submitLabel={free ? copy.claimFree : fmt(copy.makeDeposit, { price: PAY_PRICE })}
          onVerify={() => session.pastUser.setOpen(true)}
          onClose={() => setOwn(false)}
          onPick={async (name) => {
            if (!unlocked || !walletBuilt || !session.account)
              throw new WalletError("wallet.notReady")
            const [obsidionWallet, obsidionAccount] = await Promise.all([
              session.wallet.ready(),
              session.account.ready(),
            ])
            const route = free ? "past_user" : "paid"
            const over = claimChosenName(session, obsidionWallet, free, route)
            await chooseOwnName(session, name, obsidionAccount, over)
            fireOnboardingEvent("name_route_chosen", { route: free ? "past_user" : "pay" })
            session.signup.setTagDraft("")
            setOwn(false)
          }}
        />
      )}
    </ActivationSteps>
  )
}
