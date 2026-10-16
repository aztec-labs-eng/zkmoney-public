import { WASM_SIMD } from "../browserSupport"

const OLD_BROWSER = {
  title: "Browser not supported",
  advice:
    "This browser is too old for zk.money. Update the browser or the operating system to the latest version.",
}

const NO_SIMD = {
  title: "Device not supported",
  advice:
    "WebAssembly SIMD is not available in this browser or on this device, and zk.money needs it. Use a different browser or device.",
}

export function UnsupportedBrowser({ missing }: { missing: string[] }) {
  const { title, advice } = missing.every((feature) => feature === WASM_SIMD)
    ? NO_SIMD
    : OLD_BROWSER
  return (
    <div role="alert" style={{ padding: 24 }}>
      <h1>{title}</h1>
      <p>{advice}</p>
      <p>Missing: {missing.join(", ")}</p>
    </div>
  )
}
