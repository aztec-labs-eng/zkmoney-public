import { useRef, useState } from "react"
import { GradientSpinner, Icon } from "@obsidion/web-ds"
import { L1AddressText } from "../../ui/L1AddressText"

export type LookupState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "not-found" }
  | { kind: "found" }
  /** Text that can no longer become an address. */
  | { kind: "invalid" }
  /** The lookup itself failed; editing or re-pasting the address retries. */
  | { kind: "error" }

export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

/** Truncated address, MetaMask's ends in bold (0x19E7a…Aff2A). */
function FormattedAddress({ address }: { address: string }) {
  return (
    <span className="ww-verify-addr">
      <L1AddressText address={address} cut />
    </span>
  )
}

/** The old wallet's address, pasted or typed, checked against the past-user list in this browser. */
export function PastUserAddressInput(props: {
  address: string
  state: LookupState
  /** The connected wallet: the eligible card asks to connect it when it is a different one. */
  connected: boolean
  onAddress: (address: string) => void
  /** Runs the lookup again after it failed; the same address pasted again changes nothing. */
  onRetry?: () => void
}) {
  const { address, state } = props
  const inputRef = useRef<HTMLInputElement>(null)
  const [editing, setEditing] = useState(false)

  const paste = async () => {
    try {
      const text = (await navigator.clipboard.readText()).trim()
      if (text) props.onAddress(text)
      else inputRef.current?.focus()
    } catch {
      inputRef.current?.focus()
    }
  }

  // A complete address shows truncated; clicking it hands editing back.
  const showRaw = !ADDRESS_RE.test(address) || editing
  const bad = state.kind === "not-found" || state.kind === "error" || state.kind === "invalid"

  return (
    <div className="ww-verify-field">
      <p className="ww-verify-field__label">
        {state.kind === "found"
          ? "Which address did you use?"
          : "Not sure which wallet? Check an address first."}
      </p>
      <div className="ww-verify-field__input" data-error={bad || undefined}>
        {showRaw ? (
          <input
            ref={inputRef}
            aria-label="Old wallet address"
            placeholder="Paste an address"
            value={address}
            autoComplete="off"
            data-1p-ignore="true"
            data-lpignore="true"
            spellCheck={false}
            onFocus={() => setEditing(true)}
            onBlur={() => setEditing(false)}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            onChange={(e) => {
              const value = e.target.value.trim()
              props.onAddress(value)
              if (ADDRESS_RE.test(value)) e.currentTarget.blur()
            }}
          />
        ) : (
          <button
            type="button"
            className="zkm-btn-reset ww-verify-field__edit"
            title="Edit address"
            onClick={() => {
              setEditing(true)
              requestAnimationFrame(() => inputRef.current?.focus())
            }}
          >
            <FormattedAddress address={address} />
          </button>
        )}
        {state.kind === "loading" && <GradientSpinner size={18} />}
        {state.kind === "found" && <Icon name="check" size={20} color="var(--accent-green)" />}
        {address && state.kind !== "loading" && state.kind !== "found" && (
          <button
            type="button"
            className="zkm-btn-reset ww-verify-field__clear"
            aria-label="Clear address"
            onClick={() => props.onAddress("")}
          >
            <Icon name="x" size={10} />
          </button>
        )}
        {!address && (
          <button type="button" className="zkm-btn-reset ww-verify-field__paste" onClick={paste}>
            Paste
            <Icon name="copy" size={12} />
          </button>
        )}
      </div>
      {state.kind === "not-found" && <p className="ww-verify-field__error">Not eligible</p>}
      {state.kind === "invalid" && <p className="ww-verify-field__error">Not a valid address</p>}
      {state.kind === "error" && (
        <p className="ww-verify-field__error">
          Something went wrong checking this address.{" "}
          <button
            type="button"
            className="zkm-btn-reset ww-invite__link"
            data-testid="past-user-retry"
            onClick={props.onRetry}
          >
            Try again
          </button>
        </p>
      )}
      {state.kind === "found" && (
        <div className="ww-verify-field__eligible">
          <b>{props.connected ? "Ready to verify 🎉" : "Connect this wallet to continue 🎉"}</b>
          <span>Eligible past zk.money user</span>
        </div>
      )}
    </div>
  )
}
