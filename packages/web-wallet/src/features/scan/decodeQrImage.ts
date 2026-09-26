import jsQR from "jsqr"
import { MAX_QR_FRAME_SIDE } from "./qrFrame"

/** Otsu's threshold separates two intensity groups without assuming the camera's exposure. */
function contrastThreshold(histogram: Uint32Array, pixels: number): number | null {
  let total = 0
  for (let value = 0; value < 256; value++) total += value * histogram[value]
  let count = 0
  let sum = 0
  let best = 0
  let threshold = 0
  for (let value = 0; value < 256; value++) {
    count += histogram[value]
    sum += value * histogram[value]
    if (!count || count === pixels) continue
    const difference = sum / count - (total - sum) / (pixels - count)
    const variance = count * (pixels - count) * difference * difference
    if (variance > best) {
      best = variance
      threshold = value
    }
  }
  return best > 0 ? threshold : null
}

export function decodeQrImage(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): string | null {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_QR_FRAME_SIDE ||
    height > MAX_QR_FRAME_SIDE ||
    !(data instanceof Uint8ClampedArray) ||
    data.length !== width * height * 4
  ) {
    throw new RangeError("Invalid camera frame")
  }
  const options = { inversionAttempts: "attemptBoth" as const }
  const decoded = jsQR(data, width, height, options)
  if (decoded) return decoded.data

  // The minimum channel separates white modules from bright colored backgrounds.
  const intensity = new Uint8Array(width * height)
  const histogram = new Uint32Array(256)
  for (let pixel = 0; pixel < intensity.length; pixel++) {
    const offset = pixel * 4
    const value = Math.min(data[offset], data[offset + 1], data[offset + 2])
    intensity[pixel] = value
    histogram[value]++
  }
  const threshold = contrastThreshold(histogram, intensity.length)
  if (threshold === null) return null
  const contrast = new Uint8ClampedArray(data.length)
  // Nearby thresholds account for antialiased module edges in small displayed codes.
  for (const offset of [0, -4, 4]) {
    for (let pixel = 0; pixel < intensity.length; pixel++) {
      const index = pixel * 4
      const value = intensity[pixel] > threshold + offset ? 255 : 0
      contrast[index] = contrast[index + 1] = contrast[index + 2] = value
      contrast[index + 3] = data[index + 3]
    }
    const result = jsQR(contrast, width, height, options)
    if (result) return result.data
  }
  return null
}
