import * as actual from "../../../src/dev/demoDeposit"
import { desktopState, nextPooledAddress } from "./desktop"
export * from "../../../src/dev/demoDeposit"

// Demo mode shows this address instead of a pooled one; the desktop fixture keeps the pool's order.
export const demoDepositAddress: typeof actual.demoDepositAddress = (tag) => {
  const demo = actual.demoDepositAddress(tag)
  return desktopState() ? { ...demo, address: nextPooledAddress() } : demo
}
