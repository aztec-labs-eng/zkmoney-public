/**
 * The endpoint editor both hosts share: the wallet's Endpoints sheet and the desktop launcher's
 * settings page, which runs without a booted wallet. So nothing here may read the wallet's config
 * or operation state.
 */
import { Fragment, useState } from "react"
import { Icon } from "@obsidion/web-ds"
import {
  readEndpointOverrides,
  sameOverrides,
  storableApiKey,
  storableOverride,
  tryNormalizeEndpoint,
  writeEndpointOverrides,
  type EndpointKind,
  type EndpointOverrides,
} from "../config/endpointOverrides"

type Field = {
  kind: EndpointKind
  label: string
  /** The word after "Custom" in the Home pill and the Settings row. */
  short: string
  /** Shown when the host does not know the default's address. */
  placeholder: string
  hints: string[]
}

const BUILT_IN = "Leave blank to use the address built into the app"

/** The node comes first. */
const FIELDS: Field[] = [
  {
    kind: "node",
    label: "Aztec node URL",
    short: "node",
    placeholder: BUILT_IN,
    hints: [
      "How the wallet reads the Aztec Network and sends transactions. Any node serving the same network works.",
      "The node's operator sees your IP address and can tell which transactions your wallet sends and receives, but not what is in them.",
      "Switching starts a fresh sync of your history for this node. Your history on the default node is kept.",
    ],
  },
  {
    kind: "l1Rpc",
    label: "Ethereum RPC URL",
    short: "RPC",
    placeholder: BUILT_IN,
    hints: [
      "How the wallet reads Ethereum. Any provider's endpoint works, including one you pay for.",
    ],
  },
  {
    kind: "enclave",
    label: "Enclave URL",
    short: "enclave",
    placeholder: "Leave blank to use the address in zk.money's configuration",
    hints: [
      "The Oxide enclave that co-signs your sends and withdrawals. Any registered enclave works.",
    ],
  },
]

const INVALID_URL = "Enter a full http(s) URL, with no username or password."
const INVALID_ENCLAVE = "Enter the enclave's origin only: no query, fragment or /rpc."
const KEY_WITHOUT_NODE = "Enter the node URL this key is for."
const INVALID_KEY = "Enter the key as issued: no spaces, at most 512 characters."
const REFUSED = "Couldn't save: this browser refused the write."
const CHANGED = "Another tab changed the endpoints. Close this and open it again to edit them."

type Values = Record<EndpointKind, string> & { nodeApiKey: string }

/** "Custom node, RPC" for the Home pill and the Settings row; undefined when every endpoint is the default. */
export function customEndpointsLabel(
  endpoints: Record<EndpointKind, { isDefault: boolean }>,
): string | undefined {
  const custom = FIELDS.filter((field) => !endpoints[field.kind].isDefault).map((f) => f.short)
  return custom.length ? `Custom ${custom.join(", ")}` : undefined
}

/** The host of a default URL, for a placeholder; undefined when it is not an absolute URL. */
export function defaultHost(url: string): string | undefined {
  const normalized = tryNormalizeEndpoint(url)
  return normalized ? new URL(normalized).host : undefined
}

/** Why a typed value cannot be stored, by the same rules the store applies; undefined when it can. */
function invalidReason(kind: EndpointKind, value: string): string | undefined {
  if (value === "") return undefined
  if (tryNormalizeEndpoint(value) === undefined) return INVALID_URL
  if (storableOverride(kind, value) === undefined) return INVALID_ENCLAVE
  return undefined
}

/** A key is stored only beside the node URL it is for. */
function invalidKeyReason(key: string, node: string): string | undefined {
  if (key === "") return undefined
  if (node === "") return KEY_WITHOUT_NODE
  return storableApiKey(key) === undefined ? INVALID_KEY : undefined
}

const valuesOf = (stored: EndpointOverrides): Values => ({
  node: stored.node ?? "",
  l1Rpc: stored.l1Rpc ?? "",
  enclave: stored.enclave ?? "",
  nodeApiKey: stored.nodeApiKey ?? "",
})

export type EndpointCommit =
  | { ok: true }
  | { ok: false; reason: "invalid" | "changed" | "storage"; message: string }

export type EndpointEditor = ReturnType<typeof useEndpointEditor>

/**
 * The editor's state over the saved record. `commit` writes only when something changed and then
 * treats what it wrote as the saved record, so pressing save again is not refused as another tab's
 * change. A write whose read-back fails keeps the old record as the baseline: what is stored is
 * unknown until the record is read again.
 */
