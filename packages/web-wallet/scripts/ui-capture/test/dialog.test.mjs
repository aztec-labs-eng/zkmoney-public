import assert from "node:assert/strict"
import test from "node:test"
import path from "node:path"
import { readFile } from "node:fs/promises"
import { runStep } from "../plan.mjs"
import { startCaptureServer, walletDir } from "../server.mjs"
import { loadChromium, localBaseUrl, installCaptureGuard, verificationErrors } from "../capture-support.mjs"

test("shared dialog traps focus, keeps nested Escape local, and restores focus and scroll ownership", { timeout: 120_000 }, async () => {
  const { server, origin } = await startCaptureServer(Number(process.env.UI_CAPTURE_TEST_PORT ?? 5784))
  const browser = await loadChromium(path.resolve(walletDir, "../.."), process.env.PLAYWRIGHT_BROWSERS_PATH).launch({ headless: true })
  try {
    for (const viewport of [{ width: 390, height: 667 }, { width: 1280, height: 832 }]) {
      const context = await browser.newContext({ viewport, serviceWorkers: "block" })
      const report = {}
      await context.grantPermissions(["local-network-access"], { origin })
      await installCaptureGuard(context, localBaseUrl(origin), report)
      const page = await context.newPage()
      await page.goto(`${origin}/?demo=fresh`)
      await page.locator(".ww-shell").waitFor()
      await page.evaluate(async () => (await import("/scripts/ui-capture/fixtures/dialog-probe.tsx")).mountDialogProbe())
      const opener = page.getByRole("button", { name: "Open probe", exact: true })
      await opener.click()
      const outer = page.getByRole("dialog", { name: "Outer probe", exact: true })
      assert.equal(await outer.evaluate((node) => node.matches(":modal")), true)
      assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).overflow), "hidden")
      await page.keyboard.press("Shift+Tab")
      assert.equal(await page.getByRole("button", { name: "Hold probe" }).evaluate((node) => node === document.activeElement), true)
      await page.keyboard.press("Tab")
      assert.equal(await outer.getByRole("button", { name: "Close", exact: true }).evaluate((node) => node === document.activeElement), true)
      await page.locator("button").filter({ hasText: "Background probe" }).evaluate((node) => node.focus())
      assert.equal(await outer.evaluate((node) => node.contains(document.activeElement)), true)
      await page.getByRole("button", { name: "Open nested probe" }).click()
      const inner = page.getByRole("dialog", { name: "Inner probe", exact: true })
      assert.equal(await inner.evaluate((node) => node.matches(":modal") && node.contains(document.activeElement)), true)
      await page.keyboard.press("Escape")
      await inner.waitFor({ state: "detached" })
      assert.equal(await outer.evaluate((node) => node.matches(":modal")), true)
      assert.equal(await page.getByRole("button", { name: "Open nested probe" }).evaluate((node) => node === document.activeElement), true)
      await page.getByRole("button", { name: "Hold probe" }).click()
      await page.keyboard.press("Escape")
      assert.equal(await outer.evaluate((node) => node.matches(":modal")), true)
      await page.getByRole("button", { name: "Finish probe" }).click()
      await page.keyboard.press("Escape")
      await outer.waitFor({ state: "detached" })
      assert.equal(await opener.evaluate((node) => node === document.activeElement), true)
      assert.notEqual(await page.evaluate(() => getComputedStyle(document.documentElement).overflow), "hidden")
      if (viewport.width === 390) {
        await page.goto(`${origin}/?demo=activity`)
        await page.locator(".ww-shell").waitFor()
        const bell = page.getByRole("button", { name: "Notifications", exact: true })
        await bell.click()
        const notifications = page.getByRole("dialog", { name: "Notifications", exact: true })
        assert.equal(await notifications.evaluate((node) => node.matches(":modal") && node.contains(document.activeElement)), true)
        const bounds = await page.locator(".ww-modal.ww-notifications").boundingBox()
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= viewport.width + 1)
        assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= viewport.height + 1)
        assert.ok(bounds.width >= viewport.width - 1, "phone Notifications fills the sheet width")
        await page.evaluate(async () => (await import("/src/errors/errorModal.ts")).showErrorModal({ title: "Nested error probe", message: "Keep the pending notifications open." }))
        const error = page.getByRole("alertdialog", { name: "Nested error probe" })
        await error.getByText("Keep the pending notifications open.").click()
        assert.equal(await notifications.count(), 1, "interacting with a top error must preserve Notifications")
        await page.keyboard.press("Escape")
        await error.waitFor({ state: "detached" })
        assert.equal(await notifications.evaluate((node) => node.matches(":modal") && node.contains(document.activeElement)), true)
        assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).overflow), "hidden")
        await page.setViewportSize({ width: 641, height: 667 })
        await page.waitForFunction(() => document.querySelector('.ww-notifications[role="dialog"]')?.tagName === "DIV")
        assert.equal(await page.locator("dialog:modal").count(), 0)
        assert.notEqual(await page.evaluate(() => getComputedStyle(document.documentElement).overflow), "hidden")
        for (const width of [640, 639]) {
          await page.setViewportSize({ width, height: 667 })
          await page.waitForFunction(() => !!document.querySelector('dialog.ww-modal-overlay:modal'))
          assert.equal(await notifications.evaluate((node) => node.contains(document.activeElement)), true)
        }
        await page.setViewportSize(viewport)
        await page.keyboard.press("Escape")
        await notifications.waitFor({ state: "detached" })
        assert.equal(await bell.evaluate((node) => node === document.activeElement), true)
        for (const destination of ["Share @tag", "Logout"]) for (const method of (destination === "Logout" ? ["Escape", "Close", "Cancel"] : ["Escape", "Close"])) {
          const menuOpener = await page.getByRole("button", { name: "Open menu", exact: true }).elementHandle()
          await menuOpener.click()
          const menu = page.getByRole("dialog", { name: "Wallet menu", exact: true })
          await menu.getByRole("button", { name: destination, exact: true }).click()
          const sheet = page.getByRole("dialog", { name: destination, exact: true })
          await sheet.waitFor()
          assert.equal(await menu.count(), 0)
          assert.equal(await sheet.evaluate((node) => node.matches(":modal") && node.contains(document.activeElement)), true)
          if (destination === "Share @tag") assert.equal(await sheet.locator(":scope > .ww-share-tag-modal").count(), 1)
          assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).overflow), "hidden")
          if (method === "Escape") await page.keyboard.press("Escape")
          else await sheet.getByRole("button", { name: method, exact: true }).click()
          await sheet.waitFor({ state: "detached" })
          console.log("MENU_FOCUS_TRACE", JSON.stringify({ destination, method, originalOpenerConnected: await menuOpener.evaluate((node) => node.isConnected), ...await page.evaluate(() => ({
            activeTag: document.activeElement?.tagName,
            activeLabel: document.activeElement?.getAttribute("aria-label"),
            activeClass: document.activeElement?.className,
            openerConnected: document.querySelector('[aria-label="Open menu"]')?.isConnected,
            focusedOpener: document.activeElement === document.querySelector('[aria-label="Open menu"]'),
          })) }))
          assert.equal(await menuOpener.evaluate((node) => node.isConnected && node === document.activeElement), true, "menu destination restores the original connected opener")
          assert.notEqual(await page.evaluate(() => getComputedStyle(document.documentElement).overflow), "hidden")
        }
      }
      if (viewport.width === 390) {
        await page.getByRole("button", { name: "Open menu", exact: true }).click()
        const nativeMenu = page.locator("#wallet-menu")
        await nativeMenu.evaluate((node) => node.close())
        await page.waitForTimeout(100)
        await nativeMenu.waitFor({ state: "detached" })
        await page.getByRole("button", { name: "Open menu", exact: true }).click()
        await page.getByRole("dialog", { name: "Wallet menu" }).waitFor()
        await page.keyboard.press("Escape")
        await nativeMenu.waitFor({ state: "detached" })
        assert.equal(await page.getByRole("button", { name: "Open menu", exact: true }).getAttribute("aria-expanded"), "false")
        assert.notEqual(await page.evaluate(() => getComputedStyle(document.documentElement).overflow), "hidden")
        await page.goto(`${origin}/?demo=activity`)
        await page.locator(".ww-shell").waitFor()
        for (const width of [639, 640]) {
          await page.setViewportSize({ width, height: 667 })
          await page.getByRole("button", { name: "Open menu", exact: true }).click()
          await page.getByRole("dialog", { name: "Wallet menu" }).waitFor()
          await page.setViewportSize({ width: 641, height: 667 })
          await page.waitForFunction(() => {
            const current = document.querySelector('.ww-sidebar [aria-current="page"]')
            return current && current === document.activeElement && current.getClientRects().length && !current.closest('[inert]')
          })
          assert.equal(await page.locator("#wallet-menu").count(), 0)
          assert.notEqual(await page.evaluate(() => getComputedStyle(document.documentElement).overflow), "hidden")
        }
        await page.setViewportSize(viewport)
        await page.getByRole("button", { name: "Open menu", exact: true }).click()
        await page.keyboard.press("Escape")
        await page.locator("#wallet-menu").waitFor({ state: "detached" })
        await page.getByRole("button", { name: "Open menu", exact: true }).click()
        await page.getByRole("dialog", { name: "Wallet menu" }).getByRole("button", { name: "Contacts", exact: true }).click()
        await page.waitForURL("**/contacts")
        assert.equal(await page.locator("#wallet-menu").count(), 0)
        await page.goto(`${origin}/contacts/ada?demo=activity`)
        await page.locator(".ww-chat__body .ww-bubble").last().waitFor()
        await page.waitForTimeout(100)
        const footer = await page.locator(".ww-chat__foot").boundingBox()
        // scrollIntoView rounds document scroll to a CSS pixel; the outer box may retain a fraction.
        assert.ok(footer.y >= -1 && footer.y + footer.height <= viewport.height + 1, "conversation footer fits within scroll rounding")
        for (const control of await page.locator(".ww-chat__foot button").all()) {
          const bounds = await control.boundingBox()
          assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= viewport.height, "conversation footer actions are fully visible")
        }
        await page.evaluate(async () => (await import("/scripts/ui-capture/fixtures/dialog-probe.tsx")).seedAddressOnlyConversation())
        await page.locator(".ww-chat__foot").waitFor({ state: "hidden" })
        await page.waitForTimeout(100)
        const latest = await page.locator(".ww-chat__body .ww-bubble").last().boundingBox()
        console.log("FOOTERLESS_CONVERSATION", JSON.stringify({ latest, ...await page.evaluate(() => ({ scrollY, height: innerHeight, footer: document.querySelector(".ww-chat__foot")?.getClientRects().length, child: document.querySelector(".ww-chat__body")?.lastElementChild?.getBoundingClientRect().toJSON() })) }))
        assert.ok(latest.y >= 0 && latest.y + latest.height <= viewport.height + 1, "a footerless conversation opens at the newest message")
      }
      if (viewport.width === 1280) {
        const shareOpener = await page.getByRole("button", { name: "Share @tag", exact: true }).elementHandle()
        await shareOpener.click()
        const share = page.getByRole("dialog", { name: "Share @tag", exact: true })
        await share.waitFor()
        await share.getByRole("button", { name: "Close", exact: true }).click()
        await share.waitFor({ state: "detached" })
        assert.equal(await shareOpener.evaluate((node) => node === document.activeElement), true)
      }
      await page.evaluate(async () => (await import("/scripts/ui-capture/fixtures/dialog-probe.tsx")).mountDialogProbe())
      await page.getByRole("button", { name: "Open probe", exact: true }).last().click()
      const busy = page.locator('dialog[aria-label="Outer probe"]')
      await busy.getByRole("button", { name: "Hold probe" }).click()
      await busy.evaluate((node) => node.close())
      await page.waitForTimeout(100)
      assert.equal(await busy.evaluate((node) => node.matches(":modal")), true, "a busy sheet reconciles native closure")
      await busy.getByRole("button", { name: "Finish probe" }).click()
      await page.mouse.click(1, 1)
      await busy.waitFor({ state: "detached" })
      await page.getByRole("button", { name: "Open probe", exact: true }).last().click()
      await page.getByRole("button", { name: "Open destination probe", exact: true }).click()
      assert.equal(await page.getByRole("textbox", { name: "Destination probe", exact: true }).evaluate((node) => node === document.activeElement), true)

      await page.goto(`${origin}/contacts/ada/send?demo=activity`)
      const amount = page.getByRole("textbox", { name: "Amount", exact: true })
      await amount.waitFor()
      assert.equal(await amount.evaluate((node) => node === document.activeElement), true, "an explicit Amount autofocus survives native dialog opening")
      await amount.evaluate((node) => node.blur())
      // Programmatic click preserves the non-focusing tap behavior seen on phone buttons.
      await page.getByRole("button", { name: "MAX", exact: true }).evaluate((node) => node.click())
      assert.equal(await amount.evaluate((node) => node === document.activeElement), false, "ordinary form updates must not refocus a deliberately blurred field")
      await amount.fill("24")
      await page.getByRole("button", { name: "Send funds", exact: true }).click()
      const send = page.locator('dialog[aria-label="Send"]')
      await page.locator(".ww-pay__summary").waitFor()
      await send.evaluate((node) => node.close())
      await amount.waitFor()
      assert.equal(await send.evaluate((node) => node.matches(":modal")), true, "native close returns confirm to a visible amount step")
      assert.equal(await amount.evaluate((node) => node === document.activeElement), true)
      await page.keyboard.press("Escape")
      await send.waitFor({ state: "detached" })

      assert.deepEqual(verificationErrors(report), [])
      await context.close()
    }
  } finally {
    await browser.close()
    await server.close()
  }
})

