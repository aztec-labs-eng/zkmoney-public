"use strict"
// With the Chrome installed on this machine: what a page stores just before the settings page's
// relaunch (Browser.close over the DevTools pipe, then a new start on the same profile) must be there
// after it. Also prints navigator.webdriver under the pipe. Opens two short-lived Chrome windows.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const http = require("node:http")
const os = require("node:os")
const path = require("node:path")
const { once } = require("node:events")
const { closeChrome, findChrome, launchChrome, waitForDevtools } = require("../src/chrome")

const TIMEOUT_MS = 30_000

// Stores `?write=`, then reports what storage holds.
const PAGE = `<!doctype html><script>
const write = new URLSearchParams(location.search).get("write")
if (write) localStorage.setItem("relaunch-check", write)
fetch("/report?" + new URLSearchParams({
  value: localStorage.getItem("relaunch-check") ?? "",
  webdriver: String(navigator.webdriver),
}))
</script>`

function within(promise, what) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), TIMEOUT_MS)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function main() {
  const chromePath = findChrome()
  if (!chromePath) throw new Error("No Chrome found; set CHROME_PATH.")
  let onReport = () => {}
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1")
    if (url.pathname === "/report") onReport(Object.fromEntries(url.searchParams))
    response.setHeader("Content-Type", "text/html")
    response.end(url.pathname === "/report" ? "" : PAGE)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const origin = `http://127.0.0.1:${server.address().port}`
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-relaunch-check-"))

  // The wallet's own flags, less the ones that map its hostname onto the local HTTPS server.
  const start = async (query) => {
    const report = new Promise((resolve) => (onReport = resolve))
    const chrome = launchChrome(chromePath, [
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-mode",
      "--test-type",
      "--remote-debugging-pipe",
      `--app=${origin}/${query}`,
    ])
    await within(waitForDevtools(chrome), "Chrome's DevTools answer")
    return { chrome, report: await within(report, "the page") }
  }
  const close = async (chrome) => {
    const exited = once(chrome, "exit")
    await closeChrome(chrome)
    await within(exited, "Chrome to exit")
  }

  try {
    const value = String(Date.now())
    const first = await start(`?write=${value}`)
    assert.equal(first.report.value, value)
    await close(first.chrome)
    const second = await start("")
    await close(second.chrome)
    assert.equal(second.report.value, value, "the stored value did not survive the relaunch")
    console.log(`The stored value survived the relaunch (${chromePath}).`)
    console.log(`navigator.webdriver under the DevTools pipe: ${second.report.webdriver}`)
  } finally {
    server.close()
    fs.rmSync(profile, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
