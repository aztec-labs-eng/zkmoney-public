import { bestEffort } from "@obsidion/core/errors"
import { useEffect, useRef, useState } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { formatUnits } from "viem"
import { normalizeTag, useResource, useStore } from "@obsidion/front-core"
import { GradientText, Icon, PrimaryGradientButton, TopNavIconButton } from "@obsidion/web-ds"
import { Modal } from "../../../ui/Modal"
import { InviteFriendActions, InviteFriendRow } from "../../invite/InviteFriendRow"
import { useInvite } from "../../invite/useInvite"
import { fireOnboardingEvent } from "../../../lib/analytics"
import { usdFigure } from "../../../ui/format"
import { chooseOwnName, type ChosenNameClaim } from "../../registration/chooseOwnName"
import { openRegistration } from "../../registration/openRegistration"
import { useNameAvailability, type NameAvailability } from "../../registration/nameAvailability"
import { askedTotal } from "../../registration/registrationAsk"
import type { RegistrationRoute } from "@obsidion/front-core"
import { TagAvailabilityNotes } from "../../registration/TagAvailabilityNotes/TagAvailabilityNotes"
import { usePastUserCheck } from "../../registration/pastUser"
import { VerifyPastUserModal } from "../../registration/VerifyPastUserModal/VerifyPastUserModal"
import { useSession } from "../../../session/session"
import { fmt } from "../../../lib/fmt"
import copy from "./ChooseNameSheet.copy"
import { confirmsAtPick } from "./nameChoice"
import { errorMessage } from "../../../errors/catalog"

export const PAY_PRICE = usdFigure(formatUnits(askedTotal("standard"), 18))
const VERDICTS: Partial<Record<NameAvailability, string>> = {
  "available": "available",
  "reserved": "taken",
  "blocked": "blocked",
  "blocked-reserved": "blocked",
}
/** One `onboarding_handle_checked` per distinct name a sheet settles a verdict on. */
export function useReportHandleCheck(
  name: string | null,
  fresh: boolean,
  checking: boolean,
  status: NameAvailability,
) {
  const checked = useRef<string | null>(null)
  useEffect(() => {
    const verdict = VERDICTS[status]
    if (!fresh || checking || !verdict || checked.current === name) return
    checked.current = name
    fireOnboardingEvent("onboarding_handle_checked", { status: verdict })
  }, [name, fresh, checking, status])
}
const CHOSEN_ROUTES: Record<"invite" | "past-user" | "pay", string> = {
  "invite": "invite",
  "past-user": "past_user",
  "pay": "pay",
}
const REGISTRATION_ROUTES: Record<"invite" | "past-user" | "pay", RegistrationRoute> = {
  "invite": "invite",
  "past-user": "past_user",
  "pay": "paid",
}

