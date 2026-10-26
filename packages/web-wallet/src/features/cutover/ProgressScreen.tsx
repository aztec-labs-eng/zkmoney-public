/**
 * The page a run shows while it works: the ring, a banner, the stepper and a footer. Upgrading
 * (Figma 389:31309, 409:34464) and S2 Finish your upgrade (401:2054) are this page with different
 * words.
 */
import type { ReactNode } from "react"
import { PrimaryGradientButton } from "@obsidion/web-ds"
import { usePhoneLayout } from "../../ui/usePhoneLayout"
import { upgradingCopy } from "./cutoverCopy"
import { armNotify, notifySupported, useNotifyArmed } from "./notify"
import {
  Badge,
  Banner,
  CutoverPage,
  Lead,
  ProgressRing,
  Stepper,
  TextButton,
  Title,
  type CutoverAccount,
  type DetailRow,
  type Step,
} from "./parts"

export interface ProgressBanner {
  tone: "warn" | "ok"
  title: string
  body: string
}

export function ProgressScreen({
  account,
  percent,
  caption,
  tip,
  spin,
  title,
  body,
  banner,
  header,
  steps,
  footer,
  action,
  notify: notifyAsked,
  overlay,
  testId,
}: {
  account?: CutoverAccount
  /** The ring; absent for a stopped run, which shows a warning badge instead. */
  percent?: number
  caption?: string
  /** What the wait usually takes, behind the ring's info mark. */
  tip?: string
  /** The ring turns as a spinner. */
  spin?: boolean
  title: string
  body: string
  banner?: ProgressBanner
  /** What the run moves; absent when it moves no funds. */
  header?: DetailRow
  steps: Step[]
  /** The footer line. */
  footer?: string
  /** The primary action under the steps (S2's Resume). */
  action?: { label: string; onClick: () => void; testId?: string }
  /** Offers "Notify me when ready": a button on phones, a quiet line on desktop. */
  notify?: boolean
  /** A sheet over the page. */
  overlay?: ReactNode
  testId?: string
}) {
  const phone = usePhoneLayout()
  const notify = notifyAsked && notifySupported()
  const armed = useNotifyArmed()
  const label = armed ? upgradingCopy.notified : upgradingCopy.notify
  return (
    <>
      <CutoverPage
        account={account}
        testId={testId}
        center
        footer={
          notify && phone ? (
            <PrimaryGradientButton
              title={label}
              leadingIcon="bell"
              isDisabled={armed}
              testId="cutover-notify"
              onClick={armNotify}
            />
          ) : notify ? (
            <TextButton disabled={armed} testId="cutover-notify" onClick={armNotify}>
              {label}
            </TextButton>
          ) : footer ? (
            <span className="ww-cutover__caption">{footer}</span>
          ) : undefined
        }
      >
        {percent === undefined ? (
          <Badge icon="alert-triangle" tone="warn" />
        ) : (
          <ProgressRing percent={percent} caption={caption} tip={tip} spin={spin} />
        )}
        <div className="ww-cutover__intro">
          <Title>{title}</Title>
          <Lead>{body}</Lead>
        </div>
        {banner && <Banner tone={banner.tone} title={banner.title} body={banner.body} />}
        <Stepper header={header} steps={steps} />
        {action && (
          <PrimaryGradientButton
            title={action.label}
            testId={action.testId}
            onClick={action.onClick}
          />
        )}
      </CutoverPage>
      {overlay}
    </>
  )
}