function claimNotification(page, title) {
  return page.getByRole("dialog", { name: "Notifications", exact: true })
    .locator(`.ww-notifications__item:has(.ww-notifications__title:text-is("${title}"))`)
}

/** The claim's sheet closes into the bell; open it once the claim's row reaches `status`. */
async function openBellOnClaim(page, status) {
  await page.waitForFunction(async (wanted) => (await (await import("/scripts/ui-capture/fixtures/paylinks.ts")).capturePaylinkRows()).some((row) => row.kind === "paylink-claim" && row.status === wanted), status)
  await page.getByRole("button", { name: "Notifications", exact: true }).click()
}

async function capturedPaylinkRows(page) {
  return page.evaluate(async () => (await import("/scripts/ui-capture/fixtures/paylinks.ts")).capturePaylinkRows())
}

async function assertNotificationBounds(page, viewport, control) {
  await control.scrollIntoViewIfNeeded()
  await control.click({ trial: true })
  const sheet = await page.locator(".ww-modal.ww-notifications").boundingBox()
  const button = await control.boundingBox()
  assert.ok(sheet && button)
  assert.ok(sheet.x >= 0 && sheet.x + sheet.width <= viewport.width + 1)
  assert.ok(sheet.y >= 0 && sheet.y + sheet.height <= viewport.height + 1)
  assert.ok(sheet.width >= viewport.width - 1, "phone Notifications keeps its full sheet width")
  assert.ok(button.x >= 0 && button.x + button.width <= viewport.width)
  assert.ok(button.y >= 0 && button.y + button.height <= viewport.height)
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "claim handoff has no horizontal overflow")
}