export function useEndpointEditor({ onEdit }: { onEdit?: () => void } = {}) {
  const [baseline, setBaseline] = useState<EndpointOverrides>(readEndpointOverrides)
  const [values, setValues] = useState<Values>(() => valuesOf(baseline))
  const [keyTyped, setKeyTyped] = useState(false)

  const typed = (kind: EndpointKind) => values[kind].trim()
  // The saved key belongs to the saved node: until a key is typed here, no other URL gets it.
  const savedNode =
    tryNormalizeEndpoint(typed("node")) === tryNormalizeEndpoint(baseline.node ?? "")
  const apiKey = keyTyped ? values.nodeApiKey : savedNode ? baseline.nodeApiKey ?? "" : ""
  const keyWithheld = !keyTyped && !savedNode && baseline.nodeApiKey !== undefined
  const errors = Object.fromEntries(
    FIELDS.map((field) => [field.kind, invalidReason(field.kind, typed(field.kind))]),
  ) as Record<EndpointKind, string | undefined>
  const keyError = invalidKeyReason(apiKey.trim(), typed("node"))
  const valid = keyError === undefined && FIELDS.every((field) => !errors[field.kind])
  const dirty =
    FIELDS.some((field) => typed(field.kind) !== (baseline[field.kind] ?? "")) ||
    apiKey.trim() !== (baseline.nodeApiKey ?? "")

  const edit = (next: Partial<Values>) => {
    if (next.nodeApiKey !== undefined) setKeyTyped(true)
    setValues((prev) => ({ ...prev, ...next }))
    onEdit?.()
  }

  // One write for the whole record: a refused save leaves storage as it was.
  const commit = (): EndpointCommit => {
    // Nothing to write, but a record another window changed since would otherwise stand unseen.
    if (!dirty) {
      return sameOverrides(readEndpointOverrides(), baseline)
        ? { ok: true }
        : { ok: false, reason: "changed", message: CHANGED }
    }
    const result = writeEndpointOverrides({ ...values, nodeApiKey: apiKey }, baseline)
    if (result.ok) {
      const saved = readEndpointOverrides()
      setBaseline(saved)
      setValues(valuesOf(saved))
      setKeyTyped(false)
      return { ok: true }
    }
    if (result.reason === "invalid") {
      return {
        ok: false,
        reason: "invalid",
        message: result.kind === "nodeApiKey" ? INVALID_KEY : INVALID_URL,
      }
    }
    return {
      ok: false,
      reason: result.reason,
      message: result.reason === "changed" ? CHANGED : REFUSED,
    }
  }

  return { values, apiKey, keyWithheld, baseline, errors, keyError, valid, dirty, edit, commit }
}

/**
 * The fields. `defaults` holds the host of each default the wallet dials, for its placeholder; a
 * kind it lacks shows the fixed text instead.
 */
export function EndpointFields({
  editor,
  defaults = {},
  disabled = false,
}: {
  editor: EndpointEditor
  defaults?: Partial<Record<EndpointKind, string>>
  disabled?: boolean
}) {
  const { values, apiKey, keyWithheld, baseline, errors, keyError, edit } = editor
  return (
    <>
      {FIELDS.map((field) => {
        const id = `endpoint-${field.kind}`
        const error = errors[field.kind]
        const host = defaults[field.kind]
        return (
          <Fragment key={field.kind}>
            <div className="ww-endpoints__field">
              <div className="ww-endpoints__label-row">
                <label htmlFor={id}>{field.label}</label>
                {baseline[field.kind] !== undefined && values[field.kind] !== "" && (
                  <button
                    type="button"
                    className="zkm-btn-reset ww-endpoints__use-default"
                    disabled={disabled}
                    // The node's key goes with it.
                    onClick={() =>
                      edit(
                        field.kind === "node" ? { node: "", nodeApiKey: "" } : { [field.kind]: "" },
                      )
                    }
                  >
                    Use default
                  </button>
                )}
              </div>
              <input
                id={id}
                type="url"
                className="ww-endpoints__input"
                placeholder={host ? `Default: ${host}` : field.placeholder}
                value={values[field.kind]}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                disabled={disabled}
                aria-invalid={error !== undefined}
                onChange={(e) => edit({ [field.kind]: e.target.value })}
              />
              {error && (
                <p className="ww-endpoints__error" role="alert">
                  {error}
                </p>
              )}
              {field.hints.map((hint) => (
                <p key={hint} className="ww-endpoints__note">
                  <Icon name="info-circle" size={14} color="var(--text-secondary)" />
                  <span>{hint}</span>
                </p>
              ))}
            </div>
            {field.kind === "node" && (
              <div className="ww-endpoints__field">
                <div className="ww-endpoints__label-row">
                  <label htmlFor="endpoint-nodeApiKey">Aztec node API key</label>
                </div>
                {/* CSS-masked, not type="password", so password managers leave it alone. */}
                <input
                  id="endpoint-nodeApiKey"
                  type="text"
                  className="ww-endpoints__input ww-endpoints__input--secret"
                  placeholder="Leave blank if your node needs no key"
                  value={apiKey}
                  autoComplete="off"
                  data-1p-ignore
                  data-lpignore="true"
                  data-bwignore="true"
                  data-form-type="other"
                  autoCapitalize="none"
                  spellCheck={false}
                  disabled={disabled}
                  aria-invalid={keyError !== undefined}
                  onChange={(e) => edit({ nodeApiKey: e.target.value })}
                />
                {keyError && (
                  <p className="ww-endpoints__error" role="alert">
                    {keyError}
                  </p>
                )}
                {keyWithheld && (
                  <p className="ww-endpoints__note" data-testid="endpoints-key-withheld">
                    <Icon name="info-circle" size={14} color="var(--text-secondary)" />
                    <span>
                      The saved key was for the previous node, so it is not sent to this one.
                    </span>
                  </p>
                )}
                <p className="ww-endpoints__note">
                  <Icon name="info-circle" size={14} color="var(--text-secondary)" />
                  <span>Only needed if the node above asks for one.</span>
                </p>
              </div>
            )}
          </Fragment>
        )
      })}
    </>
  )
}
