import { useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { PrimaryGradientButton, TopNavIconButton } from "@obsidion/web-ds"
import {
  featuresUrlOf,
  parseFeaturesDocument,
  parseServedFeatures,
  parseServedProfile,
  resolveWalletProfileDocument,
  type FeaturesDocument,
} from "@obsidion/config-client"
import { useLeavingLosesTransaction } from "../features/operations/operations"
import { reloadPage } from "../platform/storage/walletStorage"
import { Modal, PageModal, PageModalPanel } from "../ui/Modal"
import { assertProfilePolicy, parseNetwork } from "../config/profilePolicy"
import { clearConfigDraft, configDraft, saveConfigDraft, type ConfigDocument } from "./configDraft"
import { useDomEffect } from "../ui/useDomEffect"
import { WalletError } from "@obsidion/core/errors"
import { fmt } from "../lib/fmt"
import copy from "./ConfigProfileModal.copy"

const PROFILE_URL = import.meta.env.VITE_CONFIG_PROFILE_URL as string | undefined

const EXPECTED_PROFILE_ID = import.meta.env.VITE_CONFIG_EXPECTED_PROFILE_ID
const NETWORK = import.meta.env.VITE_NETWORK ?? "sandbox"

/** What the summary shows of a valid document. */
interface DocumentSummary {
  identity: [label: string, value: string][]
  rows: [label: string, value: string][]
  /** Fields the build overrides. */
  overridden: string[]
}

/** One document the editor drafts: where it lives, how it is checked, and its words. */
interface DocumentSpec {
  kind: ConfigDocument
  /** Where the live document is read. */
  url: string | undefined
  /** Throws what is wrong with `text`; returns its summary. */
  validate(text: string): DocumentSummary
  words: typeof copy.profile | typeof copy.features
}

const PROFILE: DocumentSpec = {
  kind: "profile",
  url: PROFILE_URL,
  validate(text) {
    const profile = parseServedProfile(JSON.parse(text))
    const resolved = resolveWalletProfileDocument(profile, {
      source: "the preview draft",
      expectedProfileId: EXPECTED_PROFILE_ID,
      network: NETWORK,
    })
    assertProfilePolicy(resolved, parseNetwork(import.meta.env.VITE_NETWORK))
    const { version } = resolved
    const row = copy.profile.row
    return {
      identity: [
        [row.name, profile.profileId],
        [row.current, profile.current],
      ],
      rows: [
        [row.network, profile.network],
        [row.l1Chain, String(profile.shared.l1ChainId)],
        [row.rollup, profile.shared.rollupVersion],
        [row.xmtp, profile.shared.xmtpEnv],
        [row.l1Rpc, version.l1RpcUrl],
        [row.l2Rpc, version.nodeUrl],
        [row.bundlerRpc, row.notInProfile],
        [row.accountService, version.accountServiceUrl],
        [row.zkmoneyApi, version.zkmoneyApiUrl ?? row.disabled],
        [row.paylinkDomain, version.paylinkDomain],
        [row.tokens, version.assets?.map((asset) => asset.symbol).join(", ") || row.noneListed],
        [row.oxidePortal, version.oxide.portal],
        [row.oxideManifest, version.oxide.manifestUrl],
        [row.contracts, fmt(row.entries, { count: Object.keys(version.contracts).length })],
      ],
      overridden: [
        import.meta.env.VITE_NODE_URL && copy.profile.row.l2Rpc,
        import.meta.env.VITE_L1_RPC_URL && copy.profile.row.l1Rpc,
      ].filter((field): field is string => !!field),
    }
  },
  words: copy.profile,
}

function featuresSummary(document: FeaturesDocument): DocumentSummary {
  const { across } = document.features
  const row = copy.features.row
  return {
    identity: [
      [row.name, document.profileId],
      [row.published, document.publishedAt ?? row.notPublished],
    ],
    rows: [
      [row.network, document.network],
      [row.features, Object.keys(document.features).join(", ") || row.none],
      ...(across
        ? ([
            [row.acrossChains, across.chains.map((chain) => chain.name).join(", ") || row.none],
            [row.acrossExit, across.oxide.exit ?? row.notBound],
          ] as [string, string][])
        : []),
    ],
    overridden: [],
  }
}

const FEATURES: DocumentSpec = {
  kind: "features",
  url: PROFILE_URL && featuresUrlOf(PROFILE_URL),
  validate(text) {
    const data: unknown = JSON.parse(text)
    // The identity the wallet checks, then every rule the publisher enforces.
    parseServedFeatures(data, {
      expected: { profileId: EXPECTED_PROFILE_ID, network: parseNetwork(NETWORK) },
    })
    return featuresSummary(parseFeaturesDocument(data))
  },
  words: copy.features,
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
  return <ConfigDocumentModal spec={PROFILE} onClose={onClose} />
}

/** The Settings row that opens {@link FeaturesModal}. */
export const featuresEditorLabel = copy.features.title

export function FeaturesModal({ onClose }: { onClose: () => void }) {
  return <ConfigDocumentModal spec={FEATURES} onClose={onClose} />
}

function ConfigDocumentModal({ spec, onClose }: { spec: DocumentSpec; onClose: () => void }) {
  const { words } = spec
  const [text, setText] = useState("")
  const [summaryText, setSummaryText] = useState("")
  const [sourceUrl, setSourceUrl] = useState(spec.url ?? "")
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
  const [savedDraft] = useState(
    () => !!PROFILE_URL && configDraft(spec.kind, PROFILE_URL) !== undefined,
  )
  const losesTransaction = useLeavingLosesTransaction()

  const selectText = () => {
    userSelectedText.current = true
    setLoading(false)
    setLoadError(undefined)
  }

  useDomEffect(() => {
    if (editing) {
      const scroll = editButton.current?.closest<HTMLElement>(".ww-page-modal__scroll")
      if (scroll) scroll.scrollTop = 0
    }
  }, [editing])

  useEffect(() => () => urlRequest.current?.abort(), [])

  useEffect(() => {
    if (!PROFILE_URL || !spec.url) {
      setLoadError(words.noUrl)
      setLoading(false)
      return
    }
    const draft = configDraft(spec.kind, PROFILE_URL)
    if (draft !== undefined) {
      setText(draft)
      setSummaryText(draft)
      setLoading(false)
      return
    }
    const controller = new AbortController()
    void fetch(spec.url, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok)
          throw new WalletError(
            "config.invalid",
            fmt(words.fetchFailed, { status: response.status }),
          )
        const candidate = JSON.stringify(await response.json(), null, 2)
        if (!controller.signal.aborted && !userSelectedText.current) {
          setText(candidate)
          setSummaryText(candidate)
        }
      })
      .catch((error: Error) => {
        // eslint-disable-next-line local/message-in-state -- debt
        if (!controller.signal.aborted && !userSelectedText.current) setLoadError(error.message)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [spec, words])

  const parsed = useMemo(() => {
    if (!text) return undefined
    try {
      return { value: spec.validate(text) }
    } catch (error) {
      // eslint-disable-next-line local/message-in-state -- debt
      return { error: (error as Error).message }
    }
  }, [spec, text])
  const summary = parsed?.value
  const issues = urlError
    ? errorMessages(urlError)
    : parsed?.error
    ? errorMessages(parsed.error)
    : []
  const overridden = summary?.overridden ?? []

  const save = () => {
    if (!PROFILE_URL || !parsed?.value || losesTransaction || loadingUrl) return
    try {
      saveConfigDraft(spec.kind, PROFILE_URL, text)
      void reloadPage()
    } catch (error) {
      // eslint-disable-next-line local/message-in-state -- debt
      setSaveError((error as Error).message)
    }
  }
  const reset = () => {
    if (losesTransaction || loadingUrl) return
    try {
      clearConfigDraft(spec.kind)
      void reloadPage()
    } catch (error) {
      // eslint-disable-next-line local/message-in-state -- debt
      setSaveError((error as Error).message)
    }
  }

  const backToSummary = () => {
    urlRequest.current?.abort()
    setLoadingUrl(false)
    setText(summaryText)
    setSourceUrl(spec.url ?? "")
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
      setUrlError(words.enterUrl)
      return
    }

    const controller = new AbortController()
    urlRequest.current = controller
    setLoadingUrl(true)
    setUrlError(undefined)
    try {
      const response = await fetch(url.href, { cache: "no-store", signal: controller.signal })
      if (!response.ok)
        throw new WalletError("config.invalid", fmt(words.fetchFailed, { status: response.status }))
      const candidate = JSON.stringify(await response.json(), null, 2)
      spec.validate(candidate)
      if (controller.signal.aborted) return
      selectText()
      setText(candidate)
      setSaveError(undefined)
    } catch (error) {
      // eslint-disable-next-line local/message-in-state -- debt
      if (!controller.signal.aborted) setUrlError((error as Error).message)
    } finally {
      if (!controller.signal.aborted) setLoadingUrl(false)
      if (urlRequest.current === controller) urlRequest.current = null
    }
  }

  return (
    <PageModal
      title={words.title}
      onClose={onClose}
      fitContent={!editing}
      footer={
        <div className="ww-config-profile__actions">
          {editing ? (
            <PrimaryGradientButton
              title={copy.saveAndReload}
              isDisabled={!parsed?.value || losesTransaction || loadingUrl}
              onClick={save}
            />
          ) : (
            <PrimaryGradientButton title={copy.editJson} onClick={() => setEditing(true)} />
          )}
          {savedDraft && (
            <PrimaryGradientButton
              title={words.useLive}
              buttonStyle="secondary"
              isDisabled={losesTransaction || loadingUrl}
              onClick={reset}
            />
          )}
        </div>
      }
    >
      {summary && !editing && (
        <div className="ww-config-profile__identity">
          {summary.identity.map(([label, value]) => (
            <div key={label} className="ww-config-profile__identity-field">
              <strong>{label}</strong>
              <span>{value}</span>
            </div>
          ))}
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
          {savedDraft && <span className="ww-config-profile__badge">{copy.draftActive}</span>}
          {loading && <p>{words.loading}</p>}
          {loadError && (
            <p className="ww-config-profile__error" role="alert">
              {loadError}
            </p>
          )}
          <div className="ww-config-profile__editor-section">
            {summary && !editing && (
              <div className="ww-config-profile__summary">
                {summary.rows.map(([label, value]) => (
                  <SummaryRow key={label} label={label} value={value} />
                ))}
              </div>
            )}
            {editing && (
              <div className="ww-config-profile__json-panel">
                <label htmlFor="ww-config-profile-url">{words.urlLabel}</label>
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
                    {loadingUrl ? copy.loadingJson : copy.loadJson}
                  </button>
                </form>
                <label htmlFor="ww-config-profile-json">{words.jsonLabel}</label>
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
                {copy.backToSummary}
              </button>
            )}
          </div>
          {overridden.length > 0 && (
            <p className="ww-config-profile__note">
              {fmt(copy.overridden, { fields: overridden.join(", ") })}
            </p>
          )}
          {new URLSearchParams(location.search).has("demo") && (
            <p className="ww-config-profile__note">{words.demo}</p>
          )}
          {issues.length > 0 && (
            <div
              id="ww-config-profile-issues"
              className="ww-config-profile__issue-notice"
              role="status"
            >
              <span>
                {fmt(
                  urlError
                    ? issues.length === 1
                      ? copy.issues.loadingOne
                      : copy.issues.loadingMany
                    : issues.length === 1
                    ? copy.issues.suppliedOne
                    : copy.issues.suppliedMany,
                  { count: issues.length },
                )}
              </span>
              <button type="button" onClick={() => setShowErrors(true)}>
                {copy.showErrors}
              </button>
            </div>
          )}
          {losesTransaction && (
            <p className="ww-config-profile__error" role="alert">
              {copy.losesTransaction}
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
            label={copy.jsonErrors}
            onClose={() => setShowErrors(false)}
            className="ww-error-modal ww-config-profile__errors-modal"
          >
            <div className="ww-config-profile__errors-header">
              <span className="zkm-type-title-sm">{copy.jsonErrors}</span>
              <TopNavIconButton
                icon="x"
                ariaLabel={copy.close}
                onClick={() => setShowErrors(false)}
              />
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
