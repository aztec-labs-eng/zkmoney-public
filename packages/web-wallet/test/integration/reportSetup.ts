import { JSDOM } from "jsdom"
import { afterAll, vi } from "vitest"

// Keep Node's fetch and AbortSignal for the backend worker in this combined integration test.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" })
for (const name of [
  "window",
  "document",
  "navigator",
  "localStorage",
  "HTMLElement",
  "HTMLDialogElement",
] as const) {
  vi.stubGlobal(name, dom.window[name])
}
await import("../setup")
afterAll(() => {
  dom.window.close()
  vi.unstubAllGlobals()
})
