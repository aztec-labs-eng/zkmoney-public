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
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
const phones = [{ width: 390, height: 844 }, { width: 402, height: 879 }, { width: 390, height: 667 }]
const safeInsets = { top: 47, right: 6, bottom: 34, left: 6 }
const variants = [
  { name: "rating", title: "Help us improve zk.money", opener: ".ww-settings__banner", field: "Anything else you'd like to share?", submit: "Send feedback" },
  { name: "bug", title: "Report a bug", field: "Describe the bug", submit: "Submit" },
]

async function geometry(sheet) {
  return sheet.evaluate((node) => {
    const box = node.getBoundingClientRect()
    const close = node.querySelector('.ww-modal__close button').getBoundingClientRect()
    const title = node.querySelector('.ww-modal__close').nextElementSibling
    const titleRange = document.createRange()
    titleRange.selectNodeContents(title)
    const intersect = (a, b) => ({ left: Math.max(a.left, b.left), right: Math.min(a.right, b.right), top: Math.max(a.top, b.top), bottom: Math.min(a.bottom, b.bottom) })
    const positive = (rect) => rect.right > rect.left && rect.bottom > rect.top
    const viewport = { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
    const visibleClose = intersect(intersect(close, box), viewport)
    const collisions = []
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const text = walker.currentNode
      if (!text.textContent.trim() || text.parentElement.closest('.ww-modal__close')) continue
      const range = document.createRange()
      range.selectNodeContents(text)
      for (const line of range.getClientRects()) {
        const visible = intersect(intersect(line, box), viewport)
        if (positive(visible) && positive(visibleClose) && positive(intersect(visible, visibleClose))) {
          collisions.push({ text: text.textContent.trim(), line: line.toJSON(), visible })
        }
      }
    }
    return {
      sheet: box.toJSON(), close: close.toJSON(), title: title.getBoundingClientRect().toJSON(),
      titleLines: [...titleRange.getClientRects()].map((line) => line.toJSON()), collisions,
      scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight,
      clientWidth: node.clientWidth, scrollWidth: node.scrollWidth, documentWidth: document.documentElement.scrollWidth,
    }
  })
}