test("phone claim notification opens the stored claim transaction, including no-signing completion", { timeout: 120_000 }, async () => {
  const { server, origin } = await startCaptureServer(Number(process.env.UI_CAPTURE_TEST_PORT ?? 5784))
  const browser = await loadChromium(path.resolve(walletDir, "../.."), process.env.PLAYWRIGHT_BROWSERS_PATH).launch({ headless: true })
  try {
    const cases = [
      { width: 390, height: 844, fixture: "success" },
      { width: 402, height: 879, fixture: "success" },
      { width: 390, height: 667, fixture: "success" },
      { width: 390, height: 667, fixture: "no-signing" },
    ]
    for (const { fixture, ...viewport } of cases) {
      const context = await browser.newContext({ viewport, serviceWorkers: "block" })
      try {
        const report = {}
        await context.grantPermissions(["local-network-access"], { origin })
        await installCaptureGuard(context, localBaseUrl(origin), report)
        const page = await context.newPage()
        await page.goto(`${origin}/link?demo=activity&flowFixture=${fixture}&flowEntry=visitor`)
        const prompt = page.getByRole("dialog", { name: "Claim your payment", exact: true })
        await prompt.waitFor()
        const fundingHash = await page.evaluate(async () => {
          const { demoClaimFragments } = await import("/src/dev/demoFixtures.ts")
          const { decodeLink } = await import("/scripts/ui-capture/fixtures/paylinks.ts")
          return decodeLink(demoClaimFragments().direct).txHash
        })
        await prompt.getByRole("button", { name: "Accept", exact: true }).click()
        const working = page.getByRole("dialog", { name: "Claiming payment", exact: true })
        await working.waitFor()
        assert.equal(await working.getByRole("button", { name: /^(Close|Cancel)$/ }).count(), 0)
        await working.waitFor({ state: "detached" })
        await openBellOnClaim(page, "success")
        const received = claimNotification(page, "Received")
        await received.waitFor()
        const rows = (await capturedPaylinkRows(page)).filter((row) => row.kind === "paylink-claim")
        assert.equal(rows.length, 1, "claim has one canonical receive row")
        assert.equal(rows[0].status, "success")
        assert.equal(rows[0].amount, 100)
        assert.match(rows[0].txHash, /^0x[0-9a-f]{64}$/)
        assert.notEqual(rows[0].txHash, fundingHash, "claim result must not reuse its funding hash")
        await assertNotificationBounds(page, viewport, received.locator(".ww-notifications__row"))
        await received.locator(".ww-notifications__row").click()
        await page.getByRole("dialog", { name: "Notifications", exact: true }).waitFor({ state: "detached" })
        const detail = page.locator(".ww-txd")
        await detail.waitFor()
        assert.ok((await detail.locator(".ww-txd__hash").getAttribute("href")).endsWith(rows[0].txHash), "notification selects the exact stored claim transaction")
        await detail.getByRole("button", { name: "Close", exact: true }).click()
        await page.getByRole("button", { name: "Notifications", exact: true }).click()
        // The claim's outcome is its operation, read off the store: opening it marks it read.
        await claimNotification(page, "Received").locator('[aria-label="Unread"]').waitFor({ state: "detached" })
        assert.deepEqual(verificationErrors(report), [])
      } finally {
        await context.close()
      }
    }
  } finally {
    await browser.close()
    await server.close()
  }
})

