import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import { startCaptureServer, walletDir } from "../server.mjs"
import { installCaptureGuard, loadChromium, localBaseUrl, verificationErrors } from "../capture-support.mjs"
import { FIXTURE_TIME, settle } from "../plan.mjs"

const repo = path.resolve(walletDir, "../..")
const phones = [{ width: 390, height: 844 }, { width: 402, height: 879 }, { width: 390, height: 667 }]
const safeInsets = { top: 47, right: 6, bottom: 34, left: 6 }
const states = [
  { name: "free", query: "flowFixture=success&registrationFixture=free", dismissible: true },
  { name: "pending", query: "flowFixture=success&registrationFixture=awaiting", dismissible: false },
  { name: "terms", query: "mock=create&handle=demo", dismissible: false },
  { name: "dismissible-preview", query: "mock=deposit-free&handle=demo", dismissible: true },
]
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")

async function geometry(card) {
  return card.evaluate((node) => {
    const sheet = node.parentElement
    const button = sheet.querySelector('.ww-modal__close button')
    const cardBox = node.getBoundingClientRect()
    const closeBox = button?.getBoundingClientRect()
    const overlap = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
    const collisions = []
    let visibleTextLines = 0
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const text = walker.currentNode
      if (!text.textContent.trim()) continue
      const range = document.createRange()
      range.selectNodeContents(text)
      for (const rect of range.getClientRects()) {
        const visible = { left: Math.max(rect.left, cardBox.left), right: Math.min(rect.right, cardBox.right), top: Math.max(rect.top, cardBox.top), bottom: Math.min(rect.bottom, cardBox.bottom) }
        if (visible.right <= visible.left || visible.bottom <= visible.top) continue
        visibleTextLines++
        if (closeBox && overlap(visible, closeBox)) collisions.push({ text: text.textContent.trim(), line: rect.toJSON(), visible })
      }
    }
    return {
      sheet: sheet.getBoundingClientRect().toJSON(), card: cardBox.toJSON(), close: closeBox?.toJSON() ?? null,
      scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight,
      scrollWidth: document.documentElement.scrollWidth, visibleTextLines, collisions,
    }
  })
}

