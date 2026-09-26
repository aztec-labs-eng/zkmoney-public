// @vitest-environment node
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import path from "node:path"
import { chromium, type Browser } from "@playwright/test"
import { renderToStaticMarkup } from "react-dom/server"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { GradientQrCard } from "../../src/ui/GradientQrCard"
import { decodeQrImage } from "../../src/features/scan/decodeQrImage"
import { walletQrCorpus } from "../fixtures/scanPayloads"

const corpus = await walletQrCorpus()
const css = readFileSync(new URL("../../src/ui/shell.css", import.meta.url), "utf8")
const output = mkdtempSync(path.join(tmpdir(), "ult-785-qr-cards-"))
const evidence: object[] = []
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex")
const decoderSources = Object.fromEntries(["decodeQrImage.ts", "qrFrame.ts"].map((file) => [
  file, sha256(readFileSync(new URL(`../../src/features/scan/${file}`, import.meta.url))),
]))

describe("wallet share cards read by the scanner decoder", () => {
  let browser: Browser
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true })
  })
  afterAll(async () => {
    await browser?.close()
    writeFileSync(path.join(output, "report.json"), JSON.stringify({ decoderSources, cssSha256: sha256(css), evidence }, null, 2))
    console.info(`QR card evidence: ${output}`)
  })
  for (const [width, height] of [
    [390, 844],
    [402, 879],
    [390, 667],
    [1280, 832],
  ]) {
    for (const [name, payload] of Object.entries(corpus)) {
      it(`${name} at ${width}x${height} preserves the complete payload`, async () => {
        const context = await browser.newContext({
          viewport: { width, height },
          serviceWorkers: "block",
        })
        await context.route("**/*", (route) => route.abort())
        const page = await context.newPage()
        try {
          const card = renderToStaticMarkup(
            <GradientQrCard
              payload={payload}
              label="Wallet link"
              ariaLabel="Wallet QR code"
              copied={false}
              onCopy={() => {}}
            />,
          )
          await page.setContent(`<style>body{margin:0;background:#070707} ${css}</style>
            <div class="ww-shell"><div class="ww-modal-overlay"><div class="ww-modal ww-modal--create">${card}</div></div></div>`)
          const screenshot = await page.locator(".ww-qr-card__code").screenshot()
          const pixels = await page.evaluate(async (encoded) => {
            const image = new Image()
            image.src = `data:image/png;base64,${encoded}`
            await image.decode()
            const canvas = document.createElement("canvas")
            canvas.width = image.naturalWidth
            canvas.height = image.naturalHeight
            const drawing = canvas.getContext("2d")!
            drawing.drawImage(image, 0, 0)
            return {
              data: Array.from(drawing.getImageData(0, 0, canvas.width, canvas.height).data),
              width: canvas.width,
              height: canvas.height,
            }
          }, screenshot.toString("base64"))
          const decoded = decodeQrImage(
            new Uint8ClampedArray(pixels.data),
            pixels.width,
            pixels.height,
          )
          const file = `${name}-${width}x${height}.png`
          writeFileSync(path.join(output, file), screenshot)
          evidence.push({
            name,
            viewport: { width, height },
            qrWidth: pixels.width,
            payload,
            decoded,
            passed: decoded === payload,
            file,
            sha256: sha256(screenshot),
          })
          expect(decoded).toBe(payload)
        } finally {
          await context.close()
        }
      }, 20_000)
    }
  }
})
