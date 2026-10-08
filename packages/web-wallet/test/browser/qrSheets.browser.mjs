import assert from "node:assert/strict"
import { before, after, test } from "node:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import { startCaptureServer, walletDir } from "../../scripts/ui-capture/server.mjs"
import { loadChromium, localBaseUrl, installCaptureGuard, verificationErrors } from "../../scripts/ui-capture/capture-support.mjs"
import { FIXTURE_TIME, settle } from "../../scripts/ui-capture/plan.mjs"

// The two sheets built on DepositQrSheet. The QR card keeps its full square code and its copy row at
// every width; a short viewport scrolls the sheet to them (ULT-1025).
let server, browser, base
const output = await mkdtemp(path.join(tmpdir(), "qr-sheets-"))
const repo = path.resolve(walletDir, "../..")
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
const source = {
  commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
  status: execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim(),
  hashes: {},
}
for (const file of ["src/ui/shell.css", "src/ui/flow-layout.css", "test/browser/qrSheets.browser.mjs"]) {
  source.hashes[file] = hash(await readFile(path.join(walletDir, file)))
}
before(async () => {
  const chromium = loadChromium(repo, process.env.PLAYWRIGHT_BROWSERS_PATH)
  const started = await startCaptureServer(Number(process.env.QR_SHEETS_PORT ?? 5495))
  server = started.server
  base = localBaseUrl(started.origin)
  browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] })
}, { timeout: 120_000 })
after(async () => {
  try { await browser?.close() } finally { await server?.close() }
  console.info(`QR sheet evidence: ${output}`)
})

// Touch cases emulate a phone and scroll the sheet by swiping; the rest use the wheel.
const cases = [
  { width: 1280, height: 832 },
  { width: 390, height: 844, touch: true },
  { width: 641, height: 667 },
  { width: 640, height: 667, touch: true },
  // Wide landscape phone: above the mobile breakpoint, shorter than the sheet.
  { width: 844, height: 390, touch: true, mustOverflow: true },
  { width: 1280, height: 480, mustOverflow: true },
]
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1, `${label}: ${actual}, expected ${expected}`)
const dialogFor = (page, label) => page.locator(`dialog[aria-label="${label}"]:modal`)

// Each sheet is reached through the real screens the demo fixtures drive, in its own context.
const sheets = [
  {
    name: "deposit-qr", label: "Deposit address",
    async open(page) {
      await page.goto(`${base.origin}/?demo=activity`, { waitUntil: "domcontentloaded" })
      await page.locator(".ww-shell").waitFor({ state: "visible" })
      await page.goto(`${base.origin}/deposit?flowFixture=success`, { waitUntil: "domcontentloaded" })
      await page.locator(".ww-deposit-disclaimer").waitFor({ state: "visible" })
      await page.getByRole("button", { name: "Got it!" }).click()
      await page.getByRole("button", { name: "Show" }).click()
      await dialogFor(page, "One-time deposit address").getByRole("button", { name: "Got it!" }).click()
    },
  },
  {
    name: "request-qr", label: "Payment address",
    async open(page) {
      await page.goto(`${base.origin}/request?demo=onboarding&flowFixture=success&flowEntry=request`, { waitUntil: "domcontentloaded" })
      const external = page.getByRole("button", { name: "Pay with an Ethereum wallet" })
      await external.waitFor({ state: "visible" })
      await external.click()
      await dialogFor(page, "Pay with an Ethereum wallet").getByRole("button", { name: "Show", exact: true }).click()
      // The link's own address has no proven portal, so its capacity warning comes first.
      await dialogFor(page, "Network capacity").getByRole("button", { name: "Got it!" }).click()
    },
  },
]

async function measure(dialog) {
  return dialog.evaluate((dialog) => {
    const rect = (e) => {
      const r = e.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    }
    const sheet = dialog.querySelector(":scope > .ww-modal")
    const card = sheet.querySelector(".ww-qr-card")
    const code = card.querySelector(".ww-qr-card__code")
    const copy = card.querySelector(".ww-qr-card__label")
    const sheetRect = rect(sheet)
    const copyRect = rect(copy)
    return {
      card: {
        ...rect(card), flex: getComputedStyle(card).flex,
        clipsContent: card.scrollHeight > card.clientHeight + 1,
      },
      code: rect(code),
      copy: {
        ...copyRect, name: copy.textContent.trim(),
        withinSheet: copyRect.y >= sheetRect.y - 0.5 && copyRect.y + copyRect.height <= sheetRect.y + sheetRect.height + 0.5,
      },
      sheet: {
        ...sheetRect, scrollTop: sheet.scrollTop, scrollHeight: sheet.scrollHeight, clientHeight: sheet.clientHeight,
        overflows: sheet.scrollHeight > sheet.clientHeight + 1,
        scrolledToEnd: sheet.scrollTop + sheet.clientHeight >= sheet.scrollHeight - 1,
      },
      scrollWidth: document.documentElement.scrollWidth,
    }
  })
}

