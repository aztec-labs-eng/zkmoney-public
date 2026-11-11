import * as actual from "../../../src/features/withdraw/etherfiCheck"
import { fixtureState } from "./control"
export * from "../../../src/features/withdraw/etherfiCheck"
// ether.fi's factories live on public mainnet and Optimism RPCs; no capture address is a Cash account.
export const useEtherfiAddressVerdict: typeof actual.useEtherfiAddressVerdict = (
  address,
  waitMs,
) => {
  const fixture = fixtureState() !== null
  const live = actual.useEtherfiAddressVerdict(fixture ? null : address, waitMs)
  if (!fixture) return live
  return address ? { ...live, kind: "rejected" } : { ...live, kind: "idle" }
}
