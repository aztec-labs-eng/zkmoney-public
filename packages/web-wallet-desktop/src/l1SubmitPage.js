"use strict"

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

/** Rendered when the id is unknown or the submission expired/superseded. */
function renderL1SubmitGonePage() {
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
  if (!record || record.state !== "pending") return renderL1SubmitGonePage()
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
const statusEl = document.getElementById("status")
const button = document.getElementById("send")
// The exact origin string the wallet's confirmation shows (host:port).
document.getElementById("page-origin").textContent = location.host
if (!window.ethereum) {
  button.disabled = true
  document.getElementById("no-wallet").hidden = false
}
async function report(body) {
  await fetch("/submit/${id}/status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}
button.addEventListener("click", async () => {
  button.disabled = true
  statusEl.textContent = ""
  statusEl.className = ""
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
    const txHash = await window.ethereum.request({
      method: "eth_sendTransaction",
      params: [{ ...call, gas }],
    })
    await report({ state: "submitted", txHash })
    document.body.innerHTML =
      '<h1>Sent ✓</h1><p class="hint">You can close this tab. Your funds will arrive in zk.money Desktop shortly.</p>'
  } catch (error) {
    // Every failure here is retryable from the page (declined prompt, locked
    // wallet, refused chain switch) — display it and let the user try again;
    // only a successful submission is ever reported back.
    if (error && error.code === 4001) {
      statusEl.textContent = "Cancelled in wallet"
    } else {
      statusEl.textContent = String((error && error.message) || error)
      statusEl.className = "err"
    }
    button.disabled = false
  }
})
</script>
</body>
</html>
`
}

module.exports = { renderL1SubmitPage, renderL1SubmitGonePage }
