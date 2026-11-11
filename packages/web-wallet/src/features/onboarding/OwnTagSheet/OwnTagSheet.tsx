import { Icon, PrimaryGradientButton } from "@obsidion/web-ds"
import { PAY_PRICE } from "../../deposit/ChooseNameSheet/ChooseNameSheet"
import { TagPickSheet } from "../../registration/TagPickSheet/TagPickSheet"
import { useSession } from "../../../session/session"
import copy from "./OwnTagSheet.copy"
import styles from "./OwnTagSheet.module.css"

/** The own-tag pick, before or after the passkey. What is typed is kept for the tab. */
export function OwnTagSheet(props: {
  onClose: () => void
  onPick: (name: string) => Promise<void>
  /** A verified past user: the pick is free. */
  free: boolean
  submitLabel: string
  /** Shown while the pick is paid. */
  onVerify?: () => void
  /** Before any account. */
  onLogIn?: () => void
  /** The tag already held, which a pick must differ from. */
  current?: string
}) {
  const { signup } = useSession()
  return (
    <TagPickSheet
      flow={{ screen: "activation", current: props.current, signup }}
      className={`ww-deposit-warning ww-deposit-sheet ${styles.sheet}`}
      label={copy.label}
      art={
        <span className={`zkm-on-brand ${styles.icon}`}>
          <Icon name="user-search" size={32} color="#fff" />
        </span>
      }
      title={
        <>
          {copy.title.lead}
          <br />
          {copy.title.tag}
        </>
      }
      fieldLabel={copy.tagLabel}
      input={{ label: copy.tagLabel, placeholder: copy.tagPlaceholder }}
      adornment={({ available }) => (
        <>
          {available && <Icon name="check-circle" size={16} color="var(--accent-green)" />}
          <span>{copy.domain}</span>
          <b
            className={props.free ? `zkm-on-brand ${styles.price}` : styles.price}
            data-free={props.free || undefined}
          >
            {props.free ? copy.free : PAY_PRICE}
          </b>
        </>
      )}
      available={() => copy.available}
      onClose={props.onClose}
    >
      {({ available, busy, pick }) => (
        <>
          <PrimaryGradientButton
            title={props.submitLabel}
            testId="own-tag-sign-up"
            isDisabled={!available}
            isLoading={busy}
            onClick={() => void pick(props.onPick)}
          />
          {props.onVerify && !props.free && (
            <p className="ww-invite-modal-foot">
              {copy.usedBefore}{" "}
              <button
                type="button"
                className="zkm-btn-reset ww-invite__link"
                data-testid="own-tag-verify"
                disabled={busy}
                onClick={props.onVerify}
              >
                {copy.verify}
              </button>
            </p>
          )}
          {props.onLogIn && (
            <p className="ww-invite-modal-foot">
              {copy.haveAccount}{" "}
              <button
                type="button"
                className="zkm-btn-reset ww-invite__link"
                disabled={busy}
                onClick={props.onLogIn}
              >
                {copy.signIn}
              </button>
            </p>
          )}
        </>
      )}
    </TagPickSheet>
  )
}
