import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import path from "node:path"
import { startCaptureServer, walletDir } from "../../scripts/ui-capture/server.mjs"
import {
  installCaptureGuard,
  loadChromium,
  localBaseUrl,
} from "../../scripts/ui-capture/capture-support.mjs"
import { ROLLUP_VERSION } from "../../scripts/ui-capture/profile-fixture.mjs"

// Real Web Locks, OPFS and reloads in Chromium: two pages of one browser context are two tabs of
// one origin. The fake node answers only the node info the gate reads; the wallet mounting behind
// the gate is the signal that this tab opened its databases.
const NODE_ORIGIN = "http://node.ui-capture.invalid"
const ADDRESS_KEYS = [
  "rollupAddress",
  "registryAddress",
  "inboxAddress",
  "outboxAddress",
  "feeJuiceAddress",
  "feeJuicePortalAddress",
  "coinIssuerAddress",
  "rewardDistributorAddress",
  "governanceProposerAddress",
  "governanceAddress",
  "stakingAssetAddress",
]
const addresses = Object.fromEntries(
  ADDRESS_KEYS.map((key, i) => [key, `0x${(i + 1).toString(16).padStart(40, "0")}`]),
)
const protocolAddress = (n) => `0x${n.toString(16).padStart(64, "0")}`
const nodeInfo = {
  nodeVersion: "ui-capture",
  l1ChainId: 31337,
  // The gate checks the node against the capture profile's rollup.
  rollupVersion: Number(ROLLUP_VERSION),
  l1ContractAddresses: addresses,
  protocolContractAddresses: {
    classRegistry: protocolAddress(1),
    feeJuice: protocolAddress(2),
    instanceRegistry: protocolAddress(3),
    multiCallEntrypoint: protocolAddress(4),
  },
  realProofs: false,
  txsLimits: { gas: { daGas: 1, l2Gas: 1 } },
}
const INACTIVE = "zk.money is open in another tab"
const USE_THIS_TAB = "Use this tab"
const ACTIVE_TAB_LOCK = "webwallet.active-tab"
const TIMEOUT = 60_000

let server, browser, base
const report = {}
const repo = path.resolve(walletDir, "../..")

before(
  async () => {
    const chromium = loadChromium(repo, process.env.PLAYWRIGHT_BROWSERS_PATH)
    const started = await startCaptureServer(Number(process.env.ACTIVE_TAB_PORT ?? 5496))
    server = started.server
    base = localBaseUrl(started.origin)
    browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] })
  },
  { timeout: 120_000 },
)

after(async () => {
  try {
    await browser?.close()
  } finally {
    await server?.close()
  }
})

async function answerNode(context) {
  // Registered after the capture guard, so it answers the node origin the guard would block.
  await context.route(`${NODE_ORIGIN}/**`, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}")
    const reply = (call) =>
      call.method.endsWith("_getNodeInfo")
        ? { jsonrpc: "2.0", id: call.id, result: nodeInfo }
        : {
            jsonrpc: "2.0",
            id: call.id,
            error: { code: -32601, message: `${call.method} is not served here` },
          }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(Array.isArray(body) ? body.map(reply) : reply(body)),
    })
  })
}

/** The locks this page holds, found through a probe lock that reveals the page's client id. */
function heldLocks(page) {
  return page.evaluate(async () => {
    const probe = `probe-${crypto.randomUUID()}`
    let client
    await navigator.locks.request(probe, async () => {
      client = (await navigator.locks.query()).held.find((lock) => lock.name === probe).clientId
    })
    return (await navigator.locks.query()).held
      .filter((lock) => lock.clientId === client)
      .map((lock) => lock.name)
  })
}

/** What a failed wait saw, so the failure says why. */
async function diagnose(page, error) {
  const text = await page
    .locator("body")
    .innerText()
    .catch(() => "(no body)")
  const problems = [...(report.pageErrors ?? []), ...(report.consoleErrors ?? [])].slice(-10)
  throw new Error(`${error.message}\npage: ${text.slice(0, 500)}\nerrors: ${problems.join("\n")}`)
}

async function expectActive(page) {
  await page
    .locator(".zkm-root")
    .first()
    .waitFor({ state: "attached", timeout: TIMEOUT })
    .catch((error) => diagnose(page, error))
  const held = await heldLocks(page)
  assert.ok(held.includes(ACTIVE_TAB_LOCK), `active-tab lock held: ${held}`)
}

async function expectInactive(page) {
  await page
    .getByText(INACTIVE)
    .first()
    .waitFor({ timeout: TIMEOUT })
    .catch((error) => diagnose(page, error))
  await page.getByRole("button", { name: USE_THIS_TAB }).waitFor({ timeout: TIMEOUT })
  assert.equal(await page.locator(".zkm-root").count(), 0, "an inactive tab mounts no wallet")
  const held = await heldLocks(page)
  assert.ok(!held.includes(ACTIVE_TAB_LOCK), `inactive tab holds ${held}`)
}

/** Clicks "Use this tab" in `next`, and waits for `previous` to reload into the inactive screen. */
async function takeOver(next, previous) {
  const reloaded = previous?.waitForEvent("load", { timeout: TIMEOUT })
  await next.getByRole("button", { name: USE_THIS_TAB }).click()
  await reloaded
  await expectActive(next)
  if (previous) await expectInactive(previous)
}

test(
  "one tab runs the wallet, and takeover moves it between tabs",
  { timeout: 300_000 },
  async () => {
    const context = await browser.newContext()
    await installCaptureGuard(context, base, report)
    await answerNode(context)
    const prompts = []
    context.on("page", (page) =>
      page.on("dialog", (dialog) => {
        prompts.push(dialog.type())
        void dialog.dismiss()
      }),
    )
    try {
      const a = await context.newPage()
      await a.goto(`${base.origin}/`, { waitUntil: "domcontentloaded" })
      await expectActive(a)

      const b = await context.newPage()
      await b.goto(`${base.origin}/`, { waitUntil: "domcontentloaded" })
      await expectInactive(b)

      await takeOver(b, a)
      await takeOver(a, b)
      assert.deepEqual(prompts, [], "a displaced tab reloads without a leave prompt")

      // A reload of the active tab comes back active: the old document's locks go with it.
      await a.reload({ waitUntil: "domcontentloaded" })
      await expectActive(a)
      await expectInactive(b)

      // Closing the active tab does not promote the other one; its button does.
      await a.close({ runBeforeUnload: false })
      await b.waitForTimeout(1_000)
      await expectInactive(b)
      await takeOver(b)
    } finally {
      await context.close()
    }
  },
)
