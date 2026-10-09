import { useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { PrimaryGradientButton, TopNavIconButton } from "@obsidion/web-ds"
import {
  parseServedProfile,
  resolveWalletProfileDocument,
  type ConfigProfile,
  type ConfigVersion,
} from "@obsidion/config-client"
import { useLeavingLosesTransaction } from "../features/operations/operations"
import { reloadPage } from "../platform/storage/walletStorage"
import { Modal, PageModal, PageModalPanel } from "../ui/Modal"
import { assertProfilePolicy, parseNetwork } from "../config/profilePolicy"
import { clearProfileDraft, profileDraft, saveProfileDraft } from "./configDraft"

const PROFILE_URL = import.meta.env.VITE_CONFIG_PROFILE_URL as string | undefined

function validate(text: string): { profile: ConfigProfile; version: ConfigVersion } {
  const profile = parseServedProfile(JSON.parse(text))
  const resolved = resolveWalletProfileDocument(profile, {
    source: "the preview draft",
    expectedProfileId: import.meta.env.VITE_CONFIG_EXPECTED_PROFILE_ID,
    network: import.meta.env.VITE_NETWORK ?? "sandbox",
  })
  assertProfilePolicy(resolved, parseNetwork(import.meta.env.VITE_NETWORK))
  return { profile, version: resolved.version }
}

function errorMessages(message: string): string[] {
  const prefix = "schema violations:\n"
  return message.startsWith(prefix)
    ? message.slice(prefix.length).split("\n").filter(Boolean)
    : [message]
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="ww-config-profile__row">
      <span>{label}</span>
      <span>{value}</span>
    </div>
  )
}