test("registration keeps phone Close outside scrolling text and preserves paid and terms gates", { timeout: 300_000 }, async () => {
  const output = await mkdtemp(path.join(tmpdir(), "ult786-registration-layout-"))
  const report = {
    scope: "Actual registration surfaces with existing local demo fixtures. Bounds and dismissal checks only; no passkey, registration, transaction, device or design approval.",
    source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
    sourceStatus: execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim(),
    sourceHashes: {}, cases: [], failures: [],
  }
  for (const file of ["src/ui/shell.css", "src/features/onboarding/RegistrationSheet.tsx", "src/features/onboarding/OnboardingCard.tsx", "scripts/ui-capture/test/registration.test.mjs"]) {
    report.sourceHashes[file] = hash(await readFile(path.join(walletDir, file)))
  }
  const environments = [
    ...phones.flatMap((viewport) => [{ viewport, colorScheme: "dark", insets: null }, { viewport, colorScheme: "light", insets: safeInsets }]),
    ...["dark", "light"].map((colorScheme) => ({ viewport: { width: 1280, height: 832 }, colorScheme, insets: null })),
  ]
  const { server, origin } = await startCaptureServer(Number(process.env.UI_CAPTURE_TEST_PORT ?? 5786))
  let browser
  try {
    browser = await loadChromium(repo, process.env.PLAYWRIGHT_BROWSERS_PATH).launch({ headless: true })
    for (const environment of environments) for (const state of states) {
      const { viewport, colorScheme, insets } = environment
      const name = `${viewport.width}x${viewport.height}-${colorScheme}${insets ? "-insets" : ""}-${state.name}`
      const entry = { name, ...environment, state: state.name, fixtureQuery: state.query, samples: [], screenshots: [] }
      const context = await browser.newContext({ viewport, colorScheme, reducedMotion: "reduce", locale: "en-US", timezoneId: "UTC", serviceWorkers: "block" })
      const guard = {}
      try {
        await context.grantPermissions(["local-network-access"], { origin })
        await installCaptureGuard(context, localBaseUrl(origin), guard)
        if (insets) await context.addInitScript((edges) => {
          document.addEventListener("DOMContentLoaded", () => {
            for (const [edge, value] of Object.entries(edges)) document.documentElement.style.setProperty(`--ww-safe-area-${edge}`, `${value}px`, "important")
          })
        }, insets)
        const page = await context.newPage()
        page.setDefaultTimeout(20_000)
        await page.clock.setFixedTime(new Date(FIXTURE_TIME))
        if (insets) await (await context.newCDPSession(page)).send("Emulation.setSafeAreaInsetsOverride", { insets })
        await page.goto(`${origin}/claim?demo=onboarding&${state.query}`)
        const card = page.locator(".ww-reg-sheet__card")
        await card.waitFor()
        await settle(page)
        await page.evaluate(() => document.fonts.ready)
        const close = page.locator('.ww-reg-sheet > .ww-modal__close').getByRole("button", { name: "Close", exact: true })
        assert.equal(await close.count(), Number(state.dismissible), "existing gate determines whether Close is rendered")
        const maximum = await card.evaluate((node) => node.scrollHeight - node.clientHeight)
        // Sample intermediate positions as well as the retained top, middle and bottom stills.
        const positions = [...new Set([0, ...Array.from({ length: Math.ceil(maximum / 24) }, (_, i) => Math.min(maximum, i * 24)), maximum / 2, maximum])].sort((a, b) => a - b)
        for (const top of positions) {
          await card.evaluate((node, value) => { node.scrollTop = value }, top)
          await page.evaluate(() => new Promise(requestAnimationFrame))
          entry.samples.push(await geometry(card))
        }
        for (const [label, top] of [["top", 0], ["middle", maximum / 2], ["bottom", maximum]]) {
          await card.evaluate((node, value) => { node.scrollTop = value }, top)
          await page.evaluate(() => new Promise(requestAnimationFrame))
          const file = `${name}-${label}.png`
          const bytes = await page.screenshot({ path: path.join(output, file), animations: "disabled" })
          entry.screenshots.push({ file, sha256: hash(bytes), geometry: await geometry(card) })
        }
        for (const sample of entry.samples) {
          assert(sample.visibleTextLines > 0, "the scrolled registration content remains visible")
          assert(sample.scrollWidth <= viewport.width, "no horizontal document overflow")
          assert(sample.sheet.top >= -1 && sample.sheet.bottom <= viewport.height + 1, "sheet stays within viewport")
          if (sample.close && viewport.width <= 640) {
            assert.deepEqual(sample.collisions, [], "visible registration text must never intersect Close while scrolling")
            assert(sample.card.top >= sample.close.bottom, "phone Close has reserved space outside the scroll viewport")
            assert(sample.close.left >= 0 && sample.close.right <= viewport.width && sample.close.top >= 0 && sample.close.bottom <= viewport.height, "Close is fully visible")
          }
        }
        if (state.dismissible) {
          await close.click({ trial: true })
          await close.focus()
          const dialog = page.getByRole("dialog", { name: "Account setup", exact: true })
          await page.keyboard.press("Tab")
          assert(await dialog.evaluate((node) => node.contains(document.activeElement)), "Tab stays in the registration dialog")
          entry.dismissal = colorScheme === "dark" ? "Close" : "Escape"
          if (entry.dismissal === "Close") await close.click()
          else await page.keyboard.press("Escape")
          await card.waitFor({ state: "detached" })
          assert.equal(await page.locator("dialog:modal").count(), 0, "dismissal closes the native frame")
          assert.notEqual(await page.evaluate(() => getComputedStyle(document.documentElement).overflow), "hidden", "dismissal releases document scrolling")
        } else {
          await page.keyboard.press("Escape")
          assert.equal(await card.count(), 1, "paid or terms gate remains open without Close")
        }
        entry.passed = true
      } catch (error) {
        entry.passed = false
        entry.error = String(error)
        report.failures.push({ name, error: String(error) })
      } finally {
        entry.guardErrors = verificationErrors(guard)
        if (entry.guardErrors.length) { entry.passed = false; report.failures.push({ name, guardErrors: entry.guardErrors }) }
        report.cases.push(entry)
        await context.close()
      }
    }
  } finally {
    await browser?.close()
    await server.close()
    report.ok = report.failures.length === 0
    await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n")
    console.log("REGISTRATION_LAYOUT_REPORT", path.join(output, "report.json"))
  }
  assert.deepEqual(report.failures, [])
})
