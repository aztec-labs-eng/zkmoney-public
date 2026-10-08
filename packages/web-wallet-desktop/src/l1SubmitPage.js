"use strict"

const { isLiveSubmission } = require("./l1SubmitBridge")

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

const SHARED_STYLE = `
  /* Tokens copied from @obsidion/web-ds — standalone page, kept in sync by hand. */
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
    max-width: 560px; margin: 3rem auto; padding: 0 1rem 3rem;
  }
  h1 { font-size: 1.3rem; font-weight: 600; }
  .hint { font-size: .85rem; color: var(--text-secondary); margin-top: .5rem; }
  .err { color: var(--accent-pink); }
  .ok { color: var(--accent-green); }
  table { border-collapse: collapse; width: 100%; margin: 1.5rem 0;
    background: var(--surface-card); border-radius: var(--radius-12); overflow: hidden; }
  td { padding: .55rem .75rem; border-top: 1px solid var(--border-hairline); vertical-align: top; }
  tr:first-child td { border-top: none; }
  td:first-child { font-weight: 600; white-space: nowrap; color: var(--text-secondary); }
  td:last-child { font-family: ui-monospace, monospace; font-size: .9em; word-break: break-all; }
  button {
    font: inherit; font-weight: 600; cursor: pointer;
    padding: .65rem 1.6rem; border-radius: var(--radius-full);
    background: var(--gradient-brand); border: none; color: #fff;
  }
  button:hover { filter: brightness(1.1); }
  button:disabled {
    background: linear-gradient(90deg, rgba(160, 0, 255, 0.3) 0%, rgba(0, 153, 255, 0.3) 100%), #1a1a1a;
    color: rgba(255, 255, 255, 0.5); cursor: default; filter: none;
  }
  #status { font-size: .9rem; margin-left: .75rem; }
  code {
    font-family: ui-monospace, monospace; font-size: .9em;
    background: var(--surface-card); padding: .08em .35em; border-radius: 4px;
  }
`

/** The wallet page refused the send; its reason, as one sentence. */
function refusalText(message) {
  const reason = String(message ?? "").trim()
  const end = /[.!?]$/.test(reason) ? "" : "."
  const stopped = reason ? `stopped this transfer: ${reason}${end}` : "stopped this transfer."
  return `zk.money Desktop ${stopped} Go back to zk.money Desktop to review it.`
}