test("Feedback headings clear Close through form states, scrolling and native dismissal", { timeout: 300_000 }, async () => {
  const output = await mkdtemp(path.join(tmpdir(), "ult786-feedback-layout-"))
  const report = {
    scope: "Actual rating and bug-report surfaces with existing local service simulations. The resizable textarea is enlarged to exercise sheet scrolling. No external feedback, live operation, keyboard, device or design approval.",
    source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
    sourceStatus: execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim(),
    sourceHashes: {}, cases: [], failures: [],
  }
  for (const file of ["src/ui/shell.css", "src/ui/FeedbackModals.tsx", "src/ui/Modal.tsx", "scripts/ui-capture/test/feedback.test.mjs", "scripts/ui-capture/fixtures/feedback.ts"]) {
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
    for (const environment of environments) for (const variant of variants) {
      const { viewport, colorScheme, insets } = environment
      const name = `${viewport.width}x${viewport.height}-${colorScheme}${insets ? "-insets" : ""}-${variant.name}`
      const entry = { name, ...environment, variant: variant.name, fixtureQuery: "demo=activity&flowFixture=retry", samples: [], screenshots: [], failures: [] }
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
        await page.goto(`${origin}/settings?${entry.fixtureQuery}`)
        await page.locator(".ww-settings__user").waitFor()
        const opener = variant.opener ? page.locator(variant.opener) : page.getByRole("button", { name: "Report a bug", exact: true })
        const dialog = page.getByRole("dialog", { name: variant.title, exact: true })
        const sheet = dialog.locator(".ww-feedback")
        const close = dialog.getByRole("button", { name: "Close", exact: true })
        const textarea = dialog.getByRole("textbox", { name: variant.field, exact: true })
        const submit = dialog.getByRole("button", { name: variant.submit, exact: true })
        const check = (sample, state, titleVisible) => {
          const fail = (condition, message) => { if (!condition) entry.failures.push({ state, message }) }
          fail(sample.collisions.length === 0, "visible text intersects Close")
          fail(sample.documentWidth <= viewport.width && sample.scrollWidth <= sample.clientWidth + 1, "horizontal overflow")
          fail(sample.sheet.top >= -1 && sample.sheet.bottom <= viewport.height + 1, "sheet outside viewport")
          if (titleVisible) {
            fail(sample.titleLines.length > 0 && sample.titleLines.every((line) => line.left >= sample.sheet.left && line.right <= sample.sheet.right && line.top >= sample.sheet.top && line.bottom <= sample.sheet.bottom), "title is clipped")
            fail(sample.close.top >= 0 && sample.close.bottom <= viewport.height && sample.close.left >= 0 && sample.close.right <= viewport.width, "Close is clipped")
          }
        }
        const shot = async (state, titleVisible = true) => {
          const file = `${name}-${state}.png`
          const bytes = await page.screenshot({ path: path.join(output, file), animations: "disabled" })
          const sample = await geometry(sheet)
          entry.screenshots.push({ file, sha256: hash(bytes), state, geometry: sample })
          check(sample, state, titleVisible)
        }
        const open = async () => {
          await opener.click()
          await dialog.waitFor()
          await settle(page)
          assert(await dialog.evaluate((node) => node.matches(":modal") && node.contains(document.activeElement)), "native dialog owns focus")
          assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).overflow), "hidden")
        }
        const closed = async () => {
          await dialog.waitFor({ state: "detached" })
          assert.equal(await page.locator("dialog:modal").count(), 0)
          assert(await opener.evaluate((node) => node === document.activeElement), "dismissal restores the connected Settings opener")
          assert.notEqual(await page.evaluate(() => getComputedStyle(document.documentElement).overflow), "hidden")
        }
        await open()
        assert(await submit.isDisabled(), "empty form cannot submit")
        await shot("empty")
        if (variant.name === "rating") {
          await dialog.getByRole("button", { name: "Good", exact: true }).click()
          assert.equal(await dialog.getByRole("button", { name: "Good", exact: true }).getAttribute("aria-pressed"), "true")
          await shot("good")
          await dialog.getByRole("button", { name: "Bad", exact: true }).click()
          assert.equal(await dialog.getByRole("button", { name: "Bad", exact: true }).getAttribute("aria-pressed"), "true")
        }
        await textarea.fill("Synthetic local feedback with a long note.\n".repeat(30))
        await shot("long-note")
        await submit.click()
        const sending = dialog.locator("button:has(.zkm-spinner)")
        await sending.waitFor()
        assert(await sending.isDisabled(), "sending prevents another submission")
        await shot("sending")
        await dialog.getByRole("alert").waitFor()
        await shot("failed")

        // Exercise the textarea's existing vertical resize behavior without changing the fixture or page state.
        await textarea.evaluate((node) => { node.style.height = "640px" })
        const maximum = await sheet.evaluate((node) => node.scrollHeight - node.clientHeight)
        assert(maximum > 0, "enlarged text area produces real sheet scrolling")
        const positions = [...new Set([0, ...Array.from({ length: Math.ceil(maximum / 24) }, (_, i) => Math.min(maximum, i * 24)), maximum / 2, maximum])].sort((a, b) => a - b)
        for (const top of positions) {
          await sheet.evaluate((node, value) => { node.scrollTop = value }, top)
          await page.evaluate(() => new Promise(requestAnimationFrame))
          const sample = await geometry(sheet)
          entry.samples.push(sample)
          check(sample, `scroll-${top}`, false)
        }
        for (const [state, top] of [["scroll-top", 0], ["scroll-middle", maximum / 2], ["scroll-bottom", maximum]]) {
          await sheet.evaluate((node, value) => { node.scrollTop = value }, top)
          await shot(state, false)
        }
        await submit.click({ trial: true })
        await close.click({ trial: true })
        await close.focus()
        await page.keyboard.press("Shift+Tab")
        assert(await submit.evaluate((node) => node === document.activeElement), "reverse Tab reaches the final action")
        await page.keyboard.press("Tab")
        assert(await close.evaluate((node) => node === document.activeElement), "Tab wraps to Close")
        await textarea.evaluate((node) => { node.style.removeProperty("height") })
        await sheet.evaluate((node) => { node.scrollTop = 0 })
        await submit.click()
        await dialog.getByText("Got it.", { exact: true }).waitFor()
        await shot("sent")
        await dialog.getByRole("button", { name: "Done", exact: true }).click()
        await closed()

        await open()
        entry.dismissal = colorScheme === "dark" ? "Close" : "Escape"
        if (entry.dismissal === "Close") await close.click()
        else await page.keyboard.press("Escape")
        await closed()
        await open()
        await dialog.evaluate((node) => node.close())
        await closed()
      } catch (error) {
        entry.failures.push({ error: String(error) })
      } finally {
        entry.guardErrors = verificationErrors(guard)
        if (entry.guardErrors.length) entry.failures.push({ guardErrors: entry.guardErrors })
        entry.passed = entry.failures.length === 0
        if (!entry.passed) report.failures.push({ name, failures: entry.failures })
        report.cases.push(entry)
        await context.close()
      }
    }
  } finally {
    await browser?.close()
    await server.close()
    report.ok = report.failures.length === 0
    await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n")
    console.log("FEEDBACK_LAYOUT_REPORT", path.join(output, "report.json"))
  }
  assert.deepEqual(report.failures, [])
})
