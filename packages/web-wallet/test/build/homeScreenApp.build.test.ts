// @vitest-environment node
/**
 * What a phone reads to add the wallet to its Home Screen: the manifest, the icons and, through a
 * real, minimal `vite build` of the wallet's own index.html, the launch screens in every page.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import zlib from "node:zlib"
import { build, type Rollup } from "vite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { socialPreview } from "../../socialPreview"
import { startupImages } from "../../startupImages"

const PACKAGE = join(__dirname, "../..")
const INDEX_HTML = readFileSync(join(PACKAGE, "index.html"), "utf8")
const publicFile = (path: string) => readFileSync(join(PACKAGE, "public", path))

// Node 24's; @types/node 18 predates it.
const { crc32 } = zlib as unknown as { crc32(data: Uint8Array): number }

function png(bytes: Uint8Array) {
  const buf = Buffer.from(bytes)
  expect(buf.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  const chunks: Record<string, Buffer[]> = {}
  for (let at = 8; at < buf.length; ) {
    const length = buf.readUInt32BE(at)
    const type = buf.toString("latin1", at + 4, at + 8)
    expect(buf.readUInt32BE(at + 8 + length), `${type} CRC`).toBe(
      crc32(buf.subarray(at + 4, at + 8 + length)),
    )
    ;(chunks[type] ??= []).push(buf.subarray(at + 8, at + 8 + length))
    at += length + 12
  }
  const header = chunks.IHDR[0]
  return {
    width: header.readUInt32BE(0),
    height: header.readUInt32BE(4),
    bitDepth: header[8],
    colorType: header[9],
    chunks,
  }
}

// Grayscale, RGB, or a palette without a transparency chunk.
const isOpaque = ({ colorType, chunks }: ReturnType<typeof png>) =>
  colorType === 0 || colorType === 2 || (colorType === 3 && !chunks.tRNS)

describe("Home Screen manifest and icons", () => {
  it("links the manifest and an opaque 180×180 touch icon from index.html", () => {
    const href = (rel: string) =>
      INDEX_HTML.match(new RegExp(`<link rel="${rel}" href="([^"]+)"`))?.[1]
    expect(href("manifest")).toBe("/manifest.webmanifest")
    expect(href("apple-touch-icon")).toBe("/apple-touch-icon.png")
    const icon = png(publicFile("apple-touch-icon.png"))
    expect([icon.width, icon.height, isOpaque(icon)]).toEqual([180, 180, true])
  })

  it("names opaque icons of their declared sizes, each also maskable", () => {
    const manifest = JSON.parse(publicFile("manifest.webmanifest").toString("utf8"))
    expect(manifest).toMatchObject({ start_url: "/", scope: "/", display: "standalone" })
    for (const { src, sizes, type } of manifest.icons) {
      const icon = png(publicFile(src.slice(1)))
      expect([`${icon.width}x${icon.height}`, type, isOpaque(icon)], src).toEqual([
        sizes,
        "image/png",
        true,
      ])
    }
    const purposes = (src: string) =>
      manifest.icons
        .filter((i: { src: string }) => i.src === src)
        .map((i: { purpose?: string }) => i.purpose ?? "any")
    expect(purposes("/icon-192.png")).toEqual(["any", "maskable"])
    expect(purposes("/icon-512.png")).toEqual(["any", "maskable"])
  })
})

describe("startupImages", () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "startup-images-"))
    mkdirSync(join(root, "src"))
    writeFileSync(join(root, "src/boot.tsx"), 'document.body.dataset.booted = "yes"\n')
    writeFileSync(join(root, "index.html"), INDEX_HTML)
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  async function buildBundle(
    env: Record<string, string> = {},
  ): Promise<Map<string, Uint8Array | string>> {
    const result = (await build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [startupImages(env), socialPreview(env)],
      build: { write: false },
    })) as Rollup.RollupOutput | Rollup.RollupOutput[]
    const output = (Array.isArray(result) ? result[0] : result).output
    return new Map(
      output
        .filter((o): o is Rollup.OutputAsset => o.type === "asset")
        .map((o) => [o.fileName, o.source]),
    )
  }

  const startupLinks = (html: string) =>
    new Map(
      [
        ...html.matchAll(/<link rel="apple-touch-startup-image" href="([^"]+)" media="([^"]+)">/g),
      ].map(([, href, media]) => [href, media]),
    )

  it("gives every page a launch screen per iOS screen and orientation", async () => {
    const bundle = await buildBundle()
    const pages = ["index.html", "link.html", "request.html", "pay.html"]
    const links = startupLinks(String(bundle.get("index.html")))
    for (const page of pages) expect(startupLinks(String(bundle.get(page)))).toEqual(links)

    const screen = (width: number, height: number, ratio: number, orientation: string) =>
      `(device-width: ${width}px) and (device-height: ${height}px) and (-webkit-device-pixel-ratio: ${ratio}) and (orientation: ${orientation})`
    expect(links.get("/startup/1206x2622.png")).toBe(screen(402, 874, 3, "portrait"))
    expect(links.get("/startup/2622x1206.png")).toBe(screen(402, 874, 3, "landscape"))
    expect(links.get("/startup/1320x2868.png")).toBe(screen(440, 956, 3, "portrait"))
    expect(links.get("/startup/750x1334.png")).toBe(screen(375, 667, 2, "portrait"))
    expect(links.get("/startup/2752x2064.png")).toBe(screen(1032, 1376, 2, "landscape"))
    expect(links.get("/startup/1878x2670.png")).toBe(screen(626, 890, 3, "portrait"))
  })

  it("fills each launch screen, at its size, with the boot screen's dark background", async () => {
    const bundle = await buildBundle()
    const bootBackground = INDEX_HTML.match(/--boot-bg: #([0-9a-f]{6});/)![1]
    for (const href of startupLinks(String(bundle.get("index.html"))).keys()) {
      const image = png(bundle.get(href.slice(1)) as Uint8Array)
      const [, width, height] = href.match(/(\d+)x(\d+)\.png$/)!.map(Number)
      expect([image.width, image.height], href).toEqual([width, height])
      // A one-entry palette: every pixel is that color.
      expect([image.colorType, image.chunks.PLTE[0].toString("hex")], href).toEqual([
        3,
        bootBackground,
      ])
      const rows = zlib.inflateSync(Buffer.concat(image.chunks.IDAT))
      expect(rows.length, href).toBe(height * (1 + Math.ceil((width * image.bitDepth) / 8)))
      expect(
        rows.every((byte) => byte === 0),
        href,
      ).toBe(true)
    }
  })

  it("leaves the desktop build without launch screens", async () => {
    const bundle = await buildBundle({ VITE_DESKTOP_BUILD: "true" })
    expect(startupLinks(String(bundle.get("index.html"))).size).toBe(0)
    expect([...bundle.keys()].filter((name) => name.startsWith("startup/"))).toEqual([])
  })
})
