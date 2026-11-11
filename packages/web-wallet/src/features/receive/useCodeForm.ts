import { useEffect, useRef, useState } from "react"
import { amountError, decimalInput } from "../../ui/format"
import { useLookup } from "@obsidion/front-core"
import type { ReceiveCode } from "@obsidion/front-core"
import { useSession } from "../../session/session"
import type { CodeForm } from "./receiveCode"
import { parseRequestAmount } from "./receiveView"

/** Typing settles for this long before the code is minted again. */
const SETTLE_MS = 800

const keyOf = (amount: number, note: string) => `${amount}|${note.trim()}`

export interface CodeFormState {
  amount: string
  note: string
  setAmount: (value: string) => void
  setNote: (value: string) => void
  amountError?: string
  error?: string
}

/** The amount and note typed on the Receive code. Empty is any amount; the code follows the form. */
export function useCodeForm(
  code: ReceiveCode | undefined,
  onSubmit: (form: CodeForm) => Promise<void>,
): CodeFormState {
  const [amount, setAmount] = useState("")
  const [note, setNote] = useState("")
  const [failed, setFailed] = useState(false)
  // What the code holds or was last asked to hold, so a settled form mints once.
  const applied = useRef(keyOf(0, ""))

  // A code from elsewhere (a fresh visit, the next one after a payment) resets the form.
  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => {
    if (!code) return
    const key = keyOf(code.amount, code.note ?? "")
    if (key === applied.current) return
    applied.current = key
    setAmount(code.amount > 0 ? String(code.amount) : "")
    setNote(code.note ?? "")
  }, [code])

  const parsed = amount.trim() ? parseRequestAmount(amount) : 0
  const typed = code && parsed !== null ? keyOf(parsed, note) : undefined
  const latest = useRef({ parsed, note, onSubmit })
  latest.current = { parsed, note, onSubmit }
  // A form's code: minted again each time the form settles on it.
  const { query } = useSession().page
  const [mints] = useState(() =>
    query<[string], void>("receiveCodeMint", {
      load: (key) => {
        // A code from elsewhere may have settled the form while the wait ran.
        if (key === applied.current) return Promise.resolve()
        applied.current = key
        const form = latest.current
        return form
          .onSubmit({
            amountInput: form.parsed ? String(form.parsed) : "",
            noteInput: form.note,
          })
          .then(
            () => setFailed(false),
            () => {
              applied.current = ""
              setFailed(true)
            },
          )
      },
      stale: 0,
    }),
  )
  useLookup(typed === applied.current ? undefined : typed, mints, { delayMs: SETTLE_MS })

  return {
    amount,
    note,
    setAmount: (value) => setAmount(decimalInput(value)),
    setNote,
    amountError: amountError(amount.trim()),
    error: failed
      ? "Your pay QR code didn't update. Edit the amount or note to try again."
      : undefined,
  }
}
