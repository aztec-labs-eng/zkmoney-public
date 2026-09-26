"use strict"

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

// One entry per user-overridable endpoint (mirrors ENDPOINT_KEYS in config.js).
const FIELDS = Object.freeze([
  {
    key: "l1RpcUrl",
    label: "L1 RPC URL",
    hint: "Any Ethereum RPC for the wallet's chain works (public endpoint or your own provider key).",
    envName: "OBSIDION_L1_RPC_URL",
  },
  {
    key: "nodeUrl",
    label: "Aztec node URL",
    hint: "Any Aztec node serving the wallet's rollup.",
    envName: "OBSIDION_NODE_URL",
  },
  {
    key: "enclaveUrl",
    label: "Enclave URL",
    hint: "Address of the oxide enclave service that co-signs wallet transactions.",
    envName: "OBSIDION_ENCLAVE_TARGET",
  },
])

/**
 * The endpoint-settings page served at /desktop-settings. Pure HTML string —
 * shipped by the desktop package, independent of the wallet bundle, so it stays
 * reachable when the wallet itself cannot boot. The one-time token gates the
 * mutation endpoints (wallet-origin scripts must not be able to rewrite endpoints).
 */
function renderSettingsPage({ token, endpoints, sources, build, probeFailure, defaults = {} }) {
  const fieldsHtml = FIELDS.map((field) => {
    const value = endpoints[field.key] ?? ""
    const placeholder = defaults[field.key]
      ? `${defaults[field.key]} (default)`
      : "https://… (empty = default)"
    // The env var outranks anything saved here — without a warning, a save that
    // silently doesn't take effect is undebuggable.
    const envWarning =
      sources[field.key] === "env"
        ? `<div class="hint err">The <code>${field.envName}</code> environment variable is set and overrides whatever is saved here.</div>`
        : ""
    return `
<label for="${field.key}">${escapeHtml(field.label)}</label>
<div class="hint">${field.hint}</div>
<input type="url" id="${field.key}" data-endpoint placeholder="${escapeHtml(
      placeholder,
    )}" value="${escapeHtml(value)}">
${envWarning}`
  }).join("\n")

  let builtLine = "unknown"
  if (build?.builtAt) {
    const parsed = new Date(build.builtAt)
    builtLine = Number.isNaN(parsed.getTime())
      ? build.builtAt
      : parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
  }

  const banner = probeFailure
    ? `<div class="banner">The L1 RPC endpoint from ${escapeHtml(
        probeFailure.source,
      )} — <code>${escapeHtml(
        probeFailure.url,
      )}</code> — did not respond at startup. Set a working endpoint below (or clear the field to return to the default), then relaunch the wallet.</div>`
    : ""

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<title>zk.money Desktop — endpoint settings</title>
<style>
  /* Tokens copied from @obsidion/web-ds (design-system/src/styles/styles.css) —
     this page is standalone HTML served by the launcher and can't import the
     package, so keep the values in sync by hand. Dark-only, like the DS. */
  @font-face {
    /* Mirrors design-system/fonts/fonts.css; the launcher serves the same TTF. */
    font-family: "Sen";
    src: url("/desktop-assets/Sen-VariableFont.ttf") format("truetype-variations");
    font-weight: 400 800;
    font-style: normal;
    font-display: swap;
  }
  :root {
    color-scheme: dark;
    --surface-canvas: #181818;
    --surface-card: rgba(255, 255, 255, 0.05);
    --surface-faint: rgba(255, 255, 255, 0.03);
    --surface-pink: rgba(230, 101, 126, 0.1);
    --text-primary: #fdfdfd;
    --text-secondary: #bfc2d7;
    --accent-green: #56e79d;
    --accent-pink: #fe708b;
    --border-hairline: rgba(255, 255, 255, 0.08);
    --gradient-brand: linear-gradient(90deg, #a000ff 0%, #0099ff 100%);
    --radius-12: 12px;
    --radius-full: 9999px;
    --font-body: "Sen", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  body {
    font: 15px/1.5 var(--font-body);
    background: var(--surface-canvas);
    color: var(--text-primary);
    max-width: 640px; margin: 3rem auto; padding: 0 1rem 3rem;
  }
  h1 { font-size: 1.3rem; font-weight: 600; }
  .banner {
    background: var(--surface-pink); color: var(--accent-pink);
    border: 1px solid var(--accent-pink);
    padding: .75rem 1rem; border-radius: var(--radius-12); margin-bottom: 1.5rem;
  }
  label { display: block; font-weight: 600; margin: 1.5rem 0 .15rem; }
  input[type=url] {
    width: 100%; box-sizing: border-box;
    padding: .6rem .75rem; font: inherit;
    background: var(--surface-faint); color: var(--text-primary);
    border: 1px solid var(--border-hairline); border-radius: var(--radius-12);
  }
  input[type=url]:focus { outline: none; border-color: #ad33ff; }
  input[type=url]::placeholder { color: var(--text-secondary); opacity: .55; }
  .hint { font-size: .85rem; color: var(--text-secondary); margin-bottom: .35rem; }
  .hint.err { color: var(--accent-pink); }
  .row { margin-top: 1.75rem; display: flex; gap: .75rem; align-items: center; flex-wrap: wrap; }
  .row + .row { margin-top: .5rem; }
  button {
    font: inherit; font-weight: 600; cursor: pointer;
    padding: .55rem 1.4rem; border-radius: var(--radius-full);
    background: var(--surface-faint); color: var(--text-primary);
    border: 1px solid var(--border-hairline);
  }
  button:hover { background: var(--surface-card); }
  button.primary { background: var(--gradient-brand); border: none; color: #fff; }
  button.primary:hover { filter: brightness(1.1); }
  button.primary:disabled {
    /* DS disabled recipe (.zkm-primary-btn--disabled): brand gradient at 30% over #1a1a1a */
    background: linear-gradient(90deg, rgba(160, 0, 255, 0.3) 0%, rgba(0, 153, 255, 0.3) 100%), #1a1a1a;
    color: rgba(255, 255, 255, 0.5);
    cursor: default; filter: none;
  }
  button.text { background: none; border: none; color: var(--text-secondary); font-weight: 400; padding: .55rem .5rem; }
  button.text:hover { color: var(--text-primary); text-decoration: underline; background: none; }
  #status { font-size: .9rem; }
  .ok { color: var(--accent-green); } .err { color: var(--accent-pink); }
  table { border-collapse: collapse; margin-top: 2.5rem; font-size: .85rem; width: 100%; }
  td { padding: .4rem .5rem; border-top: 1px solid var(--border-hairline); vertical-align: top; }
  td:first-child { font-weight: 600; white-space: nowrap; }
  code {
    word-break: break-all; font-size: .9em;
    background: var(--surface-card); padding: .08em .35em; border-radius: 4px;
  }
</style>
</head>
<body>
<h1>zk.money Desktop — endpoint settings</h1>
${banner}
<p>Overrides apply to this computer only and survive app updates. Leave a field empty to use the value built into the app.</p>
${fieldsHtml}

<div class="row">
  <button id="reset" class="text">Reset all to defaults</button>
</div>
<div class="row">
  <button id="relaunch" class="primary">Save &amp; relaunch wallet</button>
  <span id="status"></span>
</div>

<table>
  <tr><td>Bundle built</td><td>${escapeHtml(builtLine)}</td></tr>
</table>

<script>
const token = ${JSON.stringify(token)}
const statusEl = document.getElementById("status")
const inputs = () => Array.from(document.querySelectorAll("input[data-endpoint]"))
async function post(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, ...body }),
  })
  if (!response.ok) throw new Error((await response.text()) || response.statusText)
  return response
}
// Clears the fields only — nothing is stored until Save & relaunch.
document.getElementById("reset").addEventListener("click", () => {
  inputs().forEach((input) => { input.value = "" })
  statusEl.textContent = ""
  statusEl.className = ""
})
// The relaunch kills every window of the wallet's Chrome — this page included —
// so there is no success state to render: disable the button and only come back
// (re-enabled, with the error shown) if saving or relaunching fails.
document.getElementById("relaunch").addEventListener("click", async (event) => {
  const button = event.currentTarget
  button.disabled = true
  statusEl.textContent = ""
  statusEl.className = ""
  try {
    const values = Object.fromEntries(inputs().map((input) => [input.id, input.value]))
    await post("/desktop-settings/save", values)
    await post("/desktop-settings/relaunch", {})
  } catch (error) {
    statusEl.textContent = String(error.message || error)
    statusEl.className = "err"
    button.disabled = false
  }
})
</script>
</body>
</html>
`
}

module.exports = { renderSettingsPage }