/** Picks a name of the user's own before the first deposit, in place of the drawn `tag`. */
export function ChooseNameSheet({
  tag,
  claim: claimName,
  onClose,
}: {
  tag: string
  claim: ChosenNameClaim
  onClose: () => void
}) {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const session = useSession()
  const obsidionAccount = useResource(session.account)
  const obsidionWallet = useResource(session.wallet)
  const [typed, setTyped] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [route, setRoute] = useState<"invite" | "past-user" | "pay">("pay")
  const verified = usePastUserCheck().state.step === "confirmed"
  const verifying = useStore(session.pastUser.state, (s) => s.open)
  const invite = useInvite()
  const name = normalizeTag(typed)
  const fresh = name !== null && name !== tag
  const { status, checking } = useNameAvailability(typed, fresh)
  const available = fresh && !checking && status === "available"
  useEffect(() => {
    fireOnboardingEvent("name_sheet_opened", {
      screen: pathname === "/deposit" ? "deposit" : "settings",
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per opening
  }, [])
  useReportHandleCheck(name, fresh, checking, status)

  const deposit = () => {
    onClose()
    if (pathname !== "/deposit") navigate("/deposit")
  }

  const claim = async (earned: boolean) => {
    if (!available || !name || !obsidionAccount || !obsidionWallet) return
    setBusy(true)
    setError(undefined)
    try {
      const over = claimName(session, obsidionWallet, earned, REGISTRATION_ROUTES[route])
      await chooseOwnName(session, name, obsidionAccount, over)
      fireOnboardingEvent("name_route_chosen", { route: CHOSEN_ROUTES[route] })
      const open = openRegistration(session)?.record
      if (open && confirmsAtPick(route, pathname))
        void bestEffort("unknown", session.confirmTag(open))
      onClose()
      if (pathname !== "/deposit") navigate("/")
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  return (
    <Modal
      variant="bare"
      className="ww-deposit-warning ww-deposit-sheet ww-choose-name"
      label={copy.title}
      onClose={busy ? undefined : onClose}
    >
      <div className="ww-deposit-warning__close">
        <TopNavIconButton icon="x" ariaLabel={copy.close} onClick={busy ? undefined : onClose} />
      </div>
      <GradientText size={24} weight={700}>
        {copy.title}
      </GradientText>
      <div className="ww-choose-name__name">
        <span className="ww-invite-field__input ww-choose-name__field">
          <span>{copy.at}</span>
          <input
            aria-label={copy.nameLabel}
            placeholder={copy.namePlaceholder}
            value={typed}
            autoFocus
            disabled={busy}
            onChange={(e) => setTyped(e.target.value.replace(/^@/, "").toLowerCase())}
          />
        </span>
        {available ? (
          <p className="ww-choose-name__ok">
            <Icon name="check-circle" size={14} color="var(--accent-green)" />
            {fmt(copy.available, { name: name ?? "" })}
          </p>
        ) : (
          <TagAvailabilityNotes
            typed={typed}
            valid={name !== null}
            availability={status}
            checking={checking}
            resuming={false}
          />
        )}
      </div>
      <div
        className="ww-choose-name__routes"
        role="radiogroup"
        aria-labelledby="ww-choose-name-label"
      >
        <p id="ww-choose-name-label" className="ww-choose-name__label">
          {copy.routesLabel}
        </p>
        <InviteFriendRow
          invite={invite}
          selected={route === "invite"}
          onSelect={() => setRoute("invite")}
        />
        <button
          type="button"
          role="radio"
          aria-checked={route === "past-user"}
          className="zkm-btn-reset ww-choose-name__route"
          onClick={() => {
            setRoute("past-user")
            if (!verified) session.pastUser.setOpen(true)
          }}
        >
          <span className="ww-choose-name__dot" />
          <span>{copy.pastUser}</span>
          <b>{copy.free}</b>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={route === "pay"}
          className="zkm-btn-reset ww-choose-name__route"
          onClick={() => setRoute("pay")}
        >
          <span className="ww-choose-name__dot" />
          <span>{copy.pay}</span>
          <b>{PAY_PRICE}</b>
        </button>
      </div>
      {error && (
        <p className="ww-invite__error" role="alert">
          {error}
        </p>
      )}
      {route === "invite" ? (
        <InviteFriendActions
          invite={invite}
          depositLabel={fmt(copy.depositAs, { tag })}
          name={available ? name : null}
          busy={busy}
          onClaim={() => void claim(true)}
          onDeposit={deposit}
        />
      ) : (
        <>
          <PrimaryGradientButton
            title={
              route === "pay"
                ? fmt(copy.makeDeposit, { price: PAY_PRICE })
                : verified
                ? fmt(copy.claim, { name: name ? fmt(copy.claimName, { name }) : "" })
                : copy.verifyToClaim
            }
            isDisabled={!available}
            isLoading={busy}
            onClick={() =>
              route === "past-user" && !verified
                ? session.pastUser.setOpen(true)
                : void claim(route === "past-user")
            }
          />
          <button
            type="button"
            className="zkm-btn-reset ww-deposit__link"
            disabled={busy}
            onClick={onClose}
          >
            {fmt(copy.keep, { tag })}
          </button>
        </>
      )}
      {verifying && (
        <VerifyPastUserModal claim={claimName} onChoose={() => setRoute("past-user")} />
      )}
    </Modal>
  )
}
