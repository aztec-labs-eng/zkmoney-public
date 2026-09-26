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

// The four sheets whose 64px circular badge sits in a capped-height column flex card. Content
// pressure must scroll the card, never squash the badge (ULT-1024).
let server, browser, base
const output = await mkdtemp(path.join(tmpdir(), "modal-badges-"))
const repo = path.resolve(walletDir, "../..")
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
const source = {
  commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
  status: execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim(),
  hashes: {},
}
for (const file of ["src/ui/shell.css", "src/ui/flow-layout.css", "test/browser/modalBadges.browser.mjs"]) {
  source.hashes[file] = hash(await readFile(path.join(walletDir, file)))
}
before(async () => {
  const chromium = loadChromium(repo, process.env.PLAYWRIGHT_BROWSERS_PATH)
  const started = await startCaptureServer(Number(process.env.MODAL_BADGES_PORT ?? 5497))
  server = started.server
  base = localBaseUrl(started.origin)
  browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] })
}, { timeout: 120_000 })
after(async () => {
  try { await browser?.close() } finally { await server?.close() }
  console.info(`Modal badge evidence: ${output}`)
})

const BADGE = 64
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
const cases = [
  { width: 1280, height: 720 },
  { width: 1280, height: 832 },
  { width: 900, height: 600 },
  { width: 641, height: 667 },
  { width: 640, height: 667 },
  { width: 390, height: 667 },
  // Every sheet overflows here, so the scroll-to-final-control check always runs.
  { width: 1280, height: 480, mustOverflow: true },
]
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 0.1, `${label}: ${actual}, expected ${expected}`)
const dialogFor = (page, label) => page.locator(`dialog[aria-label="${label}"]:modal`)

// Each sheet is reached through the real screens the demo fixtures drive.
const sheets = [
  {
    name: "one-time-warning", label: "One-time deposit address",
    async open(page) {
      await page.goto(`${base.origin}/deposit?flowFixture=success`, { waitUntil: "domcontentloaded" })
      await page.locator(".ww-deposit-disclaimer").waitFor({ state: "visible" })
      await page.getByRole("button", { name: "Got it!" }).click()
      await page.getByRole("button", { name: "Show" }).click()
    },
  },
  {
    name: "deposit-qr", label: "Deposit address",
    async open(page) {
      await dialogFor(page, "One-time deposit address").getByRole("button", { name: "Got it!" }).click()
    },
  },
  {
    name: "deposit-detail", label: "Deposit details",
    async open(page) {
      await page.goto(`${base.origin}/activity`, { waitUntil: "domcontentloaded" })
      // The settled deposit is the row without a status badge.
      await page.getByRole("button", { name: "Open deposit details" })
        .filter({ hasNotText: /Pending|Needs recovery|Recovered|Cancelled/ }).first().click()
    },
  },
  {
    name: "withdrawal-detail", label: "Withdrawal details",
    async open(page) {
      await page.goto(`${base.origin}/activity`, { waitUntil: "domcontentloaded" })
      await page.getByRole("button", { name: "Open withdrawal details" }).filter({ hasText: "Releasing" }).first().click()
    },
  },
]

async function measure(dialog) {
  return dialog.evaluate((dialog, FOCUSABLE) => {
    const rect = (e) => {
      const r = e.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    }
    const card = dialog.querySelector(":scope > .ww-modal")
    const badge = card.querySelector(".ww-deposit__connect-icon")
    const glyph = badge.firstElementChild
    const controls = [...card.querySelectorAll(FOCUSABLE)]
    const last = controls[controls.length - 1]
    const top = { badge: rect(badge), glyph: rect(glyph), final: rect(last) }
    card.scrollTop = card.scrollHeight
    const cardRect = card.getBoundingClientRect()
    const finalRect = last.getBoundingClientRect()
    return {
      badge: { ...top.badge, flex: getComputedStyle(badge).flex, borderRadius: getComputedStyle(badge).borderRadius },
      glyph: {
        ...top.glyph, tag: glyph.tagName.toLowerCase(),
        intrinsicWidth: Number(glyph.getAttribute("width")), intrinsicHeight: Number(glyph.getAttribute("height")),
      },
      card: {
        scrollHeight: card.scrollHeight, clientHeight: card.clientHeight,
        overflows: card.scrollHeight > card.clientHeight + 1,
        scrolledToEnd: card.scrollTop + card.clientHeight >= card.scrollHeight - 1,
      },
      final: {
        name: last.getAttribute("aria-label") ?? last.textContent.trim(),
        atTop: top.final, atEnd: finalRect,
        withinCard: finalRect.top >= cardRect.top - 0.5 && finalRect.bottom <= cardRect.bottom + 0.5,
      },
      scrollWidth: document.documentElement.scrollWidth,
    }
  }, FOCUSABLE)
}

for (const { width, height, mustOverflow } of cases) {
  test(`modal badges stay ${BADGE}px circles at ${width}x${height}`, { timeout: 180_000 }, async () => {
    const name = `${width}x${height}`
    const report = { source, viewport: { width, height }, sheets: {}, ok: false }
    const context = await browser.newContext({
      viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: "reduce",
      colorScheme: "dark", serviceWorkers: "block", locale: "en-US", timezoneId: "UTC",
    })
    try {
      await context.grantPermissions(["local-network-access"], { origin: base.origin })
      await installCaptureGuard(context, base, report)
      const page = await context.newPage()
      page.setDefaultTimeout(20_000)
      await page.clock.setFixedTime(new Date(FIXTURE_TIME))
      await page.goto(`${base.origin}/?demo=activity`, { waitUntil: "domcontentloaded" })
      await page.locator(".ww-shell").waitFor({ state: "visible" })
      // Every sheet is measured before the case fails, so one run reports all four.
      const failures = []
      for (const sheet of sheets) {
        await sheet.open(page)
        const dialog = dialogFor(page, sheet.label)
        await dialog.locator(".ww-deposit__connect-icon").waitFor({ state: "visible" })
        await settle(page)
        const screenshot = `${name}-${sheet.name}.png`
        const pixels = await page.screenshot({ path: path.join(output, screenshot), animations: "disabled" })
        const g = await measure(dialog)
        report.sheets[sheet.name] = { screenshot: { file: screenshot, sha256: hash(pixels) }, geometry: g }
        const label = `${sheet.name} ${name}`
        try {
          near(g.badge.width, BADGE, `${label} badge width`)
          near(g.badge.height, BADGE, `${label} badge height`)
          assert.equal(g.badge.borderRadius, "50%", `${label} badge stays circular`)
          near(g.glyph.width, g.glyph.intrinsicWidth, `${label} ${g.glyph.tag} glyph width`)
          near(g.glyph.height, g.glyph.intrinsicHeight, `${label} ${g.glyph.tag} glyph height`)
          assert.ok(g.scrollWidth <= width, `${label} adds no horizontal page scroll`)
          if (mustOverflow) assert.equal(g.card.overflows, true, `${label} content exceeds the card`)
          if (g.card.overflows) assert.equal(g.card.scrolledToEnd, true, `${label} card scrolls to its end`)
          assert.equal(g.final.withinCard, true, `${label} final control "${g.final.name}" is within the scrolled card`)
          // Trial click: scrolled into view, stable, and receiving pointer events.
          await dialog.locator(FOCUSABLE).last().click({ trial: true })
        } catch (error) {
          failures.push(error.message)
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
      await context.close()
      await writeFile(path.join(output, `${name}.json`), JSON.stringify(report, null, 2) + "\n")
    }
  })
}
