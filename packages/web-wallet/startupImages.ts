import { deflateSync } from "node:zlib"
import type { Plugin } from "vite"

/** iOS screens as portrait CSS points and device pixel ratio (ios-resolution.com). */
const SCREENS: readonly (readonly [width: number, height: number, ratio: number])[] = [
  [320, 568, 2],
  [375, 667, 2],
  [414, 736, 3],
  [375, 812, 3],
  [414, 896, 2],
  [414, 896, 3],
  [390, 844, 3],
  [428, 926, 3],
  [393, 852, 3],
  [430, 932, 3],
  [402, 874, 3],
  [440, 956, 3],
  [420, 912, 3],
  [466, 678, 3],
  [626, 890, 3],
  [768, 1024, 2],
  [810, 1080, 2],
  [820, 1180, 2],
  [744, 1133, 2],
  [834, 1112, 2],
  [834, 1194, 2],
  [834, 1210, 2],
  [1024, 1366, 2],
  [1032, 1376, 2],
]

/** index.html's dark `--boot-bg`, the first color the wallet paints. */
const BOOT_BACKGROUND = [0x07, 0x07, 0x07]

export const STARTUP_IMAGE_PATH = /^\/startup\/\d+x\d+\.png$/

const STARTUP_IMAGES = SCREENS.flatMap(([width, height, ratio]) =>
  (["portrait", "landscape"] as const).map((orientation) => {
    const [w, h] = orientation === "portrait" ? [width, height] : [height, width]
    return {
      fileName: `startup/${w * ratio}x${h * ratio}.png`,
      width: w * ratio,
      height: h * ratio,
      // iOS reports device-width and device-height in portrait in either orientation.
      media: `(device-width: ${width}px) and (device-height: ${height}px) and (-webkit-device-pixel-ratio: ${ratio}) and (orientation: ${orientation})`,
    }
  }),
)

/**
 * The Home Screen web app's launch screens. Without one that matches the screen, iOS can launch it
 * on white; these are the boot screen's background, so the launch hands over to it without a flash.
 * The desktop app has no Home Screen.
 */
export function startupImages(env: Record<string, string>): Plugin {
  return {
    name: "startup-images",
    apply: (_config, { command }) => command === "build" && env.VITE_DESKTOP_BUILD !== "true",
    transformIndexHtml: () =>
      STARTUP_IMAGES.map(({ fileName, media }) => ({
        tag: "link",
        attrs: { rel: "apple-touch-startup-image", href: `/${fileName}`, media },
        injectTo: "head" as const,
      })),
    generateBundle() {
      for (const { fileName, width, height } of STARTUP_IMAGES) {
        this.emitFile({ type: "asset", fileName, source: solidPng(width, height, BOOT_BACKGROUND) })
      }
    },
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1
  return n >>> 0
})

function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data])
  let crc = 0xffffffff
  for (const byte of body) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  const out = Buffer.alloc(body.length + 8)
  out.writeUInt32BE(data.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, body.length + 4)
  return out
}

/** One color as a one-entry palette at one bit per pixel: a few hundred bytes at any size. */
function solidPng(width: number, height: number, rgb: readonly number[]): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([1, 3, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("PLTE", Uint8Array.from(rgb)),
    chunk("IDAT", deflateSync(Buffer.alloc(height * (1 + Math.ceil(width / 8))))),
    chunk("IEND", new Uint8Array(0)),
  ])
}
