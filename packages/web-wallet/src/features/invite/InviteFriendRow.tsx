import { Icon, PrimaryGradientButton } from "@obsidion/web-ds"
import { useCopy } from "../../ui/hooks"
import { inviteLink, type Invite } from "./useInvite"
import "./invite.css"

export function InviteFriendRow(props: {
  invite: Invite
  selected: boolean
  onSelect: () => void
}) {
  const { copied, copy } = useCopy()
  const { code, credited } = props.invite
  // A div, so the copy button can sit inside the card.
  return (
    <div
      role="radio"
      aria-checked={props.selected}
      tabIndex={0}
      className="zkm-btn-reset ww-choose-name__route"
      onClick={props.onSelect}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return
        e.preventDefault()
        props.onSelect()
      }}
    >
      <span className="ww-choose-name__dot" />
      <span>Invite a friend</span>
      <b>Free</b>
      {props.selected && (
        <span className="ww-invite-row">
          <button
            type="button"
            className="zkm-btn-reset zkm-pressable ww-invite-row__link"
            disabled={!code}
            onClick={() => code && void copy(`https://${inviteLink(code)}`)}
          >
            <span>
              Your invite link
              <code>{code ? inviteLink(code) : "Creating your link…"}</code>
            </span>
            <span className="ww-invite-row__copy">
              <Icon name={copied ? "check" : "copy"} size={16} />
              {copied ? "Copied" : "Copy"}
            </span>
          </button>
          <span className="ww-invite-row__note">
            {credited
              ? "A friend you invited made their first deposit"
              : "Free when a friend makes their first deposit"}
          </span>
        </span>
      )}
    </div>
  )
}

export function InviteFriendActions(props: {
  invite: Invite
  depositLabel: string
  name: string | null
  busy: boolean
  onClaim: () => void
  onDeposit: () => void
}) {
  const { copied, copy } = useCopy()
  const { code, credited } = props.invite
  return (
    <>
      {credited ? (
        <PrimaryGradientButton
          title={props.name ? `Claim @${props.name} for free` : "Claim your name for free"}
          isDisabled={!props.name}
          isLoading={props.busy}
          onClick={props.onClaim}
        />
      ) : (
        <PrimaryGradientButton
          title={copied ? "Copied!" : "Copy invite link"}
          isDisabled={!code}
          onClick={() => code && void copy(`https://${inviteLink(code)}`)}
        />
      )}
      <button
        type="button"
        className="zkm-btn-reset ww-deposit__link"
        disabled={props.busy}
        onClick={props.onDeposit}
      >
        {props.depositLabel}
      </button>
    </>
  )
}