test("claim signing, pending and failure fixtures preserve notification and busy-dialog guards", { timeout: 120_000 }, async () => {
  const { server, origin } = await startCaptureServer(Number(process.env.UI_CAPTURE_TEST_PORT ?? 5784))
  const browser = await loadChromium(path.resolve(walletDir, "../.."), process.env.PLAYWRIGHT_BROWSERS_PATH).launch({ headless: true })
  const viewport = { width: 390, height: 667 }
  try {
    for (const fixture of ["signing", "pending", "signing-retry", "post-signing-failure"]) {
      const context = await browser.newContext({ viewport, serviceWorkers: "block" })
      try {
        const report = {}
        await context.grantPermissions(["local-network-access"], { origin })
        await installCaptureGuard(context, localBaseUrl(origin), report)
        const page = await context.newPage()
        await page.goto(`${origin}/link?demo=activity&flowFixture=${fixture}&flowEntry=visitor`)
        const prompt = page.getByRole("dialog", { name: "Claim your payment", exact: true })
        await prompt.getByRole("button", { name: "Accept", exact: true }).click()
        const working = page.getByRole("dialog", { name: "Claiming payment", exact: true })
        await working.waitFor()
        if (fixture === "signing") {
          await working.getByText("Confirm with passkey...", { exact: true }).waitFor()
          assert.equal(await working.getByRole("button", { name: /^(Close|Cancel)$/ }).count(), 0)
          await page.keyboard.press("Escape")
          assert.equal(await working.evaluate((node) => node.matches(":modal")), true)
          await working.evaluate((node) => node.close())
          await page.waitForFunction(() => document.querySelector('dialog[aria-label="Claiming payment"]')?.matches(":modal"))
          assert.equal(await page.getByRole("dialog", { name: "Notifications", exact: true }).count(), 0)
        } else if (fixture === "pending") {
          // Past the hand-off the bell holds the running claim and says the tab must stay open.
          await working.waitFor({ state: "detached" })
          await page.getByRole("button", { name: "Notifications, keep this tab open", exact: true }).click()
          const item = claimNotification(page, "Receiving")
          await item.waitFor()
          assert.equal(await item.locator(".ww-notifications__dismiss").count(), 0)
          await assertNotificationBounds(page, viewport, item.locator(".ww-notifications__row"))
          const rows = await capturedPaylinkRows(page)
          assert.equal(rows.length, 1)
          assert.equal(rows[0].status, "pending")
          assert.equal(rows[0].txHash, "")
        } else if (fixture === "signing-retry") {
          await prompt.waitFor()
          assert.equal(await page.getByRole("dialog", { name: "Notifications", exact: true }).count(), 0, "failed signing does not hand off")
          const failed = await capturedPaylinkRows(page)
          assert.equal(failed.length, 1)
          assert.equal(failed[0].status, "failed")
          assert.equal(failed[0].txHash, "")
          await prompt.getByRole("button", { name: "Accept", exact: true }).click()
          await working.waitFor({ state: "detached" })
          await openBellOnClaim(page, "success")
          await claimNotification(page, "Received").waitFor()
          const retried = await capturedPaylinkRows(page)
          assert.equal(retried.length, 2)
          assert.equal(new Set(retried.map((row) => row.operationId)).size, 2)
          assert.equal(retried.filter((row) => row.status === "success").length, 1)
        } else {
          await working.waitFor({ state: "detached" })
          await openBellOnClaim(page, "failed")
          const item = claimNotification(page, "Claim failed")
          await item.waitFor()
          assert.equal(await prompt.count(), 0, "a failure past the hand-off is owned by Notifications")
          const rows = await capturedPaylinkRows(page)
          assert.equal(rows.length, 1)
          assert.equal(rows[0].status, "failed")
          assert.equal(rows[0].txHash, "")
          const dismiss = item.locator(".ww-notifications__dismiss")
          await assertNotificationBounds(page, viewport, dismiss)
          await dismiss.click()
          await item.waitFor({ state: "detached" })
        }
        const expectedError = fixture === "signing-retry"
          ? "paylink claim failed Error: The signing request was declined. Try again."
          : fixture === "post-signing-failure"
            ? "paylink claim failed Error: The transaction could not be submitted. Try again."
            : null
        assert.equal(report.consoleErrors.length, expectedError ? 1 : 0)
        if (expectedError) assert.equal(report.consoleErrors[0].split("\n")[0], expectedError)
        assert.deepEqual(verificationErrors(report, { failOnConsoleError: false }), [])
      } finally {
        await context.close()
      }
    }
  } finally {
    await browser.close()
    await server.close()
  }
})

