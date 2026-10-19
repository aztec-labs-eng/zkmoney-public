import assert from "node:assert/strict"
import { before, after, test } from "node:test"
import path from "node:path"
import { startCaptureServer, walletDir } from "../../scripts/ui-capture/server.mjs"
import { loadChromium, localBaseUrl, installCaptureGuard, verificationErrors } from "../../scripts/ui-capture/capture-support.mjs"

// The host bar reservation through the real cascade, which jsdom cannot check: in an app's browser
// the sheet keeps the bar's height free and its card scrolls above it.
const BAR = 88
const X_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone/10.80"

let server, browser, base
const repo = path.resolve(walletDir, "../..")
before(async () => {
  const chromium = loadChromium(repo, process.env.PLAYWRIGHT_BROWSERS_PATH)
  const started = await startCaptureServer(Number(process.env.IN_APP_HOST_BAR_PORT ?? 5495))
  server = started.server
  base = localBaseUrl(started.origin)
  browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] })
}, { timeout: 120_000 })
after(async () => {
  try { await browser?.close() } finally { await server?.close() }
})

// A phone context, as the app's browser or as a plain one, on a dev-bootstrapped page.
async function open(pathname, { width, height, inApp, report }) {
  const context = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: "reduce", hasTouch: true, isMobile: true,
    colorScheme: "dark", serviceWorkers: "block", locale: "en-US", timezoneId: "UTC",
    ...(inApp ? { userAgent: X_IPHONE } : {}),
  })
  await context.grantPermissions(["local-network-access"], { origin: base.origin })
  await installCaptureGuard(context, base, report)
  const page = await context.newPage()
  page.setDefaultTimeout(20_000)
  await page.goto(`${base.origin}${pathname}`, { waitUntil: "domcontentloaded" })
  return { context, page }
}

const marked = (page) => page.evaluate(() => document.documentElement.dataset.inAppBrowser !== undefined)
const SHEET = "dialog.ww-modal-overlay > .ww-modal.ww-reg-sheet"
const sheetSettled = (page) => page.locator(SHEET).evaluate((el) =>
  Promise.all(el.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => {}))))

// The sign-up sheet and its scrolling card; the report link, when the card shows it, is its last control.
const sheetGeometry = (page) => page.evaluate((selector) => {
  const sheet = document.querySelector(selector)
  const card = sheet.querySelector(".ww-reg-sheet__card")
  const report = sheet.querySelector('[data-testid="passkey-report"]')
  const box = (el) => (el ? el.getBoundingClientRect().toJSON() : null)
  return {
    paddingBottom: getComputedStyle(sheet).paddingBottom,
    sheetBottom: sheet.getBoundingClientRect().bottom,
    card: box(card),
    scrolls: card.scrollHeight > card.clientHeight + 1,
    report: box(report),
    viewport: window.innerHeight,
  }
}, SHEET)
// The sheet's border crosses the edge by a pixel on some sizes.
const onBottomEdge = (g, label) => assert.ok(Math.abs(g.sheetBottom - g.viewport) <= 2, `${label}: ${g.sheetBottom} vs ${g.viewport}`)
// The whole report link sits inside the card's box and above the reserved band.
function lastControlVisible(g) {
  assert.ok(g.report && g.report.height > 0, "the report link is rendered")
  assert.ok(g.report.top >= g.card.top - 0.5, `the last control starts inside the card: ${g.report.top} vs ${g.card.top}`)
  assert.ok(g.report.bottom <= g.card.bottom + 0.5, `the last control ends inside the card: ${g.report.bottom} vs ${g.card.bottom}`)
  assert.ok(g.report.bottom <= g.viewport - BAR + 0.5, `the last control is above the bar: ${g.report.bottom}`)
}

const scrollCardToEnd = (page) => page.evaluate(() => {
  const card = document.querySelector(".ww-reg-sheet__card")
  card.scrollTop = card.scrollHeight
})

async function signUpSheet(size, inApp, report) {
  const { context, page } = await open("/claim?demo=onboarding&mock=create", { ...size, inApp, report })
  await page.locator('[data-testid="create-in-app-notice"], [data-testid="registration-sheet-summary"], .ww-reg-sheet').first().waitFor({ state: "visible" })
  return { context, page }
}

