import { decodeQrImage } from "./decodeQrImage"

self.onmessage = (
  event: MessageEvent<{ data: Uint8ClampedArray; width: number; height: number }>,
) => {
  try {
    const { data, width, height } = event.data
    self.postMessage({ text: decodeQrImage(data, width, height) })
  } catch {
    self.postMessage({ text: null, error: true })
  }
}