// The sheet's entrance animation must end before its geometry is read.
const animationsDone = (dialog) => dialog.locator(":scope > .ww-modal").evaluate((el) =>
  Promise.all(el.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => {}))))

// A user gesture over the sheet (a swipe dispatched as touch points, or the wheel): the sheet, not a
// shrunken child, owns the overflow.
async function gestureToEnd(page, dialog, touch) {
  const sheet = dialog.locator(":scope > .ww-modal")
  const box = await sheet.boundingBox()
  const x = box.x + box.width / 2
  const cdp = touch ? await page.context().newCDPSession(page) : null
  for (let i = 0; i < 20; i += 1) {
    if (touch) {
      const from = Math.round(box.y + box.height * 0.85)
      const to = Math.round(box.y + box.height * 0.15)
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: from }] })
      for (let y = from - 10; y >= to; y -= 10) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] })
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
      await page.waitForTimeout(200)
    } else {
      await page.mouse.move(x, box.y + box.height / 2)
      await page.mouse.wheel(0, 400)
      await page.waitForTimeout(50)
    }
    const atEnd = await sheet.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 1)
    if (atEnd) break
  }
  await cdp?.detach()
}

for (const { width, height, touch = false, mustOverflow } of cases) {
  test(`QR sheets keep the square code and copy row reachable at ${width}x${height}${touch ? " (touch)" : ""}`, { timeout: 180_000 }, async () => {
    const name = `${width}x${height}`
    const report = { source, viewport: { width, height, touch }, sheets: {}, ok: false }
    const failures = []
    try {
      for (const sheet of sheets) {
        const context = await browser.newContext({
          viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: "reduce", hasTouch: touch, isMobile: touch,
          colorScheme: "dark", serviceWorkers: "block", locale: "en-US", timezoneId: "UTC",
        })
        try {
          await context.grantPermissions(["local-network-access"], { origin: base.origin })
          await installCaptureGuard(context, base, report)
          const page = await context.newPage()
          page.setDefaultTimeout(20_000)
          await page.clock.setFixedTime(new Date(FIXTURE_TIME))
          await sheet.open(page)
          const dialog = dialogFor(page, sheet.label)
          await dialog.locator(".ww-qr-card__code svg").waitFor({ state: "visible" })
          await settle(page)
          await animationsDone(dialog)
          const top = await measure(dialog)
          const before = `${name}-${sheet.name}-top.png`
          const beforePixels = await page.screenshot({ path: path.join(output, before), animations: "disabled" })
          await gestureToEnd(page, dialog, touch)
          const end = await measure(dialog)
          const after = `${name}-${sheet.name}-end.png`
          const afterPixels = await page.screenshot({ path: path.join(output, after), animations: "disabled" })
          report.sheets[sheet.name] = {
            screenshots: { top: { file: before, sha256: hash(beforePixels) }, end: { file: after, sha256: hash(afterPixels) } },
            top, end,
          }
          const label = `${sheet.name} ${name}`
          try {
            assert.equal(top.card.clipsContent, false, `${label} card clips none of its content`)
            near(top.code.width, top.code.height, `${label} code stays square`)
            near(top.code.width, top.card.width, `${label} code spans the card`)
            near(top.card.height, top.code.height + top.copy.height, `${label} card holds the code and the copy row`)
            assert.ok(top.scrollWidth <= width, `${label} adds no horizontal page scroll`)
            if (mustOverflow) assert.equal(top.sheet.overflows, true, `${label} sheet content exceeds the viewport`)
            if (top.sheet.overflows) {
              assert.ok(end.sheet.scrollTop > 0, `${label} ${touch ? "swipe" : "wheel"} scrolls the sheet`)
              assert.equal(end.sheet.scrolledToEnd, true, `${label} sheet scrolls to its end`)
            }
            assert.equal(end.copy.withinSheet, true, `${label} copy row "${end.copy.name}" is within the scrolled sheet`)
            assert.equal(top.card.flex, "0 0 auto", `${label} card never shrinks`)
            // Trial click: scrolled into view, stable, and receiving pointer events.
            await dialog.locator(".ww-qr-card__label").click({ trial: true })
          } catch (error) {
            failures.push(error.message)
          }
        } finally {
          await context.close()
        }
      }
      if (failures.length > 0) assert.fail(failures.join("\n"))
      assert.deepEqual(verificationErrors(report), [])
      report.ok = true
    } catch (error) {
      report.error = { message: error.message, stack: error.stack }
      throw error
    } finally {
      report.verificationErrors = verificationErrors(report)
      await writeFile(path.join(output, `${name}.json`), JSON.stringify(report, null, 2) + "\n")
    }
  })
}
