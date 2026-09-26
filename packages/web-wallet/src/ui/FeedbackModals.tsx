import { Modal } from "./Modal"
import { useState, type ReactNode } from "react"
import { GradientText, Icon, PrimaryGradientButton, TopNavIconButton } from "@obsidion/web-ds"

import { sendFeedback } from "../lib/feedback"

function Sheet({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: ReactNode
}) {
  return (
    <Modal variant="bare" label={title} className="ww-modal--create ww-feedback" onClose={onClose}>
      <div className="ww-modal__close">
        <TopNavIconButton icon="x" ariaLabel="Close" onClick={onClose} />
      </div>
      <GradientText className="ww-feedback__title" gradient="title" size={24} weight={700} style={{ textAlign: "center" }}>
        {title}
      </GradientText>
      {children}
    </Modal>
  )
}

function Thanks({ onClose }: { onClose: () => void }) {
  return (
    <>
      <div className="ww-feedback__thanks" role="status">
        <Icon name="check" size={36} color="var(--accent-green)" strokeWidth={2.5} />
        <span>Got it.</span>
      </div>
      <PrimaryGradientButton title="Done" onClick={onClose} />
    </>
  )
}

function useSubmit(send: () => Promise<boolean>) {
  const [status, setStatus] = useState<"idle" | "sending" | "failed" | "sent">("idle")
  const submit = async () => {
    setStatus("sending")
    setStatus((await send()) ? "sent" : "failed")
  }
  return { status, submit }
}

function SendFailed() {
  return (
    <p className="ww-feedback__error" role="alert">
      Couldn't send — please try again.
    </p>
  )
}

// `as="div"` for groups of buttons: a <label> would forward clicks to the first one.
function Field({
  label,
  as: Tag = "label",
  children,
}: {
  label: string
  as?: "label" | "div"
  children: ReactNode
}) {
  return (
    <Tag className="ww-feedback__field">
      <span>{label}</span>
      {children}
    </Tag>
  )
}

export function FeedbackModal({ onClose }: { onClose: () => void }) {
  const [rating, setRating] = useState<"good" | "bad">()
  const [text, setText] = useState("")
  const { status, submit } = useSubmit(() => sendFeedback({ kind: "feedback", rating, text }))

  return (
    <Sheet title="Help us improve zk.money" onClose={onClose}>
      {status === "sent" ? (
        <Thanks onClose={onClose} />
      ) : (
        <>
          <div className="ww-feedback__body">
            <Field label="How are you liking zk.money?" as="div">
              <div className="ww-feedback__rate">
                {(["good", "bad"] as const).map((r) => (
                  <button
                    key={r}
                    type="button"
                    className="zkm-btn-reset ww-feedback__rate-btn"
                    data-active={rating === r || undefined}
                    aria-pressed={rating === r}
                    onClick={() => setRating(r)}
                  >
                    <Icon name={r === "good" ? "thumb-up" : "thumb-down"} size={16} />
                    {r === "good" ? "Good" : "Bad"}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="What other feedback do you have?">
              <textarea
                className="ww-feedback__textarea"
                placeholder="A feature you want, something that felt slow or confusing, or anything that would make zk.money better."
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </Field>
          </div>
          {status === "failed" && <SendFailed />}
          <PrimaryGradientButton
            title="Send feedback"
            isLoading={status === "sending"}
            isDisabled={!rating && !text.trim()}
            onClick={submit}
          />
        </>
      )}
    </Sheet>
  )
}

export function BugReportModal({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState("")
  const { status, submit } = useSubmit(() => sendFeedback({ kind: "bug", text }))

  return (
    <Sheet title="Report a bug" onClose={onClose}>
      {status === "sent" ? (
        <Thanks onClose={onClose} />
      ) : (
        <>
          <div className="ww-feedback__body">
            <Field label="Describe the bug">
              <textarea
                className="ww-feedback__textarea"
                placeholder="Describe the bug in as much detail as you can: what you were doing, what you expected, and what happened instead."
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </Field>
            {/* Screenshot attachment needs multipart through the svc proxy + Mailgun — ULT-778.
            <Field label="Attach file">
              <span className="ww-feedback__file">
                <Icon name="image-upload" size={16} />
                {file?.name ?? "Select file"}
              </span>
              <input
                type="file"
                accept="image/*"
                className="ww-feedback__file-input"
                onChange={(e) => setFile(e.target.files?.[0])}
              />
            </Field>
            */}
          </div>
          {status === "failed" && <SendFailed />}
          <PrimaryGradientButton
            title="Submit"
            isLoading={status === "sending"}
            isDisabled={!text.trim()}
            onClick={submit}
          />
        </>
      )}
    </Sheet>
  )
}
