import { atPar } from "../conversion.js"
import type { ConversionAdapter } from "../conversion.js"

/** A vault whose asset is its base's token. */
export const noConversion: ConversionAdapter = {
  kind: "None",
  bind: async () => ({ steps: () => [], quote: atPar }),
}
