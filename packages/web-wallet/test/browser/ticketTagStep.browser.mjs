import assert from "node:assert/strict"
import { test } from "node:test"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import { chromium } from "@playwright/test"

const walletDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

// The two-column card through the real cascade, which jsdom cannot check.
test("the golden ticket tag step splits into two columns from 960px", { timeout: 180_000 }, async () => {
  const server = await createServer({
    root: walletDir, envDir: false, logLevel: "error", server: { host: "127.0.0.1", port: 0 },
    plugins: [{ name: "ticket-fixture", configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url !== "/") return next()
        res.setHeader("Content-Type", "text/html")
        // The app's React plugin needs its preamble, which only a transformed page carries.
        res.end(await vite.transformIndexHtml("/", '<div id="root"></div><script type="module" src="/test/browser/ticketTagStep.fixture.tsx"></script>'))
      })
    } }],
  })
  let browser
  try {
    await server.listen()
    browser = await chromium.launch({ headless: true })
    for (const width of [959, 960]) {
      // Motion off: the phone intro's endless shine would never let the animation wait below settle.
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" })
      const origin = server.resolvedUrls.local[0]
      await page.route("**/*", (route) => route.request().url().startsWith(origin) ? route.continue() : route.abort())
      await page.goto(origin)
      const [card, main, art] = [".ww-ticket-step", ".ww-ticket-step__main", '[data-testid="ticket-art"]'].map((s) => page.locator(s))
      await main.waitFor({ state: "visible" })
      await card.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)))
      const cardBox = await card.boundingBox()
      if (width < 960) {
        assert.equal(await art.isVisible(), false, `${width}px: no art column`)
        assert.equal(cardBox.width, 500, `${width}px: the one-column card`)
      } else {
        assert.equal(await art.isVisible(), true, `${width}px: the art column shows`)
        assert.equal(cardBox.width, 896, `${width}px: the card widens`)
        const [m, a] = [await main.boundingBox(), await art.boundingBox()]
        assert.ok(a.x >= m.x + m.width && Math.abs(a.y - m.y) < 1, `${width}px: art sits beside the form`)
      }
      await page.close()
    }
  } finally {
    await browser?.close()
    await server.close()
  }
})
