import { bridgeInDelivers, type BridgeInRecord } from "@obsidion/front-core"

/**
 * The newest bridge-in from this wallet that may be paying, or has paid, the deposit address
 * `payee`. Its record is saved before the wallet prompt, so it holds the pay sheet from then on.
 */
export const bridgePaymentHold = (
  records: readonly BridgeInRecord[],
  payee: string,
): string | undefined =>
  records.find(
    (r) => !!r.pays && bridgeInDelivers(r) && r.recipient.toLowerCase() === payee.toLowerCase(),
  )?.id