test("prepared creator link opens pending details and settles in the same sheet", { timeout: 60_000 }, async () => {
  const plan = JSON.parse(await readFile(new URL("../plans/flows/paylinks.json", import.meta.url), "utf8"))
  const { server, origin } = await startCaptureServer(Number(process.env.UI_CAPTURE_TEST_PORT ?? 5784))
  const browser = await loadChromium(path.resolve(walletDir, "../.."), process.env.PLAYWRIGHT_BROWSERS_PATH).launch({ headless: true })
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 667 }, serviceWorkers: "block" })
    try {
      const report = {}
      await context.grantPermissions(["local-network-access"], { origin })
      await installCaptureGuard(context, localBaseUrl(origin), report)
      const page = await context.newPage()
      await page.goto(`${origin}/links/new?demo=activity&flowFixture=success`)
      for (const step of plan.steps) {
        await runStep(page, step, { timeout: 30_000, base: localBaseUrl(origin), shot: async () => {} })
        if (step.action === "click" && step.name === "Create paylink") break
      }
      await page.locator(".ww-txd__notice--live").waitFor()
      const card = await page.locator(".ww-txd").elementHandle()
      const pending = (await capturedPaylinkRows(page)).find((row) => row.kind === "paylink-create")
      assert.equal(pending.status, "pending")
      assert.equal(pending.txHash, "")
      const preparedHash = await page.evaluate(async (url) => {
        const { decodeLink } = await import("/scripts/ui-capture/fixtures/paylinks.ts")
        return decodeLink(new URL(url).hash.slice(1)).txHash
      }, pending.paylink)
      assert.equal(preparedHash, undefined)
      await page.waitForFunction(async () => (await (await import("/scripts/ui-capture/fixtures/paylinks.ts")).capturePaylinkRows()).some((row) => row.kind === "paylink-create" && row.status === "success"))
      await page.locator(".ww-txd__notice--live").waitFor({ state: "detached" })
      const settled = (await capturedPaylinkRows(page)).find((row) => row.operationId === pending.operationId)
      assert.equal(settled.secret, pending.secret)
      assert.notEqual(settled.paylink, pending.paylink)
      assert.equal(await card.evaluate((node) => node.isConnected), true)
      assert.ok((await page.locator(".ww-txd__hash").getAttribute("href")).endsWith(settled.txHash))
      assert.deepEqual(verificationErrors(report), [])
    } finally {
      await context.close()
    }
  } finally {
    await browser.close()
    await server.close()
  }
})
test("phone paylink details keep the expiry information inside the sheet gutter", { timeout: 120_000 }, async () => {
  const plan = JSON.parse(await readFile(new URL("../plans/flows/paylinks.json", import.meta.url), "utf8"))
  const { server, origin } = await startCaptureServer(Number(process.env.UI_CAPTURE_TEST_PORT ?? 5784))
  const browser = await loadChromium(path.resolve(walletDir, "../.."), process.env.PLAYWRIGHT_BROWSERS_PATH).launch({ headless: true })
  try {
    for (const [index, viewport] of [{ width: 390, height: 844 }, { width: 402, height: 879 }, { width: 390, height: 667 }, { width: 390, height: 667 }].entries()) {
      const context = await browser.newContext({ viewport, serviceWorkers: "block" })
      const report = {}
      await context.grantPermissions(["local-network-access"], { origin })
      await installCaptureGuard(context, localBaseUrl(origin), report)
      const page = await context.newPage()
      await page.clock.setFixedTime(new Date("2026-09-01T12:00:00.000Z"))
      await page.goto(`${origin}/?demo=activity`)
      await page.locator(".ww-shell").waitFor()
      await page.goto(`${origin}${plan.path}`)
      if (index === 3) await page.evaluate(() => {
        for (const [edge, value] of Object.entries({ top: 20, right: 12, bottom: 34, left: 12 })) {
          document.documentElement.style.setProperty(`--ww-safe-area-${edge}`, `${value}px`, "important")
        }
      })
      for (const step of plan.steps) {
        await runStep(page, step, { timeout: 30_000, base: localBaseUrl(origin), shot: async () => {} })
        if (step.file === "created-controls.png") break
      }
      const information = page.locator(".ww-txd__info")
      await information.scrollIntoViewIfNeeded()
      const parent = await information.boundingBox()
      const option = await information.locator(".ww-send-option").boundingBox()
      const text = await information.locator(".ww-send-option__text").boundingBox()
      console.log("PAYLINK_INFO_BOUNDS", JSON.stringify({ viewport, simulatedInsets: index === 3, parent, option, text }))
      assert.ok(option.x >= parent.x - 1 && option.x + option.width <= parent.x + parent.width + 1, "expiry card stays inside the sheet content gutter")
      assert.ok(text.x + text.width <= option.x + option.width - 1, "expiry text keeps padding inside its card")
      assert.ok(await page.locator(".ww-txd").evaluate((node) => node.scrollWidth <= node.clientWidth + 1), "details have no horizontal scrolling")
      assert.deepEqual(verificationErrors(report), [])
      await context.close()
    }
  } finally {
    await browser.close()
    await server.close()
  }
})
