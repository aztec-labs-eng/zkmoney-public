import { bestEffort } from "@obsidion/core/errors"
import { useState } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { formatUnits } from "viem"
import { useStore, NO_SERVICE, serviceStatus } from "@obsidion/front-core"
import { Icon, PrimaryGradientButton } from "@obsidion/web-ds"
import { InviteFriendActions, InviteFriendRow } from "../../invite/InviteFriendRow"
import { useInvite } from "../../invite/useInvite"
import { fireOnboardingEvent } from "../../../lib/analytics"
import { usdFigure } from "../../../ui/format"
import { chooseOwnName, type ChosenNameClaim } from "../../registration/chooseOwnName"
import { openRegistration } from "../../registration/openRegistration"
import { askedTotal } from "../../registration/registrationAsk"
import type { RegistrationRoute } from "@obsidion/front-core"
import { usePastUserCheck } from "../../registration/pastUser"
import { VerifyPastUserModal } from "../../registration/VerifyPastUserModal/VerifyPastUserModal"
import { TagPickSheet } from "../../registration/TagPickSheet/TagPickSheet"
import { useSession } from "../../../session/session"
import { fmt } from "../../../lib/fmt"
import copy from "./ChooseNameSheet.copy"
import { confirmsAtPick } from "./nameChoice"

export const PAY_PRICE = usdFigure(formatUnits(askedTotal("standard"), 18))
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
  const unlocked = useStore(session.account ?? NO_SERVICE, serviceStatus) === "ready"
  const walletBuilt = useStore(session.wallet, serviceStatus) === "ready"
  const [route, setRoute] = useState<"invite" | "past-user" | "pay">("pay")
  const verified = usePastUserCheck().state.step === "confirmed"
  const verifying = useStore(session.pastUser.state, (s) => s.open)
  const invite = useInvite()

  const deposit = () => {
    onClose()
    if (pathname !== "/deposit") navigate("/deposit")
  }

  const claimAs = (earned: boolean) => async (name: string) => {
    if (!unlocked || !walletBuilt || !session.account) return
    const [obsidionWallet, obsidionAccount] = await Promise.all([
      session.wallet.ready(),
      session.account.ready(),
    ])
    const over = claimName(session, obsidionWallet, earned, REGISTRATION_ROUTES[route])
    await chooseOwnName(session, name, obsidionAccount, over)
    fireOnboardingEvent("name_route_chosen", { route: CHOSEN_ROUTES[route] })
    const open = openRegistration(session)?.record
    if (open && confirmsAtPick(route, pathname))
      void bestEffort("unknown", session.confirmTag(open))
    onClose()
    if (pathname !== "/deposit") navigate("/")
  }

  return (
    <TagPickSheet
      flow={{ screen: pathname === "/deposit" ? "deposit" : "settings", current: tag }}
      className="ww-deposit-warning ww-deposit-sheet ww-choose-name"
      label={copy.title}
      title={copy.title}
      input={{ label: copy.nameLabel, placeholder: copy.namePlaceholder }}
      available={(name) => (
        <>
          <Icon name="check-circle" size={14} color="var(--accent-green)" />
          {fmt(copy.available, { name })}
        </>
      )}
      onClose={onClose}
    >
      {({ name, available, busy, pick, errorNote }) => (
        <>
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
          {errorNote}
          {route === "invite" ? (
            <InviteFriendActions
              invite={invite}
              depositLabel={fmt(copy.depositAs, { tag })}
              name={available ? name : null}
              busy={busy}
              onClaim={() => void pick(claimAs(true))}
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
                    : void pick(claimAs(route === "past-user"))
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
        </>
      )}
    </TagPickSheet>
  )
}