/** Rendered when the id is unknown, the submission ended, or the wallet page refused it. */
function renderL1SubmitGonePage(record) {
  if (record?.state === "refused") {
    return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>zk.money Desktop — transfer stopped</title><style>${SHARED_STYLE}</style></head>
<body>
<h1>This transfer was stopped</h1>
<p class="hint">${escapeHtml(refusalText(record.message))}</p>
</body></html>
`
  }
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>zk.money Desktop — request expired</title><style>${SHARED_STYLE}</style></head>
<body>
<h1>This request has expired</h1>
<p class="hint">Go back to zk.money Desktop and start the deposit again — it will open a fresh copy of this page.</p>
</body></html>
`
}

/**
 * The page opened in the user's NORMAL browser (where their EVM wallet extension
 * lives) to submit a transaction the desktop wallet prepared. The page displays
 * the prepared summary and hands the transaction to the injected wallet — the
 * wallet's own confirmation UI is the actual review step.
 */
function renderL1SubmitPage(id, record) {
  if (!isLiveSubmission(record)) return renderL1SubmitGonePage(record)
  const rows = record.display.lines
    .map(([label, value]) => `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(value)}</td></tr>`)
    .join("\n")

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>zk.money Desktop — ${escapeHtml(record.display.title)}</title>
<style>${SHARED_STYLE}</style>
</head>
<body>
<h1>${escapeHtml(record.display.title)}</h1>
<p class="hint">zk.money Desktop opened this page in your regular browser so you can pay with the
Ethereum wallet installed here. When your wallet asks you to confirm, check before approving: the
request should come from this page's address (<code id="page-origin">127.0.0.1</code>, as shown in
your address bar), and what you're signing should match the details below.</p>
${
  record.recheck
    ? `<p class="hint">Before your wallet opens, zk.money Desktop checks this transfer again. Keep
zk.money Desktop open until you have approved it.</p>`
    : ""
}
<table>
${rows}
</table>
<div>
  <button id="send">Open wallet &amp; send</button>
  <span id="status"></span>
</div>
<p class="hint" id="no-wallet" hidden>No EVM wallet found in this browser. Open this page in the
browser where your wallet extension is installed.</p>

<script>
const tx = ${JSON.stringify(record.tx).replaceAll("<", "\\u003c")}
${refusalText.toString()}
const recheck = ${record.recheck ? "true" : "false"}
const CHECK_TIMEOUT_MS = 20000
// Set once the request can no longer be sent from this page.
let ended = false
const statusEl = document.getElementById("status")
const button = document.getElementById("send")
// The exact origin string the wallet's confirmation shows (host:port).
document.getElementById("page-origin").textContent = location.host
if (!window.ethereum) {
  button.disabled = true
  document.getElementById("no-wallet").hidden = false
}
const post = (path, body) =>
  fetch("/submit/${id}/" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
// Asks zk.money Desktop to approve this send, waits for its answer, then claims the
// approval so no other tab can open a second wallet prompt. Only an approval this
// attempt asked for lets the page open the wallet; no answer means no send.
async function approval(attempt) {
  const gone = "This request has ended. Go back to zk.money Desktop and start again."
  const response = await post("check", { attempt })
  if (!response.ok) {
    const { error: reason } = await response.json().catch(() => ({}))
    if (reason === "A send is already open in a wallet") {
      throw new Error("This transfer is already open in a wallet. Finish or cancel it there.")
    }
    ended = true
    throw new Error(gone)
  }
  const { check } = await response.json()
  const deadline = Date.now() + CHECK_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const stateResponse = await fetch("/submit/${id}/state")
    const state = stateResponse.ok ? await stateResponse.json() : undefined
    if (!state || !["checking", "authorized", "sending", "refused"].includes(state.state)) {
      ended = true
      throw new Error(gone)
    }
    if (state.check !== check) throw new Error("Another check started for this request. Try again.")
    if (state.state === "authorized") {
      if ((await post("claim", { attempt, check })).ok) return
      throw new Error("Another check started for this request. Try again.")
    }
    if (state.state === "refused") {
      ended = true
      throw new Error(refusalText(state.message))
    }
  }
  throw new Error(
    "zk.money Desktop didn't confirm this transfer. " +
      "Make sure zk.money Desktop is open, then try again.",
  )
}
async function report(body) {
  await post("status", body)
}
// A declined send whose release never reached zk.money Desktop; sent once more before the next check.
// Any answer counts as delivered: a refusal means that attempt already holds nothing.
let unreleased
async function release(attempt) {
  const delivered = await post("release", { attempt }).then(() => true, () => false)
  unreleased = delivered ? undefined : attempt
}
const randomAttempt = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("")
button.addEventListener("click", async () => {
  button.disabled = true
  statusEl.textContent = ""
  statusEl.className = ""
  // One attempt per click; set once this page holds the submission's send.
  const attempt = randomAttempt()
  let claimed = false
  try {
    const chainHex = "0x" + tx.chainId.toString(16)
    const [from] = await window.ethereum.request({ method: "eth_requestAccounts" })
    if ((await window.ethereum.request({ method: "eth_chainId" })) !== chainHex) {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: chainHex }],
      })
    }
    const call = { from, to: tx.to, data: tx.data, ...(tx.value ? { value: tx.value } : {}) }
    // Estimate before sending: a transfer that would revert (e.g. the account
    // doesn't hold the token) fails HERE with a real reason. Without this,
    // MetaMask substitutes a huge fallback gas limit and the network rejects it
    // with a confusing "gas limit too high" cap error. Passing the estimate
    // also stops the wallet from ever using that fallback.
    let gas
    try {
      gas = await window.ethereum.request({ method: "eth_estimateGas", params: [call] })
    } catch (estimateError) {
      throw new Error(
        "This transfer would fail — check that the selected account holds the token being sent (and some ETH for gas). Wallet said: " +
          String((estimateError && estimateError.message) || estimateError),
      )
    }
    if (recheck) {
      statusEl.textContent = "Checking with zk.money Desktop…"
      if (unreleased) await release(unreleased)
      await approval(attempt)
      claimed = true
      statusEl.textContent = ""
    }
    const txHash = await window.ethereum.request({
      method: "eth_sendTransaction",
      params: [{ ...call, gas }],
    })
    await report({ state: "submitted", txHash, ...(recheck ? { attempt } : {}) })
    document.body.innerHTML =
      '<h1>Sent ✓</h1><p class="hint">You can close this tab. ' +
      "zk.money Desktop shows the progress of this transaction.</p>"
  } catch (error) {
    // Most failures here are retryable from the page (declined prompt, locked
    // wallet, refused chain switch, no answer to the check) — display it and let
    // the user try again. A refused or ended request stays disabled. Only a
    // successful submission is ever reported back.
    const declined = error && error.code === 4001
    if (claimed && declined) {
      // Declined in the wallet: nothing was sent, so the claim is released for a retry.
      await release(attempt)
    } else if (claimed) {
      // Any other wallet error cannot prove nothing was sent; the claim stays held.
      ended = true
      error = new Error(
        "Your wallet returned an error, so this transfer may or may not have been sent. " +
          "Go back to zk.money Desktop.",
      )
    }
    if (declined) {
      statusEl.textContent = "Cancelled in wallet"
    } else {
      statusEl.textContent = String((error && error.message) || error)
      statusEl.className = "err"
    }
    button.disabled = ended
  }
})
</script>
</body>
</html>
`
}

module.exports = { renderL1SubmitPage, renderL1SubmitGonePage }
