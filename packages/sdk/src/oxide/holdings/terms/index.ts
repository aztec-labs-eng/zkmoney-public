import { termsAdapters } from "../terms.js"
import { erc4626Terms } from "./erc4626.js"

export { erc4626Terms }

/** Every terms kind the sdk routes. A kind is added here and in its own module. */
export const TERMS_ADAPTERS = termsAdapters(erc4626Terms)
