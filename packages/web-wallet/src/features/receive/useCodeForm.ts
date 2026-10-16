import { useEffect, useRef, useState } from "react"
import { decimalInput } from "../../ui/format"
import type { CodeForm, ReceiveCode } from "./receiveCode"
import { parseRequestAmount } from "./receiveView"

/** Typing settles for this long before the code is minted again. */
const SETTLE_MS = 800

const keyOf = (amount: number, note: string) => `${amount}|${note.trim()}`

export interface CodeFormState {
  amount: string
  note: string
  setAmount: (value: string) => void
  setNote: (value: string) => void
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
  useEffect(() => {
    if (!code) return
    const key = keyOf(code.amount, code.note ?? "")
    if (key === applied.current) return
    applied.current = key
    setAmount(code.amount > 0 ? String(code.amount) : "")
    setNote(code.note ?? "")
  }, [code])

  const parsed = amount.trim() ? parseRequestAmount(amount) : 0
  useEffect(() => {
    if (!code || parsed === null) return
    const key = keyOf(parsed, note)
    if (key === applied.current) return
    const timer = setTimeout(() => {
      applied.current = key
      onSubmit({ amountInput: parsed ? String(parsed) : "", noteInput: note }).then(
        () => setFailed(false),
        () => {
          applied.current = ""
          setFailed(true)
        },
      )
    }, SETTLE_MS)
    return () => clearTimeout(timer)
  }, [code, parsed, note, onSubmit])

  return {
    amount,
    note,
    setAmount: (value) => setAmount(decimalInput(value)),
    setNote,
    error:
      parsed === null
        ? "Enter an amount above $0."
        : failed
        ? "The code didn't update. Edit it to try again."
        : undefined,
  }
}
