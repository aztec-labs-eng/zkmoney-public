import { seedDemo as actual } from "../../../src/dev/seedDemo"
import { getConfig } from "../../../src/config/env"
import { primeOxideTuple } from "../../../src/config/oxideTuple"
import { DEMO_OXIDE_TUPLE } from "../../../src/dev/demoFixtures"
import { isDemoMode } from "../../../src/dev/demoFlag"
import { installFakeEthereum } from "../../../src/dev/fakeEthereum"
import { installL1RpcStub } from "../../../src/dev/fakeL1Rpc"
import { fixtureState } from "./control"
import { seedRegistration } from "./registration-seed"
import { entryPath, TOKEN, SIPA } from "./data"
export * from "../../../src/dev/seedDemo"
export const seedDemo: typeof actual = async (scenario) => {
  const seeded = await actual(scenario)
  if (!seeded || !isDemoMode() || !fixtureState()) return seeded
  const config = getConfig()
  if (scenario === "onboarding") installL1RpcStub(config.l1RpcUrl, installFakeEthereum(config.l1ChainId))
  primeOxideTuple(getConfig(), { ...DEMO_OXIDE_TUPLE, l2Token: TOKEN, swapEscrowFactory: SIPA })
  const query = new URLSearchParams(location.search)
  const registration = query.get("registrationFixture")
  if (registration) await seedRegistration(registration)
  const entry = query.get("flowEntry")
  if (entry) {
    const destination = new URL(entryPath(entry), location.origin)
    query.delete("flowEntry")
    destination.search = query.toString()
    history.replaceState(history.state, "", destination)
  }
  return seeded
}
