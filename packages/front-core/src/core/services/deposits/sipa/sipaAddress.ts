import { computeLegacySIPAAddress } from "@oxide/oxide-lib/legacy_sipa_address.js"

export const computeSIPAAddress = computeLegacySIPAAddress
export type SipaAddressInputs = Parameters<typeof computeLegacySIPAAddress>[0]
export { computeSIPAAddress as computeAccountSIPAAddress } from "@oxide/oxide-lib/sipa_address.js"