test("in X's browser, a tall phone shows the whole card above the bar with no scroll", { timeout: 120_000 }, async () => {
  const report = {}
  const { context, page } = await signUpSheet({ width: 390, height: 844 }, true, report)
  try {
    await page.locator('[data-testid="create-in-app-notice"]').waitFor({ state: "visible" })
    await sheetSettled(page)
    assert.equal(await marked(page), true, "the document is marked")
    const g = await sheetGeometry(page)
    assert.equal(g.paddingBottom, `${BAR}px`, "the sheet keeps the bar free")
    onBottomEdge(g, "the sheet sits on the viewport's bottom edge")
    assert.ok(g.card.bottom <= g.viewport - BAR + 0.5, `the card ends above the bar: ${g.card.bottom} vs ${g.viewport - BAR}`)
    assert.equal(g.scrolls, false, "nothing to scroll on a tall phone")
    lastControlVisible(g)
    assert.deepEqual(verificationErrors(report), [])
  } finally {
    await context.close()
  }
})

test("in X's browser, a short web view scrolls the card to its last control above the bar", { timeout: 120_000 }, async () => {
  const report = {}
  const { context, page } = await signUpSheet({ width: 393, height: 528 }, true, report)
  try {
    await page.locator('[data-testid="create-in-app-notice"]').waitFor({ state: "visible" })
    await sheetSettled(page)
    const before = await sheetGeometry(page)
    assert.equal(before.paddingBottom, `${BAR}px`, "the sheet keeps the bar free")
    assert.equal(before.scrolls, true, "the card has more than fits")
    assert.ok(before.card.bottom <= before.viewport - BAR + 0.5, `the card's box ends above the bar: ${before.card.bottom}`)
    assert.ok(before.report && before.report.top > before.card.bottom, "before scrolling, the last control is below the card's box")
    await scrollCardToEnd(page)
    lastControlVisible(await sheetGeometry(page))
    assert.deepEqual(verificationErrors(report), [])
  } finally {
    await context.close()
  }
})

test("in a plain browser, the document is unmarked and the sheet keeps the phone's own inset", { timeout: 120_000 }, async () => {
  const report = {}
  const { context, page } = await signUpSheet({ width: 390, height: 844 }, false, report)
  try {
    await sheetSettled(page)
    assert.equal(await marked(page), false, "the document is not marked")
    const g = await sheetGeometry(page)
    assert.equal(g.paddingBottom, "0px", "no reservation outside an app's browser")
    onBottomEdge(g, "the sheet sits on the viewport's bottom edge")
    assert.equal(g.scrolls, false, "a fitting sheet has nothing to scroll")
    assert.ok(g.card.bottom <= g.viewport + 0.5, `the card ends on screen: ${g.card.bottom}`)
    assert.deepEqual(verificationErrors(report), [])
  } finally {
    await context.close()
  }
})

test("in X's browser, a landscape phone is wider than the phone layout and gets no reservation", { timeout: 120_000 }, async () => {
  const report = {}
  const { context, page } = await signUpSheet({ width: 844, height: 390 }, true, report)
  try {
    await page.locator('[data-testid="create-in-app-notice"]').waitFor({ state: "visible" })
    await sheetSettled(page)
    assert.equal(await marked(page), true, "the document is marked")
    const g = await sheetGeometry(page)
    assert.equal(g.paddingBottom, "0px", "the override stops at the phone breakpoint")
    assert.deepEqual(verificationErrors(report), [])
  } finally {
    await context.close()
  }
})

// The invitation page under the sheets is the sign-in card's host too; its bottom padding reads
// the same inset. (/enter itself starts a passkey probe that never answers in headless Chromium.)
test("in X's browser, the invitation page's own bottom padding grows by the bar", { timeout: 120_000 }, async () => {
  const report = {}
  const { context, page } = await open("/claim?demo=onboarding", { width: 393, height: 528, inApp: true, report })
  try {
    await page.locator(".ww-invite__center").waitFor({ state: "visible" })
    const paddingBottom = await page.evaluate(() => getComputedStyle(document.querySelector(".ww-invite__center")).paddingBottom)
    assert.equal(paddingBottom, `${24 + BAR}px`, "the page keeps the bar free below its content")
    assert.deepEqual(verificationErrors(report), [])
  } finally {
    await context.close()
  }
})
