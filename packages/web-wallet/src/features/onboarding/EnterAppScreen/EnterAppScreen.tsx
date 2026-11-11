import { useState } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { useStore } from "@obsidion/front-core"
import { currentDevicePosture, PHONE_STEPS_COPY } from "@obsidion/passkey-web"
import { PrimaryGradientButton, TopNavIconButton } from "@obsidion/web-ds"
import { errorMessage } from "../../../errors/catalog"
import { fmt } from "../../../lib/fmt"
import { hasOpeningBreadcrumb } from "../../../platform/auth/WebPasskeyIdentityMap"
import { useSession } from "../../../session/session"
import { EndpointsModal } from "../../../ui/EndpointsModal"
import { useHoldEndpoints } from "../../../session/endpointsHold"
import { useNextRoute } from "../../../ui/hooks"
import { useScreenFlow } from "../../../ui/useScreenFlow"
import { useCeremonyGate } from "../../identity/ceremonyGate"
import { InAppBrowserNotice } from "../../identity/InAppBrowserNotice"
import { walletInAppUpFront } from "../../identity/inAppUpFront"
import { IosFloorNotice } from "../../identity/IosFloorNotice"
import {
  GRANTED_REGISTRATION,
  PASSKEY_NOT_OFFERED,
  PASSKEY_NOT_ON_DEVICE,
  PasskeyRefusal,
  SET_UNREAD,
  STORED_ADDRESS_MISMATCH,
  promptCauses,
} from "../../identity/PasskeyRefusal"
import { GateStep } from "../../identity/PhoneSteps"
import { hasConnectStash } from "../../contacts/connectReceive"
import { peekClaimStash } from "../../paylink/claimStash"
import { tabStash } from "../../../platform/storage/tabStash"
import { InvitationChrome } from "../InvitationChrome"
import { OnboardingSpinnerBody } from "../OnboardingCard"
import { ConfirmTagModal } from "../steps/ConfirmTagModal/ConfirmTagModal"
import { CreateWalletStep } from "../steps/CreateWalletStep/CreateWalletStep"
import copy from "./EnterAppScreen.copy"
import styles from "./EnterAppScreen.module.css"
import { openSignInFlow } from "./signInFlow"
import type { ConfirmError } from "./signInTransition"

/** The refusal for a passkey that opens no wallet: `NoWalletForPasskeyError`'s name. */
const NO_WALLET = "NoWalletForPasskeyError"

/** The confirm step's line for why it refused the typed tag. */
const confirmErrorText = (error: ConfirmError): string =>
  error.kind === "notReserved"
    ? fmt(copy.tagNotReserved, { tag: error.tag })
    : error.kind === "finishFailed"
    ? copy.finishFailed
    : fmt(copy.tagUnmatched, {
        detail:
          error.error instanceof Error
            ? fmt(copy.tagUnmatchedDetail, { message: errorMessage(error.error) })
            : "",
      })

/**
 * Returning user (/enter). As soon as the wallet is ready an arrival probe tries the ceremony-free
 * sources: a cached key enters with no screen and no prompt. Otherwise the sign-in screen: the
 * accounts this browser remembers, one click each; a tag field that resolves as it is typed, whose
 * Login pins the tag's passkey; and "Show passkeys" for the browser's full chooser. Every prompt
 * opens on a tap, never on the tail of a read — the screen prepares (manifest, the one cache proof)
 * before its buttons are live, and a tap-driven entry never restores the cache. The assertion
 * re-derives the account, the anchors decide, and the claim is found on the L1 Registry; when no
 * tag names it, the confirm step asks for the handle, only to NAME the claim (the chain stores its
 * hash). A refusal stays here with the reason, Back to the screen and the cancel: none of them is a
 * reason to create an account. Every action runs under its own AbortController; the user's cancel
 * aborts it, and a result arriving after that is dropped — unless the account was already
 * committed, which is the point of no return: an entry completes, and a moved session reloads.
 */
