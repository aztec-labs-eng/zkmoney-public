import assert from "node:assert/strict"
import { before, after, test } from "node:test"
import path from "node:path"
import { startCaptureServer, walletDir } from "../../scripts/ui-capture/server.mjs"
import { loadChromium, localBaseUrl, installCaptureGuard, verificationErrors } from "../../scripts/ui-capture/capture-support.mjs"
import { FIXTURE_TIME } from "../../scripts/ui-capture/plan.mjs"

// Phone sheet geometry through the real cascade, which jsdom cannot check.
let server, browser, base
const repo = path.resolve(walletDir, "../..")
before(async () => {
  const chromium = loadChromium(repo, process.env.PLAYWRIGHT_BROWSERS_PATH)
  const started = await startCaptureServer(Number(process.env.PHONE_SHEETS_PORT ?? 5494))
  server = started.server
  base = localBaseUrl(started.origin)
  browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] })
}, { timeout: 120_000 })
after(async () => {
  try { await browser?.close() } finally { await server?.close() }
})

const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1, `${label}: ${actual}, expected ${expected}`)
const dialogFor = (page, label) => page.locator(`dialog[aria-label="${label}"]:modal`)
const animationsDone = (dialog) => dialog.locator(":scope > .ww-modal").evaluate((el) =>
  Promise.all(el.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => {}))))

// A phone context on the demo fixtures, with the deposit address sheet open.
async function depositSheet(width, height, report) {
  const context = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: "reduce", hasTouch: true, isMobile: true,
    colorScheme: "dark", serviceWorkers: "block", locale: "en-US", timezoneId: "UTC",
  })
  await context.grantPermissions(["local-network-access"], { origin: base.origin })
  await installCaptureGuard(context, base, report)
  const page = await context.newPage()
  page.setDefaultTimeout(20_000)
  await page.clock.setFixedTime(new Date(FIXTURE_TIME))
  await page.goto(`${base.origin}/?demo=activity`, { waitUntil: "domcontentloaded" })
  await page.locator(".ww-shell").waitFor({ state: "visible" })
  await page.goto(`${base.origin}/deposit?flowFixture=success`, { waitUntil: "domcontentloaded" })
  await page.locator(".ww-deposit-disclaimer").waitFor({ state: "visible" })
  await page.getByRole("button", { name: "Got it!" }).click()
  await page.getByRole("button", { name: /^USDC/ }).click()
  const dialog = page.locator("dialog.ww-modal-overlay:modal")
  await animationsDone(dialog)
  return { context, page, dialog }
}

const sheetGeometry = (dialog) => dialog.evaluate((el) => {
  const sheet = el.querySelector(":scope > .ww-modal")
  const r = sheet.getBoundingClientRect()
  return { paddingBottom: getComputedStyle(el).paddingBottom, top: r.top, bottom: r.bottom, height: r.height }
})

for (const { width, height } of [{ width: 375, height: 667 }, { width: 390, height: 844 }]) {
  // Half the screen, as an iPhone keyboard with its suggestion bar takes.
  const KEYBOARD = Math.round(height / 2)
  test(`the sheet sits above a ${KEYBOARD}px keyboard at ${width}x${height}, no taller than what stays visible`, { timeout: 120_000 }, async () => {
    const report = {}
    const { context, dialog } = await depositSheet(width, height, report)
    try {
      const visible = height - KEYBOARD
      const closed = await sheetGeometry(dialog)
      near(closed.bottom, height, "sheet bottom with the keyboard closed")
      assert.ok(closed.height > visible, `the sheet is taller than ${visible}px, so the cap below is exercised`)
      // What useKeyboardInset writes on the dialog while the keyboard is up.
      await dialog.evaluate((el, { inset, visible }) => {
        el.style.setProperty("--ww-keyboard-inset", `${inset}px`)
        el.style.setProperty("--ww-visible-height", `${visible}px`)
      }, { inset: KEYBOARD, visible })
      const open = await sheetGeometry(dialog)
      assert.equal(open.paddingBottom, `${KEYBOARD}px`, "the dialog keeps the keyboard's height free")
      near(open.bottom, visible, "sheet bottom with the keyboard open")
      assert.ok(open.height <= visible + 0.5, `sheet height ${open.height} within the visible ${visible}px`)
      assert.ok(open.top >= 0, "the sheet stays on screen")
      assert.deepEqual(verificationErrors(report), [])
    } finally {
      await context.close()
    }
  })
}

test("a page sheet stays within what the keyboard leaves visible", { timeout: 120_000 }, async () => {
  const report = {}
  const { context, dialog } = await depositSheet(390, 844, report)
  try {
    const visible = 844 - 422
    // The page variant's classes on a real sheet: its own size rules, under the same dialog rules.
    await dialog.evaluate((el, { inset, visible }) => {
      el.classList.add("ww-modal-overlay--page")
      el.querySelector(":scope > .ww-modal").classList.add("ww-modal--page")
      el.style.setProperty("--ww-keyboard-inset", `${inset}px`)
      el.style.setProperty("--ww-visible-height", `${visible}px`)
    }, { inset: 422, visible })
    await animationsDone(dialog)
    const g = await dialog.evaluate((el) => {
      const r = el.querySelector(":scope > .ww-modal").getBoundingClientRect()
      return { top: r.top, bottom: r.bottom }
    })
    assert.ok(g.top >= 0, `page sheet top ${g.top} on screen`)
    assert.ok(g.bottom <= visible + 0.5, `page sheet bottom ${g.bottom} above the keyboard at ${visible}`)
  } finally {
    await context.close()
  }
})

test("the phone card keeps the address on one line inside the card at 375px", { timeout: 120_000 }, async () => {
  const report = {}
  const { context, dialog } = await depositSheet(375, 667, report)
  try {
    const g = await dialog.evaluate((el) => {
      const address = el.querySelector('[data-testid="deposit-address"]')
      const row = address.closest(".ww-sheet__fact")
      const card = address.closest(".ww-sheet__facts")
      const r = (e) => e.getBoundingClientRect()
      return {
        address: r(address).toJSON(), row: r(row).toJSON(), card: r(card).toJSON(),
        lineHeight: parseFloat(getComputedStyle(address).lineHeight) || parseFloat(getComputedStyle(address).fontSize) * 1.5,
        scrollWidth: document.documentElement.scrollWidth,
      }
    })
    assert.ok(g.address.height <= g.lineHeight + 1, `address is one line: ${g.address.height}px for a ${g.lineHeight}px line`)
    assert.ok(g.address.right <= g.card.right + 0.5 && g.address.left >= g.card.left - 0.5, "address stays inside the card")
    assert.ok(g.address.left >= g.row.left, "address stays in its row")
    assert.ok(g.scrollWidth <= 375, `no horizontal page scroll: ${g.scrollWidth}`)
    assert.deepEqual(verificationErrors(report), [])
  } finally {
    await context.close()
  }
})
