export interface QrDecoder {
  decode(frame: ImageData): Promise<string | null>
  destroy(): void
}

/** The decoder dependencies load only when a camera session creates this worker. */
export function createQrDecoder(): QrDecoder {
  const worker = new Worker(new URL("./qrDecoder.worker.ts", import.meta.url), { type: "module" })
  let pending:
    | { resolve: (text: string | null) => void; reject: (error: Error) => void }
    | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false

  const destroy = () => {
    closed = true
    clearTimeout(timer)
    worker.terminate()
    pending?.reject(new Error("QR decoder stopped"))
    pending = undefined
  }
  worker.onmessage = (event: MessageEvent<{ text: string | null; error?: boolean }>) => {
    clearTimeout(timer)
    const job = pending
    pending = undefined
    if (event.data.error) job?.reject(new Error("Couldn't read the camera frame"))
    else job?.resolve(event.data.text)
  }
  worker.onerror = (event) => {
    event.preventDefault()
    destroy()
  }

  return {
    decode(frame) {
      if (closed) return Promise.reject(new Error("QR decoder stopped"))
      if (pending) return Promise.reject(new Error("QR decoder is busy"))
      return new Promise((resolve, reject) => {
        pending = { resolve, reject }
        timer = setTimeout(destroy, 10_000)
        try {
          worker.postMessage({ data: frame.data, width: frame.width, height: frame.height }, [
            frame.data.buffer,
          ])
        } catch (error) {
          clearTimeout(timer)
          pending = undefined
          reject(error)
        }
      })
    },
    destroy,
  }
}
