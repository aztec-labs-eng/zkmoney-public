import { useEffect, useState, type ReactNode } from "react"
import { PrimaryGradientButton } from "@obsidion/web-ds"
import type { Network } from "@obsidion/core/constants"
import { tryNormalizeEndpoint } from "../config/endpointOverrides"
import { assertHostProfileUrl, parseNetwork } from "../config/profilePolicy"
import { EndpointFields, useEndpointEditor } from "../ui/endpointsEditor"
import {
  readDesktopSettingsState,
  type ConfigKey,
  type ConfigValues,
  type DesktopSettingsState,
} from "./state"

const ENV_NAMES: Record<ConfigKey, string> = {
  configProfileUrl: "OBSIDION_CONFIG_PROFILE_URL",
  bootFromBakedProfile: "OBSIDION_BOOT_FROM_BAKED_PROFILE",
}
const NOT_HTTP = "Enter a full http(s) URL."
const WRONG_SHAPE =
  "Enter a profile address of the form https://<host>/profiles/<generation>/<current or x.y.z>.json."

// The launcher answers on loopback; a request still open after this counts as unanswered.
const REQUEST_TIMEOUT_MS = 15_000

type Status = { tone: "error" | "info"; text: string }
type Answer = { ok: true; status?: string } | { ok: false; error: string } | "no-answer"

