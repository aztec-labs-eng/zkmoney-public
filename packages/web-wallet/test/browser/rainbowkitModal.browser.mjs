import assert from "node:assert/strict"
import { test } from "node:test"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import { chromium } from "@playwright/test"

const walletDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

test("RainbowKit remains interactive above retained native sheets and restores nested focus", { timeout: 120_000 }, async () => {
  const server = await createServer({
    root: walletDir, configFile: false, envFile: false, logLevel: "error",
    resolve: { alias: { "@obsidion/web-ds": path.resolve(walletDir, "../design-system/src/index.ts") } },
    esbuild: { jsx: "automatic" },
    optimizeDeps: { entries: ["test/browser/rainbowkit.fixture.tsx"] },
    server: { host: "127.0.0.1", port: 0 },
    plugins: [{ name: "modal-fixture", configureServer(vite) {
      vite.middlewares.use((req, res, next) => {
        if (req.url !== "/") return next()
        res.setHeader("Content-Type", "text/html")
        res.end('<div id="root"></div><script type="module" src="/test/browser/rainbowkit.fixture.tsx"></script>')
      })
    } }],
  })
  let browser
  try {
    await server.listen()
    browser = await chromium.launch({ headless: true })
    for (const viewport of [{ width: 390, height: 667 }, { width: 1280, height: 832 }]) {
      const page = await browser.newPage({ viewport })
      page.setDefaultTimeout(15_000)
      const errors = []
      page.on("pageerror", (error) => errors.push(error.message))
      const origin = server.resolvedUrls.local[0]
      await page.route("**/*", (route) => route.request().url().startsWith(origin) ? route.continue() : route.abort())
      await page.goto(origin)
      await page.getByRole("button", { name: "Open sheet", exact: true }).click()
      const amount = page.getByRole("textbox", { name: "Amount" })
      await amount.fill("123")
      for (const nested of [false, true]) {
        if (nested) await page.getByRole("button", { name: "Open nested", exact: true }).click()
        const connect = page.getByRole("button", { name: nested ? "Connect nested wallet" : "Connect wallet", exact: true })
        await connect.click()
        const picker = page.locator('[data-rk][role="dialog"]')
        await picker.waitFor({ state: "visible" })
        assert.equal(await page.locator("dialog:modal").count(), 0, "Native sheets must yield the top layer to RainbowKit")
        const wallet = picker.getByRole("button", { name: "MetaMask", exact: true })
        await wallet.focus()
        assert.equal(await wallet.evaluate((node) => node === document.activeElement), true, "Wallet picker accepts keyboard focus")
        await wallet.click()
        await page.keyboard.press("Escape")
        await picker.waitFor({ state: "detached" })
        assert.equal(await page.locator("dialog:modal").count(), nested ? 2 : 1)
        assert.equal(await connect.evaluate((node) => node === document.activeElement), true, "Focus returns to the wallet button")
        if (nested) await page.keyboard.press("Escape")
        assert.equal(await amount.inputValue(), "123", "The deposit form survives connection cancellation")
      }
      await page.keyboard.press("Escape")
      assert.equal(await page.locator("dialog:modal").count(), 0)
      assert.equal(await page.getByRole("button", { name: "Open sheet", exact: true }).evaluate((node) => node === document.activeElement), true)
      assert.deepEqual(errors, [])
      await page.close()
    }
  } finally {
    await browser?.close()
    await server.close()
  }
})
