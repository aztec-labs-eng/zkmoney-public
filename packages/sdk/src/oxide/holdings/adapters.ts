import type { ConversionAdapters } from "./conversion.js"
import { CONVERSION_ADAPTERS } from "./conversions/index.js"
import type { TermsAdapters } from "./terms.js"
import { TERMS_ADAPTERS } from "./terms/index.js"

/** What a vault's route resolves its conversion and terms through. */
export interface HoldingAdapters {
  conversions: ConversionAdapters
  terms: TermsAdapters
}

/** Every conversion and terms kind the sdk routes. */
export const HOLDING_ADAPTERS: HoldingAdapters = {
  conversions: CONVERSION_ADAPTERS,
  terms: TERMS_ADAPTERS,
}
