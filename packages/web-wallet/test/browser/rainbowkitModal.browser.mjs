import assert from "node:assert/strict"
import { test } from "node:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "vite"
import { chromium } from "@playwright/test"

const walletDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

test(
  "RainbowKit remains interactive above retained native sheets and restores nested focus",
  { timeout: 120_000 },
  async () => {
    // The fixture built once, as the wallet builds, into a directory of this run's own, then served as files: no
    // on-demand compile or dependency pre-bundle while the page loads, and no write to the package's Vite cache.
    const outDir = mkdtempSync(path.join(tmpdir(), "rainbowkit-modal-"))
    await build({
      root: walletDir,
      configFile: false,
      envFile: false,
      logLevel: "error",
      cacheDir: path.join(outDir, ".vite"),
      resolve: {
        alias: { "@obsidion/web-ds": path.resolve(walletDir, "../design-system/src/index.ts") },
      },
      esbuild: { jsx: "automatic" },
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
      build: {
        outDir: path.join(outDir, "dist"),
        minify: false,
        cssCodeSplit: false,
        lib: {
          entry: path.resolve(walletDir, "test/browser/rainbowkit.fixture.tsx"),
          formats: ["es"],
          fileName: "page",
        },
      },
    })
    const dist = path.join(outDir, "dist")
    const css = readdirSync(dist).find((name) => name.endsWith(".css"))
    const types = {
      ".js": "text/javascript",
      ".css": "text/css",
      ".svg": "image/svg+xml",
      ".png": "image/png",
    }
    const server = createServer((req, res) => {
      if (req.url === "/") {
        res.writeHead(200, { "content-type": "text/html" })
        return res.end(
          `<link rel="stylesheet" href="/${css}"><div id="root"></div><script type="module" src="/page.js"></script>`,
        )
      }
      const file = path.join(dist, decodeURIComponent(req.url.split("?")[0]))
      if (!file.startsWith(dist + path.sep) || !existsSync(file)) return res.writeHead(404).end()
      res.writeHead(200, {
        "content-type": types[path.extname(file)] ?? "application/octet-stream",
      })
      res.end(readFileSync(file))
    })
    let browser
    try {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
      browser = await chromium.launch({ headless: true })
      for (const viewport of [
        { width: 390, height: 667 },
        { width: 1280, height: 832 },
      ]) {
        const page = await browser.newPage({ viewport })
        page.setDefaultTimeout(15_000)
        const errors = []
        page.on("pageerror", (error) => errors.push(error.message))
        const origin = `http://127.0.0.1:${server.address().port}/`
        await page.route("**/*", (route) =>
          route.request().url().startsWith(origin) ? route.continue() : route.abort(),
        )
        await page.goto(origin)
        await page.getByRole("button", { name: "Open sheet", exact: true }).click()
        const amount = page.getByRole("textbox", { name: "Amount" })
        await amount.fill("123")
        for (const nested of [false, true]) {
          if (nested) await page.getByRole("button", { name: "Open nested", exact: true }).click()
          const connect = page.getByRole("button", {
            name: nested ? "Connect nested wallet" : "Connect wallet",
            exact: true,
          })
          await connect.click()
          const picker = page.locator('[data-rk][role="dialog"]')
          await picker.waitFor({ state: "visible" })
          assert.equal(
            await page.locator("dialog:modal").count(),
            0,
            "Native sheets must yield the top layer to RainbowKit",
          )
          const wallet = picker.getByRole("button", { name: "MetaMask", exact: true })
          await wallet.focus()
          assert.equal(
            await wallet.evaluate((node) => node === document.activeElement),
            true,
            "Wallet picker accepts keyboard focus",
          )
          await wallet.click()
          await page.keyboard.press("Escape")
          await picker.waitFor({ state: "detached" })
          assert.equal(await page.locator("dialog:modal").count(), nested ? 2 : 1)
          assert.equal(
            await connect.evaluate((node) => node === document.activeElement),
            true,
            "Focus returns to the wallet button",
          )
          if (nested) await page.keyboard.press("Escape")
          assert.equal(
            await amount.inputValue(),
            "123",
            "The deposit form survives connection cancellation",
          )
        }
        await page.keyboard.press("Escape")
        assert.equal(await page.locator("dialog:modal").count(), 0)
        assert.equal(
          await page
            .getByRole("button", { name: "Open sheet", exact: true })
            .evaluate((node) => node === document.activeElement),
          true,
        )
        assert.deepEqual(errors, [])
        await page.close()
      }
    } finally {
      await browser?.close()
      await new Promise((resolve) => server.close(resolve))
      rmSync(outDir, { recursive: true, force: true })
    }
  },
)
