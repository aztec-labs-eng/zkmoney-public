import type { ReactNode } from "react"
import { useStore } from "@obsidion/front-core"
import { GradientText, TopNavIconButton } from "@obsidion/web-ds"
import { errorMessage } from "../../../errors/catalog"
import { useSession } from "../../../session/session"
import { Modal } from "../../../ui/Modal"
import { useScreenFlow } from "../../../ui/useScreenFlow"
import { TagAvailabilityNotes } from "../TagAvailabilityNotes/TagAvailabilityNotes"
import { openTagPickFlow, type TagPickDeps } from "../tagPickFlow"
import copy from "./TagPickSheet.copy"
import styles from "./TagPickSheet.module.css"

type Flow = ReturnType<typeof openTagPickFlow>
/** `errorNote`: the pick's error, for a host that shows it with its actions. */
type View = ReturnType<Flow["view"]["get"]> & { pick: Flow["pick"]; errorNote: ReactNode }

/** A tag pick over `tagPickFlow`; each host brings its words, its pick and its actions. */
export function TagPickSheet(props: {
  flow: Omit<TagPickDeps, "fire" | "page">
  className: string
  label: string
  /** Above the title, inside the sheet. */
  art?: ReactNode
  title: ReactNode
  input: { label: string; placeholder: string }
  /** A visible label over the field, which then also holds the pick's error. */
  fieldLabel?: string
  /** In the field after the input. */
  adornment?: (view: View) => ReactNode
  /** The line for a free tag. */
  available: (name: string) => ReactNode
  onClose: () => void
  children: (view: View) => ReactNode
}) {
  const { page } = useSession()
  const flow = useScreenFlow(undefined, () => openTagPickFlow({ ...props.flow, page }))
  const state = useStore(flow.view)
  const { typed, name, status, checking, available, busy, error } = state
  const errorNote = error !== undefined && (
    <p className="ww-invite__error" role="alert">
      {errorMessage(error)}
    </p>
  )
  const view = { ...state, pick: flow.pick, errorNote }
  const Field = props.fieldLabel ? "label" : "div"
  const onClose = busy ? undefined : props.onClose
  return (
    <Modal variant="bare" className={props.className} label={props.label} onClose={onClose}>
      <div className="ww-deposit-warning__close">
        <TopNavIconButton icon="x" ariaLabel={copy.close} onClick={onClose} />
      </div>
      {props.art}
      <GradientText size={24} weight={700}>
        {props.title}
      </GradientText>
      <Field className={styles.name}>
        {props.fieldLabel && <span className="ww-invite-field__label">{props.fieldLabel}</span>}
        <span className={`ww-invite-field__input ${styles.field}`}>
          <span>{copy.at}</span>
          <input
            aria-label={props.input.label}
            placeholder={props.input.placeholder}
            value={typed}
            autoFocus
            disabled={busy}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            onChange={(e) => flow.type(e.target.value)}
          />
          {props.adornment?.(view)}
        </span>
        {available && name ? (
          <p className={styles.ok}>{props.available(name)}</p>
        ) : (
          <TagAvailabilityNotes
            typed={typed}
            valid={name !== null}
            availability={status}
            checking={checking}
            resuming={false}
          />
        )}
        {props.fieldLabel && errorNote}
      </Field>
      {props.children(view)}
    </Modal>
  )
}