export function EnterAppScreen() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const nextRoute = useNextRoute()
  const opened = useSession()
  const { device, page } = opened
  // The screen's own buttons are the tap before the first prompt; only the second prompt holds.
  const {
    gate,
    state: gateState,
    cancel: cancelGate,
  } = useCeremonyGate(currentDevicePosture, {
    holdsSignIn: false,
  })
  const flow = useScreenFlow(
    { navigate, params, nextRoute, gate: { gate, cancel: cancelGate } },
    (latest) => openSignInFlow({ session: opened, origin: location.origin }, latest),
  )
  const s = useStore(flow.state)
  const { refusal, confirming, reserved, shown: start, busy } = s
  // A stashed paylink is why most visitors reach this screen. Say so, so the passkey prompt reads
  // as the step between them and the money rather than an unexplained interruption.
  const claimPending = !!peekClaimStash(tabStash)
  const connectPending = hasConnectStash(tabStash)
  const [endpointsOpen, setEndpointsOpen] = useState(false)
  const { back, cancel: cancelSignIn, continueSignup, showPasskeys } = flow

  const pill = (label: string, testId: string, onClick: () => void) => (
    <button
      type="button"
      className="zkm-btn-reset zkm-pressable ww-invite-pill"
      data-testid={testId}
      onClick={onClick}
    >
      {label}
    </button>
  )

  // These two cards leave for a signup already begun rather than a new one: the tag is reserved
  // under this account's own key, and the claim server settles that when it is submitted.
  const resuming = refusal?.name === GRANTED_REGISTRATION

  // The spinner and the security-key step: a sign-in is running.
  useHoldEndpoints(!confirming && !refusal && (gateState.kind === "awaiting-action" || !start))

  if (refusal && !confirming) {
    const notOffered = refusal.name === PASSKEY_NOT_OFFERED
    const laptop = currentDevicePosture() === "laptop"
    const wrongKey = refusal.name === STORED_ADDRESS_MISMATCH && refusal.verdict === "wrong-key"
    const resumeTag = refusal.resumeTag
    // The "what went wrong" list stays where it is the only guidance: a phone's closed prompt (a
    // laptop's own account chooser is the guidance there), or a pinned prompt that matched nothing.
    const causes =
      (notOffered && !laptop) || refusal.name === PASSKEY_NOT_ON_DEVICE
        ? promptCauses(currentDevicePosture())
        : undefined
    // The plain exits: another passkey (where the phone leads), another tag, and the close.
    const plainExits = !resumeTag && !resuming && !refusal.committed && !refusal.probeCommitted
    // A passkey with no wallet has no retry here (NO_RETRY), so the way on is another passkey.
    const noWallet = plainExits && refusal.name === NO_WALLET
    const retryable = flow.retryable(refusal)
    return (
      <InvitationChrome landing page={page}>
        <div className={styles.sheet}>
          {plainExits && (
            <div className={styles.close}>
              <TopNavIconButton
                icon="x"
                ariaLabel={copy.cancel}
                testId="enter-cancel"
                onClick={cancelSignIn}
              />
            </div>
          )}
          <IosFloorNotice />
          <PasskeyRefusal
            error={refusal}
            onRetry={retryable ? flow.rerun : undefined}
            busy={busy}
            causes={causes}
            verdict={refusal.verdict}
            reportContext="enter"
            primary={
              refusal.macPhone
                ? {
                    title: PHONE_STEPS_COPY.noPhone.back,
                    onClick: flow.usePhone,
                    testId: "enter-phone",
                  }
                : wrongKey
                ? { title: copy.showPasskeys, onClick: showPasskeys, testId: "enter-show-passkeys" }
                : refusal.name === SET_UNREAD
                ? // Back to the screen, where the tag field takes focus; no prompt opens.
                  { title: copy.typeTag, onClick: back, testId: "enter-type-tag" }
                : resumeTag
                ? {
                    title: copy.continueSignup,
                    onClick: () => flow.resume(resumeTag),
                    testId: "enter-continue",
                  }
                : noWallet
                ? { title: copy.showPasskeys, onClick: showPasskeys, testId: "enter-show-passkeys" }
                : undefined
            }
            testId="enter-refused"
            retryTestId="enter-retry"
            exits={
              resumeTag ? (
                pill(copy.back, "enter-back", back)
              ) : resuming ? (
                // A passkey picked by mistake, such as another signup's, needs a way to a different one.
                <>
                  {pill(copy.continueSignup, "enter-continue", () => flow.resume())}
                  {pill(copy.showPasskeys, "enter-show-passkeys", showPasskeys)}
                  {pill(copy.cancel, "enter-cancel", cancelSignIn)}
                </>
              ) : refusal.committed ? (
                <>
                  {pill(copy.continueSignup, "enter-continue", continueSignup)}
                  {pill(copy.cancel, "enter-cancel", cancelSignIn)}
                </>
              ) : refusal.probeCommitted ? (
                pill(copy.cancel, "enter-cancel", cancelSignIn)
              ) : (
                <>
                  {refusal.macPhone && (
                    <PrimaryGradientButton
                      title={copy.showPasskeys}
                      buttonStyle="dark"
                      testId="enter-show-passkeys"
                      onClick={showPasskeys}
                    />
                  )}
                  <button
                    type="button"
                    className={`zkm-btn-reset ww-invite__link ${styles.otherTag}`}
                    data-testid="enter-back"
                    onClick={back}
                  >
                    {/* Other cards' text says "go back", so only this one names the tag. */}
                    {noWallet ? copy.otherTag : copy.back}
                  </button>
                </>
              )
            }
          />
        </div>
      </InvitationChrome>
    )
  }

  // The landing card the visitor came from stays behind the sign-in modals.
  const backdrop = (
    <CreateWalletStep
      busy={false}
      returning={hasOpeningBreadcrumb(device.get().passkeyMap, page.config.rpId)}
      onCreate={() => {}}
      onLogIn={() => {}}
      onCancel={() => {}}
    />
  )
  if (gateState.kind === "awaiting-action" && !confirming) {
    return (
      <InvitationChrome landing page={page}>
        <div className={styles.sheet}>
          <GateStep state={gateState} onCancel={cancelSignIn} cancelLabel={copy.cancel} />
        </div>
      </InvitationChrome>
    )
  }
  // An app's built-in browser is told before the first prompt, in place of the screen. The
  // remembered-account rows are not the test: a nameless account, or one the screen hides, is
  // still a passkey that worked here.
  const inAppMode =
    start && !confirming ? walletInAppUpFront(device.get(), page.config.rpId) : undefined
  if (inAppMode) {
    return (
      <InvitationChrome landing page={page}>
        <div className={styles.sheet}>
          <InAppBrowserNotice
            mode={inAppMode}
            reportContext="enter"
            testId="enter-in-app-notice"
            exits={pill(copy.cancel, "enter-cancel", cancelSignIn)}
          />
        </div>
      </InvitationChrome>
    )
  }
  if (start && !confirming) {
    const { candidates, keyed } = flow.remembered()
    const row = s.row
    const found = s.found
    return (
      <InvitationChrome bare landing page={page}>
        {backdrop}
        <>
          <ConfirmTagModal
            start={{
              candidates,
              onCandidate: flow.chooseAccount,
              keyed,
              rowKeys: row && {
                credentialId: row.account.credentialId,
                choices: row.options,
                reading: row.reading,
                failed: row.failed,
              },
              onRowKey: flow.chooseRowKey,
              onRowKeysAgain: flow.rowAgain,
              tagKeys: found?.keys,
              onTagKey: flow.chooseTagKey,
              value: s.typed,
              onTagChange: flow.tagChanged,
              onTagBlur: flow.tagBlurred,
              onDifferentPasskey: flow.differentPasskey,
              submitReady: flow.submitReady(),
              resolving: s.resolving,
              prepared: s.prepared,
              onPrepareAgain: flow.prepare,
              notice: s.notice,
              chooserFirst: params.get("choose") === "1" || s.notice?.kind === "reserved",
              busy,
              onEndpoints: () => setEndpointsOpen(true),
            }}
            onConfirm={flow.login}
            onShowPasskeys={showPasskeys}
            onClose={cancelSignIn}
          />
          {/* Beside the card, not in it: inside the card's form, Enter in a field would sign in. */}
          {endpointsOpen && (
            <EndpointsModal config={page.config} onClose={() => setEndpointsOpen(false)} />
          )}
        </>
      </InvitationChrome>
    )
  }
  if (!confirming) {
    return (
      <InvitationChrome landing page={page}>
        <div className={styles.sheet}>
          <div className="ww-invite-spinner" data-testid="enter-passkey">
            <IosFloorNotice />
            {claimPending && <p className="ww-paylink-summary__caption">{copy.paymentWaiting}</p>}
            {connectPending && <p className="ww-paylink-summary__caption">{copy.connectWaiting}</p>}
            <OnboardingSpinnerBody
              label={s.prompted ? copy.signingInPasskey : copy.signingIn}
              cancelLabel={copy.cancel}
              onCancel={cancelSignIn}
            />
          </div>
        </div>
      </InvitationChrome>
    )
  }
  return (
    <InvitationChrome bare landing page={page}>
      {backdrop}
      <>
        <ConfirmTagModal
          key={reserved ? "reserved" : "claimed"}
          initialHandle={reserved ? reserved.tag : s.selectedTag}
          submitTitle={reserved ? copy.continueSignup : undefined}
          error={s.confirmError && confirmErrorText(s.confirmError)}
          onConfirm={flow.confirm}
          onBack={back}
          onClose={reserved ? continueSignup : cancelSignIn}
        />
      </>
    </InvitationChrome>
  )
}
