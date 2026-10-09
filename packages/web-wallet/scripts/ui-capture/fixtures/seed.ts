import { seedDemo as actual } from "../../../src/dev/seedDemo"
import { getConfig } from "../../../src/config/env"
import { primeOxideTuple } from "../../../src/config/oxideTuple"
import { DEMO_OXIDE_TUPLE } from "../../../src/dev/demoFixtures"
import { isDemoMode } from "../../../src/dev/demoFlag"
import { installFakeEthereum } from "../../../src/dev/fakeEthereum"
import { installL1RpcStub } from "../../../src/dev/fakeL1Rpc"
import { fixtureState } from "./control"
import { seedRegistration } from "./registration-seed"
import { seedProcessing } from "./processing-seed"
import { entryPath, TOKEN, SIPA } from "./data"
import { desktopState, installDesktopBridge, seedPublishedAddress } from "./desktop"
import { BalanceStorage } from "@obsidion/front-core"
import { parseUnits } from "viem"
import { DEMO_COMPLETE_ADDRESS, DEMO_L2_TOKEN } from "../../../src/dev/demoFixtures"
import { webStorage } from "../../../src/platform/storage/WebStorageAdapter"
import { loadWalletIdentity, saveWalletIdentity } from "../../../src/features/identity/walletIdentity"
export * from "../../../src/dev/seedDemo"
export const seedDemo: typeof actual = async (scenario) => {
  const seeded = await actual(scenario)
  if (!seeded || !isDemoMode() || !fixtureState()) return seeded
  const config = getConfig()
  if (scenario === "onboarding") installL1RpcStub(config.l1RpcUrl, installFakeEthereum(config.l1ChainId))
  primeOxideTuple(getConfig(), { ...DEMO_OXIDE_TUPLE, l2Token: TOKEN, swapEscrowFactoryV2: SIPA })
  const query = new URLSearchParams(location.search)
  const registration = query.get("registrationFixture")
  if (registration) await seedRegistration(registration)
  // `?identityFixture=pending`: the seeded tag is still registering, as after a signup.
  const identity = query.get("identityFixture")
  if (identity) {
    if (identity !== "pending") throw new Error(`Unknown identity fixture: ${identity}`)
    const current = loadWalletIdentity()
    if (current) await saveWalletIdentity({ ...current, pending: true })
  }
  const processing = query.get("processingFixture")
  if (processing) await seedProcessing(processing)
  // `?balanceFixture=<tokens>` replaces the seeded wallet balance.
  const balance = query.get("balanceFixture")
  if (balance) {
    if (!/^\d+(\.\d+)?$/.test(balance)) throw new Error(`Unknown balance fixture: ${balance}`)
    await BalanceStorage.get(webStorage).updateBalance(`${config.network}:${DEMO_COMPLETE_ADDRESS}`, DEMO_L2_TOKEN, parseUnits(balance, 18))
  }
  if (desktopState()) {
    installDesktopBridge()
    await seedPublishedAddress(SIPA)
  }
  const entry = query.get("flowEntry")
  if (entry) {
    const destination = new URL(entryPath(entry), location.origin)
    query.delete("flowEntry")
    destination.search = query.toString()
    history.replaceState(history.state, "", destination)
  }
  return seeded
}
