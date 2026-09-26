// @vitest-environment node
import { readFileSync, mkdirSync, writeFileSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { chromium, type Browser } from "@playwright/test"
import { renderToStaticMarkup } from "react-dom/server"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import jsQR from "jsqr"
import { Network, MAX_TAG_LENGTH } from "@obsidion/core/constants"
import { decodeInline, parseConnectLink, qrPayloadDisplayLabel } from "@obsidion/front-core"
import { GradientQrCard } from "../src/ui/GradientQrCard"
import { mintMyConnectLink } from "../src/features/contacts/myCode"

const baseline = process.env.QR_BASELINE_CSS
const css = readFileSync(baseline ?? new URL("../src/ui/shell.css", import.meta.url), "utf8")
const viewports = [
  { width: 390, height: 844 },
  { width: 402, height: 879 },
  { width: 390, height: 667 },
  { width: 1280, height: 832 },
  { width: 402, height: 678 },
  { width: 390, height: 667, insets: { top: 20, right: 12, bottom: 34, left: 12 } },
]
const packets = [
  { name: "tagged", tag: "alice", origin: "https://wallet.staging.zk.money" },
  { name: "tagless", tag: undefined, origin: "https://wallet.staging.zk.money" },
  {
    name: "long",
    tag: "a".repeat(MAX_TAG_LENGTH),
    origin: `https://${"preview".repeat(9)}.${"branch".repeat(10)}.zk.money`,
  },
]

describe("generated white-on-gradient connect QR compatibility", () => {
  let browser: Browser
  const output = process.env.QR_EVIDENCE_DIR ?? mkdtempSync(path.join(tmpdir(), "wallet-qr-"))
  const evidence: object[] = []
  beforeAll(async () => {
    mkdirSync(output, { recursive: true })
    browser = await chromium.launch({ headless: true })
  })
  afterAll(async () => {
    await browser?.close()
    writeFileSync(path.join(output, "report.json"), JSON.stringify(evidence, null, 2))
    console.info(`QR pixel decode evidence: ${output}`)
  })

  for (const viewport of viewports)
    for (const packet of packets) {
      it(`${packet.name} at ${viewport.width}x${viewport.height}${
        viewport.insets ? " with safe areas" : ""
      }: ${
        baseline
          ? "baseline measurement"
          : viewport.width <= 640
          ? "full payload decode"
          : "unchanged desktop rendering"
      }`, async () => {
        const payload = await mintMyConnectLink({
          ownTag: packet.tag,
          masterSecret: { toString: () => `0x${(0x1234abcdn).toString(16).padStart(64, "0")}` },
          chain: Network.TESTNET,
          l2Address: "0x" + "2".repeat(64),
          origin: packet.origin,
          record: async () => {},
          uuid: () => "a1b2c3d4-e5f6-4a7b-89ab-cdef01234567",
          now: () => 1_753_000_000_000,
        })
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: 1,
          serviceWorkers: "block",
        })
        await context.route("**/*", (route) => route.abort())
        const page = await context.newPage()
        try {
          const card = renderToStaticMarkup(
            <GradientQrCard
              payload={payload}
              label={qrPayloadDisplayLabel(payload)}
              ariaLabel="My connect QR code"
              copied={false}
              onCopy={() => {}}
            />,
          )
          await page.setContent(`<style>:root { --surface-sheet:#212121; --surface-dark:#070707; --space-24:24px; --radius-32:32px; }
          body { margin:0; background:#070707; } ${css}</style>
          <div class="ww-shell"><div class="ww-modal-overlay"><div class="ww-modal ww-modal--create ww-share-tag-modal">${card}</div></div></div>`)
          if (viewport.insets)
            await page.addStyleTag({
              content: `:root { ${Object.entries(viewport.insets)
                .map(([edge, value]) => `--ww-safe-area-${edge}: ${value}px;`)
                .join(" ")} }`,
            })
          const image = await page
            .locator(".ww-qr-card__code")
            .screenshot({ animations: "disabled" })
          const decodedPixels = await page.evaluate(async (base64) => {
            const source = new Image()
            source.src = `data:image/png;base64,${base64}`
            await source.decode()
            const canvas = document.createElement("canvas")
            canvas.width = source.naturalWidth
            canvas.height = source.naturalHeight
            const drawing = canvas.getContext("2d")!
            drawing.drawImage(source, 0, 0)
            return {
              data: Array.from(drawing.getImageData(0, 0, canvas.width, canvas.height).data),
              width: canvas.width,
              height: canvas.height,
            }
          }, image.toString("base64"))
          const decoded = jsQR(
            new Uint8ClampedArray(decodedPixels.data),
            decodedPixels.width,
            decodedPixels.height,
            { inversionAttempts: "attemptBoth" },
          )
          const filename = `${packet.name}-${viewport.width}x${viewport.height}${
            viewport.insets ? "-insets" : ""
          }.png`
          writeFileSync(path.join(output, filename), image)
          const desktopOverlay = viewport.width > 640
            ? await page.locator(".ww-qr-card__code").evaluate((element) => getComputedStyle(element).backgroundColor)
            : undefined
          const decodePassed = decoded?.data === payload
          evidence.push({
            packet: packet.name,
            viewport,
            qrSize: decodedPixels.width,
            payload,
            decoded: decoded?.data,
            check: baseline ? "baseline-measurement" : viewport.width <= 640 ? "phone-payload-decode" : "desktop-overlay-preservation",
            decodePassed,
            desktopOverlay,
            passed: baseline ? null : viewport.width <= 640 ? decodePassed : desktopOverlay === "rgba(253, 253, 253, 0.2)",
            screenshot: filename,
            decoder: "jsqr@1.4.0",
            source: "GradientQrCard + mintMyConnectLink",
          })
          if (!baseline && viewport.width <= 640) expect(decoded?.data).toBe(payload)
          if (viewport.width > 640) {
            expect(desktopOverlay).toBe("rgba(253, 253, 253, 0.2)")
          }
          if (decoded)
            expect(decodeInline(parseConnectLink(decoded.data)!)).toMatchObject({
              kind: "handshake",
              uuid: "a1b2c3d4-e5f6-4a7b-89ab-cdef01234567",
              l2Address: "0x" + "2".repeat(64),
            })
        } finally {
          await context.close()
        }
      }, 20_000)
    }
})
