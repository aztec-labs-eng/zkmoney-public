import * as actual from "../../../src/features/deposit/sipaAddresses"
import { fixtureState, operation, pause } from "./control"
import { SIPA } from "./data"
import { desktopState, nextPooledAddress } from "./desktop"
export * from "../../../src/features/deposit/sipaAddresses"

const address = { address: SIPA, name: "demo.sandbox.oxide" }

export const createSipaAddresses: typeof actual.createSipaAddresses = (deps) => {
  const real = actual.createSipaAddresses(deps)
  return {
    ...real,
    depositAddress: async (tag, opts) => {
      if (!fixtureState()) return real.depositAddress(tag, opts)
      if (desktopState()) {
        await pause(300)
        return { ...address, address: nextPooledAddress() }
      }
      opts?.onStage?.("resolving")
      await operation("deposit-address")
      return address
    },
    readyAddress: async (maxAgeMs) =>
      fixtureState()
        ? { address: SIPA, day: Math.floor(Date.now() / 86_400_000) }
        : real.readyAddress(maxAgeMs),
  }
}