function formatDate(value: string | undefined): string | undefined {
  if (!value) return undefined
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

/** Why the launcher or the wallet would refuse this URL; undefined when neither would. */
function profileUrlError(url: string, shipped: boolean, network: Network): string | undefined {
  if (url === "") return undefined
  if (tryNormalizeEndpoint(url) === undefined) return NOT_HTTP
  // The switch starts the wallet without fetching, so the URL goes unused.
  if (shipped) return undefined
  try {
    assertHostProfileUrl(url, network)
  } catch {
    return WRONG_SHAPE
  }
  return undefined
}

function EnvWarning({ name }: { name: string }) {
  return (
    <p className="ww-dsettings__hint ww-dsettings__hint--err">
      The <code>{name}</code> environment variable is set and overrides whatever is saved here.
    </p>
  )
}

function Banner({ info, children }: { info?: boolean; children: ReactNode }) {
  return (
    <div
      className={info ? "ww-dsettings__banner ww-dsettings__banner--info" : "ww-dsettings__banner"}
    >
      {children}
    </div>
  )
}

function banners(state: DesktopSettingsState, shippedOn: boolean): ReactNode[] {
  const out: ReactNode[] = []
  for (const [i, problem] of state.problems.entries()) {
    out.push(
      <Banner key={`problem-${i}`}>
        {problem.key === null ? (
          <>
            The saved settings could not be read ({problem.message}). Saving this page replaces
            them.
          </>
        ) : problem.source === "env" ? (
          <>
            The <code>{ENV_NAMES[problem.key]}</code> environment variable holds an invalid value
            and was ignored: {problem.message}.
          </>
        ) : (
          <>
            A saved setting is invalid and was ignored: {problem.message}. Saving this page replaces
            it.
          </>
        )}
      </Banner>,
    )
  }
  const probe = state.profileProbe
  if (!probe) return out
  // Names whatever served the configuration, so the copy stays true under an override.
  const source = probe.overridden
    ? "The configuration URL you set"
    : "zk.money's configuration service"
  const shipped = <strong>Shipped configuration</strong>
  if (probe.state === "rejected" && shippedOn) {
    out.push(
      <Banner info key="probe">
        {source} did not provide a usable configuration when the app started ({probe.detail}). It is
        being ignored while {shipped} is on, and the wallet is running on the shipped copy.
      </Banner>,
    )
  } else if (probe.state === "rejected" && probe.overridden) {
    out.push(
      <Banner key="probe">
        {source} did not provide a usable configuration when the app started ({probe.detail}), so
        the wallet cannot start. Correct or clear the URL below and relaunch.
      </Banner>,
    )
  } else if (probe.state === "rejected") {
    out.push(
      <Banner key="probe">
        {source} did not provide a usable configuration when the app started ({probe.detail}), so
        the wallet cannot start. First check for a newer release of zk.money Desktop: this is what
        an out-of-date app sees once zk.money has moved on. If there is none because zk.money has
        shut down, turn on {shipped} below and relaunch.
      </Banner>,
    )
  } else if (probe.state === "unreachable" && !state.profile.baked) {
    out.push(
      <Banner key="probe">
        {source} could not be reached when the app started ({probe.detail}), and this build carries
        no shipped configuration to fall back on. The wallet cannot start until it answers.
      </Banner>,
    )
  } else if (probe.state === "unreachable" && probe.bakedExpired && !shippedOn) {
    out.push(
      <Banner key="probe">
        {source} could not be reached when the app started ({probe.detail}), and the shipped copy
        has expired, so the wallet cannot start on its own. Check for a newer release of zk.money
        Desktop.
      </Banner>,
    )
  } else if (probe.state === "ok" && shippedOn) {
    out.push(
      <Banner info key="probe">
        {source} answered normally when the app started. Turn {shipped} off and relaunch to go back
        to it.
      </Banner>,
    )
  }
  return out
}

/**
 * The desktop launcher's settings page: the wallet's endpoint editor above the configuration
 * setting the launcher keeps. It runs without a booted wallet, so it opens when the wallet cannot
 * start. Saving posts the configuration first (the step that can fail on the far side), then
 * writes the endpoint record, then asks for the relaunch; each step that succeeds is not repeated.
 */
export function DesktopSettingsScreen({
  state = readDesktopSettingsState(),
  network = parseNetwork(import.meta.env.VITE_NETWORK),
}: {
  state?: DesktopSettingsState | null
  network?: Network
}) {
  if (!state) {
    return (
      <main className="ww-dsettings">
        <h1>zk.money Desktop — endpoint settings</h1>
        <p data-testid="dsettings-missing">
          Open this page from the zk.money Desktop menu: Endpoint Settings….
        </p>
      </main>
    )
  }
  return <SettingsForm state={state} network={network} />
}

function SettingsForm({ state, network }: { state: DesktopSettingsState; network: Network }) {
  const [status, setStatus] = useState<Status>()
  const editor = useEndpointEditor({ onEdit: () => setStatus(undefined) })
  const [url, setUrl] = useState(state.values.configProfileUrl ?? "")
  const [shipped, setShipped] = useState(state.values.bootFromBakedProfile === true)
  const [saved, setSaved] = useState({ url, shipped })
  // Saving rewrites a settings file the launcher could not use, as its banner promises.
  const [repair, setRepair] = useState(state.problems.some((p) => p.source !== "env"))
  const [busy, setBusy] = useState(false)
  const [relaunching, setRelaunching] = useState(false)
  // A reset saves the defaults even where the fields already showed them: another window may have
  // saved since this one opened.
  const [resetAsked, setResetAsked] = useState(false)

  const typedUrl = url.trim()
  // A URL is checked once this page would put it to use: typed here, or brought back by turning the
  // switch off. One the launcher already runs on (an environment value among them) is its to report.
  const urlActivated = typedUrl !== saved.url || (saved.shipped && !shipped)
  const urlError = urlActivated ? profileUrlError(typedUrl, shipped, network) : undefined
  const configChanged = repair || resetAsked || typedUrl !== saved.url || shipped !== saved.shipped
  const baked = state.profile.baked
  const canSave = editor.valid && urlError === undefined && !busy && !relaunching

  // Closing the page mid-save would leave it half done with nobody told.
  useEffect(() => {
    if (!busy) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [busy])

  const post = async (path: string, body: Partial<ConfigValues>): Promise<Answer> => {
    let response: Response
    try {
      response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: state.token, ...body }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch {
      return "no-answer"
    }
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string
      status?: string
    }
    if (!response.ok) return { ok: false, error: payload.error ?? response.statusText }
    return { ok: true, status: payload.status }
  }

  const save = async () => {
    if (!canSave) return
    setBusy(true)
    setStatus(undefined)
    const fail = (text: string) => {
      setStatus({ tone: "error", text })
      setBusy(false)
    }
    let configPosted = false
    if (configChanged) {
      const answer = await post("/desktop-settings/save", {
        configProfileUrl: typedUrl,
        bootFromBakedProfile: shipped,
      })
      if (answer === "no-answer") {
        return fail(
          "The configuration may not have been saved and the endpoints were not. Reopen this page to check.",
        )
      }
      if (!answer.ok) return fail(answer.error)
      setSaved({ url: typedUrl, shipped })
      setRepair(false)
      setResetAsked(false)
      configPosted = true
    }
    const committed = editor.commit()
    if (!committed.ok) {
      const lead = configPosted ? "The configuration was saved, but the endpoints" : "The endpoints"
      if (committed.reason === "changed") {
        return fail(
          `${lead} were not: another window changed them. Reopen this page to review them.`,
        )
      }
      if (committed.reason === "storage") {
        return fail(`${lead} could not be confirmed saved. Reopen this page to check them.`)
      }
      return fail(committed.message)
    }
    const relaunch = await post("/desktop-settings/relaunch", {})
    if (relaunch === "no-answer" || !relaunch.ok) {
      return fail(
        "Your settings are saved, but the relaunch may not have started. Press the button again, or restart zk.money Desktop.",
      )
    }
    setRelaunching(true)
    setBusy(false)
    setStatus({
      tone: "info",
      text:
        relaunch.status === "already-relaunching"
          ? "Your settings are saved. The wallet is already relaunching; restart zk.money Desktop if nothing happens."
          : "Relaunching… This window closes with the wallet. Restart zk.money Desktop if nothing happens.",
    })
  }

  // Clears the fields only; nothing is stored until Save & relaunch.
  const reset = () => {
    editor.edit({ node: "", nodeApiKey: "", l1Rpc: "", enclave: "" })
    setUrl("")
    setShipped(false)
    setResetAsked(true)
  }

  return (
    <main className="ww-dsettings">
      <h1>zk.money Desktop — endpoint settings</h1>
      {banners(state, saved.shipped)}
      <p>
        Settings apply to this computer only and survive app updates. Leave a field blank to use the
        value built into the app.
      </p>

      <EndpointFields editor={editor} disabled={busy || relaunching} />

      <h2>Contract configuration</h2>
      <p className="ww-dsettings__hint">
        The configuration is the list of contracts the wallet sends funds to. The app fetches it
        from zk.money each time it starts, unless it's overridden by the settings below.
      </p>
      <div className="ww-dsettings__tablewrap">
        <table className="ww-dsettings__table">
          <tbody>
            <tr>
              <td>Bundle built</td>
              <td>{formatDate(state.builtAt) ?? "unknown"}</td>
            </tr>
            <tr>
              <td>Shipped configuration</td>
              <td>
                {baked
                  ? `version ${baked.current}, published ${formatDate(baked.publishedAt)}` +
                    (baked.expiresAt ? `, expires ${formatDate(baked.expiresAt)}` : "")
                  : "none in this build"}
              </td>
            </tr>
            <tr>
              <td>Configuration in use</td>
              <td>
                {saved.shipped ? (
                  "shipped configuration"
                ) : (
                  <>
                    <code>{state.profile.url ?? ""}</code>
                    {state.profile.overridden ? " (your override)" : ""}
                  </>
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="ww-endpoints__field">
        <label htmlFor="config-profile-url">Configuration URL</label>
        <input
          id="config-profile-url"
          type="url"
          className="ww-endpoints__input"
          placeholder={
            !state.profile.overridden && state.profile.url
              ? `${state.profile.url} (default)`
              : "Leave blank to use zk.money's own address"
          }
          value={url}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          disabled={busy || relaunching}
          aria-invalid={urlError !== undefined}
          onChange={(e) => {
            setUrl(e.target.value)
            setStatus(undefined)
          }}
        />
        {urlError && (
          <p className="ww-endpoints__error" role="alert">
            {urlError}
          </p>
        )}
        <p className="ww-dsettings__hint">
          Where the app fetches that list, of the form
          https://&lt;host&gt;/profiles/&lt;generation&gt;/current.json. Leave it blank to use
          zk.money's. Set a URL here only once zk.money's own is gone for good and someone you trust
          publishes a replacement.
        </p>
        <div className="ww-dsettings__danger" data-testid="dsettings-fund-warning">
          <strong>Only use a URL you are sure of.</strong> The document at that URL decides which
          contracts the wallet sends funds to, so one written by an attacker points the wallet at
          contracts the attacker controls, and funds sent to them are gone.
          <br />
          <br />
          Never use a URL a stranger sent you, and treat a message saying the wallet is broken and
          offering a URL as an attack. If zk.money is simply down, you do not need this field: the
          app falls back to its shipped copy on its own.
        </div>
        {state.sources.configProfileUrl === "env" && (
          <EnvWarning name={ENV_NAMES.configProfileUrl} />
        )}
        {shipped && typedUrl && (
          <p className="ww-dsettings__hint">
            Ignored while <strong>Shipped configuration</strong> is on, because that setting starts
            the wallet without fetching anything.
          </p>
        )}
      </div>

      <h3>Shipped configuration</h3>
      <p className="ww-dsettings__hint">
        Every release carries a copy of zk.money's configuration as it was when that release was
        built. The app falls back to that copy on its own whenever zk.money cannot be reached.
      </p>
      <label className="ww-dsettings__switch">
        <input
          type="checkbox"
          checked={shipped}
          disabled={!baked || busy || relaunching}
          onChange={(e) => {
            setShipped(e.target.checked)
            setStatus(undefined)
          }}
        />
        Use the shipped copy, whatever the live service says
      </label>
      <p className="ww-dsettings__hint ww-dsettings__hint--warn">
        You only need this when zk.money no longer serves its configuration. The app opens this page
        and says so when that happens.
        <br />
        If a newer release of zk.money Desktop exists, install it instead: zk.money has moved to new
        contracts and this app is out of date.
        <br />
        On the shipped copy the wallet uses the contracts from{" "}
        {formatDate(baked?.publishedAt) ?? "the release date"}. If zk.money has moved since,
        transactions may fail, deposits can land in a retired portal, and if those contracts were
        retired for a fault your funds could be exposed. Confirm through a source you trust before
        sending funds.
      </p>
      {state.sources.bootFromBakedProfile === "env" && (
        <EnvWarning name={ENV_NAMES.bootFromBakedProfile} />
      )}

      <div className="ww-dsettings__actions">
        <button
          type="button"
          className="zkm-btn-reset ww-dsettings__reset"
          disabled={busy || relaunching}
          onClick={reset}
        >
          Reset all to defaults
        </button>
        <p className="ww-dsettings__hint">
          Reset only clears the fields. Nothing changes until you save and relaunch.
        </p>
        <PrimaryGradientButton
          title="Save & relaunch wallet"
          isLoading={busy}
          isDisabled={!canSave}
          onClick={() => void save()}
        />
        {status && (
          <p
            className={
              status.tone === "error"
                ? "ww-dsettings__status ww-dsettings__status--err"
                : "ww-dsettings__status"
            }
            role={status.tone === "error" ? "alert" : "status"}
            data-testid="dsettings-status"
          >
            {status.text}
          </p>
        )}
      </div>
    </main>
  )
}