export function ConfigProfileModal({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState("")
  const [summaryText, setSummaryText] = useState("")
  const [sourceUrl, setSourceUrl] = useState(PROFILE_URL ?? "")
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string>()
  const [urlError, setUrlError] = useState<string>()
  const [loadingUrl, setLoadingUrl] = useState(false)
  const [saveError, setSaveError] = useState<string>()
  const [editing, setEditing] = useState(false)
  const [showErrors, setShowErrors] = useState(false)
  const userSelectedText = useRef(false)
  const editButton = useRef<HTMLButtonElement>(null)
  const urlRequest = useRef<AbortController | null>(null)
  const [savedDraft] = useState(() => !!PROFILE_URL && profileDraft(PROFILE_URL) !== undefined)
  const losesTransaction = useLeavingLosesTransaction()

  const selectText = () => {
    userSelectedText.current = true
    setLoading(false)
    setLoadError(undefined)
  }

  useEffect(() => {
    if (editing) {
      const scroll = editButton.current?.closest<HTMLElement>(".ww-page-modal__scroll")
      if (scroll) scroll.scrollTop = 0
    }
  }, [editing])

  useEffect(() => () => urlRequest.current?.abort(), [])

  useEffect(() => {
    if (!PROFILE_URL) {
      setLoadError("This build has no config profile URL.")
      setLoading(false)
      return
    }
    const draft = profileDraft(PROFILE_URL)
    if (draft !== undefined) {
      setText(draft)
      setSummaryText(draft)
      setLoading(false)
      return
    }
    const controller = new AbortController()
    void fetch(PROFILE_URL, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Profile fetch returned ${response.status}`)
        const candidate = JSON.stringify(await response.json(), null, 2)
        if (!controller.signal.aborted && !userSelectedText.current) {
          setText(candidate)
          setSummaryText(candidate)
        }
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted && !userSelectedText.current) setLoadError(error.message)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [])

  const parsed = useMemo(() => {
    if (!text) return undefined
    try {
      return { value: validate(text) }
    } catch (error) {
      return { error: (error as Error).message }
    }
  }, [text])
  const profile = parsed?.value?.profile
  const version = parsed?.value?.version
  const issues = urlError
    ? errorMessages(urlError)
    : parsed?.error
    ? errorMessages(parsed.error)
    : []
  const assets = version?.assets?.map((asset) => asset.symbol).join(", ") || "None listed"
  const overridden = [
    import.meta.env.VITE_NODE_URL && "L2 RPC",
    import.meta.env.VITE_L1_RPC_URL && "L1 RPC",
  ].filter(Boolean)

  const save = () => {
    if (!PROFILE_URL || !parsed?.value || losesTransaction || loadingUrl) return
    try {
      saveProfileDraft(PROFILE_URL, text)
      void reloadPage()
    } catch (error) {
      setSaveError((error as Error).message)
    }
  }
  const reset = () => {
    if (losesTransaction || loadingUrl) return
    try {
      clearProfileDraft()
      void reloadPage()
    } catch (error) {
      setSaveError((error as Error).message)
    }
  }

  const backToSummary = () => {
    urlRequest.current?.abort()
    setLoadingUrl(false)
    setText(summaryText)
    setSourceUrl(PROFILE_URL ?? "")
    setUrlError(undefined)
    setSaveError(undefined)
    setShowErrors(false)
    setEditing(false)
  }

  const loadFromUrl = async () => {
    if (loadingUrl) return
    let url: URL
    try {
      url = new URL(sourceUrl.trim(), location.href)
      if (!sourceUrl.trim() || !["http:", "https:"].includes(url.protocol)) throw new Error()
    } catch {
      setUrlError("Enter an HTTP(S) profile URL.")
      return
    }

    const controller = new AbortController()
    urlRequest.current = controller
    setLoadingUrl(true)
    setUrlError(undefined)
    try {
      const response = await fetch(url.href, { cache: "no-store", signal: controller.signal })
      if (!response.ok) throw new Error(`Profile fetch returned ${response.status}`)
      const candidate = JSON.stringify(await response.json(), null, 2)
      validate(candidate)
      if (controller.signal.aborted) return
      selectText()
      setText(candidate)
      setSaveError(undefined)
    } catch (error) {
      if (!controller.signal.aborted) setUrlError((error as Error).message)
    } finally {
      if (!controller.signal.aborted) setLoadingUrl(false)
      if (urlRequest.current === controller) urlRequest.current = null
    }
  }

  return (
    <PageModal
      title="Config profile"
      onClose={onClose}
      fitContent={!editing}
      footer={
        <div className="ww-config-profile__actions">
          {editing ? (
            <PrimaryGradientButton
              title="Save & reload"
              isDisabled={!parsed?.value || losesTransaction || loadingUrl}
              onClick={save}
            />
          ) : (
            <PrimaryGradientButton title="Edit JSON" onClick={() => setEditing(true)} />
          )}
          {savedDraft && (
            <PrimaryGradientButton
              title="Use live profile"
              buttonStyle="dark"
              isDisabled={losesTransaction || loadingUrl}
              onClick={reset}
            />
          )}
        </div>
      }
    >
      {profile && version && !editing && (
        <div className="ww-config-profile__identity">
          <div className="ww-config-profile__identity-field">
            <strong>Profile Name</strong>
            <span>{profile.profileId}</span>
          </div>
          <div className="ww-config-profile__identity-field">
            <strong>Current version</strong>
            <span>{profile.current}</span>
          </div>
        </div>
      )}
      <PageModalPanel scrollable={!editing}>
        <div
          className={
            editing
              ? "ww-config-profile__body ww-config-profile__body--editing"
              : "ww-config-profile__body"
          }
        >
          {savedDraft && <span className="ww-config-profile__badge">Session draft active</span>}
          {loading && <p>Loading profile…</p>}
          {loadError && (
            <p className="ww-config-profile__error" role="alert">
              {loadError}
            </p>
          )}
          <div className="ww-config-profile__editor-section">
            {profile && version && !editing && (
              <div className="ww-config-profile__summary">
                <SummaryRow label="Network" value={profile.network} />
                <SummaryRow label="L1 chain" value={String(profile.shared.l1ChainId)} />
                <SummaryRow label="Rollup" value={profile.shared.rollupVersion} />
                <SummaryRow label="XMTP" value={profile.shared.xmtpEnv} />
                <SummaryRow label="L1 RPC" value={version.l1RpcUrl} />
                <SummaryRow label="L2 RPC" value={version.nodeUrl} />
                <SummaryRow label="Bundler RPC" value="Not in profile" />
                <SummaryRow label="Account service" value={version.accountServiceUrl} />
                <SummaryRow label="zk.money API" value={version.zkmoneyApiUrl} />
                <SummaryRow label="Paylink domain" value={version.paylinkDomain} />
                <SummaryRow label="Tokens" value={assets} />
                <SummaryRow label="Oxide portal" value={version.oxide.portal} />
                <SummaryRow label="Oxide manifest" value={version.oxide.manifestUrl} />
                <SummaryRow
                  label="Contracts"
                  value={`${Object.keys(version.contracts).length} entries`}
                />
              </div>
            )}
            {editing && (
              <div className="ww-config-profile__json-panel">
                <label htmlFor="ww-config-profile-url">Profile JSON URL</label>
                <form
                  className="ww-config-profile__url-row"
                  noValidate
                  onSubmit={(event) => {
                    event.preventDefault()
                    void loadFromUrl()
                  }}
                >
                  <input
                    id="ww-config-profile-url"
                    type="text"
                    inputMode="url"
                    value={sourceUrl}
                    onChange={(event) => {
                      setSourceUrl(event.target.value)
                      setUrlError(undefined)
                    }}
                    disabled={loadingUrl}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    aria-invalid={!!urlError}
                    aria-describedby={urlError ? "ww-config-profile-issues" : undefined}
                  />
                  <button type="submit" disabled={loadingUrl || !sourceUrl.trim()}>
                    {loadingUrl ? "Loading…" : "Load JSON"}
                  </button>
                </form>
                <label htmlFor="ww-config-profile-json">Profile JSON</label>
                <textarea
                  id="ww-config-profile-json"
                  value={text}
                  wrap="soft"
                  onChange={(event) => {
                    selectText()
                    setText(event.target.value)
                    setUrlError(undefined)
                    setSaveError(undefined)
                  }}
                  spellCheck={false}
                  disabled={loadingUrl}
                  aria-invalid={!!parsed?.error}
                  aria-describedby={
                    parsed?.error && !urlError ? "ww-config-profile-issues" : undefined
                  }
                />
              </div>
            )}
            {editing && (
              <button
                ref={editButton}
                type="button"
                className="ww-config-profile__view"
                onClick={backToSummary}
              >
                Back to summary
              </button>
            )}
          </div>
          {overridden.length > 0 && (
            <p className="ww-config-profile__note">
              Build settings override these profile fields: {overridden.join(", ")}.
            </p>
          )}
          {new URLSearchParams(location.search).has("demo") && (
            <p className="ww-config-profile__note">
              Demo mode uses its own profile. This draft applies when the real wallet boots.
            </p>
          )}
          {issues.length > 0 && (
            <div
              id="ww-config-profile-issues"
              className="ww-config-profile__issue-notice"
              role="status"
            >
              <span>
                {issues.length} {issues.length === 1 ? "error" : "errors"}{" "}
                {urlError ? "loading the JSON" : "in the supplied JSON"}
              </span>
              <button type="button" onClick={() => setShowErrors(true)}>
                Show errors
              </button>
            </div>
          )}
          {losesTransaction && (
            <p className="ww-config-profile__error" role="alert">
              A transaction is still being sent. Wait for it to finish before reloading.
            </p>
          )}
          {saveError && (
            <p className="ww-config-profile__error" role="alert">
              {saveError}
            </p>
          )}
        </div>
      </PageModalPanel>
      {showErrors &&
        createPortal(
          <Modal
            variant="bare"
            label="JSON errors"
            onClose={() => setShowErrors(false)}
            className="ww-error-modal ww-config-profile__errors-modal"
          >
            <div className="ww-config-profile__errors-header">
              <span className="zkm-type-title-sm">JSON errors</span>
              <TopNavIconButton icon="x" ariaLabel="Close" onClick={() => setShowErrors(false)} />
            </div>
            <div className="ww-config-profile__errors-surface">
              <div className="ww-config-profile__errors-scroll">
                <div className="ww-config-profile__issue-list">
                  {issues.map((issue, index) => (
                    <p key={`${index}-${issue}`} className="ww-config-profile__issue">
                      {issue}
                    </p>
                  ))}
                </div>
              </div>
            </div>
          </Modal>,
          document.body,
        )}
    </PageModal>
  )
}
