import { conversionAdapters } from "../conversion.js"
import { daiUsdsConversion } from "./daiUsds.js"
import { noConversion } from "./none.js"
import { psmConversion } from "./psm.js"

export { daiUsdsConversion, noConversion, psmConversion }

/** Every conversion the sdk routes. A conversion is added here and in its own module. */
export const CONVERSION_ADAPTERS = conversionAdapters(noConversion, daiUsdsConversion, psmConversion)
