import { keyedService } from "@obsidion/front-core"
import { initNoirWasm, type NoirWasm } from "./noirProver"

/** The page's witness wasm: made on a proof's first wait, and again once it failed. */
export function pageNoirWasm(): NoirWasm {
  const wasm = keyedService("noirWasm", { retry: "manual" }, () => initNoirWasm())
  return () => wasm().ready()
}
